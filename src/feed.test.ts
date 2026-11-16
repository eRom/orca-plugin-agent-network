// Joue le fil de messages sur des données fabriquées et sur l'échantillon réel capturé avec `orca orchestration inbox`.
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, assert, test } from 'orca/testing'
import { buildFeed, fetchFeed, type CliMessage, type CliTerminal } from './feed'
import { createOrcaRunner, OrcaCliError, resolveOrcaBinary, type OrcaRunner } from './orca-cli'

const message = (overrides: Partial<CliMessage> & { sequence: number }): CliMessage => ({
  id: `msg_${overrides.sequence}`,
  from_handle: 'term_a',
  to_handle: 'term_b',
  subject: 'Hello',
  body: 'Body',
  created_at: '2026-11-16T10:00:00Z',
  read: 0,
  thread_id: null,
  ...overrides
})

const TERMINALS: CliTerminal[] = [
  { handle: 'term_a', title: 'Fix parser', agentIdentity: 'codex' },
  { handle: 'term_b', title: 'zsh' },
  { handle: 'term_c', title: 'Review', agentIdentity: 'claude' }
]

test('keeps only messages touching this workspace', () => {
  const messages = [
    message({ sequence: 1, from_handle: 'term_a', to_handle: 'term_b' }),
    message({ sequence: 2, from_handle: 'term_x', to_handle: 'term_y' }),
    message({ sequence: 3, from_handle: 'term_x', to_handle: 'term_c' }),
    message({ sequence: 4, from_handle: 'term_c', to_handle: 'term_y' }),
    message({ sequence: 5, from_handle: null, to_handle: 'term_y' })
  ]
  const feed = buildFeed(TERMINALS, messages)
  assert.deepEqual(
    feed.map((item) => item.id),
    ['msg_4', 'msg_3', 'msg_1']
  )
})

test('sorts newest first and caps at 20', () => {
  const messages = Array.from({ length: 25 }, (_, index) => message({ sequence: index + 1 }))
  // Ordre d'entrée mélangé : le tri ne doit pas dépendre de l'ordre reçu.
  const shuffled = [...messages].sort((a, b) => ((a.sequence * 7) % 25) - ((b.sequence * 7) % 25))
  const feed = buildFeed(TERMINALS, shuffled)
  assert.equal(feed.length, 20)
  assert.deepEqual(
    feed.map((item) => item.id),
    Array.from({ length: 20 }, (_, index) => `msg_${25 - index}`)
  )
  assert.equal(buildFeed(TERMINALS, shuffled, 3).length, 3)
})

test('labels a closed terminal instead of dropping the line', () => {
  const feed = buildFeed(TERMINALS, [message({ sequence: 1, from_handle: 'term_a', to_handle: 'term_gone' })])
  assert.equal(feed.length, 1)
  assert.equal(feed[0].to.handle, 'term_gone')
  assert.equal(feed[0].to.live, false)
  assert.equal(feed[0].to.label, 'closed terminal')
  assert.equal(feed[0].to.agent, null)
  assert.equal(feed[0].from?.live, true)

  const localized = buildFeed(TERMINALS, [message({ sequence: 2, to_handle: 'term_gone' })], 20, {
    closedTerminal: 'terminal fermé',
    shell: 'shell'
  })
  assert.equal(localized[0].to.label, 'terminal fermé')
})

test('labels peers by agent then title', () => {
  const feed = buildFeed(TERMINALS, [message({ sequence: 1, from_handle: 'term_a', to_handle: 'term_b' })])
  assert.equal(feed[0].from?.label, 'codex · Fix parser')
  assert.equal(feed[0].from?.agent, 'codex')
  assert.equal(feed[0].to.label, 'shell · zsh')
  assert.equal(feed[0].to.agent, null)
  assert.equal(feed[0].to.live, true)

  const localized = buildFeed(TERMINALS, [message({ sequence: 2, to_handle: 'term_b' })], 20, {
    closedTerminal: 'terminal fermé',
    shell: 'terminal'
  })
  assert.equal(localized[0].to.label, 'terminal · zsh')
})

test('marks answers and previews the first line', () => {
  const long = 'x'.repeat(200)
  const feed = buildFeed(TERMINALS, [
    message({ sequence: 1, subject: 'Re: x', body: 'first line\nsecond line' }),
    message({ sequence: 2, subject: 'Question', body: long }),
    message({ sequence: 3, subject: 'Question', body: '\n  \nafter blanks  \nnext' }),
    message({ sequence: 4, subject: 'Question', body: 'x'.repeat(140) })
  ])
  const bySequence = (sequence: number) => {
    const item = feed.find((candidate) => candidate.id === `msg_${sequence}`)
    if (!item) throw new Error(`missing item ${sequence}`)
    return item
  }
  assert.equal(bySequence(1).isReply, true)
  assert.equal(bySequence(1).preview, 'first line')
  assert.equal(bySequence(2).isReply, false)
  assert.equal(bySequence(2).preview, `${'x'.repeat(140)}…`)
  assert.equal(bySequence(3).preview, 'after blanks')
  assert.equal(bySequence(4).preview, 'x'.repeat(140))
})

test('maps the read flag and a null sender', () => {
  const feed = buildFeed(TERMINALS, [
    message({ sequence: 1, from_handle: null, to_handle: 'term_a', read: 1 }),
    message({ sequence: 2, from_handle: 'term_a', to_handle: 'term_b', read: 0 })
  ])
  assert.equal(feed[1].from, null)
  assert.equal(feed[1].read, true)
  assert.equal(feed[0].read, false)
})

