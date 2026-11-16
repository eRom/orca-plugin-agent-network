// Installe (et retire) la skill d'agent-network dans le dossier de skills de chaque harnais présent.
// Règle d'or : ne jamais écraser, ni supprimer, un fichier que l'installateur n'a pas écrit lui-même ou que l'utilisateur a modifié.
// Le registre (ledger) garde, par fichier posé, son empreinte sha256 et les dossiers créés pour lui.
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { skillFile, skillFolder, skillTargets, type SkillTarget, type TargetId } from './targets'

/** Le disque, réduit à ce que l'installateur utilise : les tests y branchent de vrais dossiers temporaires. */
export type FileSystem = {
  /** Suit les liens symboliques : un lien cassé n'existe pas. */
  exists(path: string): Promise<boolean>
  /** Ne suit pas le lien : vrai pour un lien symbolique, même cassé. */
  isSymlink(path: string): Promise<boolean>
  /** `null` si le fichier n'existe pas. */
  readText(path: string): Promise<string | null>
  writeText(path: string, text: string): Promise<void>
  /** Crée un seul niveau (le parent doit exister). */
  makeDir(path: string): Promise<void>
  removeFile(path: string): Promise<void>
  /** Retire le dossier s'il est vide ; rend `false` s'il ne l'est pas (ou n'existe plus). */
  removeEmptyDir(path: string): Promise<boolean>
}

export type LedgerEntry = { target: TargetId; file: string; sha256: string; createdDirs: string[] }
export type Ledger = { version: 1; entries: LedgerEntry[] }
export type LedgerStore = { load(): Promise<Ledger>; save(ledger: Ledger): Promise<void> }

export type TargetState = 'installed' | 'outdated' | 'modified' | 'foreign' | 'absent-harness' | 'not-installed'
export type TargetStatus = { target: TargetId; harnesses: readonly string[]; file: string; state: TargetState }

export type InstallOutcome =
  | 'written'
  | 'updated'
  | 'unchanged'
  | 'skipped-modified'
  | 'skipped-foreign'
  | 'absent-harness'
  | 'failed'
export type InstallReport = { results: { target: TargetId; file: string; outcome: InstallOutcome; error?: string }[] }

export type UninstallOutcome = 'removed' | 'kept-modified' | 'not-installed' | 'failed'
export type UninstallReport = { results: { target: TargetId; file: string; outcome: UninstallOutcome; error?: string }[] }

const errorCode = (error: unknown): string | undefined => (error as { code?: string } | null)?.code

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** Disque réel. Seules les absences attendues sont avalées : une erreur de droits remonte. */
export function nodeFileSystem(): FileSystem {
  return {
    async exists(path) {
      try {
        await stat(path)
        return true
      } catch (error) {
        if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return false
        throw error
      }
    },
    async isSymlink(path) {
      try {
        return (await lstat(path)).isSymbolicLink()
      } catch (error) {
        if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') return false
        throw error
      }
    },
    async readText(path) {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return null
        throw error
      }
    },
    async writeText(path, text) {
      await writeFile(path, text, 'utf8')
    },
    async makeDir(path) {
      await mkdir(path)
    },
    async removeFile(path) {
      await unlink(path)
    },
    async removeEmptyDir(path) {
      try {
        await rmdir(path)
        return true
      } catch (error) {
        const code = errorCode(error)
        // ENOTDIR : le chemin est devenu un lien symbolique ou un fichier, ce n'est plus un dossier à nous.
        if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOENT' || code === 'ENOTDIR') return false
        throw error
      }
    }
  }
}

/** Un harnais est présent dès qu'un seul de ses chemins existe. */
async function isPresent(target: SkillTarget, fs: FileSystem): Promise<boolean> {
  for (const path of target.presence) if (await fs.exists(path)) return true
  return false
}

/**
 * Dossiers de l'entrée que l'installateur a le droit de toucher : après normalisation, strictement sous HOME
 * et ancêtres du fichier de l'entrée. Tout le reste d'un registre trafiqué est ignoré, jamais supprimé.
 */
function trustedCreatedDirs(home: string, entry: LedgerEntry): string[] {
  const root = resolve(home)
  return entry.createdDirs.map((dir) => resolve(dir)).filter((dir) => dir.startsWith(root + sep) && entry.file.startsWith(dir + sep))
}

