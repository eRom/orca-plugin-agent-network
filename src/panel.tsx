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
import { harnessName, messagesFor, type Messages } from './copy'
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

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Messages dans la langue d'affichage d'Orca, lue à chaque appel. */
const copy = (): Messages => messagesFor(env.locale)

// --- Lectures ---------------------------------------------------------------------------------------------------

/** Numéro de la dernière lecture lancée, par sujet : une réponse en retard sur une plus récente est jetée. */
const latest = { agents: 0, feed: 0, status: 0 }
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

/** Tourne une fois avant le premier rendu ; ce qui est poussé dans `subscriptions` s'arrête avec le panneau. */
export function setup(ctx: PanelContext): void {
  const timers = new Set<ReturnType<typeof setTimeout>>()
  /** Relance `load` dans `delay` ms ; une rafale d'appels ne fait qu'une lecture, à la fin. */
  const debounced = (load: () => Promise<void>, delay: number) => {
    let pending: ReturnType<typeof setTimeout> | undefined
    return () => {
      if (pending !== undefined) clearTimeout(pending)
      pending = setTimeout(() => {
        timers.delete(pending!)
        pending = undefined
        void load()
      }, delay)
      timers.add(pending)
    }
  }
  const scheduleAgents = debounced(loadAgents, AGENTS_DEBOUNCE_MS)
  const scheduleFeed = debounced(loadFeed, FEED_DEBOUNCE_MS)

  ctx.subscriptions.push(
    on('agent.status.changed', () => {
      scheduleAgents()
      scheduleFeed()
    })
  )
  ctx.subscriptions.push(
    on('workspace.changed', ({ context }) => {
      const workspaceId = context?.workspaceId ?? null
      // Un autre workspace : on ne montre pas, même un instant, les agents et le fil du précédent.
      if (lastWorkspaceId !== undefined && workspaceId !== lastWorkspaceId) {
        set(agentsView, null)
        set(feedResult, null)
      }
      lastWorkspaceId = workspaceId
      void loadAll()
    })
  )
  ctx.subscriptions.push(plugin.on('skill.changed', ({ targets }) => set(statusResult, { targets })))

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
    }
  })

  lastWorkspaceId = undefined
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

// --- Présentation -----------------------------------------------------------------------------------------------

/**
 * Un badge par état. Le bloqué est le seul en `danger` (et sa ligne est encadrée en danger) : c'est lui qu'on doit voir.
 * L'attente est en `warning`, le travail en `accent`, le terminé en `success` : quatre teintes, toutes lisibles sur le
 * thème sombre (le badge `neutral` y disparaît sur un fond `muted`, d'où aucun état en neutre).
 */
const AGENT_STATE_TONE: Record<AgentState, Tone> = { blocked: 'danger', waiting: 'warning', working: 'accent', done: 'success' }

/** Teinte du libellé d'état d'une cible ; `null` = texte atténué (rien à signaler). */
const TARGET_STATE_TONE: Record<TargetState, Tone | null> = {
  installed: 'success',
  outdated: 'warning',
  modified: 'warning',
  foreign: 'warning',
  'absent-harness': null,
  'not-installed': null
}

/** Largeur de l'emplacement de tête d'une ligne : icône ou monogramme y tiennent, les noms s'alignent. */
const LEAD_SLOT_WIDTH = 20

/**
 * Sans icône, une pastille ronde porte l'initiale du nom. Elle est posée sur la surface `card`, l'inverse du fond
 * `muted` des groupes : un Badge ou une puce `muted` s'y confondent sur le thème sombre (constaté le 15/11).
 */
