/**
 * Browser half of dsh-tts (CONTRACT §3): speak the character's bubble lines and
 * drive the mouth from the audio level.
 *
 * One GET decides whether to attach. Disabled, or a 404 from an older host,
 * means no listener, no speech request and no AudioContext — the bubble keeps
 * its plain setTimeout timing. Every __dsc.voice call is optional-chained, so an
 * older dsc.js still plays audio without lipsync.
 * @module dsh-tts/client
 */
import { ChunkScheduler, carryOddByte } from './core.js'

/** Contract: no client service dependencies. */
export const inject = []

const STATE_ROUTE = '/dsh-tts/state'
const SPEAK_ROUTE = '/dsh-tts/speak'
const SAY_EVENT = 'dsc:say'
/** Keep the mouth alive between animation frames. */
const VOICE_FLOOR_MS = 250
/** Small lead so a chunk scheduled mid-frame is not played in the past. */
const LEAD_SECONDS = 0.06
/** Give up when no audio arrives before the bubble could still show it. */
const FIRST_CHUNK_LIMIT_MS = 1500
/** Sentinel that distinguishes a deadline expiry from a stream end. */
const TIMEOUT = Symbol('dsh-tts timeout')

/** Map one dsc:say kind to its voiceLines switch. */
function kindAllowed(lines, kind) {
  if (kind === 'reaction') return lines.reactions === true
  if (kind === 'status') return lines.status === true
  if (kind === 'mutter') return lines.mutters === true
  return lines.others === true
}

/** Read the state route once; null unless the host says enabled with a rate. */
async function readState() {
  try {
    const response = await fetch(STATE_ROUTE, { cache: 'no-store' })
    if (!response.ok) return null
    const state = await response.json()
    if (state?.enabled !== true || typeof state.pcmSampleRate !== 'number') return null
    return state
  } catch {
    return null
  }
}

/**
 * Read one chunk before deadline; null on stream end, and an abort on deadline.
 * The unused race branch keeps its rejection handled.
 */
async function readChunk(reader, deadline, controller) {
  let timer = 0
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, deadline - performance.now()))
  })
  const read = reader.read().catch(() => ({ done: true, value: undefined }))
  const result = await Promise.race([read, timeout])
  clearTimeout(timer)
  if (result === TIMEOUT) {
    controller.abort()
    return null
  }
  return result.done ? null : result.value
}

