// Tout le texte affiché par le plugin, en un seul endroit, en anglais et en français.
// Module pur (sans 'orca') : le worker, le panneau et les tests l'importent tous.
import type { InstallOutcome, TargetState, UninstallOutcome } from './installer'
import type { AgentState } from './protocol'
import { canonicalAgentId } from './icons'

export type Locale = 'en' | 'fr'

export const LOCALES: readonly Locale[] = ['en', 'fr']

/** Bilan d'une installation, compté par cible (un dossier de skills peut servir plusieurs harnais). */
export type InstallCounts = { done: number; skipped: number; failed: number; absent: number }

/** Bilan d'une désinstallation, compté par cible. */
export type UninstallCounts = { removed: number; kept: number; failed: number }

/** Noms propres des harnais : identiques dans les deux langues. */
const HARNESS_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  dsh: 'DeepSeek Harness',
  grok: 'Grok',
  antigravity: 'Antigravity'
}

/** Nom affichable d'un harnais ; un identifiant inconnu s'affiche tel quel. */
export const harnessName = (id: string): string => {
  const canonical = canonicalAgentId(id) ?? id
  return HARNESS_NAMES[canonical] ?? canonical
}

/** Nom court d'un harnais, pour les lignes étroites du panneau : « DSH » pour DeepSeek Harness. */
export const harnessShortName = (id: string): string => (canonicalAgentId(id) === 'dsh' ? 'DSH' : harnessName(id))

/** Handle d'un terminal Orca assez court pour une infobulle : `term_27a740ab-…` devient `term_…5da274`. */
export function shortHandle(handle: string): string {
  const prefix = 'term_'
  if (!handle.startsWith(prefix) || handle.length - prefix.length <= 8) return handle
  return `${prefix}…${handle.slice(-6)}`
}

export type Messages = {
  // Fil des messages : libellés des parties absentes de la liste des terminaux du workspace.
  /** Un terminal fermé, ou d'un autre workspace : le CLI ne permet pas de les distinguer. */
  closedTerminal: string
  shell: string

  // Erreurs et résultats rendus par le worker.
  feedTimeout: string
  feedSpawnFailed: string
  feedBadJson: string
  feedFailed: string
  statusFailed: (detail: string) => string
  copyFailed: (detail: string) => string
  clipboardUnavailable: string
  installFailed: (detail: string) => string
  uninstallFailed: (detail: string) => string
  installResult: (counts: InstallCounts) => string
  uninstallResult: (counts: UninstallCounts) => string

  // Libellés d'états.
  agentStates: Record<AgentState, string>
  targetStates: Record<TargetState, string>
  /** Une demi-phrase par état de cible (minuscule, sans libellé), à lire après le libellé via `labelled`. */
  targetStateHints: Record<TargetState, string>
  installOutcomes: Record<InstallOutcome, string>
  uninstallOutcomes: Record<UninstallOutcome, string>

  // Panneau.
  sectionAgents: string
  sectionMessages: string
  sectionInstructions: string
  noWorkspace: string
  noAgents: string
  unnamedAgent: string
  noMessages: string
  /** Résumé visible quand la section Messages est repliée : « 3 messages, 1 non lu » ; `unread` à 0 : « 3 messages ». */
  messagesCount: (total: number, unread: number) => string
  replyBadge: string
  unreadBadge: string
  messageRoute: (from: string, to: string) => string
  unknownSender: string
  instructionsHint: string
  /** Résumé visible quand la section Consignes est repliée : « 3 sur 4 installées ». */
  instructionsInstalledCount: (installed: number, total: number) => string
  instructionsUpdateAvailable: string
  instructionsNotInstalled: string
  install: string
  update: string
  uninstall: string
  loading: string
  /** Les agents n'ont pas pu être relus : ceux déjà affichés restent, ce message le dit sans alarmer. */
  agentsStale: string
  /** « libellé : texte » avec la typographie de la langue (espace avant les deux-points en français). */
  labelled: (label: string, text: string) => string
  retry: string
  /** Titre de l'erreur du fil : sans lui, Orca affiche un « Attention » générique. */
  feedUnavailableTitle: string
  refresh: string
  /** Nom accessible du bouton qui copie l'ID d'un agent. */
  copyHandle: (name: string) => string
  /** Infobulle du bouton : l'ID (abrégé) qu'il copie. */
  copyHandleTooltip: (handle: string) => string
  /** Infobulle du bouton pendant la seconde et demie qui suit une copie réussie. */
  copied: string
  /** Date du message illisible : le panneau n'invente pas d'heure. */
  unknownTime: string
  /** Le worker a répondu sans cible ni erreur : rien à installer ni à retirer. */
  noTargets: string
}

