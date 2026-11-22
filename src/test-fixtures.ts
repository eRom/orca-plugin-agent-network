// Données communes au test du panneau et à ses scénarios `orca plugin check` : aucun hôte, que des valeurs.
import { MESSAGES } from './copy'
import type { FeedItem, Party } from './feed'
import type { TargetState, TargetStatus } from './installer'
import type { AgentsView } from './protocol'

/** Instant de référence des données d'exemple : les durées relatives partent de lui, donc se lisent « il y a 4 min » à tout moment. */
export const NOW = Date.now()

const MINUTE = 60_000

export const WORKSPACE_NAME = 'agent-network'
export const OTHER_WORKSPACE_NAME = 'agent-progress-sp'

export const BLOCKED_AGENT = { handle: 'term_claude', agent: 'claude', title: 'Reviewer', state: 'blocked', since: NOW - 4 * MINUTE } as const
export const WORKING_AGENT = { handle: 'term_codex', agent: 'codex', title: 'Builder', state: 'working', since: NOW - 12 * MINUTE } as const
export const WAITING_AGENT = { handle: 'term_grok', agent: 'grok', title: null, state: 'waiting', since: NOW - 90 * MINUTE } as const
export const DONE_AGENT = { handle: 'term_agy', agent: 'antigravity', title: 'Docs', state: 'done', since: NOW - 3 * 60 * MINUTE } as const
/** Un agent sans icône livrée : le panneau dessine un monogramme. */
export const UNKNOWN_AGENT = { handle: 'term_other', agent: 'kimi', title: 'Scratch', state: 'working', since: NOW - MINUTE } as const
/** Un agent d'un autre workspace, dont le worker connaît l'état. */
export const REMOTE_AGENT = { handle: 'term_remote', agent: 'claude', title: 'Lone harness', state: 'waiting', since: NOW - 7 * MINUTE } as const
/** Un agent d'un autre workspace dont Orca n'a encore rien rapporté : ni état, ni durée. */
export const SILENT_AGENT = { handle: 'term_far', agent: 'codex', title: 'Far away', state: null, since: null } as const

/** Deux workspaces : celui qu'on regarde (en évidence) et un autre, rangés par nom. */
export const LIVE_AGENTS: AgentsView = {
  groups: [
    { id: 'wt-main', name: WORKSPACE_NAME, current: true, agents: [BLOCKED_AGENT, WORKING_AGENT, WAITING_AGENT, DONE_AGENT, UNKNOWN_AGENT] },
    { id: 'wt-other', name: OTHER_WORKSPACE_NAME, current: false, agents: [REMOTE_AGENT, SILENT_AGENT] }
  ]
}

/** La même liste une fois l'autre workspace affiché : seule la mise en évidence a bougé. */
export const OTHER_WORKSPACE_AGENTS: AgentsView = {
  groups: LIVE_AGENTS.groups.map((group) => ({ ...group, current: !group.current }))
}

/** Aucun terminal d'agent nulle part. */
export const NO_AGENTS: AgentsView = { groups: [] }

/** Le workspace affiché n'a pas d'agent : son groupe reste, pour dire où l'on est. */
export const EMPTY_WORKSPACE_AGENTS: AgentsView = { groups: [{ id: 'wt-main', name: WORKSPACE_NAME, current: true, agents: [] }] }

const party = (handle: string, agent: string | null, title: string | null, live = true): Party => ({
  handle,
  label: live ? (title ? `${agent ?? MESSAGES.en.shell} · ${title}` : (agent ?? MESSAGES.en.shell)) : MESSAGES.en.closedTerminal,
  agent,
  live
})

/** Première ligne de 140 caractères suivie d'une ellipse : la longueur maximale d'un aperçu du worker. */
export const LONG_PREVIEW = `${'Please review the migration plan before we cut the release branch, '.repeat(3).slice(0, 140)}…`

export const UNREAD_MESSAGE: FeedItem = {
  id: 'm1',
  from: party('term_codex', 'codex', 'Builder'),
  to: party('term_claude', 'claude', 'Reviewer'),
  subject: 'Review the migration plan',
  preview: LONG_PREVIEW,
  at: NOW - 2 * MINUTE,
  read: false,
  isReply: false
}

export const REPLY_MESSAGE: FeedItem = {
  id: 'm2',
  from: party('term_claude', 'claude', 'Reviewer'),
  to: party('term_codex', 'codex', 'Builder'),
  subject: 'Re: Review the migration plan',
  preview: 'Looks good, two small remarks inline.',
  at: NOW - 10 * MINUTE,
  read: true,
  isReply: true
}

/** Date illisible côté worker (`at: 0`) et expéditeur disparu. */
export const UNDATED_MESSAGE: FeedItem = {
  id: 'm3',
  from: null,
  to: party('term_grok', 'grok', null),
  subject: 'Heads up',
  preview: 'The CI is red on main.',
  at: 0,
  read: true,
  isReply: false
}

export const CLOSED_TERMINAL_MESSAGE: FeedItem = {
  id: 'm4',
  from: party('term_gone', null, null, false),
  to: party('term_agy', 'antigravity', 'Docs'),
  subject: 'Docs question',
  preview: 'Which section covers the install flow?',
  at: NOW - 30 * MINUTE,
  read: true,
  isReply: false
}

export const FEED: FeedItem[] = [UNREAD_MESSAGE, REPLY_MESSAGE, UNDATED_MESSAGE, CLOSED_TERMINAL_MESSAGE]

/** Une cible par état. Il n'y a quatre cibles que dans la vraie vie : ici les identifiants se répètent, c'est sans effet sur le rendu. */
export function target(state: TargetState, id: TargetStatus['target'], harnesses: readonly string[]): TargetStatus {
  return { target: id, harnesses, file: `/home/me/.${id}/skills/agent-network/SKILL.md`, state }
}

export const ONE_TARGET_OF_EACH_STATE: TargetStatus[] = [
  target('installed', 'claude', ['claude']),
  target('outdated', 'shared', ['codex', 'dsh', 'opencode', 'pi']),
  target('modified', 'grok', ['grok']),
  target('foreign', 'antigravity', ['antigravity']),
  target('absent-harness', 'grok', ['grok']),
  target('not-installed', 'claude', ['claude'])
]

export const ALL_INSTALLED: TargetStatus[] = [
  target('installed', 'claude', ['claude']),
  target('installed', 'shared', ['codex', 'dsh', 'opencode', 'pi']),
  target('installed', 'grok', ['grok']),
  target('installed', 'antigravity', ['antigravity'])
]

export const NONE_INSTALLED: TargetStatus[] = [
  target('not-installed', 'claude', ['claude']),
  target('not-installed', 'shared', ['codex', 'dsh', 'opencode', 'pi']),
  target('absent-harness', 'grok', ['grok']),
  target('not-installed', 'antigravity', ['antigravity'])
]

/** Ce que voit quelqu'un dont les quatre dossiers `agent-network` viennent d'ailleurs : ni installation, ni retrait possibles. */
export const ALL_FOREIGN: TargetStatus[] = [
  target('foreign', 'claude', ['claude']),
  target('foreign', 'shared', ['codex', 'dsh', 'opencode', 'pi']),
  target('foreign', 'grok', ['grok']),
  target('foreign', 'antigravity', ['antigravity'])
]
