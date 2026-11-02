import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../src/client/index.js'

const STATE = {
  enabled: true,
  pcmSampleRate: 24000,
  voiceLines: { reactions: true, status: true, mutters: true, others: true },
}

/** Build a ReadableStream-like body that yields the given chunks then ends. */
function pcmStream(chunks) {
  let index = 0
  return {
    getReader() {
      return {
        read() {
          if (index < chunks.length) return Promise.resolve({ done: false, value: chunks[index++] })
          return Promise.resolve({ done: true, value: undefined })
        },
      }
    },
  }
}

/** Minimal AudioContext stand-in with manual playback completion. */
function makeAudio() {
  const started = []
  const stopped = []
  const analysers = []
  const makeAnalyser = () => {
    const analyser = {
      fftSize: 512,
      disconnected: false,
      connect() {},
      disconnect() {
        analyser.disconnected = true
      },
      getFloatTimeDomainData(samples) {
        samples.fill(0.5)
      },
    }
    analysers.push(analyser)
    return analyser
  }
  const context = {
    currentTime: 0,
    state: 'running',
    destination: {},
    createAnalyser: makeAnalyser,
    createBuffer: (channels, length, sampleRate) => ({
      duration: length / sampleRate,
      length,
      sampleRate,
      getChannelData: () => new Float32Array(length),
    }),
    createBufferSource() {
      const source = {
        connected: null,
        disconnected: false,
        onended: null,
        connect() {},
        disconnect() {
          source.disconnected = true
        },
        start(at) {
          started.push({ at, source })
        },
        stop() {
          stopped.push(source)
        },
      }
      return source
    },
    resume: async () => {},
    close: async () => {},
  }
  return { context, started, stopped, analysers }
}

/** Install browser-ish globals and return handles for driving time and events. */
function createHarness(t, speakChunks) {
  const windowListeners = new Map()
  const voiceCalls = []
  const pendingFrames = []
  const fetchCalls = []
  const audio = makeAudio()
  const chunks = [...speakChunks]

  globalThis.window = {
    __dsc: {
      voice(value) {
        voiceCalls.push(value)
      },
    },
    addEventListener(type, listener) {
      windowListeners.set(type, listener)
    },
    removeEventListener(type) {
      windowListeners.delete(type)
    },
  }
  globalThis.AudioContext = function AudioContext() {
    return audio.context
  }
  globalThis.fetch = async (url, init) => {
    if (url === '/dsh-tts/state') return { ok: true, status: 200, json: async () => STATE }
    if (url === '/dsh-tts/speak') {
      fetchCalls.push(JSON.parse(init.body))
      return { ok: true, status: 200, body: pcmStream(chunks.shift() ?? []) }
    }
    return { ok: false, status: 404 }
  }
  globalThis.requestAnimationFrame = (callback) => {
    pendingFrames.push(callback)
    return pendingFrames.length
  }
  globalThis.cancelAnimationFrame = () => {}

  const flush = async () => {
    for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  const frames = () => {
    for (const callback of pendingFrames.splice(0)) callback(performance.now())
  }
  const emit = (detail) => {
    const listener = windowListeners.get('dsc:say')
    assert.ok(listener, 'client subscribed to dsc:say')
    listener({ detail })
  }

  const disposers = []
  const ctx = {
    effect(fn) {
      disposers.push(fn())
    },
  }
  t.after(() => {
    for (const dispose of disposers) dispose?.()
    delete globalThis.window
    delete globalThis.AudioContext
    delete globalThis.fetch
    delete globalThis.requestAnimationFrame
    delete globalThis.cancelAnimationFrame
  })

  return { ctx, audio, voiceCalls, fetchCalls, emit, frames, flush }
}

test('fast response keeps lip-sync metering until playback finishes', async (t) => {
  // 4800 bytes of PCM16 = 100 ms at 24 kHz, delivered before the response ends.
  const harness = createHarness(t, [[new Uint8Array(4800)], [new Uint8Array(4800)]])
  await apply(harness.ctx)
  harness.emit({ text: 'hello', ms: 0, kind: 'reaction' })
  await harness.flush()

  assert.equal(harness.audio.started.length, 1)
  // Download is over, but audio is still playing: the meter must keep running.
  harness.frames()
  const levels = harness.voiceCalls.filter((value) => value?.speaking === true)
  assert.ok(levels.length > 0, 'meter published speaking levels after download end')
  assert.ok(levels.some((value) => value.level > 0), 'level reflects the audible buffer')
  assert.ok(!harness.voiceCalls.includes(null), 'mouth is not released before playback ends')

  // Actual playback completion (scheduler idle) releases everything.
  harness.audio.started[0].source.onended()
  assert.equal(harness.voiceCalls.at(-1), null)
  assert.equal(harness.audio.analysers[0].disconnected, true)

  // The next line still plays after a clean release.
  harness.emit({ text: 'again', ms: 0, kind: 'reaction' })
  await harness.flush()
  assert.equal(harness.audio.started.length, 2)
})

test('a new ms=0 line stops audio that is still playing from the previous line', async (t) => {
  const harness = createHarness(t, [[new Uint8Array(4800)], [new Uint8Array(4800)]])
  await apply(harness.ctx)
  harness.emit({ text: 'first', ms: 0, kind: 'reaction' })
  await harness.flush()
  assert.equal(harness.audio.started.length, 1)

  // Download finished for the first line but its buffer is still playing.
  harness.emit({ text: 'second', ms: 0, kind: 'reaction' })
  await harness.flush()
  assert.equal(harness.fetchCalls.length, 2)
  assert.ok(harness.audio.stopped.includes(harness.audio.started[0].source), 'previous source stopped')
  assert.equal(harness.audio.started.length, 2, 'second line scheduled')
})

test('barge-in during AudioContext.resume never schedules the superseded line', async (t) => {
  const harness = createHarness(t, [[new Uint8Array(4800)], [new Uint8Array(4800)]])
  let resumeCalls = 0
  let releaseResume = () => {}
  harness.audio.context.resume = () => {
    resumeCalls += 1
    if (resumeCalls === 1) {
      return new Promise((resolve) => {
        releaseResume = resolve
      })
    }
    return Promise.resolve()
  }

  await apply(harness.ctx)
  harness.emit({ text: 'first', ms: 0, kind: 'reaction' })
  await harness.flush()
  assert.equal(resumeCalls, 1, 'first line is waiting on resume()')

  // The second line supersedes the first while its resume() is still pending.
  harness.emit({ text: 'second', ms: 0, kind: 'reaction' })
  await harness.flush()
  releaseResume()
  await harness.flush()

  assert.equal(harness.fetchCalls.length, 2)
  assert.equal(harness.audio.started.length, 1, 'only the new line schedules audio')
  assert.equal(harness.audio.analysers.length, 1, 'superseded line created no audio graph')
})

