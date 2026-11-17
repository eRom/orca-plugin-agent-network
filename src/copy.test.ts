// L'abréviation d'un handle de terminal pour l'infobulle : les limites se contrôlent des deux côtés.
import { assert, test } from 'orca/testing'
import { harnessName, harnessShortName, shortHandle } from './copy'

test('Pi and OpenCode keep their full name, even on narrow rows', () => {
  assert.equal(harnessName('pi'), 'Pi')
  assert.equal(harnessName('opencode'), 'OpenCode')
  assert.equal(harnessShortName('pi'), 'Pi')
  assert.equal(harnessShortName('opencode'), 'OpenCode')
  assert.equal(harnessShortName('dsh-tui'), 'DSH')
  assert.equal(harnessShortName('codex'), 'Codex')
})

test('a short handle is shown as is', () => {
  assert.equal(shortHandle('term_claude'), 'term_claude')
})

test('a long terminal handle keeps the prefix and its last six characters', () => {
  assert.equal(shortHandle('term_27a740ab-0791-4705-9353-a9e72a5da274'), 'term_…5da274')
})

test('eight characters after the prefix are kept, nine are shortened', () => {
  assert.equal(shortHandle('term_12345678'), 'term_12345678')
  assert.equal(shortHandle('term_123456789'), 'term_…456789')
})

test('a handle without the term_ prefix is never shortened', () => {
  assert.equal(shortHandle('abc_27a740ab-0791-4705'), 'abc_27a740ab-0791-4705')
})
