/**
 * In-memory LRU + TTL cache for synthesized PCM.
 *
 * Keyed by sha256(model \0 voice \0 text): a voice line is a pure function of
 * those three, so one entry serves every repeat. Bounded by both entry count
 * and total bytes, and a hit refreshes recency. Nothing is written to disk.
 * @module dsh-tts/cache
 */
import { createHash } from 'node:crypto'

/**
 * Build the cache key for one synthesized line.
 * @param model - configured TTS model id.
 * @param voice - configured voice id.
 * @param text - exact input text.
 * @returns lowercase sha256 hex digest.
 */
export function cacheKey(model, voice, text, extra = '') {
  return createHash('sha256').update(model + '\u0000' + voice + '\u0000' + text + '\u0000' + extra).digest('hex')
}

/**
 * Create one bounded cache.
 * @param options - cache config (enabled, maxEntries, ttlMs, maxCacheBytes) plus
 *   an injectable now() for tests.
 * @returns get/set/clear over Buffers, oldest entry evicted first.
 */
export function createCache(options = {}) {
  const enabled = options.enabled !== false
  const maxEntries = options.maxEntries ?? 200
  const ttlMs = options.ttlMs ?? 604800000
  const maxBytes = options.maxCacheBytes ?? 33554432
  const now = options.now ?? Date.now
  const entries = new Map()
  let bytes = 0

  const drop = (key) => {
    const entry = entries.get(key)
    if (entry === undefined) return
    entries.delete(key)
    bytes -= entry.data.length
  }

  return {
    enabled,
    /** Return cached PCM, or null on a miss/expiry. */
    get(key) {
      const entry = entries.get(key)
      if (entry === undefined) return null
      if (entry.expires <= now()) {
        drop(key)
        return null
      }
      entries.delete(key)
      entries.set(key, entry)
      return entry.data
    },
    /** Store PCM; oversized payloads are skipped rather than evicting everything. */
    set(key, data) {
      if (!enabled || maxEntries === 0 || data.length > maxBytes) return false
      drop(key)
      entries.set(key, { data, expires: now() + ttlMs })
      bytes += data.length
      while (entries.size > maxEntries || bytes > maxBytes) {
        const oldest = entries.keys().next().value
        if (oldest === undefined) break
        drop(oldest)
      }
      return true
    },
    clear() {
      entries.clear()
      bytes = 0
    },
    get size() {
      return entries.size
    },
    get bytes() {
      return bytes
    },
  }
}
