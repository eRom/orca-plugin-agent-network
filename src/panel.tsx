// Panneau Network : les agents du workspace, le fil de leurs derniers messages, puis les consignes à installer pour chaque harnais.
// Aucun CSS ni DOM : Orca dessine les composants. Le worker reste le seul à lire le disque et à lancer `orca`.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  EmptyState,
  env,
  IconButton,
  Image,
  on,
  plugin,
  read,
  RelativeTime,
  Row,
  Separator,
  set,
  Skeleton,
  Stack,
  Text,
  type OrcaNode,
  type PanelContext,
  type ReadonlyAtom,
  type Tone
} from 'orca'
import { harnessName, harnessShortName, messagesFor, shortHandle, type Messages } from './copy'
import type { FeedItem } from './feed'
import { agentIcon } from './icons'
import type { InstallReport, TargetState, UninstallReport } from './installer'
import type { AgentState, AgentsView, FeedResult, StatusResult } from './protocol'

/** Relève du fil tant que le panneau est visible. */
export const FEED_POLL_MS = 5000
/** Délai de regroupement des rafales d'événements d'état avant de relire les agents. */
export const AGENTS_DEBOUNCE_MS = 300
/** Idem pour le fil : une lecture coûte deux appels au CLI, on la laisse retomber plus longtemps. */
export const FEED_DEBOUNCE_MS = 1000
/** Durée de l'icône de validation sur le bouton qui vient de copier un ID. */
export const COPIED_FEEDBACK_MS = 1500

/** Retour de la dernière action sur les consignes, gardé brut pour être rendu dans la langue et avec les noms du moment. */
type Feedback =
  | { kind: 'install'; report: InstallReport }
  | { kind: 'uninstall'; report: UninstallReport }
  | { kind: 'error'; message: string }

/** Les agents du workspace actif ; null tant que le worker n'a pas répondu. */
const agentsView = atom<AgentsView | null>(null)
/** Pourquoi la lecture des agents a échoué (le worker injoignable), le cas échéant. */
const agentsFailure = atom<string | null>(null)
/** Le fil, ou son message d'erreur ; null tant que le worker n'a pas répondu. */
const feedResult = atom<FeedResult | null>(null)
/** État des consignes par cible ; null tant que le worker n'a pas répondu. */
const statusResult = atom<StatusResult | null>(null)
/** Vrai pendant une installation ou un retrait : les deux boutons sont alors grisés. */
const busy = atom(false)
const feedback = atom<Feedback | null>(null)
/** Handle de l'agent dont l'ID vient d'être copié (son bouton montre une coche) ; null sinon. */
const copiedHandle = atom<string | null>(null)
/** Pourquoi la dernière copie a échoué, déjà localisé ; null tant qu'aucune n'a échoué. */
const copyFailure = atom<string | null>(null)

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Messages dans la langue d'affichage d'Orca, lue à chaque appel. */
const copy = (): Messages => messagesFor(env.locale)

// --- Lectures ---------------------------------------------------------------------------------------------------

/** Numéro de la dernière lecture lancée, par sujet : une réponse en retard sur une plus récente est jetée. */
const latest = { agents: 0, feed: 0, status: 0, copy: 0 }
/** Minuteur de la coche : une seule à la fois, à l'échelle du module car l'action de copie vit hors de `setup`. */
let copiedTimer: ReturnType<typeof setTimeout> | undefined
/** Une relève est déjà en vol : la suivante attend, pour ne pas empiler les appels au CLI. */
let feedInFlight = false
/** Workspace de la dernière notification `workspace.changed` ; sert à reconnaître un vrai changement. */
let lastWorkspaceId: string | null | undefined

async function loadAgents(): Promise<void> {
  const ticket = ++latest.agents
  try {
    const next = await plugin.request('network.agents')
    if (ticket !== latest.agents) return
    set(agentsView, next)
    set(agentsFailure, null)
  } catch (error) {
    if (ticket === latest.agents) set(agentsFailure, messageOf(error))
  }
}

async function loadFeed(): Promise<void> {
  const ticket = ++latest.feed
  feedInFlight = true
  try {
    const next = await plugin.request('network.feed')
    if (ticket === latest.feed) set(feedResult, next)
  } catch (error) {
    if (ticket === latest.feed) set(feedResult, { error: messageOf(error) })
  } finally {
    if (ticket === latest.feed) feedInFlight = false
  }
}

