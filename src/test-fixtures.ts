// Données communes au test du panneau et à ses scénarios `orca plugin check` : aucun hôte, que des valeurs.
import type { FeedItem, Party } from './feed'
import type { TargetState, TargetStatus } from './installer'
import type { AgentsView } from './protocol'

/** Instant de référence des données d'exemple : les durées relatives partent de lui, donc se lisent « il y a 4 min » à tout moment. */
export const NOW = Date.now()

const MINUTE = 60_000

export const WORKSPACE_NAME = 'My workspace'

export const BLOCKED_AGENT = { handle: 'term_claude', agent: 'claude', title: 'Reviewer', state: 'blocked', since: NOW - 4 * MINUTE } as const
export const WORKING_AGENT = { handle: 'term_codex', agent: 'codex', title: 'Builder', state: 'working', since: NOW - 12 * MINUTE } as const
export const WAITING_AGENT = { handle: 'term_grok', agent: 'grok', title: null, state: 'waiting', since: NOW - 90 * MINUTE } as const
export const DONE_AGENT = { handle: 'term_agy', agent: 'antigravity', title: 'Docs', state: 'done', since: NOW - 3 * 60 * MINUTE } as const
/** Un agent sans icône livrée : le panneau dessine un monogramme. */
export const UNKNOWN_AGENT = { handle: 'term_other', agent: 'kimi', title: 'Scratch', state: 'working', since: NOW - MINUTE } as const

export const LIVE_AGENTS: AgentsView = {
  workspace: { name: WORKSPACE_NAME },
  agents: [BLOCKED_AGENT, WORKING_AGENT, WAITING_AGENT, DONE_AGENT, UNKNOWN_AGENT]
}

/** Autre workspace, pour les tests de bascule. */
export const OTHER_WORKSPACE_AGENTS: AgentsView = {
  workspace: { name: 'Other workspace' },
  agents: [{ handle: 'term_dsh', agent: 'dsh', title: 'Lone harness', state: 'waiting', since: NOW - 2 * MINUTE }]
}

export const NO_WORKSPACE_AGENTS: AgentsView = { workspace: null, agents: [] }

export const EMPTY_WORKSPACE_AGENTS: AgentsView = { workspace: { name: WORKSPACE_NAME }, agents: [] }

const party = (handle: string, agent: string | null, title: string | null, live = true): Party => ({
  handle,
  label: live ? (title ? `${agent ?? 'shell'} · ${title}` : (agent ?? 'shell')) : 'closed terminal',
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
  target('outdated', 'shared', ['codex', 'dsh']),
  target('modified', 'grok', ['grok']),
  target('foreign', 'antigravity', ['antigravity']),
  target('absent-harness', 'grok', ['grok']),
  target('not-installed', 'claude', ['claude'])
]

export const ALL_INSTALLED: TargetStatus[] = [
  target('installed', 'claude', ['claude']),
  target('installed', 'shared', ['codex', 'dsh']),
  target('installed', 'grok', ['grok']),
  target('installed', 'antigravity', ['antigravity'])
]

export const NONE_INSTALLED: TargetStatus[] = [
  target('not-installed', 'claude', ['claude']),
  target('not-installed', 'shared', ['codex', 'dsh']),
  target('absent-harness', 'grok', ['grok']),
  target('not-installed', 'antigravity', ['antigravity'])
]
