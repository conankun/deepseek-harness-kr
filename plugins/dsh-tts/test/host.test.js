import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'
import { createCache } from '../src/cache.js'
import { normalize } from '../src/config.js'
import { createSpeakHandler } from '../src/host.js'
import { apply } from '../src/index.js'

const KEY_ENV = 'DSH_TTS_TEST_KEY'
const PCM = [Buffer.from([1, 0, 2, 0]), Buffer.from([3, 0, 4, 0]), Buffer.from([5, 0, 6, 0])]
const PCM_ALL = Buffer.concat(PCM)

/** Resolve once the server listens; returns its port. */
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

/** Close a server and any lingering keep-alive sockets. */
function closeServer(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(resolve))
}

/** Poll until predicate() is true, or the timeout expires. */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return predicate()
}

/** Fake OpenAI-compatible /audio/speech; behaviour is keyed by input text. */
async function startUpstream() {
  const stats = { calls: 0, aborted: 0, bodies: [], authorizations: [] }
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      stats.calls += 1
      stats.authorizations.push(req.headers.authorization)
      const body = JSON.parse(raw)
      stats.bodies.push(body)
      req.on('close', () => {
        if (!res.writableEnded) stats.aborted += 1
      })
      if (body.input === 'fail') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'upstream exploded' } }))
        return
      }
      res.writeHead(200, { 'content-type': 'audio/pcm' })
      if (body.input === 'slow') {
        res.write(PCM[0])
        return
      }
      let index = 0
      const pump = () => {
        if (index === PCM.length) {
          res.end()
          return
        }
        res.write(PCM[index])
        index += 1
        setTimeout(pump, 10)
      }
      pump()
    })
  })
  server.on('clientError', () => {})
  const port = await listen(server)
  return { stats, port, close: () => closeServer(server) }
}

/** Activate the plugin through apply() and serve its routes over real HTTP. */
async function startHost(upstreamPort, config = {}) {
  const routes = new Map()
  const disposers = []
  const ctx = {
    webServer: {
      register({ path, handler }) {
        routes.set(path, handler)
        return () => routes.delete(path)
      },
    },
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
  }
  apply(ctx, {
    enabled: true,
    ...config,
    openai: { ...(config.openai ?? {}), baseUrl: 'http://127.0.0.1:' + upstreamPort + '/v1' },
  })
  const server = http.createServer((req, res) => {
    const handler = routes.get(req.url)
    if (handler === undefined) {
      res.writeHead(404).end()
      return
    }
    handler(req, res)
  })
  const port = await listen(server)
  return {
    url: 'http://127.0.0.1:' + port,
    close: async () => {
      await closeServer(server)
      for (const dispose of disposers) dispose()
    },
  }
}

/** POST one speech line; a string body is sent verbatim. */
function speak(url, body, options = {}) {
  return fetch(url + '/dsh-tts/speak', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...options,
  })
}

test('disabled registers no routes, invalid config names its field', () => {
  const routes = []
  const ctx = {
    webServer: {
      register({ path }) {
        routes.push(path)
        return () => {}
      },
    },
    effect(fn) {
      fn()
    },
  }
  apply(ctx, { enabled: false })
  assert.deepEqual(routes, [])
  assert.throws(() => apply(ctx, { enabled: true, openai: { model: 42 } }), /config\.openai\.model/)
  assert.throws(() => apply(ctx, { enabled: true, openai: { baseUrl: 'ftp://nope' } }), /config\.openai\.baseUrl/)
})

test('state route exposes the contract shape', async () => {
  process.env[KEY_ENV] = 'test-key'
  const upstream = await startUpstream()
  const host = await startHost(upstream.port, { voiceLines: { status: true } })
  try {
    const response = await fetch(host.url + '/dsh-tts/state')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      enabled: true,
      pcmSampleRate: 24000,
      voiceLines: { reactions: true, status: true, mutters: false, others: true },
    })
    assert.equal((await fetch(host.url + '/dsh-tts/speak')).status, 405)
  } finally {
    await host.close()
    await upstream.close()
    delete process.env[KEY_ENV]
  }
})

test('speak rejects invalid bodies with 400 and never calls upstream', async () => {
  process.env[KEY_ENV] = 'test-key'
  const upstream = await startUpstream()
  const host = await startHost(upstream.port, { limits: { maxCharsPerLine: 5 }, openai: { apiKeyEnv: KEY_ENV } })
  try {
    assert.equal((await speak(host.url, '{not json')).status, 400)
    assert.equal((await speak(host.url, { text: '   ' })).status, 400)
    assert.equal((await speak(host.url, {})).status, 400)
    assert.equal((await speak(host.url, { text: 'too long' })).status, 400)
    assert.equal(upstream.stats.calls, 0)
  } finally {
    await host.close()
    await upstream.close()
    delete process.env[KEY_ENV]
  }
})

test('speak answers 503 when the configured env var is unset', async () => {
  delete process.env[KEY_ENV]
  const upstream = await startUpstream()
  const host = await startHost(upstream.port, { openai: { apiKeyEnv: KEY_ENV } })
  try {
    const response = await speak(host.url, { text: 'hello' })
    assert.equal(response.status, 503)
    assert.match((await response.json()).error.message, /API key/)
    assert.equal(upstream.stats.calls, 0)
  } finally {
    await host.close()
    await upstream.close()
  }
})