async function loadStatus(): Promise<void> {
  const ticket = ++latest.status
  try {
    const next = await plugin.request('skill.status')
    if (ticket === latest.status) set(statusResult, next)
  } catch (error) {
    if (ticket === latest.status) set(statusResult, { targets: [], error: messageOf(error) })
  }
}

const loadAll = (): Promise<unknown> => Promise.all([loadAgents(), loadFeed(), loadStatus()])

function clearCopiedTimer(): void {
  if (copiedTimer === undefined) return
  clearTimeout(copiedTimer)
  copiedTimer = undefined
}

/** Efface la coche, l'échec et le minuteur ; une réponse de copie encore en vol est jetée. */
function resetCopyState(): void {
  latest.copy++
  clearCopiedTimer()
  set(copiedHandle, null)
  set(copyFailure, null)
}

/** Tourne une fois avant le premier rendu ; ce qui est poussé dans `subscriptions` s'arrête avec le panneau. */
export function setup(ctx: PanelContext): void {
  // Un nouveau panneau repart sans workspace connu : la première notification n'est pas un changement.
  lastWorkspaceId = undefined
  const timers = new Set<ReturnType<typeof setTimeout>>()
  /** Relance `load` dans `delay` ms ; une rafale d'appels ne fait qu'une lecture, à la fin. `cancel` annule l'attente. */
  const debounced = (load: () => Promise<unknown>, delay: number) => {
    let pending: ReturnType<typeof setTimeout> | undefined
    const cancel = () => {
      if (pending === undefined) return
      clearTimeout(pending)
      timers.delete(pending)
      pending = undefined
    }
    const schedule = () => {
      cancel()
      const handle = setTimeout(() => {
        timers.delete(handle)
        pending = undefined
        void load()
      }, delay)
      pending = handle
      timers.add(handle)
    }
    return { schedule, cancel }
  }
  const agentsReload = debounced(loadAgents, AGENTS_DEBOUNCE_MS)
  const feedReload = debounced(loadFeed, FEED_DEBOUNCE_MS)
  const allReload = debounced(loadAll, AGENTS_DEBOUNCE_MS)

  ctx.subscriptions.push(
    on('agent.status.changed', () => {
      agentsReload.schedule()
      feedReload.schedule()
    })
  )
  ctx.subscriptions.push(
    on('workspace.changed', ({ context }) => {
      const workspaceId = context?.workspaceId ?? null
      // Orca livre le contexte courant dès l'abonnement : les lectures d'ouverture l'ont déjà vu, on le retient seulement.
      if (lastWorkspaceId === undefined) {
        lastWorkspaceId = workspaceId
        return
      }
      if (workspaceId === lastWorkspaceId) {
        // Même workspace (terminal ouvert, fermé ou renommé) : on garde l'affichage et on relit après la rafale.
        allReload.schedule()
        return
      }
      // Un autre workspace : on ne montre pas, même un instant, les agents et le fil du précédent.
      lastWorkspaceId = workspaceId
      // La relecture groupée du workspace précédent n'a plus lieu d'être : `loadAll` va la remplacer.
      allReload.cancel()
      agentsReload.cancel()
      feedReload.cancel()
      set(agentsView, null)
      set(feedResult, null)
      set(agentsFailure, null)
      resetCopyState()
      void loadAll()
    })
  )
  ctx.subscriptions.push(
    plugin.on('skill.changed', ({ targets }) => {
      // Une lecture d'état encore en vol est plus ancienne que ce que le worker vient d'annoncer : on la jette.
      latest.status++
      set(statusResult, { targets })
    })
  )

  // Le minuteur tourne tant que le panneau existe, mais ne lit rien tant qu'on ne le voit pas.
  const visible: ReadonlyAtom<boolean> = ctx.visible
  const poll = setInterval(() => {
    if (read(visible) && !feedInFlight) void loadFeed()
  }, FEED_POLL_MS)
  ctx.subscriptions.push({
    dispose: () => {
      clearInterval(poll)
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      // La coche vit dans un minuteur du module : le panneau fermé, il ne doit plus tirer ni recevoir une réponse en retard.
      latest.copy++
      clearCopiedTimer()
    }
  })

  // D'abord la langue : le worker n'en a pas, il parle la dernière annoncée (erreurs du fil, retour des actions).
  // Un échec est sans gravité : il garde la précédente, l'anglais au départ.
  void plugin
    .request('locale.set', { locale: env.locale })
    .catch(() => undefined)
    .then(loadAll)
}

