// Construit le fil des derniers messages entre les agents du workspace, à partir des sorties JSON du CLI `orca`.
import { OrcaCliError, type OrcaRunner } from './orca-cli'
import { canonicalAgentId } from './icons'

/** Un élément de `result.terminals` d'`orca terminal list --json`. */
export type CliTerminal = { handle: string; title?: string; agentIdentity?: string }

/** Un élément de `result.messages` d'`orca orchestration inbox --full --json`. */
export type CliMessage = {
  id: string
  from_handle: string | null
  to_handle: string
  subject: string
  body: string
  sequence: number
  created_at: string
  read: number
  thread_id: string | null
}

export type Party = { handle: string; label: string; agent: string | null; live: boolean }

export type FeedItem = {
  id: string
  from: Party | null
  to: Party
  subject: string
  preview: string
  at: number
  read: boolean
  isReply: boolean
}

export const FEED_LIMIT = 20
export const INBOX_SCAN_LIMIT = 200

const PREVIEW_MAX_CHARS = 140

/** Libellés visibles du fil : la copie localisée vient de l'appelant (voir `copy.ts`). */
export type FeedLabels = { closedTerminal: string; shell: string }

const DEFAULT_LABELS: FeedLabels = { closedTerminal: 'closed terminal', shell: 'shell' }

/** Première ligne non vide du corps, coupée à 140 caractères avec une ellipse. */
function previewOf(body: string): string {
  const firstLine = body.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
  const trimmed = firstLine.trim()
  return trimmed.length > PREVIEW_MAX_CHARS ? `${trimmed.slice(0, PREVIEW_MAX_CHARS)}…` : trimmed
}

function partyOf(handle: string, known: Map<string, CliTerminal>, labels: FeedLabels): Party {
  const terminal = known.get(handle)
  if (!terminal) return { handle, label: labels.closedTerminal, agent: null, live: false }
  const agent = canonicalAgentId(terminal.agentIdentity ? terminal.agentIdentity : null)
  const kind = agent ?? labels.shell
  return { handle, label: terminal.title ? `${kind} · ${terminal.title}` : kind, agent, live: true }
}

/**
 * Garde les messages dont l'expéditeur ou le destinataire est un terminal de ce workspace (l'inbox est global),
 * du plus récent au plus ancien. Un terminal fermé reste affiché, avec le libellé « fermé ».
 */
export function buildFeed(
  terminals: CliTerminal[],
  messages: CliMessage[],
  limit = FEED_LIMIT,
  labels: FeedLabels = DEFAULT_LABELS
): FeedItem[] {
  const known = new Map(terminals.map((terminal) => [terminal.handle, terminal]))
  const touchesWorkspace = (message: CliMessage): boolean =>
    known.has(message.to_handle) || (message.from_handle !== null && known.has(message.from_handle))

  return messages
    .filter(touchesWorkspace)
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, limit)
    .map((message) => {
      const at = Date.parse(message.created_at)
      return {
        id: message.id,
        from: message.from_handle === null ? null : partyOf(message.from_handle, known, labels),
        to: partyOf(message.to_handle, known, labels),
        subject: message.subject,
        preview: previewOf(message.body),
        at: Number.isNaN(at) ? 0 : at,
        read: message.read !== 0,
        isReply: /^re:\s/i.test(message.subject)
      }
    })
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

/** Extrait un tableau d'un champ de la réponse du CLI, ou signale une forme inattendue. */
function listField<T>(payload: unknown, field: string): T[] {
  if (isRecord(payload) && Array.isArray(payload[field])) return payload[field] as T[]
  throw new OrcaCliError('bad_json', `orca answered without a "${field}" list`)
}

/** Lit les terminaux du workspace puis la boîte de réception (lecture seule, jamais `check`), et assemble le fil. */
export async function fetchFeed(
  run: OrcaRunner,
  workspaceSelector: string,
  labels: FeedLabels = DEFAULT_LABELS
): Promise<FeedItem[]> {
  const [terminalsPayload, inboxPayload] = await Promise.all([
    run(['terminal', 'list', '--worktree', workspaceSelector, '--json']),
    run(['orchestration', 'inbox', '--limit', String(INBOX_SCAN_LIMIT), '--full', '--json'])
  ])
  return buildFeed(
    listField<CliTerminal>(terminalsPayload, 'terminals'),
    listField<CliMessage>(inboxPayload, 'messages'),
    FEED_LIMIT,
    labels
  )
}