const fr: Messages = {
  closedTerminal: 'terminal indisponible',
  shell: 'shell',

  feedTimeout: "Orca ne répond pas : les messages n'ont pas pu être lus à temps.",
  feedSpawnFailed: "Impossible de lancer la commande orca : les messages n'ont pas pu être lus.",
  feedBadJson: "Réponse inattendue d'orca : les messages n'ont pas pu être lus.",
  feedFailed: "Les messages n'ont pas pu être lus.",
  statusFailed: (detail) => `État de l'installation illisible : ${detail}`,
  copyFailed: (detail) => `Copie impossible : ${detail}`,
  clipboardUnavailable: 'aucune commande de presse-papiers sur ce système',
  installFailed: (detail) => `Installation impossible : ${detail}`,
  uninstallFailed: (detail) => `Retrait impossible : ${detail}`,
  installResult: ({ done, skipped, failed, absent }) => {
    const folders = (count: number) => (count === 1 ? '1 dossier de skills' : `${count} dossiers de skills`)
    const parts = [done > 0 ? `Installé dans ${folders(done)}` : 'Rien installé']
    if (skipped > 0) parts.push(`${skipped} ignoré${skipped > 1 ? 's' : ''}`)
    if (failed > 0) parts.push(`${failed} en échec`)
    const absentNote = absent > 0 ? ` ${folders(absent)} sans harnais.` : ''
    return `${parts.join(', ')}.${absentNote}`
  },
  uninstallResult: ({ removed, kept, failed }) => {
    if (removed === 0 && kept === 0 && failed === 0) return 'Rien à retirer.'
    const parts = [removed > 0 ? `Retiré de ${removed === 1 ? '1 dossier de skills' : `${removed} dossiers de skills`}` : 'Rien retiré']
    if (kept > 0) parts.push(`${kept} conservé${kept > 1 ? 's' : ''} (modifié${kept > 1 ? 's' : ''})`)
    if (failed > 0) parts.push(`${failed} en échec`)
    return `${parts.join(', ')}.`
  },

  agentStates: { working: 'Au travail', blocked: 'Bloqué', waiting: 'En attente', done: 'Terminé' },
  targetStates: {
    installed: 'Installé',
    outdated: 'À mettre à jour',
    modified: 'Modifié par toi',
    foreign: 'Dossier tiers',
    'absent-harness': 'Harnais absent',
    'not-installed': 'Non installé'
  },
  targetStateHints: {
    installed: 'à jour.',
    outdated: 'installé par ce plugin, une version plus récente est prête.',
    modified: 'tu as changé le fichier, il est laissé tel quel.',
    foreign: "un dossier agent-network que ce plugin n'a pas écrit, laissé tel quel.",
    'absent-harness': 'rien à installer pour lui.',
    'not-installed': 'prêt à installer.'
  },
  installOutcomes: {
    written: 'Installé',
    updated: 'Mis à jour',
    unchanged: 'Déjà à jour',
    'skipped-modified': 'Ignoré : fichier modifié',
    'skipped-foreign': 'Ignoré : dossier tiers',
    'absent-harness': 'Harnais absent',
    failed: 'Échec'
  },
  uninstallOutcomes: {
    removed: 'Retiré',
    'kept-modified': 'Conservé : fichier modifié',
    'not-installed': 'Non installé',
    failed: 'Échec'
  },

  sectionAgents: 'Agents',
  sectionMessages: 'Messages',
  sectionInstructions: 'Consignes',
  noWorkspace: 'Ouvre un workspace pour voir ses agents.',
  noAgents: 'Aucun agent dans ce workspace.',
  unnamedAgent: 'Terminal',
  noMessages: 'Aucun message pour le moment.',
  messagesCount: (total, unread) => {
    const count = total === 1 ? '1 message' : `${total} messages`
    if (unread === 0) return count
    return `${count}, ${unread === 1 ? '1 non lu' : `${unread} non lus`}`
  },
  replyBadge: 'Réponse',
  unreadBadge: 'Non lu',
  messageRoute: (from, to) => `${from} → ${to}`,
  unknownSender: 'Expéditeur inconnu',
  instructionsHint: 'Installe les consignes qui apprennent à chaque harnais à écrire à ses voisins.',
  instructionsInstalledCount: (installed, total) => `${installed} sur ${total} ${installed === 1 ? 'installée' : 'installées'}`,
  instructionsUpdateAvailable: 'Mise à jour disponible',
  instructionsNotInstalled: 'Non installées',
  install: 'Installer',
  update: 'Mettre à jour',
  uninstall: 'Retirer',
  loading: 'Chargement',
  agentsStale: 'Agents non actualisés.',
  labelled: (label, text) => `${label} : ${text}`,
  retry: 'Réessayer',
  feedUnavailableTitle: 'Messages indisponibles',
  refresh: 'Actualiser',
  copyHandle: (name) => `Copier l'ID de l'agent ${name}`,
  copyHandleTooltip: (handle) => `Copier l'ID (${handle})`,
  copied: 'Copié',
  unknownTime: 'heure inconnue',
  noTargets: 'Aucun dossier de consignes à afficher.'
}

