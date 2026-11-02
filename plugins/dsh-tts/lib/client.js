window.__ModuleLoader__.load({ id: "dsh-tts", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.js
var index_exports = {};
__export(index_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);

// src/client/core.js
function pcm16ToFloat32(int16) {
  const out = new Float32Array(int16.length);
  for (let index = 0; index < int16.length; index += 1) out[index] = int16[index] / 32768;
  return out;
}
function carryOddByte(prev, chunk) {
  const head = prev instanceof Uint8Array ? prev : new Uint8Array(0);
  const tail = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
  let bytes = tail;
  if (head.length > 0) {
    bytes = new Uint8Array(head.length + tail.length);
    bytes.set(head, 0);
    bytes.set(tail, head.length);
  }
  const usable = bytes.length - bytes.length % 2;
  const aligned = new Int16Array(usable / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, usable);
  for (let index = 0; index < aligned.length; index += 1) aligned[index] = view.getInt16(index * 2, true);
  return { aligned, rest: bytes.subarray(usable) };
}
var ChunkScheduler = class {
  constructor({ audioContext, destination, lead = 0.06 } = {}) {
    this.audioContext = audioContext;
    this.destination = destination;
    this.lead = lead;
    this.sources = /* @__PURE__ */ new Set();
    this.nextStart = 0;
    this.stopped = false;
    this.ended = false;
    this.onIdle = null;
  }
  /** Schedule whole PCM16 samples at sampleRate; returns their start time. */
  add(int16, sampleRate) {
    if (this.stopped || int16.length === 0) return null;
    const buffer = this.audioContext.createBuffer(1, int16.length, sampleRate);
    buffer.getChannelData(0).set(pcm16ToFloat32(int16));
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.destination);
    const startAt = Math.max(this.nextStart, this.audioContext.currentTime + this.lead);
    source.start(startAt);
    this.nextStart = startAt + buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      if (this.ended && this.sources.size === 0) this.onIdle?.();
    };
    return startAt;
  }
  /** Mark the stream ended; returns the time the last queued sample ends. */
  finish() {
    this.ended = true;
    if (this.sources.size === 0) this.onIdle?.();
    return this.nextStart;
  }
  /** Stop and forget every queued buffer (barge-in or teardown). */
  stop() {
    this.stopped = true;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
      }
      try {
        source.disconnect();
      } catch {
      }
    }
    this.sources.clear();
    this.nextStart = 0;
  }
  /** Audio-clock time at which the last scheduled sample ends. */
  get endTime() {
    return this.nextStart;
  }
  /** True while at least one scheduled buffer has not played out. */
  get active() {
    return this.sources.size > 0;
  }
};

