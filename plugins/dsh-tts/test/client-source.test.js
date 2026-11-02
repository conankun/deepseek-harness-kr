import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The character dispatches "dsc:say" on window; a document listener would
// never fire, because an event dispatched on window does not propagate to
// document. Keep the two halves pinned to the same target.
const source = readFileSync(new URL('../src/client/index.js', import.meta.url), 'utf8')

test('client listens for dsc:say on window', () => {
  assert.match(source, /window\.addEventListener\(SAY_EVENT, onSay\)/)
  assert.match(source, /window\.removeEventListener\(SAY_EVENT, onSay\)/)
  assert.doesNotMatch(source, /document\.(add|remove)EventListener\(SAY_EVENT/)
})
