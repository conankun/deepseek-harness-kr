import assert from 'node:assert/strict'
import test from 'node:test'
import { ChunkScheduler, carryOddByte, pcm16ToFloat32 } from '../src/client/core.js'

/** Minimal AudioContext stand-in: records starts/stops, no real audio. */
function mockAudioContext() {
  const started = []
  const stopped = []
  const context = {
    currentTime: 0,
    createBuffer(channels, length, sampleRate) {
      const data = new Float32Array(length)
      return { duration: length / sampleRate, length, sampleRate, getChannelData: () => data }
    },
    createBufferSource() {
      const source = {
        buffer: null,
        connected: null,
        onended: null,
        connect(node) {
          this.connected = node
        },
        disconnect() {},
        start(at) {
          started.push({ at, source: this })
        },
        stop() {
          stopped.push(this)
        },
      }
      return source
    },
  }
  return { context, started, stopped }
}

test('pcm16ToFloat32 maps signed samples into [-1, 1)', () => {
  const floats = pcm16ToFloat32(new Int16Array([0, 16384, -16384, -32768, 32767]))
  assert.deepEqual([...floats], [0, 0.5, -0.5, -1, 32767 / 32768])
})

test('carryOddByte joins an odd byte to the next chunk', () => {
  const first = carryOddByte(new Uint8Array(0), new Uint8Array([0x01, 0x00, 0x02]))
  assert.deepEqual([...first.aligned], [1])
  assert.deepEqual([...first.rest], [0x02])

  const second = carryOddByte(first.rest, new Uint8Array([0x00, 0x03, 0x00, 0x04]))
  assert.deepEqual([...second.aligned], [2, 3])
  assert.deepEqual([...second.rest], [0x04])

  const negative = carryOddByte(new Uint8Array(0), new Uint8Array([0xff, 0xff]))
  assert.deepEqual([...negative.aligned], [-1])
  assert.equal(negative.rest.length, 0)

  const empty = carryOddByte(new Uint8Array(0), new Uint8Array(0))
  assert.equal(empty.aligned.length, 0)
  assert.equal(empty.rest.length, 0)
})

test('ChunkScheduler schedules chunks back-to-back after a small lead', () => {
  const { context, started } = mockAudioContext()
  const destination = {}
  const scheduler = new ChunkScheduler({ audioContext: context, destination, lead: 0.06 })
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, actual + ' != ' + expected)

  near(scheduler.add(new Int16Array(2400), 24000), 0.06)
  near(scheduler.endTime, 0.16)
  assert.equal(scheduler.active, true)

  near(scheduler.add(new Int16Array(1200), 24000), 0.16)
  near(scheduler.endTime, 0.21)
  assert.equal(started.length, 2)
  assert.equal(started[0].source.connected, destination)

  // A late chunk restarts at currentTime + lead instead of playing in the past.
  context.currentTime = 1
  near(scheduler.add(new Int16Array(240), 24000), 1.06)
  near(scheduler.endTime, 1.07)
})

test('ChunkScheduler finish waits for playback and stop silences queued audio', () => {
  const { context, started, stopped } = mockAudioContext()
  const scheduler = new ChunkScheduler({ audioContext: context, destination: {} })
  let idle = 0
  scheduler.onIdle = () => {
    idle += 1
  }

  scheduler.add(new Int16Array(4800), 24000)
  assert.equal(scheduler.finish(), scheduler.endTime)
  assert.equal(idle, 0)
  for (const { source } of started) source.onended()
  assert.equal(idle, 1)
  assert.equal(scheduler.active, false)

  const silent = new ChunkScheduler({ audioContext: context, destination: {} })
  silent.onIdle = () => {
    idle += 1
  }
  silent.finish()
  assert.equal(idle, 2)

  scheduler.add(new Int16Array(480), 24000)
  assert.equal(scheduler.active, true)
  scheduler.stop()
  assert.equal(stopped.length, 1)
  assert.equal(scheduler.active, false)
  assert.equal(scheduler.endTime, 0)
  assert.equal(scheduler.add(new Int16Array(480), 24000), null)
})