// --- Actions ----------------------------------------------------------------------------------------------------

/** Les deux requêtes d'écriture partagent le même cycle ; un rejet du worker (échec total) devient un retour d'action. */
async function runAction(kind: 'install' | 'uninstall'): Promise<void> {
  if (read(busy)) return
  set(busy, true)
  set(feedback, null)
  try {
    if (kind === 'install') set(feedback, { kind, report: await plugin.request('skill.install') })
    else set(feedback, { kind, report: await plugin.request('skill.uninstall') })
  } catch (error) {
    set(feedback, { kind: 'error', message: messageOf(error) })
  } finally {
    set(busy, false)
  }
}

/** Demande au worker de copier l'ID d'un agent ; coche pendant `COPIED_FEEDBACK_MS` si c'est fait, ligne d'échec sinon. */
async function copyHandle(handle: string): Promise<void> {
  const ticket = ++latest.copy
  set(copyFailure, null)
  try {
    const result = await plugin.request('network.copyHandle', { handle })
    if (ticket !== latest.copy) return
    if ('error' in result) {
      set(copyFailure, result.error)
      return
    }
    clearCopiedTimer()
    set(copiedHandle, handle)
    copiedTimer = setTimeout(() => {
      copiedTimer = undefined
      set(copiedHandle, null)
    }, COPIED_FEEDBACK_MS)
  } catch (error) {
    if (ticket === latest.copy) set(copyFailure, copy().copyFailed(messageOf(error)))
  }
}

// --- Présentation -----------------------------------------------------------------------------------------------

/**
 * Un badge par état. Orca dessine `danger` plein et `accent` en pastille opaque (blanche en sombre, noire en clair) : seul le
 * bloqué doit être plein, donc l'accent n'est utilisé nulle part. Le travail est en `neutral`, l'attente en `warning`,
 * le terminé en `success` : trois badges discrets à contour, quatre états distincts (relevé sur les captures du 16/11).
 */
const AGENT_STATE_TONE: Record<AgentState, Tone> = { blocked: 'danger', waiting: 'warning', working: 'neutral', done: 'success' }

/** Teinte du libellé d'état d'une cible ; `null` = texte atténué (rien à signaler). */
const TARGET_STATE_TONE: Record<TargetState, Tone | null> = {
  installed: 'success',
  outdated: 'warning',
  modified: 'warning',
  foreign: 'warning',
  'absent-harness': null,
  'not-installed': null
}

/** Ordre des phrases d'explication sous la liste des cibles : ce que l'utilisateur peut agir d'abord. */
const NOTE_ORDER: readonly TargetState[] = ['outdated', 'modified', 'foreign', 'absent-harness', 'not-installed']

/** Largeur de l'emplacement de tête d'une ligne : icône ou monogramme y tiennent, les noms s'alignent. */
const LEAD_SLOT_WIDTH = 20

/**
 * Sans icône, une pastille ronde porte l'initiale du nom. Les lignes sont posées à même le fond du volet : la pastille
 * prend la surface `muted` (la surface `card` se confond avec ce fond sur le thème sombre, constaté le 15/11).
 */
function renderMonogram(id: string, name: string) {
  const initial = Array.from(name.trim())[0]
  return (
    <Box key={`monogram-${id}`} width={LEAD_SLOT_WIDTH} height={LEAD_SLOT_WIDTH} radius="full" background="muted" align="center" justify="center">
      <Text size="xs" weight="medium">
        {initial ? initial.toUpperCase() : '?'}
      </Text>
    </Box>
  )
}

function renderLead(id: string, name: string, agent: string | null) {
  const icon = agentIcon(agent, env.theme.colorScheme)
  return (
    <Box key={`lead-${id}`} width={LEAD_SLOT_WIDTH} shrink={false} align="center" justify="center">
      {icon === null ? renderMonogram(id, name) : <Image src={icon} alt="" size="xs" />}
    </Box>
  )
}

/** Lignes à plat, pleine largeur, séparées par un filet : le rendu d'une liste native du volet d'Orca, sans carte. */
function renderRuled(rows: { key: string; node: OrcaNode }[]) {
  return <Stack gap="none">{rows.flatMap((row, index) => (index === 0 ? [row.node] : [<Separator key={`rule-${row.key}`} />, row.node]))}</Stack>
}

