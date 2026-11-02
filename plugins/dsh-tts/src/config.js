/**
 * Config defaults and validation for dsh-tts (CONTRACT §5).
 *
 * A bad value is refused when the plugin activates, naming the exact field:
 * a broken baseUrl or model id cannot be repaired at request time. Unknown
 * keys are ignored so a profile written for a newer version still boots.
 * @module dsh-tts/config
 */

/** Defaults, exactly as documented in cordis.patch.yml. */
export const DEFAULTS = {
  enabled: false,
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'alloy', speed: 1, apiKeyEnv: 'OPENAI_API_KEY', headers: {}, timeoutMs: 30000 },
  stream: { enabled: true, pcmSampleRate: 24000 },
  voiceLines: { reactions: true, status: false, mutters: false, others: true },
  cache: { enabled: true, maxEntries: 200, ttlMs: 604800000, maxCacheBytes: 33554432 },
  limits: { maxCharsPerLine: 300, maxBytes: 16777216 },
}

/** Throw one error naming the config path, the expectation and the value. */
function fail(path, expected, value) {
  throw new Error('dsh-tts: config.' + path + ' must be ' + expected + ', got ' + JSON.stringify(value ?? null))
}

/** Read an optional nested config section; null and arrays are refused. */
function section(source, key) {
  const value = source[key]
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(key, 'an object', value)
  return value
}

function bool(source, key, path, fallback) {
  const value = source[key]
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(path, 'a boolean', value)
  return value
}

function text(source, key, path, fallback, { url = false } = {}) {
  const value = source[key]
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== 'string' || resolved.trim().length === 0) fail(path, 'a non-empty string', resolved)
  const trimmed = resolved.trim()
  if (url) {
    let parsed
    try {
      parsed = new URL(trimmed)
    } catch {
      fail(path, 'an absolute http(s) URL', trimmed)
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(path, 'an http(s) URL', trimmed)
  }
  return url ? trimmed.replace(/\/+$/, '') : trimmed
}

function num(source, key, path, fallback, min, max, { integer = false, exclusiveMin = false } = {}) {
  const value = source[key]
  const resolved = value === undefined ? fallback : value
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved > max
    || (exclusiveMin ? resolved <= min : resolved < min) || (integer && !Number.isInteger(resolved))) {
    fail(path, 'a number in ' + (exclusiveMin ? '(' : '[') + min + ', ' + max + ']', resolved)
  }
  return resolved
}

function stringMap(source, key, path) {
  const value = source[key]
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'an object of string values', value)
  const out = {}
  for (const [name, entry] of Object.entries(value)) {
    if (name.trim().length === 0) fail(path, 'an object with non-empty keys', value)
    if (typeof entry !== 'string') fail(path + '.' + name, 'a string', entry)
    out[name] = entry
  }
  return out
}

/**
 * Validate and normalize the Loader-row config.
 * @param raw - raw config from cordis.patch.yml, possibly undefined.
 * @returns the normalized config: every field present, unknown keys dropped.
 */
export function normalize(raw) {
  const source = raw ?? {}
  if (typeof source !== 'object' || Array.isArray(source)) fail('config', 'an object', source)
  const openai = section(source, 'openai')
  const stream = section(source, 'stream')
  const lines = section(source, 'voiceLines')
  const cache = section(source, 'cache')
  const limits = section(source, 'limits')
  return {
    enabled: bool(source, 'enabled', 'enabled', DEFAULTS.enabled),
    openai: {
      baseUrl: text(openai, 'baseUrl', 'openai.baseUrl', DEFAULTS.openai.baseUrl, { url: true }),
      model: text(openai, 'model', 'openai.model', DEFAULTS.openai.model),
      voice: text(openai, 'voice', 'openai.voice', DEFAULTS.openai.voice),
      speed: num(openai, 'speed', 'openai.speed', DEFAULTS.openai.speed, 0.25, 4),
      apiKeyEnv: text(openai, 'apiKeyEnv', 'openai.apiKeyEnv', DEFAULTS.openai.apiKeyEnv),
      headers: stringMap(openai, 'headers', 'openai.headers'),
      timeoutMs: num(openai, 'timeoutMs', 'openai.timeoutMs', DEFAULTS.openai.timeoutMs, 1000, 600000, { integer: true }),
    },
    stream: {
      enabled: bool(stream, 'enabled', 'stream.enabled', DEFAULTS.stream.enabled),
      pcmSampleRate: num(stream, 'pcmSampleRate', 'stream.pcmSampleRate', DEFAULTS.stream.pcmSampleRate, 8000, 48000, { integer: true }),
    },
    voiceLines: {
      reactions: bool(lines, 'reactions', 'voiceLines.reactions', DEFAULTS.voiceLines.reactions),
      status: bool(lines, 'status', 'voiceLines.status', DEFAULTS.voiceLines.status),
      mutters: bool(lines, 'mutters', 'voiceLines.mutters', DEFAULTS.voiceLines.mutters),
      others: bool(lines, 'others', 'voiceLines.others', DEFAULTS.voiceLines.others),
    },
    cache: {
      enabled: bool(cache, 'enabled', 'cache.enabled', DEFAULTS.cache.enabled),
      maxEntries: num(cache, 'maxEntries', 'cache.maxEntries', DEFAULTS.cache.maxEntries, 0, 100000, { integer: true }),
      ttlMs: num(cache, 'ttlMs', 'cache.ttlMs', DEFAULTS.cache.ttlMs, 0, 31536000000),
      maxCacheBytes: num(cache, 'maxCacheBytes', 'cache.maxCacheBytes', DEFAULTS.cache.maxCacheBytes, 0, Number.MAX_SAFE_INTEGER, { integer: true }),
    },
    limits: {
      maxCharsPerLine: num(limits, 'maxCharsPerLine', 'limits.maxCharsPerLine', DEFAULTS.limits.maxCharsPerLine, 1, 100000, { integer: true }),
      maxBytes: num(limits, 'maxBytes', 'limits.maxBytes', DEFAULTS.limits.maxBytes, 1024, Number.MAX_SAFE_INTEGER, { integer: true }),
    },
  }
}
