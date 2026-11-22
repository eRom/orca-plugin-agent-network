// Assemble les agents de tous les workspaces en groupes, à partir du CLI `orca` (terminaux), de l'état connu par le worker
// et des agents du workspace affiché. Module pur : aucun appel à l'hôte, le worker n'y met que ses lectures.
import type { CliTerminal } from './feed'
import { canonicalAgentId } from './icons'
import type { AgentRow, AgentsView, AgentState } from './protocol'

/** Dernier état rapporté pour un terminal (événement `agent.status.changed` ou `agents.list`). */
export type AgentStateEntry = { state: AgentState; since: number; title?: string }

/** Le workspace affiché : ses terminaux (`readContext`), ses agents (`agents.list`) et le nom que donne Orca. */
export type FocusedWorkspace = {
  workspaceId: string | null
  displayName: string
  /** Handles des terminaux du workspace, tous types confondus : ils servent à retrouver son groupe dans le CLI. */
  handles: ReadonlySet<string>
  /** Lignes déjà construites depuis `agents.list`, dans son ordre. */
  rows: AgentRow[]
}

export type AgentGroupsInput = {
  /** Terminaux du CLI de tous les workspaces ; `null` quand le CLI a échoué. */
  terminals: readonly CliTerminal[] | null
  focused: FocusedWorkspace | null
  cache: ReadonlyMap<string, AgentStateEntry>
  /** Nom du groupe des terminaux sans dossier (le terminal flottant d'Orca). */
  floatingLabel: string
}

const lastSegment = (path: string): string => path.split(/[\\/]/).filter((part) => part !== '').pop() ?? ''

/** Clé de regroupement d'un terminal : le workspace d'Orca, à défaut son dossier. */
const groupKey = (terminal: CliTerminal): string => terminal.worktreeId ?? terminal.worktreePath ?? ''

/** Nom d'un groupe : le dossier du workspace, ou le libellé du terminal flottant quand il n'y en a pas. */
function groupName(terminals: readonly CliTerminal[], floatingLabel: string): string {
  for (const terminal of terminals) {
    const name = lastSegment(terminal.worktreePath ?? '')
    if (name !== '') return name
  }
  return floatingLabel
}

const isAgentTerminal = (terminal: CliTerminal): boolean =>
  typeof terminal.agentIdentity === 'string' && terminal.agentIdentity !== '' && terminal.orphaned !== true

function otherRow(terminal: CliTerminal, cache: ReadonlyMap<string, AgentStateEntry>): AgentRow {
  const known = cache.get(terminal.handle)
  const cliTitle = typeof terminal.title === 'string' && terminal.title !== '' ? terminal.title : null
  return {
    handle: terminal.handle,
    agent: canonicalAgentId(terminal.agentIdentity ?? null),
    title: known?.title ?? cliTitle,
    state: known?.state ?? null,
    since: known?.since ?? null
  }
}

/**
 * Un groupe par workspace qui a des agents, triés par nom. Celui du workspace affiché vient de `agents.list` (état exact) et
 * reste présent même vide ; les autres viennent du CLI, avec l'état que le worker a retenu (nul tant qu'il n'a rien vu).
 */
export function buildAgentGroups({ terminals, focused, cache, floatingLabel }: AgentGroupsInput): AgentsView {
  const byKey = new Map<string, CliTerminal[]>()
  for (const terminal of terminals ?? []) {
    if (typeof terminal.handle !== 'string') continue
    byKey.set(groupKey(terminal), [...(byKey.get(groupKey(terminal)) ?? []), terminal])
  }

  // Le groupe du workspace affiché : celui d'un de ses terminaux dans le CLI ; sinon (CLI muet, workspace sans terminal)
  // on ne sait pas lequel c'est, et ses propres lignes suffisent.
  let focusedKey: string | null = null
  if (focused !== null) {
    for (const [key, members] of byKey) {
      if (members.some((terminal) => focused.handles.has(terminal.handle))) {
        focusedKey = key
        break
      }
    }
  }

  const groups: AgentsView['groups'] = []
  if (focused !== null) {
    groups.push({
      id: focusedKey ?? focused.workspaceId ?? 'focused',
      name: focusedKey === null ? focused.displayName : groupName(byKey.get(focusedKey) ?? [], floatingLabel),
      current: true,
      agents: focused.rows
    })
  }
  for (const [key, members] of byKey) {
    if (key === focusedKey) continue
    const agents = members.filter(isAgentTerminal)
    if (agents.length === 0) continue
    groups.push({ id: key, name: groupName(members, floatingLabel), current: false, agents: agents.map((terminal) => otherRow(terminal, cache)) })
  }
  groups.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { groups }
}
