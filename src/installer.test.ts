// Joue l'installateur sur de vrais dossiers temporaires (HOME factice) : jamais le vrai HOME.
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, test } from 'orca/testing'
import {
  installSkill,
  nodeFileSystem,
  readStatus,
  uninstallSkill,
  type FileSystem,
  type Ledger,
  type LedgerStore
} from './installer'
import { skillFile, skillTargets, type TargetId } from './targets'

const SKILL_A = '---\nname: agent-network\n---\nVersion A\n'
const SKILL_B = '---\nname: agent-network\n---\nVersion B\n'

const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Registre en mémoire qui sérialise en JSON à chaque `save`, comme le stockage d'Orca. */
function memoryStore(initialJson: string | null = null): { store: LedgerStore; json: () => string | null } {
  let json = initialJson
  return {
    store: {
      async load(): Promise<Ledger> {
        return json === null ? { version: 1, entries: [] } : (JSON.parse(json) as Ledger)
      },
      async save(ledger: Ledger): Promise<void> {
        json = JSON.stringify(ledger)
      }
    },
    json: () => json
  }
}

/** Dossiers temporaires de chaque test, supprimés après lui. */
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Crée un HOME factice contenant les dossiers donnés (chemins relatifs). */
async function makeHome(...dirs: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-network-test-'))
  roots.push(root)
  const home = join(root, 'home')
  await mkdir(home)
  for (const dir of dirs) await mkdir(join(home, dir), { recursive: true })
  return home
}

/** Dossier hors HOME, pour les contenus tiers que l'installateur ne doit jamais toucher. */
async function makeOutside(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-network-outside-'))
  roots.push(dir)
  return dir
}

const fileOf = (home: string, id: TargetId): string => {
  const target = skillTargets(home).find((candidate) => candidate.id === id)
  if (!target) throw new Error(`unknown target ${id}`)
  return skillFile(target)
}

const resultOf = <T extends { target: TargetId }>(results: T[], id: TargetId): T => {
  const found = results.find((result) => result.target === id)
  if (!found) throw new Error(`no result for ${id}`)
  return found
}

/** Relevé complet d'une arborescence : chemin relatif vers contenu (`dir` pour un dossier, `link` pour un lien). */
async function snapshot(root: string, current = root, into: Record<string, string> = {}): Promise<Record<string, string>> {
  for (const name of (await readdir(current)).sort()) {
    const path = join(current, name)
    const relative = path.slice(root.length)
    const info = await lstat(path)
    if (info.isSymbolicLink()) into[relative] = 'link'
    else if (info.isDirectory()) {
      into[relative] = 'dir'
      await snapshot(root, path, into)
    } else into[relative] = await readFile(path, 'utf8')
  }
  return into
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

test('writes the skill into every present harness and records it', async () => {
  const home = await makeHome('.claude', '.codex', '.grok', '.gemini/config')
  const { store } = memoryStore()
  const report = await installSkill(home, SKILL_A, nodeFileSystem(), store)
  assert.deepEqual(
    report.results.map((result) => result.outcome),
    ['written', 'written', 'written', 'written']
  )
  const ledger = await store.load()
  assert.equal(ledger.entries.length, 4)
  for (const target of skillTargets(home)) {
    assert.equal(await readFile(skillFile(target), 'utf8'), SKILL_A)
    const entry = ledger.entries.find((candidate) => candidate.target === target.id)
    assert.ok(entry, `entry for ${target.id}`)
    assert.equal(entry.file, skillFile(target))
    assert.equal(entry.sha256, sha(SKILL_A))
  }
})

test('reports an absent harness without creating its folder', async () => {
  const home = await makeHome('.claude')
  const { store } = memoryStore()
  const report = await installSkill(home, SKILL_A, nodeFileSystem(), store)
  assert.equal(resultOf(report.results, 'claude').outcome, 'written')
  for (const id of ['shared', 'grok', 'antigravity'] as const) assert.equal(resultOf(report.results, id).outcome, 'absent-harness')
  assert.equal(await exists(join(home, '.grok')), false)
  assert.equal(await exists(join(home, '.agents')), false)
  assert.equal(await exists(join(home, '.gemini')), false)
  assert.equal((await store.load()).entries.length, 1)
})

test('is idempotent', async () => {
  const home = await makeHome('.claude', '.codex', '.grok', '.gemini/config')
  const { store } = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), store)
  const before = await Promise.all(skillTargets(home).map(async (target) => (await stat(skillFile(target))).mtimeMs))
  await pause()
  const second = await installSkill(home, SKILL_A, nodeFileSystem(), store)
  assert.deepEqual(
    second.results.map((result) => result.outcome),
    ['unchanged', 'unchanged', 'unchanged', 'unchanged']
  )
  const after = await Promise.all(skillTargets(home).map(async (target) => (await stat(skillFile(target))).mtimeMs))
  assert.deepEqual(after, before)
})

