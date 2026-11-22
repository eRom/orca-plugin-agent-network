// Le regroupement des agents par workspace, sans hôte ni CLI : des terminaux et des réponses en entrée, des groupes en sortie.
import { assert, test } from 'orca/testing'
import { agentGroupKeys, buildAgentGroups, focusedGroupKey, type FocusedWorkspace } from './agents'
import type { CliTerminal } from './feed'
import type { AgentRow } from './protocol'

const FLOATING = 'Floating terminal'
const NO_ANSWERS: ReadonlyMap<string, AgentRow[] | null> = new Map()

const terminal = (handle: string, worktreeId: string, worktreePath: string, extra: Partial<CliTerminal> = {}): CliTerminal => ({
  handle,
  worktreeId,
  worktreePath,
  ...extra
})

const row = (handle: string, state: AgentRow['state'] = 'working', since: AgentRow['since'] = 1): AgentRow => ({
  handle,
  agent: 'codex',
  title: null,
  state,
  since
})

const focusedOn = (handles: string[], rows: AgentRow[] = [], displayName = 'Display name'): FocusedWorkspace => ({
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
    answers: NO_ANSWERS,
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
    answers: NO_ANSWERS,
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups.map((group) => group.name), ['proj', 'repo'])
})

test('only workspaces with an agent terminal are asked: no shell, no empty identity, no orphan', () => {
  const terminals = [
    terminal('shell', 'wt-shell', '/dev/shells'),
    terminal('blank', 'wt-blank', '/dev/blank', { agentIdentity: '' }),
    terminal('orphan', 'wt-orphan', '/dev/orphan', { agentIdentity: 'codex', orphaned: true }),
    terminal('agent', 'wt-agent', '/dev/agent', { agentIdentity: 'codex' }),
    terminal('mixed-shell', 'wt-mixed', '/dev/mixed'),
    terminal('mixed-agent', 'wt-mixed', '/dev/mixed', { agentIdentity: 'claude' })
  ]
  assert.deepEqual(agentGroupKeys(terminals), ['wt-agent', 'wt-mixed'])
  const view = buildAgentGroups({ terminals, focused: null, answers: NO_ANSWERS, floatingLabel: FLOATING })
  assert.deepEqual(view.groups.map((group) => group.id), ['wt-agent', 'wt-mixed'])
  assert.deepEqual(view.groups.find((group) => group.id === 'wt-mixed')?.agents.map((entry) => entry.handle), ['mixed-agent'])
})

test('a workspace with only shells makes no group', () => {
  const view = buildAgentGroups({ terminals: [terminal('shell', 'wt', '/dev/repo')], focused: null, answers: NO_ANSWERS, floatingLabel: FLOATING })
  assert.deepEqual(view, { groups: [] })
})

test('terminals without a folder go to one group named by the floating label', () => {
  const view = buildAgentGroups({
    terminals: [
      terminal('a', 'global-floating-terminal', '', { agentIdentity: 'claude' }),
      terminal('b', 'global-floating-terminal', '', { agentIdentity: 'codex' })
    ],
    focused: null,
    answers: NO_ANSWERS,
    floatingLabel: 'Terminal flottant'
  })
  assert.equal(view.groups.length, 1)
  assert.equal(view.groups[0]?.name, 'Terminal flottant')
  assert.deepEqual(view.groups[0]?.agents.map((entry) => entry.handle), ['a', 'b'])
})

