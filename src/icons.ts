// Icônes des agents selon le thème d'Orca. Module pur : le panneau l'importe, il n'a pas de système de fichiers,
// donc la liste des variantes est une table statique (un test la compare au disque dans les deux sens).

export type ColorScheme = 'light' | 'dark'

/** Agents qui ont une icône livrée : le nom est l'identifiant d'agent d'Orca, le fichier `agent-icons/<id>.png`. */
export const ICONED_AGENTS: readonly string[] = ['claude', 'codex', 'grok', 'antigravity', 'dsh']

/**
 * Images de base (chemin relatif à la racine du plugin) qui ont une variante pour un thème : la variante est dans le
 * sous-dossier `on-<thème>/` du même dossier (`agent-icons/on-light/codex.png`).
 * Orca dessine Codex avec `currentColor` : notre PNG converti est clair, donc illisible sur fond clair.
 */
export const ICON_VARIANTS: Readonly<Record<ColorScheme, readonly string[]>> = {
  light: ['agent-icons/codex.png'],
  dark: []
}

/** Chemin de la variante de `iconPath` pour `colorScheme` si elle existe, sinon `iconPath` inchangé. */
export function themedIcon(iconPath: string, colorScheme: ColorScheme): string {
  if (!ICON_VARIANTS[colorScheme].includes(iconPath)) return iconPath
  const slash = iconPath.lastIndexOf('/')
  return `${iconPath.slice(0, slash)}/on-${colorScheme}/${iconPath.slice(slash + 1)}`
}

/** Icône d'un agent pour le thème, ou `null` quand on n'en livre pas (le panneau dessine alors un monogramme). */
export function agentIcon(agent: string | null, colorScheme: ColorScheme): string | null {
  if (agent === null || !ICONED_AGENTS.includes(agent)) return null
  return themedIcon(`agent-icons/${agent}.png`, colorScheme)
}