function renderMonogram(id: string, name: string) {
  const initial = Array.from(name.trim())[0]
  return (
    <Box key={`monogram-${id}`} width={LEAD_SLOT_WIDTH} height={LEAD_SLOT_WIDTH} radius="full" background="card" align="center" justify="center">
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

function renderAgentRow(m: Messages, agent: AgentsView['agents'][number]) {
  const harness = agent.agent === null ? null : harnessName(agent.agent)
  const name = agent.title ?? harness ?? m.unnamedAgent
  return (
    <Box
      key={`agent-${agent.handle}`}
      direction="row"
      align="center"
      gap="sm"
      padding="sm"
      radius="md"
      background="muted"
      border={agent.state === 'blocked' ? 'danger' : true}
    >
      {renderLead(agent.handle, name, agent.agent)}
      <Box key={`text-${agent.handle}`} grow minWidth={0}>
        <Text weight="medium" truncate>
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
    </Box>
  )
}

function renderAgentsSection(m: Messages) {
  const view = read(agentsView)
  const failure = read(agentsFailure)
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
            <Button variant="outline" size="sm" onPress={loadAgents}>
              {m.retry}
            </Button>
          </Row>
        </Stack>
      )
  } else if (view.agents.length === 0) {
    body = (
      <Text muted size="xs">
        {m.noAgents}
      </Text>
    )
  } else {
    body = <Stack gap="xs">{view.agents.map((agent) => renderAgentRow(m, agent))}</Stack>
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
    <Box key={`message-${item.id}`} gap="xs">
      <Box key={`meta-${item.id}`} direction="row" align="center" gap="sm">
        <Box key={`route-${item.id}`} grow minWidth={0}>
          <Text muted size="xs" truncate>
            {route}
          </Text>
        </Box>
        <Box key={`time-${item.id}`} shrink={false}>
          <Text muted size="xs">
            {item.at === 0 ? m.unknownTime : <RelativeTime at={item.at} format="short" />}
          </Text>
        </Box>
      </Box>
      <Box key={`subject-${item.id}`} direction="row" align="center" gap="xs">
        {item.read ? null : (
          <Box key={`unread-${item.id}`} shrink={false}>
            <Badge tone="accent">{m.unreadBadge}</Badge>
          </Box>
        )}
        <Box key={`subject-text-${item.id}`} grow minWidth={0}>
          <Text weight={item.read ? 'medium' : 'semibold'} truncate>
            {item.subject}
          </Text>
        </Box>
        {item.isReply ? (
          <Box key={`reply-${item.id}`} shrink={false}>
            <Text muted size="xs">
              {m.replyBadge}
            </Text>
          </Box>
        ) : null}
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
        <Callout key="feed-error" tone="danger">
          {result.error}
        </Callout>
        <Row>
          <Button variant="outline" size="sm" onPress={loadFeed}>
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
    body = (
      <Box border radius="md" padding="sm" gap="sm" background="muted">
        {result.items.flatMap((item, index) => (index === 0 ? [renderMessage(m, item)] : [<Separator key={`rule-${item.id}`} />, renderMessage(m, item)]))}
      </Box>
    )
  }
  return (
    <Stack gap="sm">
      {renderSectionHeader(m.sectionMessages, result !== null && 'items' in result && result.items.length > 0 ? String(result.items.length) : null)}
      {body}
    </Stack>
  )
}

/** Une ligne par cible : harnais servis, libellé d'état en couleur, puis la phrase qui dit ce que le plugin en fait. */
function renderTarget(m: Messages, target: StatusResult['targets'][number], index: number) {
  const key = `target-${index}-${target.target}`
  const tone = TARGET_STATE_TONE[target.state]
  return (
    <Box key={key} gap="xs" padding="sm" radius="md" border background="muted">
      <Box key={`head-${key}`} direction="row" align="center" gap="sm">
        {target.harnesses.map((harness) => renderLead(`${key}-${harness}`, harnessName(harness), harness))}
        <Box key={`names-${key}`} grow minWidth={0}>
          <Text weight="medium" truncate>
            {target.harnesses.map(harnessName).join(', ')}
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
      <Text muted size="xs">
        {m.targetStateHints[target.state]}
      </Text>
    </Box>
  )
}

/** Noms affichés des harnais d'une cible, d'après l'état connu ; l'identifiant de la cible à défaut. */
function targetNames(status: StatusResult | null, id: string): string {
  const known = status?.targets.find((target) => target.target === id)
  return known === undefined ? id : known.harnesses.map(harnessName).join(', ')
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
          outcome: result.outcome,
          bad: result.outcome === 'failed',
          warn: result.outcome !== 'written' && result.outcome !== 'updated' && result.outcome !== 'unchanged',
          text: `${targetNames(status, result.target)}: ${m.installOutcomes[result.outcome]}`,
          error: result.error
        }))
      : current.report.results.map((result) => ({
          key: result.target,
          outcome: result.outcome,
          bad: result.outcome === 'failed',
          warn: result.outcome === 'kept-modified',
          text: `${targetNames(status, result.target)}: ${m.uninstallOutcomes[result.outcome]}`,
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
          <Button variant="outline" size="sm" onPress={loadStatus}>
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
    body = (
      <Stack gap="sm">
        <Stack gap="xs">{status.targets.map((target, index) => renderTarget(m, target, index))}</Stack>
        <Row gap="sm" align="center">
          {installable ? (
            <Button variant="solid" size="sm" disabled={working} onPress={() => runAction('install')}>
              {states.includes('outdated') ? m.update : m.install}
            </Button>
          ) : null}
          <Button variant="outline" size="sm" disabled={working || !removable} onPress={() => runAction('uninstall')}>
            {m.uninstall}
          </Button>
        </Row>
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
