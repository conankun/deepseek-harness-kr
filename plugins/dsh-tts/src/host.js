/**
 * Host half of dsh-tts: the state route the browser half reads
 * once, and the streaming proxy that keeps the API key server-side.
 *
 * The proxy only speaks the standard OpenAI /audio/speech shape. A non-2xx
 * upstream answer is forwarded as JSON before any audio header goes out, so the
 * client never mistakes an error page for PCM. Nothing about the request text
 * is logged.
 * @module dsh-tts/host
 */
import { cacheKey, createCache } from './cache.js'

/** Route the browser half reads once to decide whether to attach. */
export const STATE_ROUTE = '/dsh-tts/state'

/** Route the browser half posts one speech line to. */
export const SPEAK_ROUTE = '/dsh-tts/speak'

/** Speak bodies hold one short line; this bound applies before JSON parsing. */
const MAX_SPEAK_BODY_BYTES = 64 * 1024

/** PCM response headers; no-store keeps a voice line out of any HTTP cache. */
function pcmHeaders(cache, length) {
  const headers = { 'content-type': 'audio/pcm', 'cache-control': 'no-store', 'x-cache': cache }
  if (length !== undefined) headers['content-length'] = length
  return headers
}

/** Send one JSON response, owning the whole response. */
function sendJson(req, res, status, body, extra = {}) {
  res.on('error', () => {})
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...extra,
  })
  res.end(req.method === 'HEAD' ? undefined : text)
}

/** Buffer one request body up to limit bytes; rejects with tooLarge/aborted. */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('body exceeds ' + limit + ' bytes'), { tooLarge: true }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks, size)))
    req.on('error', reject)
    req.on('aborted', () => reject(Object.assign(new Error('request aborted'), { aborted: true })))
  })
}

/** Read the API key from the configured env var; null when unset or empty. */
function readApiKey(openai) {
  const value = openai.apiKeyEnv === '' ? undefined : process.env[openai.apiKeyEnv]
  if (typeof value !== 'string' || value.trim().length === 0) return null
  return value.trim()
}

/** Extract the useful message from a failed upstream response, bounded. */
async function upstreamMessage(response) {
  let raw = ''
  try {
    raw = (await response.text()).slice(0, 500)
  } catch {
    // A body that cannot be read still has a status code.
  }
  try {
    const parsed = JSON.parse(raw)
    const message = parsed?.error?.message ?? parsed?.message
    if (typeof message === 'string' && message.length > 0) return message
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return raw.trim() || 'upstream responded ' + response.status
}

/**
 * Build the exact state payload the browser half consumes.
 * @param config - normalized config.
 * @returns { enabled, pcmSampleRate, voiceLines }.
 */
export function statePayload(config) {
  const lines = config.voiceLines
  return {
    // Streaming is the only transport, so the stream switch is a kill switch.
    enabled: config.enabled === true && config.stream.enabled !== false,
    pcmSampleRate: config.stream.pcmSampleRate,
    voiceLines: {
      reactions: lines.reactions === true,
      status: lines.status === true,
      mutters: lines.mutters === true,
      others: lines.others === true,
    },
  }
}

/**
 * Build the GET/HEAD state handler.
 * @param config - normalized config.
 * @returns the route handler.
 */
export function createStateHandler(config) {
  return function stateHandler(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(req, res, 405, { error: { message: 'use GET or HEAD' } }, { allow: 'GET, HEAD' })
      return
    }
    sendJson(req, res, 200, statePayload(config))
  }
}

/**
 * Build the POST speak handler: cache first, then the streaming proxy.
 * @param config - normalized config.
 * @param deps - injectable fetch, now and cache for tests.
 * @returns the route handler.
 */
