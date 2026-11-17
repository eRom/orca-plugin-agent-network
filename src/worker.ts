// Worker du plugin : répond au panneau (agents, fil des messages, état des consignes), installe et retire la skill
// d'agent-network (panneau ou palette) et tient le registre de ce qu'il a posé. Orca transpile ce fichier au chargement.
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { JsonValue, OrcaWorkerApi } from 'orca/worker'
import { ClipboardUnavailableError, createClipboardWriter } from './clipboard'
import { localeOf, LOCALES, MESSAGES, type InstallCounts, type Locale, type Messages, type UninstallCounts } from './copy'
import { fetchFeed } from './feed'
import {
  installSkill,
  nodeFileSystem,
  readStatus,
  uninstallSkill,
  type FileSystem,
  type InstallReport,
  type Ledger,
  type LedgerStore,
  type UninstallReport
} from './installer'
import { createOrcaRunner, OrcaCliError, resolveOrcaBinary, type OrcaRunner } from './orca-cli'
import type { AgentsView, CopyResult, FeedResult, StatusResult } from './protocol'
import { skillTargets } from './targets'

/** Clé de stockage du registre des fichiers posés par l'installateur. */
export const LEDGER_KEY = 'skill.ledger'
/** Clé de stockage de la dernière langue annoncée par un panneau. */
export const LOCALE_KEY = 'locale'
/** Copie du registre quand il est illisible : fixe, jamais écrasée. */
export const LEDGER_BACKUP_KEY = 'skill.ledger.corrupt'

/** Tout ce que le worker tient du système : les tests y branchent un HOME factice et un faux CLI. */
export type WorkerDeps = {
  home: string
  readSkill(): Promise<string>
  fs: FileSystem
  runOrca: OrcaRunner
  /** Binaire `orca` résolu, journalisé une fois à l'activation (contrôle en direct). */
  orcaBinary?: string
  /** Chemin de l'exécutable du worker, journalisé avec le binaire pour comprendre une résolution en repli. */
  execPath?: string
  /** Écrit un texte dans le presse-papiers du système. */
  writeClipboard(text: string): Promise<void>
}

export function defaultDeps(): WorkerDeps {
  const orcaBinary = resolveOrcaBinary(process.execPath, existsSync)
  const skillPath = fileURLToPath(new URL('../skills/agent-network/SKILL.md', import.meta.url))
  return {
    home: homedir(),
    readSkill: () => readFile(skillPath, 'utf8'),
    fs: nodeFileSystem(),
    runOrca: createOrcaRunner(orcaBinary),
    orcaBinary,
    execPath: process.execPath,
    writeClipboard: createClipboardWriter(process.platform, process.env)
  }
}

export default function activate(orca: OrcaWorkerApi): Promise<void> {
  return activateWith(orca, defaultDeps())
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'

const KNOWN_TARGETS: ReadonlySet<string> = new Set(skillTargets('').map((target) => target.id))

/** Registre lu depuis un stockage non fiable : toute entrée de forme inattendue invalide l'ensemble. */
function parseLedger(raw: unknown): Ledger | null {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.entries)) return null
  for (const entry of raw.entries) {
    if (
      !isRecord(entry) ||
      typeof entry.target !== 'string' ||
      !KNOWN_TARGETS.has(entry.target) ||
      typeof entry.file !== 'string' ||
      typeof entry.sha256 !== 'string' ||
      !Array.isArray(entry.createdDirs) ||
      !entry.createdDirs.every((dir) => typeof dir === 'string')
    ) {
      return null
    }
  }
  return raw as Ledger
}

/** Bilans par cible. Un dossier de skills peut servir plusieurs harnais : on compte les cibles, pas les harnais. */
function countInstall(report: InstallReport): InstallCounts {
  const counts: InstallCounts = { done: 0, skipped: 0, failed: 0, absent: 0 }
  for (const { outcome } of report.results) {
    if (outcome === 'written' || outcome === 'updated' || outcome === 'unchanged') counts.done++
    else if (outcome === 'skipped-modified' || outcome === 'skipped-foreign') counts.skipped++
    else if (outcome === 'failed') counts.failed++
    else counts.absent++
  }
  return counts
}

