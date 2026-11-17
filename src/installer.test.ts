// Joue l'installateur sur de vrais dossiers temporaires (HOME factice) : jamais le vrai HOME.
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
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

/**
 * Registre en mémoire qui sérialise en JSON à chaque `save`, comme le stockage d'Orca.
 * `failSaveAfter` : nombre de sauvegardes réussies avant que les suivantes lèvent une erreur.
 * `slow` : cède la main à chaque accès, pour que deux opérations concurrentes s'entrelacent vraiment.
 */
function memoryStore(
  initialJson: string | null = null,
  options: { failSaveAfter?: number; slow?: boolean } = {}
): { store: LedgerStore; json: () => string | null } {
  let json = initialJson
  let saves = 0
  const yieldTurn = () => (options.slow ? new Promise((resolve) => setTimeout(resolve, 2)) : Promise.resolve())
  return {
    store: {
      async load(): Promise<Ledger> {
        await yieldTurn()
        return json === null ? { version: 1, entries: [] } : (JSON.parse(json) as Ledger)
      },
      async save(ledger: Ledger): Promise<void> {
        await yieldTurn()
        saves += 1
        if (options.failSaveAfter !== undefined && saves > options.failSaveAfter) throw new Error('storage down')
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

test('Pi or OpenCode alone is enough to install the shared skills folder', async () => {
  for (const marker of ['.pi', '.config/opencode']) {
    const home = await makeHome(marker)
    const { store } = memoryStore()
    const report = await installSkill(home, SKILL_A, nodeFileSystem(), store)
    assert.equal(resultOf(report.results, 'shared').outcome, 'written', marker)
    assert.equal(await readFile(join(home, '.agents', 'skills', 'agent-network', 'SKILL.md'), 'utf8'), SKILL_A)
  }
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
  assert.deepEqual(current.find((item) => item.target === 'shared')?.harnesses, ['codex', 'dsh', 'opencode', 'pi'])
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

// --- Fix round 1 -----------------------------------------------------------------------------------------------

test('I-1: a skills folder turned into a symlink after install is never followed, and uninstall is not stuck', async () => {
  const home = await makeHome('.claude')
  const outside = await makeOutside()
  const { store } = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), store)
  const moved = join(outside, 'skills')
  await rename(join(home, '.claude', 'skills'), moved)
  await symlink(moved, join(home, '.claude', 'skills'))
  const outsideBefore = await snapshot(outside)

  const status = await readStatus(home, SKILL_A, nodeFileSystem(), store)
  assert.equal(status.find((item) => item.target === 'claude')?.state, 'foreign')
  for (let round = 0; round < 2; round += 1) {
    const uninstall = await uninstallSkill(home, nodeFileSystem(), store)
    assert.equal(resultOf(uninstall.results, 'claude').outcome, 'kept-modified')
    assert.deepEqual(await snapshot(outside), outsideBefore)
    assert.equal((await store.load()).entries.length, 1)
  }
  const reinstall = await installSkill(home, SKILL_B, nodeFileSystem(), store)
  assert.equal(resultOf(reinstall.results, 'claude').outcome, 'skipped-foreign')
  assert.deepEqual(await snapshot(outside), outsideBefore)
})

test('I-1: a created ancestor folder turned into a symlink is never followed', async () => {
  const home = await makeHome('.codex')
  const outside = await makeOutside()
  const { store } = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), store)
  const moved = join(outside, 'agents')
  await rename(join(home, '.agents'), moved)
  await symlink(moved, join(home, '.agents'))
  const outsideBefore = await snapshot(outside)

  const uninstall = await uninstallSkill(home, nodeFileSystem(), store)
  assert.equal(resultOf(uninstall.results, 'shared').outcome, 'kept-modified')
  assert.deepEqual(await snapshot(outside), outsideBefore)
  assert.equal((await store.load()).entries.length, 1)
})

test('I-1: removeEmptyDir treats a symlink or a file in place of a folder as not removable', async () => {
  const root = await makeOutside()
  const real = join(root, 'real')
  await mkdir(real)
  await symlink(real, join(root, 'link'))
  await writeFile(join(root, 'file'), 'x', 'utf8')
  const fs = nodeFileSystem()
  assert.equal(await fs.removeEmptyDir(join(root, 'link')), false)
  assert.equal(await fs.removeEmptyDir(join(root, 'file', 'below')), false)
  assert.equal(await fs.removeEmptyDir(real), true)
})

test('I-2: two concurrent installs end with a complete ledger and every file installed', async () => {
  const home = await makeHome('.claude', '.grok')
  const { store } = memoryStore(null, { slow: true })
  await Promise.all([
    installSkill(home, SKILL_A, nodeFileSystem(), store),
    installSkill(home, SKILL_A, nodeFileSystem(), store)
  ])
  assert.equal((await store.load()).entries.length, 2)
  const status = await readStatus(home, SKILL_A, nodeFileSystem(), store)
  assert.deepEqual(
    status.map((item) => item.state),
    ['installed', 'absent-harness', 'installed', 'absent-harness']
  )
})

test('I-2: a failing operation does not break the queue', async () => {
  const home = await makeHome('.claude')
  const broken: LedgerStore = {
    async load() {
      throw new Error('storage unreadable')
    },
    async save() {}
  }
  const { store } = memoryStore()
  const [first, second] = await Promise.allSettled([
    installSkill(home, SKILL_A, nodeFileSystem(), broken),
    installSkill(home, SKILL_A, nodeFileSystem(), store)
  ])
  assert.equal(first.status, 'rejected')
  assert.equal(second.status, 'fulfilled')
  assert.equal((await store.load()).entries.length, 1)
})

test('M-1: forged createdDirs outside HOME, or not above the file, are ignored and never deleted', async () => {
  const home = await makeHome('.claude', 'unrelated-empty')
  const outside = await makeOutside()
  const victim = join(outside, 'victim-empty')
  await mkdir(victim)
  const first = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), first.store)
  const ledger = JSON.parse(first.json() ?? '') as Ledger
  ledger.entries[0].createdDirs.unshift(`${home}/../${outside.split('/').pop()}/victim-empty`, join(home, 'unrelated-empty'), home)
  const forged = memoryStore(JSON.stringify(ledger))
  const uninstall = await uninstallSkill(home, nodeFileSystem(), forged.store)
  assert.equal(resultOf(uninstall.results, 'claude').outcome, 'removed')
  assert.equal(await exists(victim), true)
  assert.equal(await exists(join(home, 'unrelated-empty')), true)
  assert.equal(await exists(home), true)
})