export async function apply(ctx) {
  const state = await readState()
  if (state === null) return

  let audioContext = null
  let playback = null

  /** Forward one voice state; the hook is optional and owned by dsc.js. */
  const voice = (value) => {
    try {
      window.__dsc?.voice?.(value)
    } catch {
      // A page hook that throws must not break playback.
    }
  }

  /** Lazily create the shared AudioContext; null when the API is missing. */
  const getAudioContext = () => {
    if (audioContext !== null) return audioContext
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext
    if (typeof Ctor !== 'function') return null
    try {
      audioContext = new Ctor()
    } catch {
      audioContext = null
    }
    return audioContext
  }

  /** Cancel the rAF meter and any pending bubble release. */
  function clearMeter(session) {
    clearTimeout(session.hold)
    if (session.frame !== 0) cancelAnimationFrame(session.frame)
    session.frame = 0
    session.hold = 0
  }

  /** Stop everything a session owns and detach its audio graph. */
  function teardown(session) {
    clearMeter(session)
    session.scheduler?.stop()
    session.scheduler = null
    try {
      session.analyser?.disconnect()
    } catch {
      // Already detached.
    }
    session.analyser = null
  }

  /** Barge-in: cancel the fetch, silence queued audio, reset the mouth. */
  function stopPlayback() {
    const session = playback
    if (session === null) return
    playback = null
    try {
      session.controller.abort()
    } catch {
      // abort() does not throw in practice.
    }
    teardown(session)
    voice(null)
  }

  /** Publish RMS as speaking state on every animation frame. */
  function startMeter(session) {
    const analyser = session.analyser
    const samples = new Float32Array(analyser.fftSize)
    const tick = () => {
      if (playback !== session) return
      let sum = 0
      analyser.getFloatTimeDomainData(samples)
      for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index]
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4)
      voice({ speaking: true, level, until: performance.now() + VOICE_FLOOR_MS })
      session.frame = requestAnimationFrame(tick)
    }
    session.frame = requestAnimationFrame(tick)
  }

  /** Stream ended: keep the bubble's own schedule, then release the mouth. */
  function endStream(session) {
    if (playback !== session) return
    clearMeter(session)
    const idle = () => {
      try {
        session.analyser?.disconnect()
      } catch {
        // Already detached.
      }
      session.analyser = null
    }
    session.scheduler.onIdle = idle
    if (!session.scheduler.active) idle()
    if (session.ms > 0) {
      voice({ speaking: true, level: 0, until: session.bubbleEnd })
      session.hold = setTimeout(() => {
        if (playback === session) playback = null
        voice(null)
      }, Math.max(0, session.bubbleEnd - performance.now()))
    } else {
      playback = null
      voice(null)
    }
  }

  /** Fetch, align and schedule one utterance. Never retries. */
  async function speak(detail) {
    stopPlayback()
    const text = typeof detail.text === 'string' ? detail.text.trim() : ''
    if (text.length === 0) return
    const ms = Number(detail.ms) > 0 ? Number(detail.ms) : 0
    const startedAt = performance.now()
    const controller = new AbortController()
    const session = {
      controller,
      analyser: null,
      scheduler: null,
      frame: 0,
      hold: 0,
      ms,
      bubbleEnd: startedAt + ms,
    }
    playback = session
    const deadline = startedAt + (ms > 0 ? Math.min(ms, FIRST_CHUNK_LIMIT_MS) : FIRST_CHUNK_LIMIT_MS)

    try {
      const response = await fetch(SPEAK_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: controller.signal,
      })
      if (!response.ok || response.body === null) throw new Error('dsh-tts: speak failed with ' + response.status)
      const audio = getAudioContext()
      if (audio === null) throw new Error('dsh-tts: no AudioContext')
      if (playback !== session) return
      try {
        await audio.resume()
      } catch {
        // Autoplay refusal is silent; scheduling still works once resumed.
      }
      const analyser = audio.createAnalyser()
      analyser.fftSize = 512
      analyser.connect(audio.destination)
      const scheduler = new ChunkScheduler({ audioContext: audio, destination: analyser, lead: LEAD_SECONDS })
      session.analyser = analyser
      session.scheduler = scheduler

      const reader = response.body.getReader()
      let chunk = await readChunk(reader, deadline, controller)
      if (chunk === null) throw new Error('dsh-tts: no audio before the bubble deadline')
      let rest = new Uint8Array(0)
      let metered = false
      while (chunk !== null) {
        const split = carryOddByte(rest, chunk)
        rest = split.rest
        if (split.aligned.length > 0) {
          scheduler.add(split.aligned, state.pcmSampleRate)
          if (!metered) {
            metered = true
            startMeter(session)
          }
        }
        const next = await reader.read()
        chunk = next.done ? null : next.value
      }
      scheduler.finish()
      endStream(session)
    } catch {
      if (playback === session) {
        playback = null
        teardown(session)
        voice(null)
      }
    }
  }

  function onSay(event) {
    const detail = event?.detail
    if (!detail || typeof detail.text !== 'string') return
    if (!kindAllowed(state.voiceLines ?? {}, detail.kind)) return
    void speak(detail)
  }

  ctx.effect(() => {
    document.addEventListener(SAY_EVENT, onSay)
    return () => {
      document.removeEventListener(SAY_EVENT, onSay)
      stopPlayback()
      try {
        audioContext?.close()
      } catch {
        // A context already closed is fine.
      }
      audioContext = null
    }
  }, 'dsh-tts: speech playback')
}
