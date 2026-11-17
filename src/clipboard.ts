// Écrit un texte dans le presse-papiers du système : le panneau n'y a pas accès, c'est le worker qui s'en charge.
// Un processus par tentative, sans shell, le texte passe par stdin ; délai borné par un SIGKILL.
import { spawn } from 'node:child_process'

export type ClipboardCommand = { file: string; args: readonly string[] }

/** Aucun des utilitaires de presse-papiers candidats n'est installé. */
export class ClipboardUnavailableError extends Error {
  constructor(tried: readonly string[]) {
    super(`no clipboard tool found (tried: ${tried.join(', ')})`)
    this.name = 'ClipboardUnavailableError'
  }
}

const XCLIP: ClipboardCommand = { file: 'xclip', args: ['-selection', 'clipboard'] }
const WL_COPY: ClipboardCommand = { file: 'wl-copy', args: [] }

/** Les utilitaires à essayer, dans l'ordre, pour cette plateforme. */
export function clipboardCommands(platform: string, env: Record<string, string | undefined>): ClipboardCommand[] {
  if (platform === 'darwin') return [{ file: '/usr/bin/pbcopy', args: [] }]
  if (platform === 'win32') return [{ file: 'clip', args: [] }]
  // Linux : wl-copy d'abord sous Wayland, xclip d'abord sinon ; l'autre sert de secours.
  return env.WAYLAND_DISPLAY ? [WL_COPY, XCLIP] : [XCLIP, WL_COPY]
}

type SpawnFailure = Error & { code?: string }

const MAX_STDERR_CHARS = 200

/** Rend `'missing'` si le binaire n'existe pas (on passe au suivant), `'done'` s'il a réussi, rejette sinon. */
function attempt(command: ClipboardCommand, text: string, timeoutMs: number): Promise<'missing' | 'done'> {
  return new Promise((resolve, reject) => {
    // Une tentative ne se règle qu'une fois : Node peut émettre `error` puis `close` pour le même processus.
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Libère le tube : un serveur de sélection resté en arrière-plan le garde sinon ouvert tant qu'il vit.
      child.stderr?.destroy()
      outcome()
    }

    const child = spawn(command.file, command.args, { stdio: ['pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    // Un EPIPE sur stdin (binaire absent, ou sortie avant lecture) n'est pas l'échec à rapporter : celui-ci vient de
    // l'événement `error` du processus (ENOENT) ou de `close` (sortie prématurée).
    child.stdin?.on('error', () => {})
    child.on('error', (failure: SpawnFailure) => {
      settle(() => (failure.code === 'ENOENT' ? resolve('missing') : reject(failure)))
    })
    // xclip et wl-copy laissent un serveur de sélection en arrière-plan qui peut hériter de stderr : `close` n'arriverait
    // qu'à sa mort. Un code 0 se règle donc dès `exit` ; `close` reste le chemin d'échec, stderr y est complet.
    child.on('exit', (code) => {
      if (code === 0) settle(() => resolve('done'))
    })
    child.on('close', (code) => {
      settle(() =>
        code === 0
          ? resolve('done')
          : reject(new Error(`${command.file} exited with code ${code}: ${stderr.trim().slice(0, MAX_STDERR_CHARS)}`))
      )
    })
    // SIGKILL : un SIGTERM peut être intercepté, le délai ne serait alors pas une borne dure.
    timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL')
        reject(new Error(`${command.file} did not finish within ${timeoutMs} ms`))
      })
    }, timeoutMs)

    child.stdin?.write(text)
    child.stdin?.end()
  })
}

/**
 * Essaie les commandes dans l'ordre. Un binaire absent passe au suivant ; toute autre panne (code de sortie, délai,
 * erreur de lancement) s'arrête là, car un utilitaire présent qui échoue ne sera pas meilleur avec son voisin.
 */
export async function runClipboardCommands(
  commands: readonly ClipboardCommand[],
  text: string,
  timeoutMs = 5000
): Promise<void> {
  for (const command of commands) {
    if ((await attempt(command, text, timeoutMs)) === 'done') return
  }
  throw new ClipboardUnavailableError(commands.map((command) => command.file))
}

export function createClipboardWriter(
  platform: string,
  env: Record<string, string | undefined>
): (text: string) => Promise<void> {
  return (text) => runClipboardCommands(clipboardCommands(platform, env), text)
}
