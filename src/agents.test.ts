// Le regroupement des agents par workspace, sans hôte ni CLI : des terminaux et un état en entrée, des groupes en sortie.
import { assert, test } from 'orca/testing'
import { buildAgentGroups, type AgentStateEntry, type FocusedWorkspace } from './agents'
import type { CliTerminal } from './feed'

const FLOATING = 'Floating terminal'
const NO_CACHE: ReadonlyMap<string, AgentStateEntry> = new Map()

const terminal = (handle: string, worktreeId: string, worktreePath: string, extra: Partial<CliTerminal> = {}): CliTerminal => ({
  handle,
  worktreeId,
  worktreePath,
  ...extra
})

const focusedOn = (handles: string[], rows: FocusedWorkspace['rows'] = [], displayName = 'Display name'): FocusedWorkspace => ({
  workspaceId: 'ws-id',
  displayName,
  handles: new Set(handles),
  rows
})

test('groups sort by name, whatever the CLI order', () => {
  const view = buildAgentGroups({
    terminals: [
      terminal('a', 'wt-z', '/dev/zebra', { agentIdentity: 'codex' }),
      terminal('b', 'wt-a', '/dev/alpha', { agentIdentity: 'claude' }),
      terminal('c', 'wt-m', '/dev/Mango', { agentIdentity: 'grok' })
    ],
    focused: null,
    cache: NO_CACHE,
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups.map((group) => group.name), ['alpha', 'Mango', 'zebra'])
})

test('the group name is the last folder of the workspace path, trailing slash or Windows separator included', () => {
  const view = buildAgentGroups({
    terminals: [
      terminal('a', 'wt-1', '/Users/x/dev/repo/', { agentIdentity: 'codex' }),
      terminal('b', 'wt-2', 'C:\\Users\\x\\proj', { agentIdentity: 'codex' })
    ],
    focused: null,
    cache: NO_CACHE,
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups.map((group) => group.name), ['proj', 'repo'])
})

test('keeps agent terminals only: no shell, no empty identity, no orphan', () => {
  const view = buildAgentGroups({
    terminals: [
      terminal('shell', 'wt', '/dev/repo'),
      terminal('blank', 'wt', '/dev/repo', { agentIdentity: '' }),
      terminal('orphan', 'wt', '/dev/repo', { agentIdentity: 'codex', orphaned: true }),
      terminal('agent', 'wt', '/dev/repo', { agentIdentity: 'codex' })
    ],
    focused: null,
    cache: NO_CACHE,
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups.map((group) => group.agents.map((row) => row.handle)), [['agent']])
})

test('a workspace with only shells makes no group', () => {
  const view = buildAgentGroups({ terminals: [terminal('shell', 'wt', '/dev/repo')], focused: null, cache: NO_CACHE, floatingLabel: FLOATING })
  assert.deepEqual(view, { groups: [] })
})

test('terminals without a folder go to one group named by the floating label', () => {
  const view = buildAgentGroups({
    terminals: [
      terminal('a', 'global-floating-terminal', '', { agentIdentity: 'claude' }),
      terminal('b', 'global-floating-terminal', '', { agentIdentity: 'codex' })
    ],
    focused: null,
    cache: NO_CACHE,
    floatingLabel: 'Terminal flottant'
  })
  assert.equal(view.groups.length, 1)
  assert.equal(view.groups[0]?.name, 'Terminal flottant')
  assert.deepEqual(view.groups[0]?.agents.map((row) => row.handle), ['a', 'b'])
})

test('other workspaces: agent id is canonical, title comes from the cache, then the CLI, state and time stay null when unknown', () => {
  const cache = new Map<string, AgentStateEntry>([['known', { state: 'blocked', since: 42, title: 'Cached title' }]])
  const view = buildAgentGroups({
    terminals: [
      terminal('known', 'wt', '/dev/repo', { agentIdentity: 'dsh-tui', title: 'CLI title' }),
      terminal('cached-untitled', 'wt', '/dev/repo', { agentIdentity: 'codex', title: 'CLI title' }),
      terminal('unknown', 'wt', '/dev/repo', { agentIdentity: 'grok', title: '' })
    ],
    focused: null,
    cache: new Map([...cache, ['cached-untitled', { state: 'done', since: 7 }]]),
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups[0]?.agents, [
    { handle: 'known', agent: 'dsh', title: 'Cached title', state: 'blocked', since: 42 },
    { handle: 'cached-untitled', agent: 'codex', title: 'CLI title', state: 'done', since: 7 },
    { handle: 'unknown', agent: 'grok', title: null, state: null, since: null }
  ])
})

test('the focused group is the one holding the focused terminals, its rows are the ones given, in their order', () => {
  const rows = [
    { handle: 'b', agent: 'claude', title: 'B', state: 'working' as const, since: 2 },
    { handle: 'a', agent: 'codex', title: 'A', state: 'done' as const, since: 1 }
  ]
  const view = buildAgentGroups({
    terminals: [
      terminal('a', 'wt-main', '/dev/main', { agentIdentity: 'codex', title: 'CLI A' }),
      terminal('b', 'wt-main', '/dev/main', { agentIdentity: 'claude' }),
      terminal('c', 'wt-other', '/dev/other', { agentIdentity: 'grok' })
    ],
    focused: focusedOn(['a', 'b'], rows),
    cache: NO_CACHE,
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups.map((group) => [group.id, group.current]), [['wt-main', true], ['wt-other', false]])
  assert.deepEqual(view.groups[0]?.agents, rows)
})

test('the focused group is found through a shell terminal too, and stays when it has no agent', () => {
  const view = buildAgentGroups({
    terminals: [terminal('shell', 'wt-main', '/dev/main'), terminal('c', 'wt-other', '/dev/other', { agentIdentity: 'grok' })],
    focused: focusedOn(['shell']),
    cache: NO_CACHE,
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups.map((group) => [group.name, group.current, group.agents.length]), [
    ['main', true, 0],
    ['other', false, 1]
  ])
})

test('without any CLI terminal, the focused group takes the display name and the workspace id', () => {
  const view = buildAgentGroups({ terminals: null, focused: focusedOn(['a'], [], 'My workspace'), cache: NO_CACHE, floatingLabel: FLOATING })
  assert.deepEqual(view, { groups: [{ id: 'ws-id', name: 'My workspace', current: true, agents: [] }] })
})

test('the focused workspace never appears twice, once from agents.list and once from the CLI', () => {
  const view = buildAgentGroups({
    terminals: [terminal('a', 'wt-main', '/dev/main', { agentIdentity: 'codex' })],
    focused: focusedOn(['a'], [{ handle: 'a', agent: 'codex', title: null, state: 'working', since: 1 }]),
    cache: NO_CACHE,
    floatingLabel: FLOATING
  })
  assert.equal(view.groups.length, 1)
  assert.equal(view.groups[0]?.agents[0]?.state, 'working')
})

test('the floating terminal can be the focused group', () => {
  const view = buildAgentGroups({
    terminals: [terminal('f', 'global-floating-terminal', '', { agentIdentity: 'claude' })],
    focused: focusedOn(['f'], [{ handle: 'f', agent: 'claude', title: null, state: 'done', since: 3 }]),
    cache: NO_CACHE,
    floatingLabel: 'Floating'
  })
  assert.deepEqual(view.groups.map((group) => [group.name, group.current]), [['Floating', true]])
})
