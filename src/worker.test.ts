// Joue le worker comme Orca le ferait : requêtes du panneau et commandes de la palette, sur un HOME factice.
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, assert, hostError, mockHost, mountWorker, test } from 'orca/testing'
import { MESSAGES } from './copy'
import { nodeFileSystem, type FileSystem } from './installer'
import { OrcaCliError, type OrcaRunner } from './orca-cli'
import { skillFile, skillTargets } from './targets'
import { activateWith, LEDGER_BACKUP_KEY, LEDGER_KEY, LOCALE_KEY, type WorkerDeps } from './worker'

const SKILL = '---\nname: agent-network\n---\nTest skill\n'

const WORKSPACE_ID = 'identity:wt2:local:x'
const CONTEXT = { workspaceId: WORKSPACE_ID, branch: 'main', displayName: 'My workspace', terminals: [] }

/** Dossiers temporaires de chaque test, supprimés après lui. */
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** HOME factice avec les quatre harnais présents : jamais le vrai HOME. */
async function makeHome(...dirs: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-network-worker-'))
  roots.push(root)
  const home = join(root, 'home')
  await mkdir(home)
  for (const dir of dirs) await mkdir(join(home, dir), { recursive: true })
  return home
}

const ALL_HARNESSES = ['.claude', '.codex', '.grok', '.gemini/config']

const emptyFeedRunner: OrcaRunner = async (args) => (args[0] === 'terminal' ? { terminals: [] } : { messages: [] })

async function makeDeps(overrides: Partial<WorkerDeps> = {}, dirs: string[] = ALL_HARNESSES): Promise<WorkerDeps & { home: string }> {
  const home = await makeHome(...dirs)
  return { home, readSkill: async () => SKILL, fs: nodeFileSystem(), runOrca: emptyFeedRunner, ...overrides }
}

const mount = (host: ReturnType<typeof mockHost>, deps: WorkerDeps) =>
  mountWorker({ default: (orca) => activateWith(orca, deps) }, { host })

const hostWith = (results: Record<string, unknown> = {}, storage?: Record<string, never>) =>
  mockHost({ storage, results: { 'workspace.readContext': CONTEXT, ...results } })

test('network.agents maps agents.list and readContext', async () => {
  const host = hostWith({
    'agents.list': {
      agents: [
        { terminalId: 't1', title: 'Fix parser', agent: 'codex', state: 'working', stateStartedAt: 1000 },
        { terminalId: 't2', title: null, agent: null, state: 'blocked', stateStartedAt: 2000, sessionId: 's' },
        { terminalId: null, title: 'ghost', agent: 'claude', state: 'done', stateStartedAt: 3000 }
      ]
    }
  })
  const worker = await mount(host, await makeDeps())
  assert.deepEqual(await worker.request('network.agents'), {
    workspace: { name: 'My workspace' },
    agents: [
      { handle: 't1', agent: 'codex', title: 'Fix parser', state: 'working', since: 1000 },
      { handle: 't2', agent: null, title: null, state: 'blocked', since: 2000 }
    ]
  })
  await worker.deactivate()
})

test('network.agents answers with no workspace when readContext is null', async () => {
  const host = hostWith({ 'workspace.readContext': null, 'agents.list': { agents: [] } })
  const worker = await mount(host, await makeDeps())
  assert.deepEqual(await worker.request('network.agents'), { workspace: null, agents: [] })
  await worker.deactivate()
})

test('network.feed uses the focused workspace selector', async () => {
  const calls: (readonly string[])[] = []
  const runOrca: OrcaRunner = async (args) => {
    calls.push(args)
    return emptyFeedRunner(args)
  }
  const worker = await mount(hostWith(), await makeDeps({ runOrca }))
  assert.deepEqual(await worker.request('network.feed'), { items: [] })
  const terminalCall = calls.find((args) => args[0] === 'terminal')
  assert.ok(terminalCall)
  assert.deepEqual(terminalCall.slice(0, 3), ['terminal', 'list', '--worktree'])
  assert.equal(terminalCall[3], WORKSPACE_ID)
  await worker.deactivate()
})