/** Chemins qui ne doivent jamais être des liens symboliques : écrire ou supprimer au travers sortirait de ce qu'on a posé. */
const guardedPaths = (home: string, target: SkillTarget, entry: LedgerEntry | undefined): string[] => [
  ...(entry ? trustedCreatedDirs(home, entry) : []),
  target.skillsDir,
  skillFolder(target),
  skillFile(target)
]

async function hasSymlink(fs: FileSystem, paths: readonly string[]): Promise<boolean> {
  for (const path of paths) if (await fs.isSymlink(path)) return true
  return false
}

/**
 * Étranger : un lien symbolique sur le dossier des skills, celui de la skill, le fichier lui-même ou un dossier que
 * nous avions créé ; ou un fichier présent sans que le registre l'ait posé.
 */
async function isForeign(home: string, target: SkillTarget, fs: FileSystem, entry: LedgerEntry | undefined): Promise<boolean> {
  if (await hasSymlink(fs, guardedPaths(home, target, entry))) return true
  return entry ? false : fs.exists(skillFile(target))
}

export async function readStatus(home: string, skillText: string, fs: FileSystem, store: LedgerStore): Promise<TargetStatus[]> {
  const ledger = await store.load()
  const wanted = sha256(skillText)
  const statuses: TargetStatus[] = []
  for (const target of skillTargets(home)) {
    const file = skillFile(target)
    const entry = ledger.entries.find((candidate) => candidate.file === file)
    let state: TargetState
    if (!(await isPresent(target, fs))) state = 'absent-harness'
    else if (await isForeign(home, target, fs, entry)) state = 'foreign'
    else if (!entry) state = 'not-installed'
    else {
      const text = await fs.readText(file)
      if (text === null) state = 'not-installed'
      else if (sha256(text) !== entry.sha256) state = 'modified'
      else state = entry.sha256 === wanted ? 'installed' : 'outdated'
    }
    statuses.push({ target: target.id, harnesses: target.harnesses, file, state })
  }
  return statuses
}

/**
 * Crée les dossiers manquants un niveau à la fois (du plus proche ancêtre existant vers le dossier de la skill),
 * puis écrit le fichier. Chaque dossier créé est ajouté à `created` au fil de l'eau, même si une étape échoue ensuite.
 */
async function writeSkill(fs: FileSystem, target: SkillTarget, text: string, created: string[]): Promise<void> {
  const missing: string[] = []
  let current = skillFolder(target)
  while (!(await fs.exists(current))) {
    missing.unshift(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const dir of missing) {
    await fs.makeDir(dir)
    created.push(dir)
  }
  await fs.writeText(skillFile(target), text)
}

/** Après un échec, retire (au mieux) les dossiers que cette tentative venait de créer, du plus profond au moins profond. */
async function rollbackDirs(fs: FileSystem, created: readonly string[]): Promise<void> {
  for (const dir of [...created].reverse()) {
    try {
      await fs.removeEmptyDir(dir)
    } catch {
      // Un résidu vaut mieux qu'une erreur qui masque la cause d'origine.
    }
  }
}

/** File d'attente unique : installation et désinstallation s'exécutent une par une, sinon chacune écraserait le registre de l'autre. */
let queue: Promise<unknown> = Promise.resolve()

/** Une erreur d'une opération ne casse pas la file : `queue` ne rejette jamais. */
function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const run = queue.then(operation)
  queue = run.catch(() => undefined)
  return run
}

export function installSkill(home: string, skillText: string, fs: FileSystem, store: LedgerStore): Promise<InstallReport> {
  return serialized(() => installNow(home, skillText, fs, store))
}

export function uninstallSkill(home: string, fs: FileSystem, store: LedgerStore): Promise<UninstallReport> {
  return serialized(() => uninstallNow(home, fs, store))
}