/** Titre de la section : son nom, un complément atténué, et à droite ce que l'appelant y met. */
function renderSectionHeader(title: string, hint: string | null, trailing: OrcaNode = null) {
  return (
    <Row justify="between" align="center" gap="sm">
      <Box key={`title-${title}`} direction="row" align="center" gap="sm" grow minWidth={0}>
        <Text weight="semibold">{title}</Text>
        {hint === null ? null : (
          <Text muted size="xs" truncate>
            {hint}
          </Text>
        )}
      </Box>
      {trailing === null ? null : (
        <Box key={`trailing-${title}`} shrink={false}>
          {trailing}
        </Box>
      )}
    </Row>
  )
}

function renderAgentRow(m: Messages, agent: AgentsView['agents'][number], copied: boolean) {
  const harness = agent.agent === null ? null : harnessName(agent.agent)
  const name = agent.title ?? harness ?? m.unnamedAgent
  return (
    <Box key={`agent-${agent.handle}`} direction="row" align="center" gap="sm" paddingY="sm">
      {renderLead(agent.handle, name, agent.agent)}
      <Box key={`text-${agent.handle}`} grow minWidth={0}>
        <Text weight={agent.state === 'blocked' ? 'semibold' : 'medium'} truncate>
          {name}
        </Text>
        <Text muted size="xs" truncate>
          {agent.title !== null && harness !== null ? `${harness} · ` : ''}
          <RelativeTime at={agent.since} format="short" />
        </Text>
      </Box>
      <Box key={`state-${agent.handle}`} shrink={false}>
        <Badge tone={AGENT_STATE_TONE[agent.state]}>{m.agentStates[agent.state]}</Badge>
      </Box>
      {/* Même variante et même taille que Actualiser, en tête de section : les icônes forment une colonne. */}
      <Box key={`copy-${agent.handle}`} shrink={false}>
        <IconButton
          icon={copied ? 'check' : 'copy'}
          label={m.copyHandle(name)}
          tooltip={copied ? m.copied : m.copyHandleTooltip(shortHandle(agent.handle))}
          variant="ghost"
          size="sm"
          onPress={() => copyHandle(agent.handle)}
        />
      </Box>
    </Box>
  )
}

/** Avis discret quand la relecture des agents échoue alors que la liste (même vide) reste affichée. */
function renderAgentsStale(m: Messages) {
  return (
    <Row key="agents-stale" align="center" gap="sm">
      <Text muted size="xs">
        {m.agentsStale}
      </Text>
      <Button variant="ghost" size="sm" onPress={loadAgents}>
        {m.retry}
      </Button>
    </Row>
  )
}

/** Échec de la copie d'un ID : une ligne discrète sous la liste, sans cadre d'alerte. */
function renderCopyFailure(message: string) {
  return (
    <Text key="copy-failure" tone="danger" size="xs">
      {message}
    </Text>
  )
}

function renderAgentsSection(m: Messages) {
  const view = read(agentsView)
  const failure = read(agentsFailure)
  const copied = read(copiedHandle)
  const copyError = read(copyFailure)
  const refresh = <IconButton icon="refresh" label={m.refresh} variant="ghost" size="sm" onPress={loadAll} />
  let body
  if (view === null) {
    body =
      failure === null ? (
        <Skeleton lines={2} label={m.loading} />
      ) : (
        <Stack gap="sm">
          <Callout tone="danger">{failure}</Callout>
          <Row>
            <Button variant="solid" size="sm" onPress={loadAgents}>
              {m.retry}
            </Button>
          </Row>
        </Stack>
      )
  } else if (view.agents.length === 0) {
    body = (
      <Stack gap="xs">
        <Text muted size="xs">
          {m.noAgents}
        </Text>
        {failure === null ? null : renderAgentsStale(m)}
      </Stack>
    )
  } else {
    body = (
      <Stack gap="xs">
        {renderRuled(view.agents.map((agent) => ({ key: agent.handle, node: renderAgentRow(m, agent, agent.handle === copied) })))}
        {failure === null ? null : renderAgentsStale(m)}
        {copyError === null ? null : renderCopyFailure(copyError)}
      </Stack>
    )
  }
  return (
    <Stack gap="sm">
      {renderSectionHeader(m.sectionAgents, view?.workspace?.name ?? null, refresh)}
      {body}
    </Stack>
  )
}