test('network.feed labels parties with the announced language', async () => {
  const runOrca: OrcaRunner = async (args) =>
    args[0] === 'terminal'
      ? { terminals: [{ handle: 'h1', agentIdentity: 'codex' }, { handle: 'h2' }] }
      : {
          messages: [
            {
              id: 'm1',
              from_handle: 'h1',
              to_handle: 'gone',
              subject: 'Hello',
              body: 'Body',
              sequence: 1,
              created_at: '2026-11-16T10:00:00Z',
              read: 0,
              thread_id: null
            },
            {
              id: 'm2',
              from_handle: 'h2',
              to_handle: 'h1',
              subject: 'Re: Hello',
              body: 'Body',
              sequence: 2,
              created_at: '2026-11-16T10:01:00Z',
              read: 1,
              thread_id: null
            }
          ]
        }
  const worker = await mount(hostWith(), await makeDeps({ runOrca }))
  await worker.request('locale.set', { locale: 'fr-FR' })
  const result = await worker.request('network.feed')
  assert.ok('items' in result)
  const byId = Object.fromEntries(result.items.map((item) => [item.id, item]))
  assert.equal(byId.m1?.to.label, 'terminal indisponible')
  assert.equal(byId.m2?.from?.label, MESSAGES.fr.shell)
  await worker.request('locale.set', { locale: 'en-US' })
  const english = await worker.request('network.feed')
  assert.ok('items' in english)
  assert.equal(english.items.find((item) => item.id === 'm1')?.to.label, 'unavailable terminal')
  await worker.deactivate()
})

test('network.feed returns an empty feed when no workspace is focused', async () => {
  let called = false
  const runOrca: OrcaRunner = async () => {
    called = true
    return {}
  }
  const worker = await mount(hostWith({ 'workspace.readContext': { branch: 'x', displayName: 'x', terminals: [] } }), await makeDeps({ runOrca }))
  assert.deepEqual(await worker.request('network.feed'), { items: [] })
  assert.equal(called, false)
  await worker.deactivate()
})

test('network.feed returns a readable error when the CLI fails', async () => {
  const failures: [string, keyof typeof MESSAGES.fr][] = [
    ['timeout', 'feedTimeout'],
    ['spawn_failed', 'feedSpawnFailed'],
    ['bad_json', 'feedBadJson'],
    ['not_found', 'feedFailed']
  ]
  for (const [code, key] of failures) {
    const runOrca: OrcaRunner = async () => {
      throw new OrcaCliError(code, `raw ${code} detail`)
    }
    const worker = await mount(hostWith(), await makeDeps({ runOrca }))
    await worker.request('locale.set', { locale: 'fr-FR' })
    assert.deepEqual(await worker.request('network.feed'), { error: MESSAGES.fr[key] }, code)
    await worker.request('locale.set', { locale: 'en' })
    assert.deepEqual(await worker.request('network.feed'), { error: MESSAGES.en[key] }, code)
    await worker.deactivate()
  }
  // Une erreur qui n'est pas celle du CLI donne le message générique, jamais le texte brut.
  const runOrca: OrcaRunner = async () => {
    throw new Error('boom internal')
  }
  const worker = await mount(hostWith(), await makeDeps({ runOrca }))
  assert.deepEqual(await worker.request('network.feed'), { error: MESSAGES.en.feedFailed })
  await worker.deactivate()
})