test('miss streams PCM and an identical line is served from cache', async () => {
  process.env[KEY_ENV] = 'test-key'
  const upstream = await startUpstream()
  const host = await startHost(upstream.port, { openai: { apiKeyEnv: KEY_ENV } })
  try {
    const first = await speak(host.url, { text: 'hello there' })
    assert.equal(first.status, 200)
    assert.equal(first.headers.get('content-type'), 'audio/pcm')
    assert.equal(first.headers.get('cache-control'), 'no-store')
    assert.equal(first.headers.get('x-cache'), 'miss')
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), PCM_ALL)
    assert.equal(upstream.stats.calls, 1)
    assert.equal(upstream.stats.authorizations[0], 'Bearer test-key')
    assert.deepEqual(upstream.stats.bodies[0], {
      model: 'gpt-4o-mini-tts',
      voice: 'alloy',
      input: 'hello there',
      response_format: 'pcm',
      stream_format: 'audio',
    })

    const second = await speak(host.url, { text: 'hello there' })
    assert.equal(second.status, 200)
    assert.equal(second.headers.get('x-cache'), 'hit')
    assert.equal(second.headers.get('content-type'), 'audio/pcm')
    assert.deepEqual(Buffer.from(await second.arrayBuffer()), PCM_ALL)
    assert.equal(upstream.stats.calls, 1, 'cache hit makes no upstream call')
  } finally {
    await host.close()
    await upstream.close()
    delete process.env[KEY_ENV]
  }
})

test('a non-2xx upstream answer is forwarded as JSON before any audio header', async () => {
  process.env[KEY_ENV] = 'test-key'
  const upstream = await startUpstream()
  const host = await startHost(upstream.port, { openai: { apiKeyEnv: KEY_ENV, speed: 1.5 } })
  try {
    const response = await speak(host.url, { text: 'fail' })
    assert.equal(response.status, 500)
    assert.match(response.headers.get('content-type'), /application\/json/)
    assert.equal(response.headers.get('x-cache'), null)
    assert.equal((await response.json()).error.message, 'upstream exploded')
    assert.equal(upstream.stats.bodies[0].speed, 1.5)
  } finally {
    await host.close()
    await upstream.close()
    delete process.env[KEY_ENV]
  }
})

test('a client disconnect aborts the upstream request', async () => {
  process.env[KEY_ENV] = 'test-key'
  const upstream = await startUpstream()
  const host = await startHost(upstream.port, { openai: { apiKeyEnv: KEY_ENV } })
  try {
    const request = http.request(host.url + '/dsh-tts/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    const firstChunk = new Promise((resolve, reject) => {
      request.on('response', (response) => {
        response.once('data', resolve)
        response.on('error', () => {})
      })
      request.on('error', reject)
    })
    request.end(JSON.stringify({ text: 'slow' }))
    await firstChunk
    request.destroy()
    assert.ok(await waitFor(() => upstream.stats.aborted > 0, 2000), 'upstream request was aborted')
  } finally {
    await host.close()
    await upstream.close()
    delete process.env[KEY_ENV]
  }
})

test('createSpeakHandler honors an injected fetch and clock', async () => {
  process.env[KEY_ENV] = 'test-key'
  let clock = 1000
  const config = normalize({ enabled: true, openai: { apiKeyEnv: KEY_ENV }, cache: { ttlMs: 1000 } })
  const calls = []
  const handler = createSpeakHandler(config, {
    now: () => clock,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response(Buffer.concat(PCM), { status: 200, headers: { 'content-type': 'audio/pcm' } })
    },
  })
  const server = http.createServer((req, res) => handler(req, res))
  const port = await listen(server)
  const url = 'http://127.0.0.1:' + port
  try {
    assert.equal((await speak(url, { text: 'injected' })).headers.get('x-cache'), 'miss')
    assert.equal((await speak(url, { text: 'injected' })).headers.get('x-cache'), 'hit')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/speech')
    assert.equal(calls[0].init.headers.authorization, 'Bearer test-key')
    clock += 2000
    assert.equal((await speak(url, { text: 'injected' })).headers.get('x-cache'), 'miss')
    assert.equal(calls.length, 2)
  } finally {
    await closeServer(server)
    delete process.env[KEY_ENV]
  }
})

test('cache skips oversized payloads and expires entries', () => {
  let clock = 0
  const cache = createCache({ maxEntries: 2, ttlMs: 100, maxCacheBytes: 16, now: () => clock })
  assert.equal(cache.set('a', Buffer.alloc(8)), true)
  assert.equal(cache.set('b', Buffer.alloc(17)), false, 'oversized payload is not cached')
  assert.equal(cache.set('b', Buffer.alloc(4)), true)
  assert.equal(cache.size, 2)
  assert.equal(cache.get('a').length, 8)
  clock = 1000
  assert.equal(cache.get('a'), null, 'expired entry is dropped')
  assert.equal(cache.set('c', Buffer.alloc(4)), true)
  assert.equal(cache.size, 2)
})