test('updates an unmodified file when the bundled skill changes', async () => {
  const home = await makeHome('.claude')
  const { store } = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), store)
  const report = await installSkill(home, SKILL_B, nodeFileSystem(), store)
  assert.equal(resultOf(report.results, 'claude').outcome, 'updated')
  assert.equal(await readFile(fileOf(home, 'claude'), 'utf8'), SKILL_B)
  const ledger = await store.load()
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.entries[0].sha256, sha(SKILL_B))
})

test('never overwrites or removes a file the user modified', async () => {
  const home = await makeHome('.claude')
  const { store } = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), store)
  const file = fileOf(home, 'claude')
  await writeFile(file, 'my own edits\n', 'utf8')
  const reinstall = await installSkill(home, SKILL_B, nodeFileSystem(), store)
  assert.equal(resultOf(reinstall.results, 'claude').outcome, 'skipped-modified')
  assert.equal(await readFile(file, 'utf8'), 'my own edits\n')
  const uninstall = await uninstallSkill(home, nodeFileSystem(), store)
  assert.equal(resultOf(uninstall.results, 'claude').outcome, 'kept-modified')
  assert.equal(await readFile(file, 'utf8'), 'my own edits\n')
  const ledger = await store.load()
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.entries[0].sha256, sha(SKILL_A))
})

test('never touches a foreign agent-network folder or symlink', async () => {
  const home = await makeHome('.claude/skills', '.grok/skills/agent-network')
  const outside = await makeOutside()
  const thirdParty = join(outside, 'third-party-skill')
  await mkdir(thirdParty)
  await writeFile(join(thirdParty, 'SKILL.md'), 'third party skill\n', 'utf8')
  await symlink(thirdParty, join(home, '.claude', 'skills', 'agent-network'))
  const grokFile = fileOf(home, 'grok')
  await writeFile(grokFile, 'foreign grok skill\n', 'utf8')
  const outsideBefore = await snapshot(outside)

  const { store } = memoryStore()
  const report = await installSkill(home, SKILL_A, nodeFileSystem(), store)
  assert.equal(resultOf(report.results, 'claude').outcome, 'skipped-foreign')
  assert.equal(resultOf(report.results, 'grok').outcome, 'skipped-foreign')
  assert.deepEqual(await snapshot(outside), outsideBefore)
  assert.equal(await readFile(grokFile, 'utf8'), 'foreign grok skill\n')
  assert.ok((await lstat(join(home, '.claude', 'skills', 'agent-network'))).isSymbolicLink())
  assert.equal((await store.load()).entries.length, 0)

  const status = await readStatus(home, SKILL_A, nodeFileSystem(), store)
  assert.equal(status.find((item) => item.target === 'claude')?.state, 'foreign')
  assert.equal(status.find((item) => item.target === 'grok')?.state, 'foreign')

  // Sans entrée de registre, la désinstallation n'a rien à retirer : les contenus tiers restent.
  const uninstall = await uninstallSkill(home, nodeFileSystem(), store)
  assert.equal(uninstall.results.length, 0)
  assert.equal(await readFile(grokFile, 'utf8'), 'foreign grok skill\n')
  assert.deepEqual(await snapshot(outside), outsideBefore)
})

test('uninstall leaves the home exactly as before install', async () => {
  const home = await makeHome('.claude', '.codex', '.grok/notes', '.gemini/config')
  await writeFile(join(home, '.claude', 'settings.json'), '{"keep":true}\n', 'utf8')
  await writeFile(join(home, '.grok', 'notes', 'todo.txt'), 'todo\n', 'utf8')
  const before = await snapshot(home)
  const { store } = memoryStore()
  const install = await installSkill(home, SKILL_A, nodeFileSystem(), store)
  assert.deepEqual(
    install.results.map((result) => result.outcome),
    ['written', 'written', 'written', 'written']
  )
  assert.notDeepEqual(await snapshot(home), before)
  const uninstall = await uninstallSkill(home, nodeFileSystem(), store)
  assert.deepEqual(
    uninstall.results.map((result) => result.outcome),
    ['removed', 'removed', 'removed', 'removed']
  )
  assert.deepEqual(await snapshot(home), before)
  assert.deepEqual((await store.load()).entries, [])
})

test('uninstall works from a reloaded ledger', async () => {
  const home = await makeHome('.claude', '.codex', '.grok', '.gemini/config')
  const first = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), first.store)
  const saved = first.json()
  assert.ok(saved !== null)
  const reloaded = memoryStore(saved)
  const uninstall = await uninstallSkill(home, nodeFileSystem(), reloaded.store)
  assert.deepEqual(
    uninstall.results.map((result) => result.outcome),
    ['removed', 'removed', 'removed', 'removed']
  )
  for (const target of skillTargets(home)) assert.equal(await exists(skillFile(target)), false)
  assert.deepEqual((await reloaded.store.load()).entries, [])
})