const en: Messages = {
  closedTerminal: 'unavailable terminal',
  shell: 'shell',

  feedTimeout: "Orca isn't answering: couldn't read the messages in time.",
  feedSpawnFailed: "Couldn't run the orca command: the messages couldn't be read.",
  feedBadJson: "Unexpected answer from orca: the messages couldn't be read.",
  feedFailed: "Couldn't read the messages.",
  statusFailed: (detail) => `Couldn't read the install status: ${detail}`,
  copyFailed: (detail) => `Couldn't copy: ${detail}`,
  clipboardUnavailable: 'no clipboard command found on this system',
  installFailed: (detail) => `Couldn't install: ${detail}`,
  uninstallFailed: (detail) => `Couldn't remove: ${detail}`,
  installResult: ({ done, skipped, failed, absent }) => {
    const folders = (count: number) => (count === 1 ? '1 skills folder' : `${count} skills folders`)
    const parts = [done > 0 ? `Installed in ${folders(done)}` : 'Nothing installed']
    if (skipped > 0) parts.push(`${skipped} skipped`)
    if (failed > 0) parts.push(`${failed} failed`)
    const absentNote = absent > 0 ? ` ${folders(absent)} not found (harness absent).` : ''
    return `${parts.join(', ')}.${absentNote}`
  },
  uninstallResult: ({ removed, kept, failed }) => {
    if (removed === 0 && kept === 0 && failed === 0) return 'Nothing to remove.'
    const parts = [removed > 0 ? `Removed from ${removed === 1 ? '1 skills folder' : `${removed} skills folders`}` : 'Nothing removed']
    if (kept > 0) parts.push(`${kept} kept (modified)`)
    if (failed > 0) parts.push(`${failed} failed`)
    return `${parts.join(', ')}.`
  },

  agentStates: { working: 'Working', blocked: 'Blocked', waiting: 'Waiting', done: 'Done' },
  targetStates: {
    installed: 'Installed',
    outdated: 'Update available',
    modified: 'Edited by you',
    foreign: 'Third-party folder',
    'absent-harness': 'Harness not found',
    'not-installed': 'Not installed'
  },
  targetStateHints: {
    installed: 'up to date.',
    outdated: 'installed by this plugin, a newer version is ready.',
    modified: 'you changed the file, left untouched.',
    foreign: 'an agent-network folder not written by this plugin, left untouched.',
    'absent-harness': 'nothing to install for it.',
    'not-installed': 'ready to install.'
  },
  installOutcomes: {
    written: 'Installed',
    updated: 'Updated',
    unchanged: 'Already up to date',
    'skipped-modified': 'Skipped: file edited',
    'skipped-foreign': 'Skipped: third-party folder',
    'absent-harness': 'Harness not found',
    failed: 'Failed'
  },
  uninstallOutcomes: {
    removed: 'Removed',
    'kept-modified': 'Kept: file edited',
    'not-installed': 'Not installed',
    failed: 'Failed'
  },

  sectionAgents: 'Agents',
  sectionMessages: 'Messages',
  sectionInstructions: 'Instructions',
  noWorkspace: 'Open a workspace to see its agents.',
  noAgents: 'No agents in this workspace.',
  unnamedAgent: 'Terminal',
  noMessages: 'No messages yet.',
  messagesCount: (total, unread) => {
    const count = total === 1 ? '1 message' : `${total} messages`
    return unread === 0 ? count : `${count}, ${unread} unread`
  },
  replyBadge: 'Reply',
  unreadBadge: 'Unread',
  messageRoute: (from, to) => `${from} → ${to}`,
  unknownSender: 'Unknown sender',
  instructionsHint: 'Install the instructions that teach each harness to message its neighbors.',
  instructionsInstalledCount: (installed, total) => `${installed} of ${total} installed`,
  instructionsUpdateAvailable: 'Update available',
  instructionsNotInstalled: 'Not installed',
  install: 'Install',
  update: 'Update',
  uninstall: 'Remove',
  loading: 'Loading',
  agentsStale: "Agents couldn't be refreshed.",
  labelled: (label, text) => `${label}: ${text}`,
  retry: 'Retry',
  feedUnavailableTitle: 'Messages unavailable',
  refresh: 'Refresh',
  copyHandle: (name) => `Copy the ID of ${name}`,
  copyHandleTooltip: (handle) => `Copy ID (${handle})`,
  copied: 'Copied',
  unknownTime: 'unknown time',
  noTargets: 'No instruction folder to show.'
}

export const MESSAGES: Record<Locale, Messages> = { en, fr }

/** `fr` quand la sous-étiquette de langue est `fr` (`fr`, `fr-FR`, `fr_CA`), `en` pour tout le reste. */
export function localeOf(tag: string): Locale {
  return /^fr(?:[-_]|$)/i.test(tag.trim()) ? 'fr' : 'en'
}

export const messagesFor = (tag: string): Messages => MESSAGES[localeOf(tag)]
