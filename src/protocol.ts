// Contrat panneau <-> worker, déclaré une fois par fusion de déclarations sur `orca` (gabarit worker-panel d'Orca).
import type { FeedItem } from './feed'
import type { InstallReport, TargetStatus, UninstallReport } from './installer'

export type AgentState = 'working' | 'blocked' | 'waiting' | 'done'

/** Les agents du workspace actif, tels que `agents.list` les rend (un agent sans terminal n'est pas listé). */
export type AgentsView = {
  workspace: { name: string } | null
  agents: { handle: string; agent: string | null; title: string | null; state: AgentState; since: number }[]
}

/** Le fil, ou le message d'erreur localisé à afficher à sa place. */
export type FeedResult = { items: FeedItem[] } | { error: string }

/** `error` est renseigné quand l'état n'a pas pu être lu (droits, skill introuvable) : `targets` est alors vide. */
export type StatusResult = { targets: TargetStatus[]; error?: string }

declare module 'orca' {
  interface PluginRequests {
    /** Langue d'affichage du panneau (BCP-47) : le worker la retient pour ses propres messages. */
    'locale.set': { input: { locale: string }; output: { ok: true } }
    'network.agents': { output: AgentsView }
    'network.feed': { output: FeedResult }
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