function countUninstall(report: UninstallReport): UninstallCounts {
  const counts: UninstallCounts = { removed: 0, kept: 0, failed: 0 }
  for (const { outcome } of report.results) {
    if (outcome === 'removed') counts.removed++
    else if (outcome === 'kept-modified') counts.kept++
    else if (outcome === 'failed') counts.failed++
  }
  return counts
}

export async function activateWith(orca: OrcaWorkerApi, deps: WorkerDeps): Promise<void> {
  /** Langue des résultats de commande et des erreurs : celle du dernier panneau monté, l'anglais avant. */
  let locale: Locale = 'en'
  /** Un panneau a annoncé sa langue : une lecture plus lente du stockage ne doit pas l'écraser. */
  let announced = false
  /** Langue présente dans le stockage, pour n'écrire que lorsqu'elle change. */
  let storedLocale: Locale | null = null
  /** La sauvegarde du registre illisible se fait une seule fois par activation, avec son message. */
  let corruptLedgerHandled = false
  const m = (): Messages => MESSAGES[locale]

  if (deps.orcaBinary) orca.log(`orca binary: ${deps.orcaBinary} (execPath ${deps.execPath ?? 'unknown'})`)

  /** Langue relue au démarrage ; best effort, une lecture refusée laisse l'anglais. */
  async function loadLocale(): Promise<void> {
    try {
      const raw = await orca.storage.get(LOCALE_KEY)
      const known = LOCALES.find((candidate) => candidate === raw)
      if (known) storedLocale = known
      if (known && !announced) locale = known
    } catch (error) {
      orca.log(`locale read failed: ${messageOf(error)}`)
    }
  }
  const ready = loadLocale()

  /**
   * Registre illisible ou de version inconnue : il se charge comme vide, mais la prochaine sauvegarde l'écraserait.
   * On en garde donc une copie sous une clé fixe, sans jamais écraser une copie existante.
   */
  async function backUpCorruptLedger(raw: JsonValue): Promise<void> {
    if (corruptLedgerHandled) return
    corruptLedgerHandled = true
    try {
      if ((await orca.storage.get(LEDGER_BACKUP_KEY)) === null) await orca.storage.set(LEDGER_BACKUP_KEY, raw)
      orca.log(`ledger invalid, loaded as empty (raw value kept under ${LEDGER_BACKUP_KEY})`)
    } catch (error) {
      orca.log(`ledger invalid, loaded as empty, backup failed: ${messageOf(error)}`)
    }
  }

  const ledgerStore: LedgerStore = {
    async load() {
      const raw = await orca.storage.get(LEDGER_KEY)
      if (raw === null) return { version: 1, entries: [] }
      const parsed = parseLedger(raw)
      if (parsed) return parsed
      await backUpCorruptLedger(raw)
      return { version: 1, entries: [] }
    },
    async save(ledger) {
      await orca.storage.set(LEDGER_KEY, ledger)
    }
  }

  /** Lit l'état des cibles sans jamais lever : une erreur de droits devient un message. */
  async function statusNow(): Promise<StatusResult> {
    try {
      const text = await deps.readSkill()
      return { targets: await readStatus(deps.home, text, deps.fs, ledgerStore) }
    } catch (error) {
      orca.log(`status failed: ${messageOf(error)}`)
      return { targets: [], error: m().statusFailed(messageOf(error)) }
    }
  }

  /** Prévient les panneaux ouverts que l'état a changé, d'où que vienne l'opération. */
  async function announceChange(): Promise<void> {
    const status = await statusNow()
    if (!status.error) orca.panels.post('skill.changed', { targets: status.targets })
  }

  async function runInstall(): Promise<InstallReport> {
    try {
      const text = await deps.readSkill()
      return await installSkill(deps.home, text, deps.fs, ledgerStore)
    } finally {
      await announceChange()
    }
  }

  async function runUninstall(): Promise<UninstallReport> {
    try {
      return await uninstallSkill(deps.home, deps.fs, ledgerStore)
    } finally {
      await announceChange()
    }
  }

  /** Message localisé d'une erreur du CLI `orca` ; le texte brut n'arrive jamais au panneau. */
  function feedErrorText(error: unknown): string {
    const code = error instanceof OrcaCliError ? error.code : 'unknown'
    if (code === 'timeout') return m().feedTimeout
    if (code === 'spawn_failed') return m().feedSpawnFailed
    if (code === 'bad_json') return m().feedBadJson
    return m().feedFailed
  }

  orca.panels.handle('locale.set', async ({ locale: tag }) => {
    announced = true
    locale = localeOf(tag)
    await ready
    try {
      if (storedLocale !== locale) {
        await orca.storage.set(LOCALE_KEY, locale)
        storedLocale = locale
      }
    } catch (error) {
      orca.log(`locale write failed: ${messageOf(error)}`)
    }
    return { ok: true as const }
  })

  orca.panels.handle('network.agents', async (): Promise<AgentsView> => {
    try {
      const context = await orca.host.call('workspace.readContext', {})
      if (!context) return { workspace: null, agents: [] }
      const { agents } = await orca.host.call('agents.list', {})
      return {
        workspace: { name: context.displayName },
        // Un agent sans terminal ne peut pas recevoir de message : il n'a pas d'adresse à afficher.
        agents: agents.flatMap((agent) =>
          agent.terminalId === null
            ? []
            : [{ handle: agent.terminalId, agent: agent.agent, title: agent.title, state: agent.state, since: agent.stateStartedAt }]
        )
      }
    } catch (error) {
      // Une erreur de l'hôte ne doit pas faire rejeter la requête : le panneau montre l'état vide.
      orca.log(`agents failed: ${messageOf(error)}`)
      return { workspace: null, agents: [] }
    }
  })

  orca.panels.handle('network.feed', async (): Promise<FeedResult> => {
    try {
      const context = await orca.host.call('workspace.readContext', {})
      if (!context?.workspaceId) return { items: [] }
      const labels = { closedTerminal: m().closedTerminal, shell: m().shell }
      return { items: await fetchFeed(deps.runOrca, context.workspaceId, labels) }
    } catch (error) {
      orca.log(`feed failed code=${error instanceof OrcaCliError ? error.code : 'unknown'}: ${messageOf(error)}`)
      return { error: feedErrorText(error) }
    }
  })

  /**
   * Chaîne des écritures du presse-papiers : une copie ne démarre qu'après le règlement de la précédente (succès ou échec).
   * Le panneau coche la dernière ligne pressée, le presse-papiers doit donc finir avec le dernier identifiant.
   */
  let clipboardQueue: Promise<unknown> = Promise.resolve()

  orca.panels.handle('network.copyHandle', async ({ handle }): Promise<CopyResult> => {
    try {
      const write = clipboardQueue.then(() => deps.writeClipboard(handle))
      // Un échec ne doit pas bloquer la copie suivante : la chaîne avale le rejet, la requête le garde.
      clipboardQueue = write.catch(() => undefined)
      await write
      return { ok: true }
    } catch (error) {
      orca.log(`copy failed: ${messageOf(error)}`)
      const detail = error instanceof ClipboardUnavailableError ? m().clipboardUnavailable : messageOf(error)
      return { error: m().copyFailed(detail) }
    }
  })

  orca.panels.handle('skill.status', () => statusNow())

  orca.panels.handle('skill.install', async () => {
    try {
      return await runInstall()
    } catch (error) {
      orca.log(`install failed: ${messageOf(error)}`)
      throw new Error(m().installFailed(messageOf(error)))
    }
  })

  orca.panels.handle('skill.uninstall', async () => {
    try {
      return await runUninstall()
    } catch (error) {
      orca.log(`uninstall failed: ${messageOf(error)}`)
      throw new Error(m().uninstallFailed(messageOf(error)))
    }
  })

  // Une commande de palette rend toujours une phrase, jamais une erreur brute.
  orca.commands.register('agentNetwork.installSkill', async () => {
    await ready
    try {
      return m().installResult(countInstall(await runInstall()))
    } catch (error) {
      orca.log(`install failed: ${messageOf(error)}`)
      return m().installFailed(messageOf(error))
    }
  })

  orca.commands.register('agentNetwork.uninstallSkill', async () => {
    await ready
    try {
      return m().uninstallResult(countUninstall(await runUninstall()))
    } catch (error) {
      orca.log(`uninstall failed: ${messageOf(error)}`)
      return m().uninstallFailed(messageOf(error))
    }
  })

  await ready
}
