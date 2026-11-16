// Les icônes livrées et la table des variantes se contrôlent dans les deux sens, contre le disque.
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assert, test } from 'orca/testing'
import { agentIcon, ICON_VARIANTS, ICONED_AGENTS, themedIcon } from './icons'

const root = fileURLToPath(new URL('../', import.meta.url))

test('every declared icon and variant exists on disk', () => {
  for (const id of ICONED_AGENTS) assert.ok(existsSync(join(root, 'agent-icons', `${id}.png`)), id)
  for (const scheme of ['light', 'dark'] as const) {
    for (const base of ICON_VARIANTS[scheme]) {
      assert.ok(existsSync(join(root, base)), base)
      assert.ok(existsSync(join(root, themedIcon(base, scheme))), themedIcon(base, scheme))
    }
  }
})

test('every shipped icon file is declared', async () => {
  const baseFiles = (await readdir(join(root, 'agent-icons'))).filter((name) => name.endsWith('.png')).sort()
  assert.deepEqual(baseFiles, [...ICONED_AGENTS].map((id) => `${id}.png`).sort())
  for (const scheme of ['light', 'dark'] as const) {
    const dir = join(root, 'agent-icons', `on-${scheme}`)
    const shipped = existsSync(dir) ? (await readdir(dir)).sort() : []
    const declared = ICON_VARIANTS[scheme].map((path) => path.slice(path.lastIndexOf('/') + 1)).sort()
    assert.deepEqual(shipped, declared, `on-${scheme}`)
  }
})

test('an agent without a shipped icon has none, so the panel draws a monogram', () => {
  assert.equal(agentIcon('kimi', 'dark'), null)
  assert.equal(agentIcon(null, 'dark'), null)
  assert.equal(agentIcon('codex', 'light'), 'agent-icons/on-light/codex.png')
  assert.equal(agentIcon('codex', 'dark'), 'agent-icons/codex.png')
})