test('install and uninstall commands post skill.changed', async () => {
  const deps = await makeDeps()
  const worker = await mount(hostWith(), deps)

  const installed = await worker.command('agentNetwork.installSkill')
  assert.equal(installed, 'Installed in 4 skills folders.')
  const afterInstall = worker.posts.filter((post) => post.event === 'skill.changed')
  assert.equal(afterInstall.length, 1)
  const installedTargets = (afterInstall[0]?.payload as { targets: { state: string }[] }).targets
  assert.deepEqual(installedTargets.map((target) => target.state), ['installed', 'installed', 'installed', 'installed'])
  for (const target of skillTargets(deps.home)) assert.equal(await readFile(skillFile(target), 'utf8'), SKILL)

  const removed = await worker.command('agentNetwork.uninstallSkill')
  assert.equal(removed, 'Removed from 4 skills folders.')
  const afterRemoval = worker.posts.filter((post) => post.event === 'skill.changed')
  assert.equal(afterRemoval.length, 2)
  const removedTargets = (afterRemoval[1]?.payload as { targets: { state: string }[] }).targets
  assert.deepEqual(removedTargets.map((target) => target.state), ['not-installed', 'not-installed', 'not-installed', 'not-installed'])
  await worker.deactivate()
})

test('skill.install and skill.uninstall requests return the report and post skill.changed', async () => {
  const worker = await mount(hostWith(), await makeDeps())
  const report = await worker.request('skill.install')
  assert.deepEqual(report.results.map((result) => result.outcome), ['written', 'written', 'written', 'written'])
  assert.equal(worker.posts.filter((post) => post.event === 'skill.changed').length, 1)
  const status = await worker.request('skill.status')
  assert.equal(status.error, undefined)
  assert.deepEqual(status.targets.map((target) => target.state), ['installed', 'installed', 'installed', 'installed'])
  const removal = await worker.request('skill.uninstall')
  assert.deepEqual(removal.results.map((result) => result.outcome), ['removed', 'removed', 'removed', 'removed'])
  assert.equal(worker.posts.filter((post) => post.event === 'skill.changed').length, 2)
  await worker.deactivate()
})

test('palette results count skipped, failed and absent skills folders, in French too', async () => {
  // Seul Claude est présent ; son fichier est modifié à la main, donc ignoré à la mise à jour.
  const deps = await makeDeps({}, ['.claude'])
  const worker = await mount(hostWith(), deps)
  assert.equal(await worker.command('agentNetwork.installSkill'), 'Installed in 1 skills folder. 3 skills folders not found (harness absent).')

  const claudeFile = skillFile(skillTargets(deps.home)[0]!)
  await nodeFileSystem().writeText(claudeFile, 'edited by the user')
  await worker.request('locale.set', { locale: 'fr-FR' })
  assert.equal(await worker.command('agentNetwork.installSkill'), 'Rien installé, 1 ignoré. 3 dossiers de skills sans harnais.')
  assert.equal(await worker.command('agentNetwork.uninstallSkill'), 'Rien retiré, 1 conservé (modifié).')
  await worker.deactivate()
})

test('a command never throws: an unreadable skill gives a readable sentence', async () => {
  const deps = await makeDeps({
    readSkill: async () => {
      throw new Error('ENOENT: no such file')
    }
  })
  const worker = await mount(hostWith(), deps)
  assert.equal(await worker.command('agentNetwork.installSkill'), "Couldn't install: ENOENT: no such file")
  await worker.deactivate()
})

test('the ledger survives a worker restart', async () => {
  const deps = await makeDeps()
  const host = hostWith()
  const first = await mount(host, deps)
  await first.command('agentNetwork.installSkill')
  await first.deactivate()
  assert.ok(host.data().storage[LEDGER_KEY])

  const second = await mount(host, deps)
  const status = await second.request('skill.status')
  assert.deepEqual(status.targets.map((target) => target.state), ['installed', 'installed', 'installed', 'installed'])
  const removal = await second.request('skill.uninstall')
  assert.deepEqual(removal.results.map((result) => result.outcome), ['removed', 'removed', 'removed', 'removed'])
  for (const target of skillTargets(deps.home)) assert.equal(await nodeFileSystem().exists(skillFile(target)), false)
  await second.deactivate()
})