test('a group takes the rows the host answered for it, exact state included', () => {
  const answered = [row('a', 'blocked', 42), row('b', 'done', 7)]
  const view = buildAgentGroups({
    terminals: [terminal('a', 'wt', '/dev/repo', { agentIdentity: 'codex', title: 'CLI title' })],
    focused: null,
    answers: new Map([['wt', answered]]),
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups[0]?.agents, answered)
})

test('a rejected workspace falls back to its CLI rows: canonical agent id, CLI title, no state, no time', () => {
  const view = buildAgentGroups({
    terminals: [
      terminal('known', 'wt', '/dev/repo', { agentIdentity: 'dsh-tui', title: 'CLI title' }),
      terminal('untitled', 'wt', '/dev/repo', { agentIdentity: 'grok', title: '' }),
      terminal('shell', 'wt', '/dev/repo')
    ],
    focused: null,
    answers: new Map([['wt', null]]),
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups[0]?.agents, [
    { handle: 'known', agent: 'dsh', title: 'CLI title', state: null, since: null },
    { handle: 'untitled', agent: 'grok', title: null, state: null, since: null }
  ])
})

test('one rejected workspace leaves the other groups with their exact rows', () => {
  const view = buildAgentGroups({
    terminals: [terminal('a', 'wt-a', '/dev/a', { agentIdentity: 'codex' }), terminal('b', 'wt-b', '/dev/b', { agentIdentity: 'claude' })],
    focused: null,
    answers: new Map<string, AgentRow[] | null>([
      ['wt-a', null],
      ['wt-b', [row('b', 'done', 9)]]
    ]),
    floatingLabel: FLOATING
  })
  assert.equal(view.groups.find((group) => group.id === 'wt-a')?.agents[0]?.state, null)
  assert.equal(view.groups.find((group) => group.id === 'wt-b')?.agents[0]?.state, 'done')
})

test('an agent terminal the host does not track keeps its row, without state, after the exact rows', () => {
  const view = buildAgentGroups({
    terminals: [
      terminal('hooked', 'wt', '/dev/repo', { agentIdentity: 'claude' }),
      terminal('hookless', 'wt', '/dev/repo', { agentIdentity: 'kimi', title: 'Scratch' }),
      terminal('alone', 'wt-2', '/dev/other', { agentIdentity: 'codex' })
    ],
    focused: null,
    answers: new Map([
      ['wt', [row('hooked', 'done', 3)]],
      ['wt-2', []]
    ]),
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups.find((group) => group.id === 'wt')?.agents, [
    row('hooked', 'done', 3),
    { handle: 'hookless', agent: 'kimi', title: 'Scratch', state: null, since: null }
  ])
  assert.deepEqual(view.groups.find((group) => group.id === 'wt-2')?.agents.map((entry) => [entry.handle, entry.state]), [['alone', null]])
})

test('the focused group is the one holding the focused terminals, its rows are the answer, in its order', () => {
  const answered = [row('b', 'working', 2), row('a', 'done', 1)]
  const view = buildAgentGroups({
    terminals: [
      terminal('a', 'wt-main', '/dev/main', { agentIdentity: 'codex' }),
      terminal('b', 'wt-main', '/dev/main', { agentIdentity: 'claude' }),
      terminal('c', 'wt-other', '/dev/other', { agentIdentity: 'grok' })
    ],
    focused: focusedOn(['a', 'b']),
    answers: new Map([['wt-main', answered]]),
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups.map((group) => [group.id, group.current]), [['wt-main', true], ['wt-other', false]])
  assert.deepEqual(view.groups[0]?.agents, answered)
})

test('a rejected focused group takes the rows read without argument, else its CLI rows', () => {
  const terminals = [terminal('a', 'wt-main', '/dev/main', { agentIdentity: 'codex' })]
  const answers = new Map([['wt-main', null]])
  const withRows = buildAgentGroups({ terminals, focused: focusedOn(['a'], [row('a', 'done', 5)]), answers, floatingLabel: FLOATING })
  assert.deepEqual(withRows.groups[0]?.agents, [row('a', 'done', 5)])
  const withoutRows = buildAgentGroups({ terminals, focused: focusedOn(['a']), answers, floatingLabel: FLOATING })
  assert.deepEqual(withoutRows.groups[0]?.agents, [{ handle: 'a', agent: 'codex', title: null, state: null, since: null }])
})

test('the focused group is found through a shell terminal too, and stays when it has no agent', () => {
  const terminals = [terminal('shell', 'wt-main', '/dev/main'), terminal('c', 'wt-other', '/dev/other', { agentIdentity: 'grok' })]
  assert.equal(focusedGroupKey(terminals, new Set(['shell'])), 'wt-main')
  const view = buildAgentGroups({ terminals, focused: focusedOn(['shell']), answers: new Map([['wt-other', [row('c')]]]), floatingLabel: FLOATING })
  assert.deepEqual(view.groups.map((group) => [group.name, group.current, group.agents.length]), [
    ['main', true, 0],
    ['other', false, 1]
  ])
})

test('an empty focused group carries the rows read without argument when there are some', () => {
  const view = buildAgentGroups({
    terminals: [terminal('shell', 'wt-main', '/dev/main')],
    focused: focusedOn(['shell'], [row('x', 'blocked', 3)]),
    answers: NO_ANSWERS,
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups, [{ id: 'wt-main', name: 'main', current: true, agents: [row('x', 'blocked', 3)] }])
})

test('without any CLI terminal, the focused group takes the display name and the workspace id', () => {
  const view = buildAgentGroups({ terminals: null, focused: focusedOn(['a'], [], 'My workspace'), answers: NO_ANSWERS, floatingLabel: FLOATING })
  assert.deepEqual(view, { groups: [{ id: 'ws-id', name: 'My workspace', current: true, agents: [] }] })
})

test('the focused workspace never appears twice', () => {
  const view = buildAgentGroups({
    terminals: [terminal('a', 'wt-main', '/dev/main', { agentIdentity: 'codex' })],
    focused: focusedOn(['a']),
    answers: new Map([['wt-main', [row('a', 'working', 1)]]]),
    floatingLabel: FLOATING
  })
  assert.equal(view.groups.length, 1)
  assert.equal(view.groups[0]?.agents[0]?.state, 'working')
})

test('the floating terminal can be the focused group', () => {
  const view = buildAgentGroups({
    terminals: [terminal('f', 'global-floating-terminal', '', { agentIdentity: 'claude' })],
    focused: focusedOn(['f'], [row('f', 'done', 3)]),
    answers: new Map([['global-floating-terminal', null]]),
    floatingLabel: 'Floating'
  })
  assert.deepEqual(view.groups.map((group) => [group.name, group.current, group.agents[0]?.state]), [['Floating', true, 'done']])
})

test('no focused workspace: no group is current', () => {
  const view = buildAgentGroups({
    terminals: [terminal('a', 'wt', '/dev/repo', { agentIdentity: 'codex' })],
    focused: null,
    answers: new Map([['wt', [row('a')]]]),
    floatingLabel: FLOATING
  })
  assert.deepEqual(view.groups.map((group) => group.current), [false])
})