function renderMessage(m: Messages, item: FeedItem) {
  const route = m.messageRoute(item.from === null ? m.unknownSender : item.from.label, item.to.label)
  return (
    <Box key={`message-${item.id}`} gap="xs" paddingY="sm">
      <Box key={`meta-${item.id}`} direction="row" align="center" gap="sm">
        <Box key={`route-${item.id}`} grow minWidth={0}>
          <Text muted size="xs" truncate>
            {route}
          </Text>
        </Box>
        <Box key={`time-${item.id}`} shrink={false}>
          <Text muted size="xs">
            {item.isReply ? `${m.replyBadge} · ` : ''}
            {item.at === 0 ? m.unknownTime : <RelativeTime at={item.at} format="short" />}
          </Text>
        </Box>
      </Box>
      <Box key={`subject-${item.id}`} direction="row" align="center" gap="xs">
        {item.read ? null : (
          <Box key={`unread-${item.id}`} shrink={false}>
            <Badge tone="neutral">{m.unreadBadge}</Badge>
          </Box>
        )}
        <Box key={`subject-text-${item.id}`} grow minWidth={0}>
          <Text weight={item.read ? 'medium' : 'semibold'} truncate>
            {item.subject}
          </Text>
        </Box>
      </Box>
      {item.preview === '' ? null : (
        <Text muted size="xs" truncate>
          {item.preview}
        </Text>
      )}
    </Box>
  )
}

function renderMessagesSection(m: Messages) {
  const result = read(feedResult)
  let body
  if (result === null) {
    body = <Skeleton lines={3} label={m.loading} />
  } else if ('error' in result) {
    body = (
      <Stack gap="sm">
        <Callout key="feed-error" tone="danger" title={m.feedUnavailableTitle}>
          {result.error}
        </Callout>
        <Row>
          <Button variant="solid" size="sm" onPress={loadFeed}>
            {m.retry}
          </Button>
        </Row>
      </Stack>
    )
  } else if (result.items.length === 0) {
    body = (
      <Text muted size="xs">
        {m.noMessages}
      </Text>
    )
  } else {
    body = renderRuled(result.items.map((item) => ({ key: item.id, node: renderMessage(m, item) })))
  }
  return (
    <Stack gap="sm">
      {renderSectionHeader(m.sectionMessages, result !== null && 'items' in result && result.items.length > 0 ? String(result.items.length) : null)}
      {body}
    </Stack>
  )
}

/** « Claude Code », « Codex · DSH » : assez court pour tenir sur une ligne à 360 px. */
const targetLabel = (harnesses: readonly string[]): string => harnesses.map(harnessShortName).join(' · ')

/** Une ligne par cible, sur une seule ligne : icône, harnais servis, libellé d'état à droite. L'explication se lit sous la liste. */
function renderTarget(m: Messages, target: StatusResult['targets'][number], index: number) {
  const key = `target-${index}-${target.target}`
  const tone = TARGET_STATE_TONE[target.state]
  return (
    <Box key={key} direction="row" align="center" gap="sm" paddingY="sm">
      {/* Un seul emplacement d'icône, de la largeur de celui des agents : les libellés s'alignent d'une section à l'autre.
          Une cible partagée montre l'icône de son premier harnais, son libellé nomme les deux. */}
      {renderLead(key, targetLabel(target.harnesses), target.harnesses[0] ?? null)}
      <Box key={`names-${key}`} grow minWidth={0}>
        <Text weight="medium" truncate>
          {targetLabel(target.harnesses)}
        </Text>
      </Box>
      <Box key={`state-${key}`} shrink={false}>
        {tone === null ? (
          <Text muted size="xs">
            {m.targetStates[target.state]}
          </Text>
        ) : (
          <Text tone={tone} size="xs" weight="medium">
            {m.targetStates[target.state]}
          </Text>
        )}
      </Box>
    </Box>
  )
}

/** Libellé d'une cible d'après l'état connu ; l'identifiant de la cible à défaut. */
function targetName(status: StatusResult | null, id: string): string {
  const known = status?.targets.find((target) => target.target === id)
  return known === undefined ? id : targetLabel(known.harnesses)
}