test('a corrupt or unknown-version ledger loads as empty and is logged', async () => {
  for (const bad of ['garbage', { version: 2, entries: [] }, { version: 1, entries: [{ target: 'nope' }] }, { version: 1 }]) {
    const host = mockHost({ storage: { [LEDGER_KEY]: bad as never }, results: { 'workspace.readContext': CONTEXT } })
    const worker = await mount(host, await makeDeps())
    const status = await worker.request('skill.status')
    assert.deepEqual(status.targets.map((target) => target.state), ['not-installed', 'not-installed', 'not-installed', 'not-installed'])
    assert.ok(worker.logs.some((line) => line.startsWith('ledger invalid')), worker.logs.join('|'))
    await worker.deactivate()
  }
})

test('skill.status returns an error string instead of rejecting when the disk refuses', async () => {
  const base = nodeFileSystem()
  const fs: FileSystem = {
    ...base,
    async exists() {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }
  }
  const worker = await mount(hostWith(), await makeDeps({ fs }))
  const status = await worker.request('skill.status')
  assert.deepEqual(status.targets, [])
  assert.equal(status.error, "Couldn't read the install status: EACCES: permission denied")
  await worker.deactivate()
})

test('the last announced language wins, and any French variant is French', async () => {
  const worker = await mount(hostWith(), await makeDeps({ readSkill: async () => { throw new Error('x') } }))
  assert.equal(await worker.command('agentNetwork.installSkill'), "Couldn't install: x")
  await worker.request('locale.set', { locale: 'fr-CA' })
  assert.equal(await worker.command('agentNetwork.installSkill'), 'Installation impossible : x')
  await worker.request('locale.set', { locale: 'de-DE' })
  assert.equal(await worker.command('agentNetwork.installSkill'), "Couldn't install: x")
  await worker.deactivate()
})

test('logs the resolved orca binary once at activation', async () => {
  const worker = await mount(hostWith(), await makeDeps({ orcaBinary: '/Applications/Orca.app/Contents/Resources/bin/orca' }))
  assert.deepEqual(worker.logs.filter((line) => line.startsWith('orca binary')), ['orca binary: /Applications/Orca.app/Contents/Resources/bin/orca'])
  await worker.deactivate()
})

test('never asks for a capability outside the manifest', async () => {
  const host = hostWith({ 'agents.list': { agents: [] } })
  const worker = await mount(host, await makeDeps())
  await worker.request('locale.set', { locale: 'fr' })
  await worker.request('network.agents')
  await worker.request('network.feed')
  await worker.request('skill.status')
  await worker.request('skill.install')
  await worker.command('agentNetwork.installSkill')
  await worker.command('agentNetwork.uninstallSkill')
  await worker.request('skill.uninstall')
  assert.deepEqual(host.refusals, [])
  assert.deepEqual(worker.refusals, [])
  await worker.deactivate()
})


test('network.feed answers with a localized error when readContext fails', async () => {
  const host = hostWith({
    'workspace.readContext': () => {
      throw hostError('unavailable', 'host busy')
    }
  })
  const worker = await mount(host, await makeDeps())
  assert.deepEqual(await worker.request('network.feed'), { error: MESSAGES.en.feedFailed })
  await worker.request('locale.set', { locale: 'fr' })
  assert.deepEqual(await worker.request('network.feed'), { error: MESSAGES.fr.feedFailed })
  await worker.deactivate()
})

test('network.agents answers with the empty view when a host call fails', async () => {
  const failingList = hostWith({
    'agents.list': () => {
      throw hostError('unavailable', 'host busy')
    }
  })
  const first = await mount(failingList, await makeDeps())
  assert.deepEqual(await first.request('network.agents'), { workspace: null, agents: [] })
  assert.ok(first.logs.some((line) => line.startsWith('agents failed')), first.logs.join('|'))
  await first.deactivate()

  const failingContext = hostWith({
    'workspace.readContext': () => {
      throw hostError('unavailable', 'host busy')
    },
    'agents.list': { agents: [] }
  })
  const second = await mount(failingContext, await makeDeps())
  assert.deepEqual(await second.request('network.agents'), { workspace: null, agents: [] })
  await second.deactivate()
})