test('keeps a created folder that now holds a user file', async () => {
  const home = await makeHome('.codex')
  const { store } = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), store)
  const folder = join(home, '.agents', 'skills', 'agent-network')
  await writeFile(join(folder, 'notes.md'), 'user notes\n', 'utf8')
  const uninstall = await uninstallSkill(home, nodeFileSystem(), store)
  assert.equal(resultOf(uninstall.results, 'shared').outcome, 'removed')
  assert.equal(await exists(join(folder, 'SKILL.md')), false)
  assert.equal(await readFile(join(folder, 'notes.md'), 'utf8'), 'user notes\n')
  assert.deepEqual((await store.load()).entries, [])
})

test('readStatus reflects every state', async () => {
  const home = await makeHome('.claude', '.codex', '.grok')
  const { store } = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), store)
  await writeFile(fileOf(home, 'grok'), 'edited by hand\n', 'utf8')

  const current = await readStatus(home, SKILL_A, nodeFileSystem(), store)
  assert.deepEqual(
    current.map((item) => [item.target, item.state]),
    [
      ['claude', 'installed'],
      ['shared', 'installed'],
      ['grok', 'modified'],
      ['antigravity', 'absent-harness']
    ]
  )
  assert.deepEqual(current.find((item) => item.target === 'shared')?.harnesses, ['codex', 'dsh'])
  assert.equal(current.find((item) => item.target === 'claude')?.file, fileOf(home, 'claude'))

  const newer = await readStatus(home, SKILL_B, nodeFileSystem(), store)
  assert.equal(newer.find((item) => item.target === 'claude')?.state, 'outdated')

  const fresh = await makeHome('.claude', '.grok/skills/agent-network')
  await writeFile(fileOf(fresh, 'grok'), 'foreign\n', 'utf8')
  const empty = memoryStore()
  const untouched = await readStatus(fresh, SKILL_A, nodeFileSystem(), empty.store)
  assert.equal(untouched.find((item) => item.target === 'claude')?.state, 'not-installed')
  assert.equal(untouched.find((item) => item.target === 'grok')?.state, 'foreign')
})

test('an I/O error on one target does not stop the others', async () => {
  const home = await makeHome('.claude', '.codex', '.grok')
  const real = nodeFileSystem()
  const failing: FileSystem = {
    ...real,
    async writeText(path, text) {
      if (path.includes('.agents')) throw new Error('disk full')
      return real.writeText(path, text)
    }
  }
  const { store } = memoryStore()
  const report = await installSkill(home, SKILL_A, failing, store)
  assert.equal(resultOf(report.results, 'claude').outcome, 'written')
  const shared = resultOf(report.results, 'shared')
  assert.equal(shared.outcome, 'failed')
  assert.equal(shared.error, 'disk full')
  assert.equal(resultOf(report.results, 'grok').outcome, 'written')
  // Le dossier créé pour la cible en échec est retiré : le HOME ne garde aucun résidu.
  assert.equal(await exists(join(home, '.agents')), false)
  const ledger = await store.load()
  assert.deepEqual(ledger.entries.map((entry) => entry.target).sort(), ['claude', 'grok'])
})

test('rewrites a recorded file that went missing and drops it on uninstall', async () => {
  const home = await makeHome('.codex')
  const { store } = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), store)
  const file = fileOf(home, 'shared')
  await rm(file)
  const rewrite = await installSkill(home, SKILL_A, nodeFileSystem(), store)
  assert.equal(resultOf(rewrite.results, 'shared').outcome, 'written')
  assert.equal(await readFile(file, 'utf8'), SKILL_A)

  await rm(file)
  const uninstall = await uninstallSkill(home, nodeFileSystem(), store)
  assert.equal(resultOf(uninstall.results, 'shared').outcome, 'not-installed')
  assert.deepEqual((await store.load()).entries, [])
  assert.equal(await exists(join(home, '.agents')), false)
})

test('never removes a ledger entry file outside its own target', async () => {
  const home = await makeHome('.claude')
  const outside = await makeOutside()
  const victim = join(outside, 'victim.txt')
  await writeFile(victim, 'keep me\n', 'utf8')
  const forged = memoryStore(
    JSON.stringify({ version: 1, entries: [{ target: 'claude', file: victim, sha256: sha('keep me\n'), createdDirs: [outside] }] })
  )
  const uninstall = await uninstallSkill(home, nodeFileSystem(), forged.store)
  assert.equal(resultOf(uninstall.results, 'claude').outcome, 'failed')
  assert.equal(await readFile(victim, 'utf8'), 'keep me\n')
})