// src/client/index.js
var inject = [];
var STATE_ROUTE = "/dsh-tts/state";
var SPEAK_ROUTE = "/dsh-tts/speak";
var SAY_EVENT = "dsc:say";
var VOICE_FLOOR_MS = 250;
var LEAD_SECONDS = 0.06;
var FIRST_CHUNK_LIMIT_MS = 1500;
var TIMEOUT = /* @__PURE__ */ Symbol("dsh-tts timeout");
function kindAllowed(lines, kind) {
  if (kind === "reaction") return lines.reactions === true;
  if (kind === "status") return lines.status === true;
  if (kind === "mutter") return lines.mutters === true;
  return lines.others === true;
}
async function readState() {
  try {
    const response = await fetch(STATE_ROUTE, { cache: "no-store" });
    if (!response.ok) return null;
    const state = await response.json();
    if (state?.enabled !== true || typeof state.pcmSampleRate !== "number") return null;
    return state;
  } catch {
    return null;
  }
}
async function readChunk(reader, deadline, controller) {
  let timer = 0;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), Math.max(0, deadline - performance.now()));
  });
  const read = reader.read().catch(() => ({ done: true, value: void 0 }));
  const result = await Promise.race([read, timeout]);
  clearTimeout(timer);
  if (result === TIMEOUT) {
    controller.abort();
    return null;
  }
  return result.done ? null : result.value;
}
async function apply(ctx) {
  const state = await readState();
  if (state === null) return;
  let audioContext = null;
  let playback = null;
  const voice = (value) => {
    try {
      window.__dsc?.voice?.(value);
    } catch {
    }
  };
  const getAudioContext = () => {
    if (audioContext !== null) return audioContext;
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (typeof Ctor !== "function") return null;
    try {
      audioContext = new Ctor();
    } catch {
      audioContext = null;
    }
    return audioContext;
  };
  function clearMeter(session) {
    if (session.frame !== 0) cancelAnimationFrame(session.frame);
    session.frame = 0;
  }
  function teardown(session) {
    clearMeter(session);
    if (session.watchdog !== 0) {
      clearTimeout(session.watchdog);
      session.watchdog = 0;
    }
    session.scheduler?.stop();
    session.scheduler = null;
    try {
      session.analyser?.disconnect();
    } catch {
    }
    session.analyser = null;
  }
  function stopPlayback() {
    const session = playback;
    if (session === null) return;
    playback = null;
    try {
      session.controller.abort();
    } catch {
    }
    teardown(session);
    voice(null);
  }
  function startMeter(session) {
    const analyser = session.analyser;
    const samples = new Float32Array(analyser.fftSize);
    const tick = () => {
      if (playback !== session) return;
      let sum = 0;
      analyser.getFloatTimeDomainData(samples);
      for (let index = 0; index < samples.length; index += 1) sum += samples[index] * samples[index];
      const level = Math.min(1, Math.sqrt(sum / samples.length) * 4);
      voice({ speaking: true, level, until: performance.now() + VOICE_FLOOR_MS });
      session.frame = requestAnimationFrame(tick);
    };
    session.frame = requestAnimationFrame(tick);
  }
  function release(session) {
    if (playback !== session) return;
    playback = null;
    teardown(session);
    voice(null);
  }
  function endStream(session) {
    if (playback !== session) return;
    const scheduler = session.scheduler;
    scheduler.onIdle = () => release(session);
    if (!scheduler.active) {
      release(session);
      return;
    }
    const remaining = Math.max(0, scheduler.endTime - session.audio.currentTime);
    session.watchdog = setTimeout(() => release(session), remaining * 1e3 + 1e3);
  }
  async function speak(detail) {
    stopPlayback();
    const text = typeof detail.text === "string" ? detail.text.trim() : "";
    if (text.length === 0) return;
    const ms = Number(detail.ms) > 0 ? Number(detail.ms) : 0;
    const startedAt = performance.now();
    const controller = new AbortController();
    const session = {
      controller,
      analyser: null,
      scheduler: null,
      audio: null,
      frame: 0,
      watchdog: 0,
      ms
    };
    playback = session;
    const deadline = startedAt + (ms > 0 ? Math.min(ms, FIRST_CHUNK_LIMIT_MS) : FIRST_CHUNK_LIMIT_MS);
    try {
      const response = await fetch(SPEAK_ROUTE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal: controller.signal
      });
      if (!response.ok || response.body === null) throw new Error("dsh-tts: speak failed with " + response.status);
      const audio = getAudioContext();
      if (audio === null) throw new Error("dsh-tts: no AudioContext");
      session.audio = audio;
      if (playback !== session) return;
      try {
        await audio.resume();
      } catch {
      }
      const analyser = audio.createAnalyser();
      analyser.fftSize = 512;
      analyser.connect(audio.destination);
      const scheduler = new ChunkScheduler({ audioContext: audio, destination: analyser, lead: LEAD_SECONDS });
      session.analyser = analyser;
      session.scheduler = scheduler;
      const reader = response.body.getReader();
      let chunk = await readChunk(reader, deadline, controller);
      if (chunk === null) throw new Error("dsh-tts: no audio before the bubble deadline");
      let rest = new Uint8Array(0);
      let metered = false;
      while (chunk !== null) {
        const split = carryOddByte(rest, chunk);
        rest = split.rest;
        if (split.aligned.length > 0) {
          scheduler.add(split.aligned, state.pcmSampleRate);
          if (!metered) {
            metered = true;
            startMeter(session);
          }
        }
        const next = await reader.read();
        chunk = next.done ? null : next.value;
      }
      scheduler.finish();
      endStream(session);
    } catch {
      if (playback === session) {
        playback = null;
        teardown(session);
        voice(null);
      }
    }
  }
  function onSay(event) {
    const detail = event?.detail;
    if (!detail || typeof detail.text !== "string") return;
    if (!kindAllowed(state.voiceLines ?? {}, detail.kind)) return;
    void speak(detail);
  }
  ctx.effect(() => {
    window.addEventListener(SAY_EVENT, onSay);
    return () => {
      window.removeEventListener(SAY_EVENT, onSay);
      stopPlayback();
      try {
        audioContext?.close();
      } catch {
      }
      audioContext = null;
    };
  }, "dsh-tts: speech playback");
}
return module.exports; } });