test('palette counts say skills folders, singular and plural, in both languages', () => {
  const none = { done: 0, skipped: 0, failed: 0, absent: 0 }
  assert.equal(MESSAGES.en.installResult({ ...none, done: 1, absent: 1 }), 'Installed in 1 skills folder. 1 skills folder not found (harness absent).')
  assert.equal(MESSAGES.en.installResult({ ...none, done: 2, failed: 1 }), 'Installed in 2 skills folders, 1 failed.')
  assert.equal(MESSAGES.fr.installResult({ ...none, done: 1, absent: 1 }), 'Installé dans 1 dossier de skills. 1 dossier de skills sans harnais.')
  assert.equal(MESSAGES.fr.installResult({ ...none, done: 2, skipped: 2 }), 'Installé dans 2 dossiers de skills, 2 ignorés.')
  assert.equal(MESSAGES.en.uninstallResult({ removed: 1, kept: 0, failed: 0 }), 'Removed from 1 skills folder.')
  assert.equal(MESSAGES.fr.uninstallResult({ removed: 3, kept: 0, failed: 0 }), 'Retiré de 3 dossiers de skills.')
})

test('a corrupt ledger is backed up once, files stay foreign and uninstall deletes nothing', async () => {
  const deps = await makeDeps()
  // Une installation précédente, dont le registre est ensuite perdu : les fichiers sont sur disque.
  const previous = await mount(hostWith(), deps)
  await previous.request('skill.install')
  await previous.deactivate()

  const corrupt = { version: 99, entries: [{ anything: true }] }
  const host = mockHost({ storage: { [LEDGER_KEY]: corrupt as never }, results: { 'workspace.readContext': CONTEXT } })
  const worker = await mount(host, deps)
  for (let call = 0; call < 2; call++) {
    const status = await worker.request('skill.status')
    assert.deepEqual(status.targets.map((target) => target.state), ['foreign', 'foreign', 'foreign', 'foreign'])
  }
  assert.deepEqual(host.data().storage[LEDGER_BACKUP_KEY], corrupt)
  assert.equal(worker.logs.filter((line) => line.startsWith('ledger invalid')).length, 1, worker.logs.join('|'))

  const removal = await worker.request('skill.uninstall')
  assert.deepEqual(removal.results, [])
  for (const target of skillTargets(deps.home)) assert.equal(await readFile(skillFile(target), 'utf8'), SKILL)
  assert.deepEqual(host.data().storage[LEDGER_BACKUP_KEY], corrupt)
  await worker.deactivate()
})

test('an existing ledger backup is never overwritten', async () => {
  const host = mockHost({
    storage: { [LEDGER_KEY]: 'second garbage' as never, [LEDGER_BACKUP_KEY]: 'first garbage' as never },
    results: { 'workspace.readContext': CONTEXT }
  })
  const worker = await mount(host, await makeDeps())
  await worker.request('skill.status')
  assert.equal(host.data().storage[LEDGER_BACKUP_KEY], 'first garbage')
  await worker.deactivate()
})

test('locale.set writes the storage only when the language changes', async () => {
  const host = hostWith()
  const worker = await mount(host, await makeDeps())
  const localeWrites = () => host.callsOf('storage.set').filter((params) => (params as { key: string }).key === LOCALE_KEY).length
  await worker.request('locale.set', { locale: 'fr-FR' })
  await worker.request('locale.set', { locale: 'fr-FR' })
  await worker.request('locale.set', { locale: 'fr' })
  assert.equal(localeWrites(), 1)
  await worker.request('locale.set', { locale: 'en-US' })
  assert.equal(localeWrites(), 2)
  await worker.deactivate()

  // Une langue déjà stockée n'est pas réécrite par un nouveau worker.
  const second = await mount(host, await makeDeps())
  await second.request('locale.set', { locale: 'en-GB' })
  assert.equal(localeWrites(), 2)
  await second.deactivate()
})
