// Contrat panneau <-> worker, déclaré une fois par fusion de déclarations sur `orca` (gabarit worker-panel d'Orca).
import type { FeedItem } from './feed'
import type { InstallReport, TargetStatus, UninstallReport } from './installer'

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

/** Un agent d'un terminal ; `state` et `since` sont nuls quand Orca n'a encore rien rapporté pour un autre workspace que le courant. */
export type AgentRow = { handle: string; agent: string | null; title: string | null; state: AgentState | null; since: number | null }

/** Les agents de tous les workspaces, groupés par workspace ; le groupe du workspace affiché est `current`. */
export type AgentsView = {
  groups: { id: string; name: string; current: boolean; agents: AgentRow[] }[]
}

/** Le fil, ou le message d'erreur localisé à afficher à sa place. */
export type FeedResult = { items: FeedItem[] } | { error: string }

/** La copie a abouti, ou le message d'erreur localisé à afficher. */
export type CopyResult = { ok: true } | { error: string }

/** `error` est renseigné quand l'état n'a pas pu être lu (droits, skill introuvable) : `targets` est alors vide. */
export type StatusResult = { targets: TargetStatus[]; error?: string }

declare module 'orca' {
  interface PluginRequests {
    /** Langue d'affichage du panneau (BCP-47) : le worker la retient pour ses propres messages. */
    'locale.set': { input: { locale: string }; output: { ok: true } }
    'network.agents': { output: AgentsView }
    'network.feed': { output: FeedResult }
    /** Met le handle d'un agent dans le presse-papiers du système (le panneau n'y a pas accès). */
    'network.copyHandle': { input: { handle: string }; output: CopyResult }
    'skill.status': { output: StatusResult }
    /** Seul chemin d'installation du panneau : la file de l'installateur ne sérialise que dans ce worker. */
    'skill.install': { output: InstallReport }
    'skill.uninstall': { output: UninstallReport }
  }
  interface PluginPanelEvents {
    /** Envoyé après chaque installation ou désinstallation, d'où qu'elle vienne (panneau ou palette). */
    'skill.changed': { targets: TargetStatus[] }
  }
}
