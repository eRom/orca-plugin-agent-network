// Les harnais de code qui lisent des skills, et où l'installateur dépose celle d'agent-network.
import { join } from 'node:path'

export type TargetId = 'claude' | 'shared' | 'grok' | 'antigravity'

export type SkillTarget = {
  id: TargetId
  /** Les harnais servis par ce dossier de skills (le dossier partagé en sert plusieurs). */
  harnesses: readonly string[]
  /** Un seul de ces chemins suffit à dire que le harnais est installé. */
  presence: readonly string[]
  skillsDir: string
}

/** Nom du dossier de la skill dans chaque `skillsDir`. */
export const SKILL_FOLDER_NAME = 'agent-network'

/** Les quatre cibles, dans l'ordre d'affichage. `home` est toujours passé explicitement : jamais lu ici. */
export function skillTargets(home: string): readonly SkillTarget[] {
  return [
    { id: 'claude', harnesses: ['claude'], presence: [join(home, '.claude')], skillsDir: join(home, '.claude', 'skills') },
    {
      id: 'shared',
      // Pi et OpenCode lisent aussi `~/.agents/skills` (OpenCode lit en plus `~/.claude/skills`).
      harnesses: ['codex', 'dsh', 'pi', 'opencode'],
      presence: [
        join(home, '.agents'),
        join(home, '.codex'),
        join(home, '.dsh'),
        join(home, '.pi'),
        join(home, '.config', 'opencode')
      ],
      skillsDir: join(home, '.agents', 'skills')
    },
    { id: 'grok', harnesses: ['grok'], presence: [join(home, '.grok')], skillsDir: join(home, '.grok', 'skills') },
    {
      id: 'antigravity',
      harnesses: ['antigravity'],
      presence: [join(home, '.gemini', 'config')],
      skillsDir: join(home, '.gemini', 'config', 'skills')
    }
  ]
}

/** Dossier de la skill d'une cible : `<skillsDir>/agent-network`. */
export const skillFolder = (target: SkillTarget): string => join(target.skillsDir, SKILL_FOLDER_NAME)

/** Fichier de la skill d'une cible : `<skillsDir>/agent-network/SKILL.md`. */
export const skillFile = (target: SkillTarget): string => join(skillFolder(target), 'SKILL.md')
