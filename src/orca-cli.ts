// Appelle le CLI `orca` depuis le worker : un processus par appel, sans shell, avec délai et taille de sortie bornés.
import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** Rend le champ `result` du JSON du CLI, ou lève `OrcaCliError`. */
export type OrcaRunner = (args: readonly string[]) => Promise<unknown>

/** `code` vaut `timeout`, `spawn_failed`, `bad_json`, ou le `error.code` renvoyé par le CLI. */
export class OrcaCliError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'OrcaCliError'
    this.code = code
  }
}

const MAX_BUFFER_BYTES = 4 * 1024 * 1024

/**
 * Le binaire embarqué dans l'application si on le trouve, sinon `orca` du PATH.
 * Dans un worker de plugin, `execPath` est souvent un processus auxiliaire d'Electron, rangé dans un `.app` imbriqué
 * (`Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper`) : on prend le `.app` le plus extérieur.
 */
export function resolveOrcaBinary(execPath: string, exists: (path: string) => boolean): string {
  const parts = execPath.split('/')
  const outermost = parts.findIndex((part) => part.endsWith('.app'))
  if (outermost === -1) return 'orca'
  const bundled = join(parts.slice(0, outermost + 1).join('/'), 'Contents', 'Resources', 'bin', 'orca')
  return exists(bundled) ? bundled : 'orca'
}

type ExecFailure = Error & { code?: string | number; killed?: boolean; signal?: string | null }

function parseEnvelope(stdout: string): { ok?: boolean; result?: unknown; error?: { code?: string; message?: string } } | null {
  try {
    const parsed: unknown = JSON.parse(stdout)
    return parsed !== null && typeof parsed === 'object' ? (parsed as { ok?: boolean }) : null
  } catch {
    return null
  }
}

export function createOrcaRunner(binary: string, timeoutMs = 10_000): OrcaRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      // SIGKILL : un SIGTERM peut être intercepté, le délai ne serait alors pas une borne dure.
      execFile(binary, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER_BYTES, encoding: 'utf8' }, (failure, stdout, stderr) => {
        const execError = failure as ExecFailure | null
        if (execError?.killed) {
          reject(new OrcaCliError('timeout', `orca did not answer within ${timeoutMs} ms`))
          return
        }
        if (execError && typeof execError.code === 'string') {
          // Échec avant ou pendant l'exécution (binaire absent, droits, sortie trop grosse) : aucune réponse exploitable.
          reject(new OrcaCliError('spawn_failed', execError.message))
          return
        }
        // Un code de sortie non nul porte souvent quand même l'enveloppe `{ ok: false, error }` sur stdout.
        const envelope = parseEnvelope(stdout)
        if (!envelope) {
          const detail = (stderr || stdout).trim().slice(0, 200)
          reject(new OrcaCliError('bad_json', `orca returned something other than JSON${detail ? `: ${detail}` : ''}`))
          return
        }
        if (envelope.ok === false) {
          reject(new OrcaCliError(envelope.error?.code ?? 'cli_error', envelope.error?.message ?? 'orca reported an error'))
          return
        }
        if (execError) {
          reject(new OrcaCliError('cli_error', execError.message))
          return
        }
        resolve(envelope.result)
      })
    })
}