test('M-2: a failed ledger save after a fresh write removes the file and the folders created', async () => {
  const home = await makeHome('.codex')
  const before = await snapshot(home)
  const { store } = memoryStore(null, { failSaveAfter: 0 })
  const report = await installSkill(home, SKILL_A, nodeFileSystem(), store)
  const shared = resultOf(report.results, 'shared')
  assert.equal(shared.outcome, 'failed')
  assert.equal(shared.error, 'storage down')
  assert.deepEqual(await snapshot(home), before)
})

test('M-2: a failed ledger save after an update puts the previous text back, disk and ledger still agree', async () => {
  const home = await makeHome('.claude')
  const first = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), first.store)
  const failing = memoryStore(first.json(), { failSaveAfter: 0 })
  const report = await installSkill(home, SKILL_B, nodeFileSystem(), failing.store)
  assert.equal(resultOf(report.results, 'claude').outcome, 'failed')
  assert.equal(await readFile(fileOf(home, 'claude'), 'utf8'), SKILL_A)
  const status = await readStatus(home, SKILL_A, nodeFileSystem(), memoryStore(first.json()).store)
  assert.equal(status.find((item) => item.target === 'claude')?.state, 'installed')
})

test('M-3: a recorded SKILL.md replaced by a dangling symlink is foreign: nothing is created outside HOME', async () => {
  const home = await makeHome('.claude')
  const outside = await makeOutside()
  const { store } = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), store)
  const file = fileOf(home, 'claude')
  await rm(file)
  const dangling = join(outside, 'elsewhere.md')
  await symlink(dangling, file)

  const status = await readStatus(home, SKILL_A, nodeFileSystem(), store)
  assert.equal(status.find((item) => item.target === 'claude')?.state, 'foreign')
  const install = await installSkill(home, SKILL_A, nodeFileSystem(), store)
  assert.equal(resultOf(install.results, 'claude').outcome, 'skipped-foreign')
  assert.equal(await exists(dangling), false)
  assert.ok((await lstat(file)).isSymbolicLink())
  const uninstall = await uninstallSkill(home, nodeFileSystem(), store)
  assert.equal(resultOf(uninstall.results, 'claude').outcome, 'kept-modified')
  assert.ok((await lstat(file)).isSymbolicLink())
  assert.equal((await store.load()).entries.length, 1)
})

test('M-3: a recorded SKILL.md replaced by a symlink to identical content is kept on uninstall', async () => {
  const home = await makeHome('.claude')
  const outside = await makeOutside()
  const { store } = memoryStore()
  await installSkill(home, SKILL_A, nodeFileSystem(), store)
  const file = fileOf(home, 'claude')
  const copy = join(outside, 'copy.md')
  await rename(file, copy)
  await symlink(copy, file)
  const uninstall = await uninstallSkill(home, nodeFileSystem(), store)
  assert.equal(resultOf(uninstall.results, 'claude').outcome, 'kept-modified')
  assert.ok((await lstat(file)).isSymbolicLink())
  assert.equal(await readFile(copy, 'utf8'), SKILL_A)
})