async function installNow(home: string, skillText: string, fs: FileSystem, store: LedgerStore): Promise<InstallReport> {
  const ledger = await store.load()
  const wanted = sha256(skillText)
  const report: InstallReport = { results: [] }

  for (const target of skillTargets(home)) {
    const file = skillFile(target)
    const done = (outcome: InstallOutcome, error?: string) =>
      report.results.push(error === undefined ? { target: target.id, file, outcome } : { target: target.id, file, outcome, error })
    const created: string[] = []
    try {
      if (!(await isPresent(target, fs))) {
        done('absent-harness')
        continue
      }
      const entry = ledger.entries.find((candidate) => candidate.file === file)
      if (await isForeign(home, target, fs, entry)) {
        done('skipped-foreign')
        continue
      }

      if (!entry) {
        await writeSkill(fs, target, skillText, created)
        const fresh: LedgerEntry = { target: target.id, file, sha256: wanted, createdDirs: created }
        ledger.entries.push(fresh)
        try {
          await store.save(ledger)
        } catch (error) {
          // Le registre n'a pas retenu le fichier : on le retire pour ne pas laisser un fichier à nous que personne ne reconnaît.
          ledger.entries.pop()
          await fs.removeFile(file)
          throw error
        }
        done('written')
        continue
      }

      const text = await fs.readText(file)
      if (text === null) {
        // Fichier enregistré mais disparu : on le repose, en gardant la mémoire des dossiers déjà créés par nous.
        const previous = { sha256: entry.sha256, createdDirs: entry.createdDirs }
        await writeSkill(fs, target, skillText, created)
        entry.sha256 = wanted
        entry.createdDirs = [...entry.createdDirs, ...created.filter((dir) => !entry.createdDirs.includes(dir))]
        try {
          await store.save(ledger)
        } catch (error) {
          Object.assign(entry, previous)
          await fs.removeFile(file)
          throw error
        }
        done('written')
      } else if (sha256(text) !== entry.sha256) {
        done('skipped-modified')
      } else if (entry.sha256 === wanted) {
        done('unchanged')
      } else {
        const previous = entry.sha256
        await fs.writeText(file, skillText)
        entry.sha256 = wanted
        try {
          await store.save(ledger)
        } catch (error) {
          // On remet l'ancien texte (dont on connaît l'empreinte) : disque et registre restent d'accord.
          entry.sha256 = previous
          await fs.writeText(file, text)
          throw error
        }
        done('updated')
      }
    } catch (error) {
      await rollbackDirs(fs, created)
      done('failed', errorMessage(error))
    }
  }
  return report
}

async function uninstallNow(home: string, fs: FileSystem, store: LedgerStore): Promise<UninstallReport> {
  const ledger = await store.load()
  const entries = [...ledger.entries]
  const report: UninstallReport = { results: [] }
  const kept: LedgerEntry[] = []

  /** Retire les dossiers créés par l'installateur, du plus profond au moins profond, seulement s'ils sont dignes de confiance et vides. */
  const removeCreatedDirs = async (entry: LedgerEntry): Promise<void> => {
    for (const dir of trustedCreatedDirs(home, entry).reverse()) await fs.removeEmptyDir(dir)
  }

  /** Traite une entrée et dit si elle reste au registre. */
  const handleEntry = async (entry: LedgerEntry): Promise<{ outcome: UninstallOutcome; keep: boolean; error?: string }> => {
    const target = skillTargets(home).find((candidate) => candidate.id === entry.target)
    if (!target || skillFile(target) !== entry.file) {
      return { outcome: 'failed', keep: true, error: 'ledger entry does not match its target in this home' }
    }
    try {
      if (await hasSymlink(fs, guardedPaths(home, target, entry))) return { outcome: 'kept-modified', keep: true }
      const text = await fs.readText(entry.file)
      if (text === null) {
        await removeCreatedDirs(entry)
        return { outcome: 'not-installed', keep: false }
      }
      if (sha256(text) !== entry.sha256) return { outcome: 'kept-modified', keep: true }
      await fs.removeFile(entry.file)
      await removeCreatedDirs(entry)
      return { outcome: 'removed', keep: false }
    } catch (error) {
      return { outcome: 'failed', keep: true, error: errorMessage(error) }
    }
  }

  for (const [index, entry] of entries.entries()) {
    const { outcome, keep, error } = await handleEntry(entry)
    report.results.push(
      error === undefined ? { target: entry.target, file: entry.file, outcome } : { target: entry.target, file: entry.file, outcome, error }
    )
    if (keep) kept.push(entry)
    // Registre sauvegardé après chaque entrée : une coupure en route ne perd aucun fichier posé.
    ledger.entries = [...kept, ...entries.slice(index + 1)]
    await store.save(ledger)
  }
  return report
}