export function createSpeakHandler(config, deps = {}) {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const cache = deps.cache ?? (config.cache.enabled === false ? null : createCache({ ...config.cache, now: deps.now ?? Date.now }))
  const { openai, limits } = config

  return async function speakHandler(req, res) {
    // A browser that disconnects mid-write emits an error on the response;
    // without a listener that would surface as an uncaught exception.
    res.on('error', () => {})
    if (req.method !== 'POST') {
      sendJson(req, res, 405, { error: { message: 'use POST' } }, { allow: 'POST' })
      return
    }

    let text
    try {
      const parsed = JSON.parse((await readBody(req, MAX_SPEAK_BODY_BYTES)).toString('utf8'))
      text = typeof parsed?.text === 'string' ? parsed.text.trim() : ''
    } catch (error) {
      const tooLarge = error?.tooLarge === true
      sendJson(req, res, tooLarge ? 413 : 400, {
        error: { message: tooLarge ? String(error.message) : 'body must be a JSON object with a non-empty text string' },
      })
      return
    }
    if (text.length === 0) {
      sendJson(req, res, 400, { error: { message: 'text must be a non-empty string' } })
      return
    }
    if (text.length > limits.maxCharsPerLine) {
      sendJson(req, res, 400, { error: { message: 'text exceeds ' + limits.maxCharsPerLine + ' characters' } })
      return
    }

    // Model-specific direction prefix (e.g. Drama 3 "[bright, playful] ").
    const spokenText = openai.textPrefix + text
    const key = cacheKey(openai.model, openai.voice, spokenText, JSON.stringify(openai.extraBody ?? {}))
    const cached = cache?.get(key) ?? null
    if (cached !== null) {
      res.writeHead(200, pcmHeaders('hit', cached.length))
      res.end(cached)
      return
    }

    const apiKey = readApiKey(openai)
    if (apiKey === null) {
      sendJson(req, res, 503, { error: { message: 'missing API key: set env ' + openai.apiKeyEnv } })
      return
    }

    const controller = new AbortController()
    let clientGone = false
    const onClientGone = () => {
      if (clientGone || res.writableFinished) return
      clientGone = true
      controller.abort()
    }
    // res 'close' is the reliable disconnect signal; req 'close' also fires on
    // some Node versions, so only count it when the socket itself is gone.
    res.on('close', onClientGone)
    req.on('close', () => {
      if (!req.socket || req.socket.writable === false) onClientGone()
    })
    const timeout = setTimeout(() => controller.abort(), openai.timeoutMs)
    let chunks = []
    let received = 0
    let overflow = false

    try {
      const response = await fetchImpl(openai.baseUrl + '/audio/speech', {
        method: 'POST',
        headers: { ...openai.headers, 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({
          // Model-specific fields first (e.g. Drama 3 ref_audio/ref_text); the
          // standard contract below always wins on conflict.
          ...openai.extraBody,
          model: openai.model,
          voice: openai.voice,
          input: spokenText,
          response_format: 'pcm',
          stream_format: 'audio',
          ...(openai.speed === 1 ? {} : { speed: openai.speed }),
        }),
        signal: controller.signal,
      })
      if (!response.ok) {
        sendJson(req, res, response.status, { error: { message: await upstreamMessage(response) } })
        return
      }
      res.writeHead(200, pcmHeaders('miss'))
      if (response.body !== null) {
        for await (const chunk of response.body) {
          if (clientGone) break
          const bytes = Buffer.from(chunk)
          received += bytes.length
          if (received > limits.maxBytes) {
            overflow = true
            chunks = []
            controller.abort()
            break
          }
          chunks.push(bytes)
          res.write(bytes)
        }
      }
      res.end()
      if (!clientGone && !overflow && received > 0) cache?.set(key, Buffer.concat(chunks, received))
    } catch (error) {
      if (clientGone) return
      if (!res.headersSent) {
        const timedOut = controller.signal.aborted
        sendJson(req, res, timedOut ? 504 : 502, {
          error: { message: (timedOut ? 'tts timed out: ' : 'tts request failed: ') + String(error?.message ?? error) },
        })
      } else {
        res.destroy()
      }
    } finally {
      clearTimeout(timeout)
      res.off('close', onClientGone)
    }
  }
}