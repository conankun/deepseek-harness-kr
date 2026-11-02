/**
 * Pure playback helpers for the dsh-tts client.
 *
 * Free of DOM and Web Audio globals so node:test can exercise byte alignment
 * and scheduling with a mocked AudioContext.
 * @module dsh-tts/client/core
 */

/** Convert little-endian PCM16 samples to floats in [-1, 1). */
export function pcm16ToFloat32(int16) {
  const out = new Float32Array(int16.length)
  for (let index = 0; index < int16.length; index += 1) out[index] = int16[index] / 32768
  return out
}

/**
 * Join the carried byte with the next chunk and split off whole 16-bit samples.
 * A stream may split a sample across two reads; the odd byte is returned for
 * the next call.
 * @param prev - carried byte from the previous chunk (empty on the first call).
 * @param chunk - next raw byte chunk.
 * @returns whole samples and the trailing byte to carry.
 */
export function carryOddByte(prev, chunk) {
  const head = prev instanceof Uint8Array ? prev : new Uint8Array(0)
  const tail = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
  let bytes = tail
  if (head.length > 0) {
    bytes = new Uint8Array(head.length + tail.length)
    bytes.set(head, 0)
    bytes.set(tail, head.length)
  }
  const usable = bytes.length - (bytes.length % 2)
  const aligned = new Int16Array(usable / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, usable)
  for (let index = 0; index < aligned.length; index += 1) aligned[index] = view.getInt16(index * 2, true)
  return { aligned, rest: bytes.subarray(usable) }
}

/**
 * Queue streamed PCM chunks back-to-back on one injected AudioContext.
 *
 * Each add() schedules its buffer at max(next, currentTime + lead): chunks that
 * arrive faster than playback start immediately after the previous one, while a
 * late chunk restarts with a small lead instead of playing in the past.
 */
export class ChunkScheduler {
  constructor({ audioContext, destination, lead = 0.06 } = {}) {
    this.audioContext = audioContext
    this.destination = destination
    this.lead = lead
    this.sources = new Set()
    this.nextStart = 0
    this.stopped = false
    this.ended = false
    /** Called once every scheduled buffer has played out. */
    this.onIdle = null
  }

  /** Schedule whole PCM16 samples at sampleRate; returns their start time. */
  add(int16, sampleRate) {
    if (this.stopped || int16.length === 0) return null
    const buffer = this.audioContext.createBuffer(1, int16.length, sampleRate)
    buffer.getChannelData(0).set(pcm16ToFloat32(int16))
    const source = this.audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(this.destination)
    const startAt = Math.max(this.nextStart, this.audioContext.currentTime + this.lead)
    source.start(startAt)
    this.nextStart = startAt + buffer.duration
    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      if (this.ended && this.sources.size === 0) this.onIdle?.()
    }
    return startAt
  }

  /** Mark the stream ended; returns the time the last queued sample ends. */
  finish() {
    this.ended = true
    if (this.sources.size === 0) this.onIdle?.()
    return this.nextStart
  }

  /** Stop and forget every queued buffer (barge-in or teardown). */
  stop() {
    this.stopped = true
    for (const source of this.sources) {
      try {
        source.stop()
      } catch {
        // Already ended.
      }
      try {
        source.disconnect()
      } catch {
        // Already detached.
      }
    }
    this.sources.clear()
    this.nextStart = 0
  }

  /** Audio-clock time at which the last scheduled sample ends. */
  get endTime() {
    return this.nextStart
  }

  /** True while at least one scheduled buffer has not played out. */
  get active() {
    return this.sources.size > 0
  }
}