test('parses the real inbox sample', async () => {
  const path = fileURLToPath(new URL('./fixtures/inbox-sample.json', import.meta.url))
  const sample = JSON.parse(await readFile(path, 'utf8')) as { result: { messages: CliMessage[] } }
  const messages = sample.result.messages
  assert.ok(messages.length > 0)
  // Tous les handles de l'échantillon sont déclarés vivants : aucune ligne n'est écartée.
  const handles = new Set<string>()
  for (const entry of messages) {
    if (entry.from_handle) handles.add(entry.from_handle)
    handles.add(entry.to_handle)
  }
  const terminals = [...handles].map((handle) => ({ handle, title: 'sample' }))
  const feed = buildFeed(terminals, messages, messages.length)
  assert.equal(feed.length, messages.length)
  for (const item of feed) {
    assert.equal(typeof item.at, 'number')
    assert.ok(!Number.isNaN(item.at))
  }
  // Sans terminal connu : l'échantillon ne lève rien et rend un fil vide.
  assert.deepEqual(buildFeed([], messages), [])
})

test('fetchFeed calls the CLI with the exact arguments', async () => {
  const calls: (readonly string[])[] = []
  const run: OrcaRunner = async (args) => {
    calls.push(args)
    if (args[0] === 'terminal') return { terminals: TERMINALS }
    return { messages: [message({ sequence: 1 })] }
  }
  const feed = await fetchFeed(run, 'id:wt-1')
  assert.equal(feed.length, 1)
  assert.deepEqual(calls, [
    ['terminal', 'list', '--worktree', 'id:wt-1', '--json'],
    ['orchestration', 'inbox', '--limit', '200', '--full', '--json']
  ])
  assert.ok(calls.every((args) => !args.includes('check')))
})

test('fetchFeed rejects an unexpected CLI payload', async () => {
  const run: OrcaRunner = async () => ({ nothing: true })
  await assert.rejects(
    () => fetchFeed(run, 'id:wt-1'),
    (error) => error instanceof OrcaCliError && error.code === 'bad_json'
  )
})

test('resolveOrcaBinary prefers the app bundle', () => {
  const execPath = '/Applications/Orca.app/Contents/MacOS/Orca'
  const wanted = '/Applications/Orca.app/Contents/Resources/bin/orca'
  assert.equal(resolveOrcaBinary(execPath, (path) => path === wanted), wanted)
  assert.equal(resolveOrcaBinary(execPath, () => false), 'orca')
})

test('resolveOrcaBinary finds the bundle from an Electron helper process inside Frameworks', () => {
  const helper = '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'
  const wanted = '/Applications/Orca.app/Contents/Resources/bin/orca'
  assert.equal(resolveOrcaBinary(helper, (path) => path === wanted), wanted)
})

test('resolveOrcaBinary picks the outermost .app of a nested chain, never an inner one', () => {
  const nested = '/Users/me/Apps/Orca.app/Contents/Frameworks/Orca Helper (Renderer).app/Contents/Frameworks/Deeper.app/Contents/MacOS/x'
  const outer = '/Users/me/Apps/Orca.app/Contents/Resources/bin/orca'
  const inner = '/Users/me/Apps/Orca.app/Contents/Frameworks/Orca Helper (Renderer).app/Contents/Resources/bin/orca'
  const asked: string[] = []
  assert.equal(
    resolveOrcaBinary(nested, (path) => {
      asked.push(path)
      return path === outer || path === inner
    }),
    outer
  )
  assert.deepEqual(asked, [outer], 'only the outermost bundle is looked at')
})

test('resolveOrcaBinary falls back to orca on the PATH without an .app ancestor, or when the bundle has no CLI', () => {
  assert.equal(resolveOrcaBinary('/usr/local/bin/node', () => true), 'orca')
  assert.equal(resolveOrcaBinary('/opt/electron/electron', () => true), 'orca')
  assert.equal(resolveOrcaBinary('/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper', () => false), 'orca')
})

/** Dossiers temporaires des faux binaires, supprimés après chaque test. */
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Écrit un faux exécutable dans un dossier temporaire : jamais le vrai binaire `orca`. */
async function fakeBinary(script: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-network-cli-'))
  roots.push(root)
  const path = join(root, 'fake-orca')
  await writeFile(path, script, 'utf8')
  await chmod(path, 0o755)
  return path
}

test('runner maps a timeout and bad JSON to OrcaCliError', async () => {
  const slow = await fakeBinary('#!/bin/sh\nexec sleep 5\n')
  await assert.rejects(
    () => createOrcaRunner(slow, 150)(['anything']),
    (error) => error instanceof OrcaCliError && error.code === 'timeout'
  )

  const garbage = await fakeBinary('#!/bin/sh\necho nope\n')
  await assert.rejects(
    () => createOrcaRunner(garbage)(['anything']),
    (error) => error instanceof OrcaCliError && error.code === 'bad_json'
  )

  await assert.rejects(
    () => createOrcaRunner(join(roots[0], 'does-not-exist'))(['anything']),
    (error) => error instanceof OrcaCliError && error.code === 'spawn_failed'
  )
})

test('runner returns the result field and surfaces the CLI error code', async () => {
  const good = await fakeBinary('#!/bin/sh\necho \'{"ok":true,"result":{"value":42}}\'\n')
  assert.deepEqual(await createOrcaRunner(good)(['anything']), { value: 42 })

  const failing = await fakeBinary(
    '#!/bin/sh\necho \'{"ok":false,"error":{"code":"runtime_unavailable","message":"Orca is not running"}}\'\nexit 1\n'
  )
  await assert.rejects(
    () => createOrcaRunner(failing)(['anything']),
    (error) => error instanceof OrcaCliError && error.code === 'runtime_unavailable' && /not running/.test(error.message)
  )
})
