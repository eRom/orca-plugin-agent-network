// Assemble les agents de tous les workspaces en groupes, à partir du CLI `orca` (terminaux) et des réponses d'`agents.list`
// par workspace. Module pur : aucun appel à l'hôte, le worker n'y met que ses lectures.
import type { CliTerminal } from './feed'
import { canonicalAgentId } from './icons'
import type { AgentRow, AgentsView } from './protocol'

/** Le workspace affiché : ses terminaux (`readContext`) et le nom que donne Orca. */
export type FocusedWorkspace = {
  workspaceId: string | null
  displayName: string
  /** Handles des terminaux du workspace, tous types confondus : ils servent à retrouver son groupe dans le CLI. */
  handles: ReadonlySet<string>
  /**
   * Lignes d'`agents.list` sans argument, lues seulement quand le groupe du workspace n'a pas de réponse exacte
   * (aucun groupe d'agent dans le CLI, CLI muet, appel par workspace refusé) ; vide sinon.
   */
  rows: AgentRow[]
}

export type AgentGroupsInput = {
  /** Terminaux du CLI de tous les workspaces ; `null` quand le CLI a échoué. */
  terminals: readonly CliTerminal[] | null
  focused: FocusedWorkspace | null
  /** Réponse d'`agents.list` par groupe (clé de `agentGroupKeys`) ; `null` quand l'appel a été rejeté : le groupe se replie sur le CLI. */
  answers: ReadonlyMap<string, AgentRow[] | null>
  /** Nom du groupe des terminaux sans dossier (le terminal flottant d'Orca). */
  floatingLabel: string
}

const lastSegment = (path: string): string => path.split(/[\\/]/).filter((part) => part !== '').pop() ?? ''

/** Clé de regroupement d'un terminal : le workspace d'Orca, à défaut son dossier. C'est aussi le `workspaceId` d'`agents.list`. */
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

function groupByKey(terminals: readonly CliTerminal[] | null): Map<string, CliTerminal[]> {
  const byKey = new Map<string, CliTerminal[]>()
  for (const terminal of terminals ?? []) {
    if (typeof terminal.handle !== 'string') continue
    byKey.set(groupKey(terminal), [...(byKey.get(groupKey(terminal)) ?? []), terminal])
  }
  return byKey
}

/** Les workspaces qui ont au moins un terminal d'agent : ceux dont le worker demande les agents à l'hôte. */
export function agentGroupKeys(terminals: readonly CliTerminal[]): string[] {
  return [...groupByKey(terminals)].filter(([, members]) => members.some(isAgentTerminal)).map(([key]) => key)
}

/**
 * Le groupe du workspace affiché : celui d'un de ses terminaux dans le CLI, tous types confondus. `null` quand on ne sait pas
 * lequel c'est (CLI muet, workspace sans terminal).
 */
export function focusedGroupKey(terminals: readonly CliTerminal[], handles: ReadonlySet<string>): string | null {
  for (const [key, members] of groupByKey(terminals)) {
    if (members.some((terminal) => handles.has(terminal.handle))) return key
  }
  return null
}

/** Ligne d'un terminal d'après le CLI seul : ni état ni durée, le panneau n'invente rien. */
function cliRow(terminal: CliTerminal): AgentRow {
  const title = typeof terminal.title === 'string' && terminal.title !== '' ? terminal.title : null
  return { handle: terminal.handle, agent: canonicalAgentId(terminal.agentIdentity ?? null), title, state: null, since: null }
}

/**
 * Un groupe par workspace qui a des agents, triés par nom. Les lignes d'un groupe viennent de la réponse d'`agents.list`
 * pour ce workspace (état exact) ; sans réponse, de ses terminaux du CLI. Le groupe du workspace affiché reste présent même vide.
 */
export function buildAgentGroups({ terminals, focused, answers, floatingLabel }: AgentGroupsInput): AgentsView {
  const byKey = groupByKey(terminals)
  const focusedKey = focused === null || terminals === null ? null : focusedGroupKey(terminals, focused.handles)

  const groups: AgentsView['groups'] = []
  for (const [key, members] of byKey) {
    const agentTerminals = members.filter(isAgentTerminal)
    if (agentTerminals.length === 0) continue
    const current = key === focusedKey
    const answer = answers.get(key) ?? null
    // Sans réponse exacte, le workspace affiché garde les lignes d'`agents.list` sans argument si on en a lues, sinon le CLI.
    const exact = answer ?? (current && focused !== null && focused.rows.length > 0 ? focused.rows : null)
    // Le CLI reconnaît aussi un agent à son processus ou à son titre, l'hôte seulement à ses hooks : un agent sans hook garde
    // sa ligne, sans état, pour que son ID reste copiable.
    const untracked = exact === null ? agentTerminals : agentTerminals.filter((terminal) => !exact.some((entry) => entry.handle === terminal.handle))
    const agents = [...(exact ?? []), ...untracked.map(cliRow)]
    groups.push({ id: key, name: groupName(members, floatingLabel), current, agents })
  }

  // Le workspace affiché n'a aucun terminal d'agent dans le CLI : son groupe reste, pour dire où l'on est.
  if (focused !== null && !groups.some((group) => group.current)) {
    groups.push({
      id: focusedKey ?? focused.workspaceId ?? 'focused',
      name: focusedKey === null ? focused.displayName : groupName(byKey.get(focusedKey) ?? [], floatingLabel),
      current: true,
      agents: focused.rows
    })
  }
  groups.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  return { groups }
}