function renderFeedback(m: Messages, current: Feedback, status: StatusResult | null) {
  if (current.kind === 'error') {
    return (
      <Callout key="action-feedback" tone="danger">
        {current.message}
      </Callout>
    )
  }
  const lines =
    current.kind === 'install'
      ? current.report.results.map((result) => ({
          key: result.target,
          bad: result.outcome === 'failed',
          // Un harnais absent n'est pas un problème : seuls un échec ou un dossier laissé tel quel inquiètent.
          warn: result.outcome === 'skipped-modified' || result.outcome === 'skipped-foreign',
          text: m.labelled(targetName(status, result.target), m.installOutcomes[result.outcome]),
          error: result.error
        }))
      : current.report.results.map((result) => ({
          key: result.target,
          bad: result.outcome === 'failed',
          warn: result.outcome === 'kept-modified',
          text: m.labelled(targetName(status, result.target), m.uninstallOutcomes[result.outcome]),
          error: result.error
        }))
  if (lines.length === 0) return null
  const tone: Tone = lines.some((line) => line.bad) ? 'danger' : lines.some((line) => line.warn) ? 'warning' : 'success'
  return (
    <Callout key="action-feedback" tone={tone}>
      <Stack gap="xs">
        {lines.map((line, index) => (
          <Text key={`feedback-${index}-${line.key}`} size="xs">
            {line.error === undefined ? line.text : `${line.text} (${line.error})`}
          </Text>
        ))}
      </Stack>
    </Callout>
  )
}

function renderInstructionsSection(m: Messages) {
  const status = read(statusResult)
  const current = read(feedback)
  const working = read(busy)
  let body
  if (status === null) {
    body = <Skeleton lines={3} label={m.loading} />
  } else if (status.error !== undefined) {
    body = (
      <Stack gap="sm">
        <Callout key="status-error" tone="danger">
          {status.error}
        </Callout>
        <Row>
          <Button variant="solid" size="sm" onPress={loadStatus}>
            {m.retry}
          </Button>
        </Row>
      </Stack>
    )
  } else if (status.targets.length === 0) {
    body = (
      <Text muted size="xs">
        {m.noTargets}
      </Text>
    )
  } else {
    const states = status.targets.map((target) => target.state)
    const installable = states.some((state) => state === 'not-installed' || state === 'outdated')
    const removable = states.some((state) => state === 'installed' || state === 'outdated')
    // Une phrase par état distinct (et pas par ligne) : quatre dossiers tiers ne répètent pas quatre fois la même.
    const notes = NOTE_ORDER.filter((state) => states.includes(state))
    body = (
      <Stack gap="sm">
        {renderRuled(status.targets.map((target, index) => ({ key: `${index}-${target.target}`, node: renderTarget(m, target, index) })))}
        {notes.length === 0 ? null : (
          <Stack key="state-notes" gap="xs">
            {notes.map((state) => (
              <Text key={`note-${state}`} muted size="xs">
                {m.labelled(m.targetStates[state], m.targetStateHints[state])}
              </Text>
            ))}
          </Stack>
        )}
        {installable || removable ? (
          <Row key="actions" gap="sm" align="center">
            {installable ? (
              <Button variant="solid" size="sm" disabled={working} onPress={() => runAction('install')}>
                {states.includes('outdated') ? m.update : m.install}
              </Button>
            ) : null}
            {removable ? (
              <Button variant="outline" size="sm" disabled={working} onPress={() => runAction('uninstall')}>
                {m.uninstall}
              </Button>
            ) : null}
          </Row>
        ) : null}
        {current === null ? null : renderFeedback(m, current, status)}
      </Stack>
    )
  }
  return (
    <Stack gap="sm">
      {renderSectionHeader(m.sectionInstructions, null)}
      <Text muted size="xs">
        {m.instructionsHint}
      </Text>
      {body}
    </Stack>
  )
}

export default function Panel() {
  const m = copy()
  const view = read(agentsView)
  // Sans workspace, ni agents ni fil : un seul état vide les remplace. Les consignes, elles, n'en dépendent pas.
  if (view !== null && view.workspace === null) {
    return (
      <Stack gap="lg">
        <EmptyState icon="folder" title={m.noWorkspace} />
        {renderInstructionsSection(m)}
      </Stack>
    )
  }
  return (
    <Stack gap="lg">
      {renderAgentsSection(m)}
      {renderMessagesSection(m)}
      {renderInstructionsSection(m)}
    </Stack>
  )
}
