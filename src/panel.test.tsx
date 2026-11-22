// Le panneau Network tourne ici avec le vrai runtime d'Orca ; le worker est remplacé par des réponses simulées.
import { mock } from 'node:test'
import { afterEach, assert, mockHost, mount, test } from 'orca/testing'
import { MESSAGES } from './copy'
import type { InstallReport, UninstallReport } from './installer'
import * as panel from './panel'
import type { AgentsView, CopyResult, FeedResult, StatusResult } from './protocol'
import {
  ALL_INSTALLED,
  BLOCKED_AGENT,
  EMPTY_WORKSPACE_AGENTS,
  FEED,
  LIVE_AGENTS,
  LONG_PREVIEW,
  NONE_INSTALLED,
  OTHER_WORKSPACE_NAME,
  REMOTE_AGENT,
  SILENT_AGENT,
  WORKSPACE_NAME,
  NO_AGENTS,
  ONE_TARGET_OF_EACH_STATE,
  target,
  OTHER_WORKSPACE_AGENTS,
  UNDATED_MESSAGE,
  UNREAD_MESSAGE
} from './test-fixtures'

const EN = MESSAGES.en
const FR = MESSAGES.fr

type Setup = {
  agents?: () => AgentsView | Promise<AgentsView>
  feed?: () => FeedResult | Promise<FeedResult>
  status?: () => StatusResult | Promise<StatusResult>
  install?: () => InstallReport
  uninstall?: () => UninstallReport
  copyHandle?: (input: { handle: string }) => CopyResult
  theme?: 'light' | 'dark'
  locale?: string
  visible?: boolean
  /** Choix mémorisé pour la section Consignes ; `true` par défaut, pour que les tests lisent son contenu sans la déplier. `null` : jamais choisi. */
  instructionsOpen?: boolean | null
  /** Idem pour la section Messages : `true` par défaut, `null` : jamais choisi (repliée). */
  messagesOpen?: boolean | null
}

/** Panneaux montés par le test en cours : démontés après lui, même si une assertion a échoué avant `expectClean`. */
const mounted: { unmount(): Promise<void> }[] = []

afterEach(async () => {
  // Sans cela, un test qui échoue laisse l'intervalle de relève du panneau en vie et `orca plugin test` ne rend pas la main.
  for (const view of mounted.splice(0)) {
    try {
      await view.unmount()
    } catch {
      // Déjà démonté par `expectClean` : rien à faire.
    }
  }
})

/** Ce que le panneau a demandé au worker simulé, et ce que le worker simulé répond maintenant. */
async function open(setup: Setup = {}) {
  const state = {
    agents: setup.agents ?? (() => LIVE_AGENTS),
    feed: setup.feed ?? (() => ({ items: FEED })),
    status: setup.status ?? (() => ({ targets: NONE_INSTALLED })),
    copyHandle: setup.copyHandle ?? ((): CopyResult => ({ ok: true }))
  }
  const calls = { agents: 0, feed: 0, status: 0, install: 0, uninstall: 0, copied: [] as string[] }
  const requestOrder: string[] = []
  const locales: string[] = []
  const host = mockHost({
    requests: {
      'locale.set': (input: { locale: string }) => {
        requestOrder.push('locale.set')
        locales.push(input.locale)
        return { ok: true as const }
      },
      'network.agents': () => {
        requestOrder.push('network.agents')
        calls.agents++
        return state.agents()
      },
      'network.feed': () => {
        requestOrder.push('network.feed')
        calls.feed++
        return state.feed()
      },
      'skill.status': () => {
        requestOrder.push('skill.status')
        calls.status++
        return state.status()
      },
      'skill.install': () => {
        calls.install++
        return setup.install ? setup.install() : { results: [] }
      },
      'skill.uninstall': () => {
        calls.uninstall++
        return setup.uninstall ? setup.uninstall() : { results: [] }
      },
      'network.copyHandle': (input: { handle: string }) => {
        calls.copied.push(input.handle)
        return state.copyHandle(input)
      }
    }
  })
  const view = await mount(panel, {
    host,
    theme: setup.theme,
    locale: setup.locale ?? 'en-US',
    visible: setup.visible,
    persisted: {
      plugin: {
        instructionsOpen: setup.instructionsOpen === undefined ? true : setup.instructionsOpen,
        messagesOpen: setup.messagesOpen === undefined ? true : setup.messagesOpen
      }
    }
  })
  mounted.push(view)
  return { view, state, calls, requestOrder, locales }
}

type View = Awaited<ReturnType<typeof open>>['view']

/** Le groupe repliable portant ce titre : le panneau en dessine deux (Messages et Consignes). */
const collapsibleTitled = (view: View, title: string) => view.findAll({ type: 'Collapsible' }).find((group) => group.props.title === title) ?? null

/** Un panneau propre : rien de jeté, aucun refus de l'hôte, aucun avertissement de rendu. */
async function expectClean(view: View): Promise<void> {
  assert.deepEqual(view.errors, [])
  assert.deepEqual(view.refusals, [])
  assert.deepEqual(view.warnings, [])
  await view.unmount()
}

const STATUS_CHANGED = { workspaceId: null, paneKey: 'tab:pane', state: 'done' as const, receivedAt: 0 }

const CONTEXT = (workspaceId: string, displayName: string) => ({ workspaceId, branch: 'main', displayName, terminals: [] })

/** Remet l'horloge réelle même quand une assertion échoue au milieu d'un test à temps simulé. */
async function withFakeTimers(body: () => Promise<void>): Promise<void> {
  mock.timers.enable({ apis: ['setInterval', 'setTimeout'] })
  try {
    await body()
  } finally {
    mock.timers.reset()
  }
}

type TreeNode = NonNullable<ReturnType<View['tree']>>

/** Les nœuds de l'arbre dessiné qui vérifient `matches`, en profondeur (`findAll` ne rend que les éléments les plus internes). */
const nodesWhere = (node: TreeNode | null, matches: (node: Exclude<TreeNode, string>) => boolean): Exclude<TreeNode, string>[] => {
  if (node === null || typeof node === 'string') return []
  return (matches(node) ? [node] : []).concat((node.children ?? []).flatMap((child) => nodesWhere(child, matches)))
}

/** Identifiants des groupes d'agents mis en évidence (fond `card`) : le workspace affiché, normalement un seul. */
const currentGroupIds = (view: View): string[] =>
  [LIVE_AGENTS, OTHER_WORKSPACE_AGENTS]
    .flatMap((agents) => agents.groups.map((group) => group.id))
    .filter((id, index, ids) => ids.indexOf(id) === index)
    .filter((id) => view.find({ testId: `group-${id}` })?.props.background === 'card')

// --- Agents -----------------------------------------------------------------------------------------------------

test('groups agents by workspace, names above their rows, the shown workspace highlighted', async () => {
  const { view } = await open()
  assert.notEqual(view.find({ type: 'Text', text: WORKSPACE_NAME }), null)
  assert.notEqual(view.find({ type: 'Text', text: OTHER_WORKSPACE_NAME }), null)
  assert.equal(view.find({ type: 'Text', text: WORKSPACE_NAME })?.props.truncate, true)
  assert.deepEqual(currentGroupIds(view), ['wt-main'])
  assert.equal(view.find({ testId: 'group-wt-other' })?.props.background, 'none')
  // Chaque agent est dans le bloc de son workspace, l'ID d'un agent d'un autre workspace se copie aussi.
  assert.equal(view.find({ testId: 'group-wt-main' })?.text.includes('Reviewer'), true)
  assert.equal(view.find({ testId: 'group-wt-main' })?.text.includes(REMOTE_AGENT.title), false)
  assert.equal(view.find({ testId: 'group-wt-other' })?.text.includes(REMOTE_AGENT.title), true)
  // L'ordre est celui du worker.
  const text = JSON.stringify(view.tree())
  assert.ok(text.indexOf(WORKSPACE_NAME) < text.indexOf(OTHER_WORKSPACE_NAME))
  // Le titre de la section ne porte plus de nom de workspace.
  assert.equal(view.find({ testId: 'title-Agents' })?.text, EN.sectionAgents)
  await expectClean(view)
})

test('an agent of another workspace can be copied by its handle', async () => {
  const { view, calls } = await open()
  await view.press({ label: EN.copyHandle(REMOTE_AGENT.title) })
  assert.deepEqual(calls.copied, [REMOTE_AGENT.handle])
  assert.equal(view.find({ label: EN.copyHandle(REMOTE_AGENT.title) })?.props.icon, 'check')
  await expectClean(view)
})

test('an agent whose state is unknown has no badge and no time, only its harness', async () => {
  const { view } = await open()
  const row = view.find({ testId: `agent-${SILENT_AGENT.handle}` })
  assert.ok(row)
  assert.equal(row.text.includes(SILENT_AGENT.title), true)
  assert.equal(row.text.includes('Codex'), true, 'the subline keeps the harness name')
  assert.equal(view.find({ testId: `state-${SILENT_AGENT.handle}` }), null, 'no state badge')
  assert.equal(view.findAll({ type: 'RelativeTime' }).some((time) => time.props.at === null), false)
  // Les agents dont l'état est connu gardent leur pastille.
  assert.notEqual(view.find({ testId: `state-${REMOTE_AGENT.handle}` }), null)
  assert.notEqual(view.find({ testId: `state-${BLOCKED_AGENT.handle}` }), null)
  await expectClean(view)
})

test('an untitled agent with an unknown state shows its harness name only once', async () => {
  const agents: AgentsView = {
    groups: [{ id: 'wt', name: 'Workspace', current: false, agents: [{ handle: 'term_x', agent: 'grok', title: null, state: null, since: null }] }]
  }
  const { view } = await open({ agents: () => agents })
  // Le nom de la ligne est le harnais : pas de seconde ligne qui le répète.
  assert.equal(view.find({ testId: 'agent-term_x' })?.text, 'Grok')
  await expectClean(view)
})

test('shows a blocked agent distinctly', async () => {
  const { view } = await open()
  const tone = (label: string) => view.find({ type: 'Badge', text: label })?.props.tone
  const tones = [tone(EN.agentStates.blocked), tone(EN.agentStates.working), tone(EN.agentStates.waiting), tone(EN.agentStates.done)]
  assert.equal(tones[0], 'danger')
  assert.equal(new Set(tones).size, 4, 'one distinct tone per state')
  // Seul le bloqué est plein : Orca dessine `accent` en pastille opaque, plus voyante qu'un `danger` en thème clair.
  assert.equal(view.findAll({ type: 'Badge' }).some((badge) => badge.props.tone === 'accent'), false, 'no opaque accent pill anywhere')
  assert.equal(tones[1], 'neutral')
  // Le nom de l'agent bloqué passe en gras, ceux des autres non.
  const nameWeight = (handle: string) => view.find({ testId: `agent-${handle}` })?.props
  assert.ok(nameWeight('term_claude') && nameWeight('term_codex'))
  assert.equal(view.findAll({ type: 'Text', text: 'Reviewer' })[0]?.props.weight, 'semibold')
  assert.equal(view.findAll({ type: 'Text', text: 'Builder' })[0]?.props.weight, 'medium')
  await expectClean(view)
})

test('draws flat rows separated by rules: no card, no border, no filled row', async () => {
  const { view } = await open({ status: () => ({ targets: ONE_TARGET_OF_EACH_STATE }) })
  // Seuls les blocs de workspace sont arrondis, et seul celui du workspace affiché a un fond (la surface `card`, car `muted` est celle du badge neutre) ; aucune ligne n'a de cadre.
  assert.equal(view.findAll({ type: 'Box' }).filter((box) => box.props.border !== undefined || box.props.radius === 'md').length, 0)
  const surfaces = nodesWhere(view.tree(), (node) => node.props?.radius === 'md' || node.props?.border !== undefined || node.props?.background === 'card')
  assert.deepEqual(surfaces.map((node) => node.key), ['group-wt-main', 'group-wt-other'])
  assert.deepEqual(surfaces.map((node) => node.props?.background), ['card', 'none'])
  // Cinq agents puis deux dans l'autre workspace, quatre messages et six cibles : un filet entre deux lignes d'une même liste, pas autour.
  assert.equal(view.findAll({ type: 'Separator' }).length, 4 + 1 + 3 + 5)
  await expectClean(view)
})

test('lists an agent by title, then by harness name, with its icon and the time since its state began', async () => {
  const { view } = await open()
  assert.notEqual(view.find({ type: 'Text', text: 'Reviewer' }), null)
  // Sans titre, la ligne porte le nom du harnais.
  assert.notEqual(view.find({ testId: 'agent-term_grok' })?.text.match(/^Grok/), null)
  const icons = view.findAll({ type: 'Image' }).map((image) => image.props.src)
  for (const id of ['claude', 'codex', 'grok', 'antigravity']) assert.ok(icons.includes(`agent-icons/${id}.png`), id)
  const times = view.findAll({ type: 'RelativeTime' }).map((time) => time.props.at)
  assert.ok(times.includes(BLOCKED_AGENT.since), 'the blocked agent shows since when')
  await expectClean(view)
})

test('draws a monogram chip for an agent without an icon', async () => {
  const { view } = await open()
  const row = view.find({ testId: 'agent-term_other' })
  assert.ok(row)
  assert.equal(view.findAll({ type: 'Image' }).filter((image) => String(image.props.src).includes('kimi')).length, 0)
  // Le titre « Scratch » donne l'initiale « S » dans une pastille ronde.
  assert.notEqual(view.find({ testId: 'monogram-term_other' }), null)
  assert.equal(view.find({ testId: 'monogram-term_other' })?.text, 'S')
  await expectClean(view)
})

test('picks the light-theme icon variant only where one is shipped', async () => {
  const light = await open({ theme: 'light' })
  const lightIcons = light.view.findAll({ type: 'Image' }).map((image) => String(image.props.src))
  assert.ok(lightIcons.includes('agent-icons/on-light/codex.png'))
  assert.ok(!lightIcons.includes('agent-icons/codex.png'))
  assert.ok(lightIcons.includes('agent-icons/claude.png'))
  await expectClean(light.view)

  const dark = await open({ theme: 'dark' })
  const darkIcons = dark.view.findAll({ type: 'Image' }).map((image) => String(image.props.src))
  assert.ok(darkIcons.includes('agent-icons/codex.png'))
  assert.ok(!darkIcons.some((src) => src.includes('on-light')))
  await dark.view.emit('theme', { colorScheme: 'light' })
  assert.ok(dark.view.findAll({ type: 'Image' }).some((image) => image.props.src === 'agent-icons/on-light/codex.png'))
  await expectClean(dark.view)
})

// --- Rafraîchissement -------------------------------------------------------------------------------------------

test('announces the locale first, then reads agents, feed and instructions state', async () => {
  const { view, requestOrder, locales } = await open({ locale: 'fr-FR' })
  assert.deepEqual(locales, ['fr-FR'])
  assert.equal(requestOrder[0], 'locale.set')
  assert.deepEqual([...requestOrder.slice(1)].sort(), ['network.agents', 'network.feed', 'skill.status'])
  await expectClean(view)
})

test('reloads agents on agent.status.changed', async () => {
  await withFakeTimers(async () => {
    const { view, calls } = await open()
    const before = { agents: calls.agents, feed: calls.feed }
    await view.emit('agent.status.changed', STATUS_CHANGED)
    await view.emit('agent.status.changed', STATUS_CHANGED)
    mock.timers.tick(panel.AGENTS_DEBOUNCE_MS - 1)
    await view.settled()
    assert.equal(calls.agents, before.agents, 'not before the debounce delay')
    mock.timers.tick(1)
    await view.settled()
    assert.equal(calls.agents, before.agents + 1, 'a burst of events asks once')
    assert.equal(calls.feed, before.feed, 'the feed waits for its own, longer, delay')
    mock.timers.tick(panel.FEED_DEBOUNCE_MS - panel.AGENTS_DEBOUNCE_MS)
    await view.settled()
    assert.equal(calls.feed, before.feed + 1)
    await expectClean(view)
  })
})

test('the context Orca delivers on subscribe does not trigger a second round of reads', async () => {
  await withFakeTimers(async () => {
    const { view, calls } = await open()
    const before = { ...calls }
    await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
    // Ni tout de suite, ni après les délais de regroupement : les lectures d'ouverture ont déjà vu ce workspace.
    mock.timers.tick(panel.FEED_DEBOUNCE_MS * 2)
    await view.settled()
    assert.deepEqual(calls, before)
    assert.notEqual(view.find({ type: 'Text', text: 'Reviewer' }), null)
    await expectClean(view)
  })
})

test('switches workspace on workspace.changed: the agent list stays, the highlight moves, the feed is reloaded', async () => {
  const { view, state, calls } = await open()
  await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
  assert.equal(currentGroupIds(view).join(), 'wt-main')
  const before = { ...calls }
  state.agents = () => OTHER_WORKSPACE_AGENTS
  state.feed = () => ({ items: [] })
  await view.emit('workspace.changed', { context: CONTEXT('w2', 'Other workspace') })
  // Les agents des deux workspaces sont toujours là, seul le groupe en évidence a changé.
  assert.notEqual(view.find({ type: 'Text', text: 'Reviewer' }), null)
  assert.notEqual(view.find({ type: 'Text', text: 'Lone harness' }), null)
  assert.equal(currentGroupIds(view).join(), 'wt-other')
  assert.equal(view.find({ text: UNREAD_MESSAGE.subject }), null, 'the old feed is gone')
  assert.equal(calls.agents, before.agents + 1)
  assert.equal(calls.feed, before.feed + 1)
  assert.equal(calls.status, before.status + 1)
  await expectClean(view)
})

test('keeps the agent list on screen at once while a workspace switch reloads it, but blanks the old feed', async () => {
  const { view, state } = await open()
  await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
  let release: (view: AgentsView) => void = () => undefined
  state.agents = () => new Promise<AgentsView>((resolve) => (release = resolve))
  let releaseFeed: (result: FeedResult) => void = () => undefined
  state.feed = () => new Promise<FeedResult>((resolve) => (releaseFeed = resolve))
  const switching = view.emit('workspace.changed', { context: CONTEXT('w2', 'Other workspace') })
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  assert.notEqual(view.find({ type: 'Text', text: 'Reviewer' }), null, 'the list is global: no blank while it reloads')
  assert.equal(currentGroupIds(view).join(), 'wt-main', 'the highlight moves only with the answer')
  assert.equal(view.find({ text: UNREAD_MESSAGE.subject }), null, 'the previous workspace feed is gone')
  release(OTHER_WORKSPACE_AGENTS)
  releaseFeed({ items: [] })
  await switching
  assert.equal(currentGroupIds(view).join(), 'wt-other')
  await expectClean(view)
})

test('a same-workspace workspace.changed keeps the display and reloads once after a short delay', async () => {
  await withFakeTimers(async () => {
    const { view, calls } = await open()
    await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
    const before = { ...calls }
    await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
    await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
    assert.notEqual(view.find({ type: 'Text', text: 'Reviewer' }), null, 'not blanked')
    assert.deepEqual(calls, before, 'nothing yet')
    mock.timers.tick(panel.AGENTS_DEBOUNCE_MS)
    await view.settled()
    assert.equal(calls.agents, before.agents + 1, 'a burst reads once')
    assert.equal(calls.feed, before.feed + 1)
    assert.equal(calls.status, before.status + 1)
    await expectClean(view)
  })
})

test('drops the answer of a read that a newer one has outrun', async () => {
  const { view, state } = await open()
  let release: (view: AgentsView) => void = () => undefined
  const slow = new Promise<AgentsView>((resolve) => {
    release = resolve
  })
  // La première relecture reste en vol ; la seconde, lancée après, répond tout de suite.
  await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
  let asked = 0
  state.agents = () => (++asked === 1 ? slow : OTHER_WORKSPACE_AGENTS)
  const first = view.emit('workspace.changed', { context: CONTEXT('w2', 'Other workspace') })
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  const second = view.emit('workspace.changed', { context: CONTEXT('w3', 'Third workspace') })
  // Un `emit` attend toutes les requêtes en vol : la lente doit être libérée avant d'attendre quoi que ce soit.
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  release(LIVE_AGENTS)
  await Promise.all([first, second])
  assert.equal(currentGroupIds(view).join(), 'wt-other', 'the older answer does not come back')
  await expectClean(view)
})

test('polls the feed only while visible', async () => {
  await withFakeTimers(async () => {
    const { view, calls } = await open()
    const start = calls.feed
    for (let tick = 0; tick < 2; tick++) {
      mock.timers.tick(panel.FEED_POLL_MS)
      await view.settled()
    }
    assert.equal(calls.feed, start + 2, 'two polls in 10 seconds while visible')

    await view.setVisible(false)
    for (let tick = 0; tick < 2; tick++) {
      mock.timers.tick(panel.FEED_POLL_MS)
      await view.settled()
    }
    assert.equal(calls.feed, start + 2, 'no poll while hidden')

    await view.setVisible(true)
    mock.timers.tick(panel.FEED_POLL_MS)
    await view.settled()
    assert.equal(calls.feed, start + 3, 'polling resumes once visible again')

    await view.unmount()
    mock.timers.tick(panel.FEED_POLL_MS * 3)
    await new Promise<void>((resolve) => resolve())
    assert.equal(calls.feed, start + 3, 'no poll after the panel is closed')
  })
})

test('reloads only the instructions section on skill.changed', async () => {
  const { view, calls } = await open()
  const before = { ...calls }
  assert.notEqual(view.find({ text: EN.install }), null)
  await view.post('skill.changed', { targets: ALL_INSTALLED })
  assert.equal(view.find({ text: EN.install }), null, 'nothing left to install')
  assert.equal(calls.agents, before.agents)
  assert.equal(calls.feed, before.feed)
  assert.equal(calls.status, before.status)
  await expectClean(view)
})

// --- Messages ---------------------------------------------------------------------------------------------------

test('shows each message with its route, subject, preview and time', async () => {
  const { view } = await open()
  assert.notEqual(view.find({ text: 'codex · Builder → claude · Reviewer' }), null)
  assert.notEqual(view.find({ text: UNREAD_MESSAGE.subject }), null)
  const preview = view.find({ type: 'Text', text: LONG_PREVIEW })
  assert.ok(preview, 'the 141-character preview is drawn whole')
  assert.equal(preview.props.truncate, true, 'and cut cleanly at the sidebar width')
  assert.equal(LONG_PREVIEW.length, 141)
  assert.notEqual(view.find({ text: EN.messageRoute(EN.unknownSender, 'grok') }), null)
  assert.notEqual(view.find({ text: EN.messageRoute(EN.closedTerminal, 'antigravity · Docs') }), null)
  await expectClean(view)
})

test('marks unread messages and, discreetly, replies', async () => {
  const { view } = await open()
  assert.equal(view.findAll({ type: 'Badge', text: EN.unreadBadge }).length, 1)
  assert.equal(view.find({ type: 'Badge', text: EN.unreadBadge })?.props.tone, 'neutral', 'quieter than the Blocked pill, visible on both themes')
  assert.equal(view.find({ testId: 'message-m1' })?.text.includes(EN.unreadBadge), true)
  assert.equal(view.find({ testId: 'message-m2' })?.text.includes(EN.unreadBadge), false)
  assert.equal(view.find({ testId: 'message-m2' })?.text.includes(EN.replyBadge), true)
  assert.equal(view.find({ testId: 'message-m1' })?.text.includes(EN.replyBadge), false)
  assert.equal(view.findAll({ type: 'Badge', text: EN.replyBadge }).length, 0, 'a reply is a muted word, not a badge')
  // Le mot est dans la ligne de méta, avec l'heure : rien de cliquable à droite du sujet.
  assert.notEqual(view.find({ type: 'Text', text: new RegExp(`^${EN.replyBadge} · `) }), null)
  assert.equal(view.findAll({ type: 'Text', text: EN.replyBadge }).length, 0, 'never alone, which would read like an action')
  await expectClean(view)
})

test('shows no relative time, only a muted unknown time, for an undated message', async () => {
  const { view } = await open()
  const undated = view.find({ testId: `message-${UNDATED_MESSAGE.id}` })
  assert.ok(undated)
  assert.equal(undated.text.includes(EN.unknownTime), true)
  assert.equal(view.findAll({ type: 'RelativeTime', testId: undefined }).some((time) => time.props.at === 0), false)
  // Les trois autres messages gardent leur heure relative.
  const messageTimes = view.findAll({ type: 'RelativeTime' }).filter((time) => FEED.some((item) => item.at === time.props.at && item.at !== 0))
  assert.equal(messageTimes.length, 3)
  await expectClean(view)
})

test('keeps agents when the feed fails, and says why', async () => {
  const { view, state, calls } = await open({ feed: () => ({ error: EN.feedTimeout }) })
  // Les agents restent affichés ...
  assert.notEqual(view.find({ type: 'Text', text: 'Reviewer' }), null)
  assert.notEqual(view.find({ type: 'Badge', text: EN.agentStates.blocked }), null)
  // ... et l'erreur du fil est visible, sans passer pour un fil vide.
  // Un Callout titré ne livre pas son corps à `text` : on le lit dans l'arbre dessiné.
  assert.notEqual(view.find({ testId: 'feed-error' }), null)
  assert.equal(JSON.stringify(view.tree()).includes(EN.feedTimeout), true, 'the body is unchanged')
  assert.equal(view.find({ testId: 'feed-error' })?.props.title, EN.feedUnavailableTitle)
  assert.equal(EN.feedUnavailableTitle, 'Messages unavailable')
  assert.equal(FR.feedUnavailableTitle, 'Messages indisponibles')
  // « Réessayer » a la même variante à plat que « Installer » : pas d'ombre portée.
  assert.equal(view.find({ type: 'Button', text: EN.retry })?.props.variant, 'solid')
  assert.equal(view.find({ text: EN.noMessages }), null)
  // Réessayer relit le fil.
  state.feed = () => ({ items: FEED })
  const before = calls.feed
  await view.press({ text: EN.retry })
  assert.equal(calls.feed, before + 1)
  assert.equal(view.find({ testId: 'feed-error' }), null)
  assert.notEqual(view.find({ text: UNREAD_MESSAGE.subject }), null)
  await expectClean(view)
})

test('tells apart no agent anywhere, no agent in the shown workspace and no message', async () => {
  const none = await open({ agents: () => NO_AGENTS, feed: () => ({ items: [] }) })
  assert.notEqual(none.view.find({ type: 'Text', text: EN.noAgentsAnywhere }), null)
  assert.equal(none.view.find({ text: EN.noAgents }), null)
  assert.equal(none.view.find({ text: EN.noMessages }), null)
  // Les consignes ne dépendent pas des agents.
  assert.notEqual(none.view.find({ text: EN.install }), null)
  await expectClean(none.view)

  // Le workspace affiché n'a pas d'agent : son groupe reste, avec son nom et une ligne atténuée.
  const empty = await open({ agents: () => EMPTY_WORKSPACE_AGENTS, feed: () => ({ items: [] }) })
  assert.equal(empty.view.find({ text: EN.noAgentsAnywhere }), null)
  assert.notEqual(empty.view.find({ type: 'Text', text: WORKSPACE_NAME }), null)
  assert.equal(empty.view.find({ type: 'Text', text: EN.noAgents })?.props.muted, true)
  // Le groupe Messages le dit une fois, dans sa description.
  assert.equal(messagesGroup(empty.view)?.props.description, EN.noMessages)
  await expectClean(empty.view)
})

// --- Consignes --------------------------------------------------------------------------------------------------

test('shows one dense line per target, and explains each distinct non-installed state once below the list', async () => {
  const targets = [...ONE_TARGET_OF_EACH_STATE, ONE_TARGET_OF_EACH_STATE.find((candidate) => candidate.state === 'foreign')!]
  const { view } = await open({ status: () => ({ targets }) })
  for (const state of ['installed', 'outdated', 'modified', 'foreign', 'absent-harness', 'not-installed'] as const) {
    assert.ok(view.find({ type: 'Text', text: EN.targetStates[state] }), `label of ${state}`)
  }
  // Une phrase par état distinct, jamais par ligne : le dossier tiers y est deux fois, sa phrase une seule.
  for (const state of ['outdated', 'modified', 'foreign', 'absent-harness', 'not-installed'] as const) {
    assert.equal(view.findAll({ text: EN.labelled(EN.targetStates[state], EN.targetStateHints[state]) }).length, 1, state)
  }
  assert.equal(view.find({ text: EN.labelled(EN.targetStates.installed, EN.targetStateHints.installed) }), null)
  assert.match(EN.targetStateHints.foreign, /not written by this plugin, left untouched/)
  assert.match(EN.targetStateHints.modified, /you changed the file, left untouched/)
  // Une cible partagée tient sur une ligne : « Codex · DSH · OpenCode · Pi ».
  assert.equal(view.find({ type: 'Text', text: 'Codex · DSH · OpenCode · Pi' })?.props.truncate, true)
  // La cible partagée ne montre que l'icône de Codex, son libellé nomme tous ses harnais.
  const sources = view.findAll({ type: 'Image' }).map((image) => image.props.src)
  assert.ok(sources.includes('agent-icons/codex.png'))
  assert.equal(sources.includes('agent-icons/dsh.png'), false)
  await expectClean(view)
})

test('offers Update instead of Install when a target is outdated', async () => {
  const { view } = await open({ status: () => ({ targets: ONE_TARGET_OF_EACH_STATE }) })
  assert.notEqual(view.find({ type: 'Button', text: EN.update }), null)
  assert.equal(view.find({ type: 'Button', text: EN.install }), null)
  await expectClean(view)
})

test('install button calls skill.install and shows the result', async () => {
  const report: InstallReport = {
    results: [
      { target: 'claude', file: '/h/.claude/skills/agent-network/SKILL.md', outcome: 'written' },
      { target: 'shared', file: '/h/.agents/skills/agent-network/SKILL.md', outcome: 'skipped-foreign' },
      { target: 'grok', file: '/h/.grok/skills/agent-network/SKILL.md', outcome: 'absent-harness' }
    ]
  }
  const { view, calls } = await open({ install: () => report })
  await view.press({ type: 'Button', text: EN.install })
  assert.equal(calls.install, 1)
  const feedback = view.find({ testId: 'action-feedback' })
  assert.ok(feedback)
  assert.match(feedback.text, /Claude Code: Installed/)
  assert.match(feedback.text, /Codex · DSH · OpenCode · Pi: Skipped: third-party folder/)
  assert.match(feedback.text, /Grok: Harness not found/)
  await expectClean(view)
})

test('remove button calls skill.uninstall and shows the result, and is hidden when nothing is ours', async () => {
  const none = await open()
  assert.equal(none.view.find({ type: 'Button', text: EN.uninstall }), null)
  assert.notEqual(none.view.find({ type: 'Button', text: EN.install }), null)
  await expectClean(none.view)

  const report: UninstallReport = { results: [{ target: 'claude', file: '/h/.claude/skills/agent-network/SKILL.md', outcome: 'removed' }] }
  const { view, calls } = await open({ status: () => ({ targets: ALL_INSTALLED }), uninstall: () => report })
  await view.press({ type: 'Button', text: EN.uninstall })
  assert.equal(calls.uninstall, 1)
  assert.match(view.find({ testId: 'action-feedback' })?.text ?? '', /Claude Code: Removed/)
  await expectClean(view)
})

test('shows the localized message of a rejected install, never an unhandled rejection', async () => {
  const { view } = await open({
    install: () => {
      throw new Error("Couldn't install: disk is read-only")
    }
  })
  await view.press({ type: 'Button', text: EN.install })
  const feedback = view.find({ testId: 'action-feedback' })
  assert.ok(feedback)
  assert.match(feedback.text, /Couldn't install: disk is read-only/)
  assert.equal(feedback.props.tone, 'danger')
  // Le bouton est de nouveau disponible.
  assert.equal(view.find({ type: 'Button', text: EN.install })?.disabled, false)
  await expectClean(view)
})

test('shows why the instructions state could not be read', async () => {
  const { view } = await open({ status: () => ({ targets: [], error: "Couldn't read the install status: EACCES" }) })
  assert.notEqual(view.find({ text: /EACCES/ }), null)
  await expectClean(view)
})

// --- Langue -----------------------------------------------------------------------------------------------------

test('renders in French when locale is fr', async () => {
  const { view } = await open({ locale: 'fr-FR', status: () => ({ targets: ONE_TARGET_OF_EACH_STATE }) })
  assert.notEqual(view.find({ text: FR.agentStates.blocked }), null)
  assert.notEqual(view.find({ text: FR.sectionAgents }), null)
  // Le titre d'un groupe repliable est une propriété du composant, pas un texte dessiné dans son contenu.
  assert.equal(collapsibleTitled(view, FR.sectionInstructions)?.props.title, FR.sectionInstructions)
  assert.equal(collapsibleTitled(view, FR.sectionMessages)?.props.title, FR.sectionMessages)
  assert.notEqual(view.find({ text: FR.update }), null)
  assert.notEqual(view.find({ text: FR.labelled(FR.targetStates.foreign, FR.targetStateHints.foreign) }), null)
  assert.notEqual(view.find({ text: FR.unreadBadge }), null)
  assert.notEqual(view.find({ text: 'codex · Builder → claude · Reviewer' }), null)
  assert.notEqual(view.find({ text: FR.unknownTime }), null)
  assert.equal(view.find({ text: EN.update }), null)
  await expectClean(view)
})

test('draws no em dash in either language', async () => {
  for (const locale of ['en-US', 'fr-FR']) {
    const { view } = await open({ locale, status: () => ({ targets: ONE_TARGET_OF_EACH_STATE }) })
    assert.equal(JSON.stringify(view.tree()).includes(String.fromCharCode(0x2014)), false, locale)
    await expectClean(view)
  }
})

test('shows no button when no target is ours or installable, only the explanation', async () => {
  const targets = [target('foreign', 'claude', ['claude']), target('foreign', 'grok', ['grok']), target('absent-harness', 'antigravity', ['antigravity'])]
  const { view } = await open({ status: () => ({ targets }) })
  assert.equal(view.findAll({ type: 'Button' }).length, 0)
  assert.notEqual(view.find({ text: EN.labelled(EN.targetStates.foreign, EN.targetStateHints.foreign) }), null)
  await expectClean(view)
})

test('shows Remove alone when everything is installed and up to date', async () => {
  const { view } = await open({ status: () => ({ targets: ALL_INSTALLED }) })
  assert.equal(view.find({ type: 'Button', text: EN.install }), null)
  assert.equal(view.find({ type: 'Button', text: EN.update }), null)
  assert.notEqual(view.find({ type: 'Button', text: EN.uninstall }), null)
  await expectClean(view)
})

test('keeps the agents and says they are stale when a reload fails', async () => {
  const { view, state } = await open()
  state.agents = () => {
    throw new Error('worker unreachable')
  }
  await view.press({ label: EN.refresh })
  assert.notEqual(view.find({ type: 'Text', text: 'Reviewer' }), null, 'the data stays')
  assert.notEqual(view.find({ type: 'Text', text: EN.agentsStale }), null)
  assert.equal(view.find({ type: 'Callout' }), null, 'no alarming callout while data is shown')
  // Réessayer relit, et l'avis disparaît quand la lecture réussit.
  state.agents = () => LIVE_AGENTS
  await view.press({ type: 'Button', text: EN.retry })
  assert.equal(view.find({ type: 'Text', text: EN.agentsStale }), null)
  await expectClean(view)
})

test('the stale notice is in French too', async () => {
  const { view, state } = await open({ locale: 'fr-FR' })
  state.agents = () => {
    throw new Error('injoignable')
  }
  await view.press({ label: FR.refresh })
  assert.notEqual(view.find({ type: 'Text', text: FR.agentsStale }), null)
  await expectClean(view)
})

test('a skill.changed announcement beats an older skill.status answer still in flight', async () => {
  const { view, state } = await open()
  let release: (status: StatusResult) => void = () => undefined
  const slowStatus = new Promise<StatusResult>((resolve) => {
    release = resolve
  })
  state.status = () => slowStatus
  // Un second changement de workspace relance les trois lectures, dont `skill.status` qui reste en vol.
  await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
  const switching = view.emit('workspace.changed', { context: CONTEXT('w9', 'Elsewhere') })
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  const announcing = view.post('skill.changed', { targets: ALL_INSTALLED })
  release({ targets: NONE_INSTALLED })
  await Promise.all([switching, announcing])
  assert.equal(view.find({ type: 'Button', text: EN.install }), null, 'the older answer did not overwrite the announcement')
  assert.notEqual(view.find({ type: 'Button', text: EN.uninstall }), null)
  await expectClean(view)
})

test('an install that only meets an absent harness is a success, a skipped folder a warning, a failure a danger', async () => {
  const targets = ['claude', 'shared', 'grok', 'antigravity'] as const
  const run = async (outcomes: InstallReport['results'][number]['outcome'][]) => {
    const report: InstallReport = { results: outcomes.map((outcome, index) => ({ target: targets[index]!, file: '/f', outcome })) }
    const { view } = await open({ install: () => report })
    await view.press({ type: 'Button', text: EN.install })
    const tone = view.find({ testId: 'action-feedback' })?.props.tone
    await expectClean(view)
    return tone
  }
  assert.equal(await run(['written', 'absent-harness']), 'success')
  assert.equal(await run(['written', 'skipped-foreign']), 'warning')
  assert.equal(await run(['written', 'skipped-modified']), 'warning')
  assert.equal(await run(['written', 'failed']), 'danger')
})

test('French feedback lines put a space before the colon, English ones do not', async () => {
  const report: InstallReport = { results: [{ target: 'claude', file: '/f', outcome: 'written' }] }
  const fr = await open({ locale: 'fr-FR', install: () => report })
  await fr.view.press({ type: 'Button', text: FR.install })
  assert.match(fr.view.find({ testId: 'action-feedback' })?.text ?? '', /Claude Code : Installé/)
  await expectClean(fr.view)
  const en = await open({ install: () => report })
  await en.view.press({ type: 'Button', text: EN.install })
  assert.match(en.view.find({ testId: 'action-feedback' })?.text ?? '', /Claude Code: Installed/)
  await expectClean(en.view)
})

test('a workspace switch drops the previous workspace failure, showing the skeleton instead of its danger callout', async () => {
  const { view, state } = await open({
    agents: () => {
      throw new Error('first workspace unreachable')
    }
  })
  assert.notEqual(view.find({ type: 'Callout', text: /first workspace unreachable/ }), null)
  await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
  let release: (view: AgentsView) => void = () => undefined
  state.agents = () => new Promise<AgentsView>((resolve) => (release = resolve))
  const switching = view.emit('workspace.changed', { context: CONTEXT('w2', 'Other workspace') })
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  assert.equal(view.find({ type: 'Callout', text: /first workspace unreachable/ }), null)
  assert.notEqual(view.find({ type: 'Skeleton' }), null)
  release(OTHER_WORKSPACE_AGENTS)
  await switching
  assert.notEqual(view.find({ type: 'Text', text: 'Lone harness' }), null)
  await expectClean(view)
})

test('a pending same-workspace reload does not fire after a switch to another workspace', async () => {
  await withFakeTimers(async () => {
    const { view, calls } = await open()
    await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
    await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
    await view.emit('workspace.changed', { context: CONTEXT('w2', 'Other workspace') })
    const afterSwitch = { ...calls }
    mock.timers.tick(panel.FEED_DEBOUNCE_MS * 2)
    await view.settled()
    assert.deepEqual(calls, afterSwitch, 'the old timer was cancelled')
    await expectClean(view)
  })
})

test('a failed reload with an empty agent list says so, with Retry, instead of staying silent', async () => {
  const { view, state } = await open({ agents: () => EMPTY_WORKSPACE_AGENTS })
  state.agents = () => {
    throw new Error('worker unreachable')
  }
  await view.press({ label: EN.refresh })
  assert.notEqual(view.find({ type: 'Text', text: EN.noAgents }), null)
  assert.notEqual(view.find({ type: 'Text', text: EN.agentsStale }), null)
  state.agents = () => EMPTY_WORKSPACE_AGENTS
  await view.press({ type: 'Button', text: EN.retry })
  assert.equal(view.find({ type: 'Text', text: EN.agentsStale }), null)
  await expectClean(view)
})

test('every agent row and every target row use the same icon slot width, so labels align across sections', async () => {
  const { view } = await open({ status: () => ({ targets: ONE_TARGET_OF_EACH_STATE }) })
  // `findAll` ne rend que les éléments les plus internes : on retrouve chaque emplacement par sa clé.
  const agentSlots = LIVE_AGENTS.groups.flatMap((group) => group.agents).filter((agent) => agent.agent !== 'kimi').map((agent) => view.find({ testId: `lead-${agent.handle}` }))
  const targetSlots = ONE_TARGET_OF_EACH_STATE.map((entry, index) => view.find({ testId: `lead-target-${index}-${entry.target}` }))
  const slots = [...agentSlots, ...targetSlots]
  assert.equal(slots.filter((slot) => slot !== null).length, 4 + 2 + ONE_TARGET_OF_EACH_STATE.length)
  assert.equal(new Set(slots.map((slot) => slot?.props.width)).size, 1)
  assert.equal(typeof slots[0]?.props.width, 'number')
  await expectClean(view)
})

test('an agent reported as dsh-tui gets the dsh icon and the DeepSeek Harness name', async () => {
  const agents: AgentsView = {
    groups: [{ id: 'wt', name: 'Workspace', current: true, agents: [{ handle: 'term_dsh', agent: 'dsh-tui', title: null, state: 'waiting', since: 1000 }] }]
  }
  const { view } = await open({ agents: () => agents })
  assert.ok(view.findAll({ type: 'Image' }).some((image) => image.props.src === 'agent-icons/dsh.png'))
  assert.notEqual(view.find({ type: 'Text', text: 'DeepSeek Harness' }), null)
})

test('the remove button is a secondary outline button', async () => {
  const { view } = await open({ status: () => ({ targets: ALL_INSTALLED }) })
  assert.equal(view.find({ type: 'Button', text: EN.uninstall })?.props.variant, 'outline')
})

// --- Copier l'ID d'un agent -------------------------------------------------------------------------------------

const copyButton = (view: View, name: string) => view.find({ label: EN.copyHandle(name) })

/** Les nœuds de l'arbre dessiné dont la clé commence par `prefix`, en profondeur. */
const nodesKeyed = (node: TreeNode | null, prefix: string): Exclude<TreeNode, string>[] => {
  if (node === null || typeof node === 'string') return []
  const own = node.key?.startsWith(prefix) ? [node] : []
  return own.concat((node.children ?? []).flatMap((child) => nodesKeyed(child, prefix)))
}

test('each agent row ends with a ghost copy button named after the agent', async () => {
  const { view } = await open()
  // Le bouton de copie est la dernière boîte de chaque ligne, après le badge d'état.
  const rows = nodesKeyed(view.tree(), 'agent-')
  assert.equal(rows.length, 7)
  for (const row of rows) {
    const handle = row.key?.slice('agent-'.length)
    const lastTwo = (row.children ?? []).slice(-2).map((child) => (typeof child === 'string' ? child : child.key))
    // Sans état connu, il n'y a pas de badge : le bouton suit directement le texte.
    assert.deepEqual(lastTwo, [handle === SILENT_AGENT.handle ? `text-${handle}` : `state-${handle}`, `copy-${handle}`])
  }
  const reviewer = copyButton(view, 'Reviewer')
  assert.equal(reviewer?.props.icon, 'copy')
  assert.equal(reviewer?.props.variant, 'ghost')
  assert.equal(reviewer?.props.tooltip, EN.copyHandleTooltip('term_claude'))
  const names = ['Reviewer', 'Builder', 'Grok', 'Docs', 'Scratch', REMOTE_AGENT.title, SILENT_AGENT.title]
  assert.equal(names.filter((name) => copyButton(view, name)?.props.icon === 'copy').length, 7)
  await expectClean(view)
})

test('pressing copy sends that row handle and shows a check for 1.5 s', async () => {
  await withFakeTimers(async () => {
    const { view, calls } = await open()
    await view.press({ label: EN.copyHandle('Builder') })
    assert.deepEqual(calls.copied, ['term_codex'])
    assert.equal(copyButton(view, 'Builder')?.props.icon, 'check')
    assert.equal(copyButton(view, 'Builder')?.props.tooltip, EN.copied)
    assert.equal(copyButton(view, 'Reviewer')?.props.icon, 'copy')
    mock.timers.tick(panel.COPIED_FEEDBACK_MS - 1)
    await view.settled()
    assert.equal(copyButton(view, 'Builder')?.props.icon, 'check')
    mock.timers.tick(1)
    await view.settled()
    assert.equal(copyButton(view, 'Builder')?.props.icon, 'copy')
    await expectClean(view)
  })
})

test('copying a second row moves the check and restarts the delay', async () => {
  await withFakeTimers(async () => {
    const { view } = await open()
    await view.press({ label: EN.copyHandle('Builder') })
    mock.timers.tick(1000)
    await view.settled()
    await view.press({ label: EN.copyHandle('Reviewer') })
    assert.equal(copyButton(view, 'Reviewer')?.props.icon, 'check')
    assert.equal(copyButton(view, 'Builder')?.props.icon, 'copy')
    mock.timers.tick(600)
    await view.settled()
    assert.equal(copyButton(view, 'Reviewer')?.props.icon, 'check', 'the first timer did not end the second check')
    mock.timers.tick(900)
    await view.settled()
    assert.equal(copyButton(view, 'Reviewer')?.props.icon, 'copy')
    await expectClean(view)
  })
})

test('closing the panel while the check is shown leaves no error', async () => {
  await withFakeTimers(async () => {
    const { view } = await open()
    await view.press({ label: EN.copyHandle('Builder') })
    await view.unmount()
    mock.timers.tick(panel.COPIED_FEEDBACK_MS * 2)
    await new Promise<void>((resolve) => resolve())
    assert.deepEqual(view.errors, [])
  })
})

test('a failed copy says why under the list, and the next copy clears it', async () => {
  const { view, state } = await open({ copyHandle: () => ({ error: EN.copyFailed('boom') }) })
  await view.press({ label: EN.copyHandle('Builder') })
  assert.notEqual(view.find({ type: 'Text', text: EN.copyFailed('boom') }), null)
  assert.equal(view.find({ type: 'Callout' }), null)
  assert.equal(copyButton(view, 'Builder')?.props.icon, 'copy')
  state.copyHandle = () => ({ ok: true })
  await view.press({ label: EN.copyHandle('Builder') })
  assert.equal(view.find({ type: 'Text', text: EN.copyFailed('boom') }), null)
  await expectClean(view)
})

test('a rejected copy request is shown as a copy failure, never an unhandled rejection', async () => {
  const { view } = await open({
    copyHandle: () => {
      throw new Error('worker unreachable')
    }
  })
  await view.press({ label: EN.copyHandle('Builder') })
  assert.notEqual(view.find({ type: 'Text', text: EN.copyFailed('worker unreachable') }), null)
  await expectClean(view)
})

test('a workspace switch drops the copy failure and the check', async () => {
  await withFakeTimers(async () => {
    const { view, state } = await open({ copyHandle: () => ({ error: EN.copyFailed('boom') }) })
    await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
    await view.press({ label: EN.copyHandle('Builder') })
    assert.notEqual(view.find({ type: 'Text', text: EN.copyFailed('boom') }), null)
    state.copyHandle = () => ({ ok: true })
    await view.press({ label: EN.copyHandle('Builder') })
    assert.equal(copyButton(view, 'Builder')?.props.icon, 'check')
    state.copyHandle = () => ({ error: EN.copyFailed('boom') })
    await view.press({ label: EN.copyHandle('Reviewer') })
    assert.notEqual(view.find({ type: 'Text', text: EN.copyFailed('boom') }), null)
    state.agents = () => LIVE_AGENTS
    await view.emit('workspace.changed', { context: CONTEXT('w2', 'Other workspace') })
    assert.equal(view.find({ type: 'Text', text: EN.copyFailed('boom') }), null)
    assert.equal(view.findAll({ type: 'IconButton' }).filter((button) => button.props.icon === 'check').length, 0, 'the check is gone too')
    await expectClean(view)
  })
})

test('copy labels are French when locale is fr', async () => {
  const { view } = await open({ locale: 'fr-FR' })
  assert.equal(view.find({ label: FR.copyHandle('Reviewer') })?.props.tooltip, FR.copyHandleTooltip('term_claude'))
  assert.equal(view.find({ label: EN.copyHandle('Reviewer') }), null)
  await expectClean(view)
})

// --- Copie : réponses en retard et minuteurs --------------------------------------------------------------------

/** Une réponse que le test libère quand il veut ; la requête reste en vol jusque-là. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

/**
 * Compte les minuteurs de la coche encore en attente (ceux de `COPIED_FEEDBACK_MS`) : le noyau de test ne les expose pas.
 * Se pose par-dessus `setTimeout` du moment, simulé ou réel ; `stop` remet celui qui était là.
 */
async function withFeedbackTimerCount(body: (pending: () => number) => Promise<void>): Promise<void> {
  const host = globalThis as unknown as { setTimeout: (...args: any[]) => unknown; clearTimeout: (timer: unknown) => void }
  const originalSet = host.setTimeout
  const originalClear = host.clearTimeout
  const live = new Set<unknown>()
  host.setTimeout = (callback: (...args: any[]) => void, delay: number, ...rest: any[]) => {
    const timer: unknown = originalSet(
      (...args: any[]) => {
        live.delete(timer)
        callback(...args)
      },
      delay,
      ...rest
    )
    if (delay === panel.COPIED_FEEDBACK_MS) live.add(timer)
    return timer
  }
  host.clearTimeout = (timer: unknown) => {
    live.delete(timer)
    originalClear(timer)
  }
  try {
    await body(() => live.size)
  } finally {
    host.setTimeout = originalSet
    host.clearTimeout = originalClear
  }
}

const iconsChecked = (view: View) => view.findAll({ type: 'IconButton' }).filter((button) => button.props.icon === 'check').length

test('a slower earlier copy answer does not override a newer one', async () => {
  const answers = { term_codex: deferred<CopyResult>(), term_claude: deferred<CopyResult>() }
  const { view } = await open({ copyHandle: ({ handle }) => answers[handle as keyof typeof answers].promise as unknown as CopyResult })
  // `press` attend toutes les requêtes en vol : les deux appuis sont lancés sans attente. Reviewer, appuyé en second,
  // répond d'abord ; Builder répond ensuite, en retard sur une copie plus récente.
  const presses = [view.press({ label: EN.copyHandle('Builder') }), view.press({ label: EN.copyHandle('Reviewer') })]
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  answers.term_claude.resolve({ ok: true })
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  answers.term_codex.resolve({ ok: true })
  await Promise.all(presses)
  assert.equal(copyButton(view, 'Builder')?.props.icon, 'copy', 'the older answer is dropped')
  assert.equal(copyButton(view, 'Reviewer')?.props.icon, 'check')
  await expectClean(view)
})

test('a copy answer that lands after a workspace switch shows nothing', async () => {
  const late = deferred<CopyResult>()
  const { view } = await open({ copyHandle: () => late.promise as unknown as CopyResult })
  await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
  // `press` et `emit` attendent les requêtes en vol : on les lance sans attente, puis on répond une fois le changement vu.
  const press = view.press({ label: EN.copyHandle('Builder') })
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  const switching = view.emit('workspace.changed', { context: CONTEXT('w2', 'Other workspace') })
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
  late.resolve({ error: EN.copyFailed('late') })
  await Promise.all([press, switching])
  assert.equal(view.find({ type: 'Text', text: EN.copyFailed('late') }), null)
  assert.equal(iconsChecked(view), 0)
  await expectClean(view)
})

test('a copy answer that lands after the panel closed changes nothing', async () => {
  await withFeedbackTimerCount(async (pending) => {
    const late = deferred<CopyResult>()
    const { view } = await open({ copyHandle: () => late.promise as unknown as CopyResult })
    const press = view.press({ label: EN.copyHandle('Builder') })
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    // `unmount` attend lui aussi la requête en vol : on le lance, on laisse le panneau se fermer, puis on répond.
    const closing = view.unmount()
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    late.resolve({ ok: true })
    await Promise.all([press, closing])
    assert.deepEqual(view.errors, [])
    assert.equal(pending(), 0, 'a late answer starts no check timer on a closed panel')
    // L'état de copie est celui du module : une réponse tardive qui s'y serait posée se verrait sur le panneau suivant.
    const next = await open()
    assert.equal(iconsChecked(next.view), 0, 'a late answer left no check behind')
    await expectClean(next.view)
  })
})

test('a panel opened after another one was closed on a check starts without it', async () => {
  await withFakeTimers(async () => {
    const first = await open()
    await first.view.press({ label: EN.copyHandle('Builder') })
    assert.equal(copyButton(first.view, 'Builder')?.props.icon, 'check')
    await first.view.unmount()
    const second = await open()
    assert.equal(iconsChecked(second.view), 0)
    await expectClean(second.view)
  })
})

test('closing the panel stops the check timer: no callback runs against the closed panel', async () => {
  await withFakeTimers(async () => {
    await withFeedbackTimerCount(async (pending) => {
      const { view } = await open()
      await view.press({ label: EN.copyHandle('Builder') })
      assert.equal(copyButton(view, 'Builder')?.props.icon, 'check')
      assert.equal(pending(), 1, 'the check timer runs while the panel is open')
      await view.unmount()
      assert.equal(pending(), 0, 'the check timer is cleared with the panel')
      mock.timers.tick(panel.COPIED_FEEDBACK_MS)
      await new Promise<void>((resolve) => resolve())
      assert.deepEqual(view.errors, [])
      assert.deepEqual(view.warnings, [])
    })
  })
})

test('a workspace switch stops the old check timer, which must not reset a newer check', async () => {
  await withFakeTimers(async () => {
    await withFeedbackTimerCount(async (pending) => {
      const { view } = await open()
      await view.emit('workspace.changed', { context: CONTEXT('w1', 'My workspace') })
      await view.press({ label: EN.copyHandle('Builder') })
      assert.equal(copyButton(view, 'Builder')?.props.icon, 'check')
      assert.equal(pending(), 1)
      mock.timers.tick(1000)
      await view.settled()
      await view.emit('workspace.changed', { context: CONTEXT('w2', 'Other workspace') })
      assert.equal(iconsChecked(view), 0)
      assert.equal(pending(), 0, 'the switch cleared the old check timer')
      await view.press({ label: EN.copyHandle('Reviewer') })
      assert.equal(copyButton(view, 'Reviewer')?.props.icon, 'check')
      // 1000 + 600 = 1,6 s depuis la première copie : son minuteur aurait tiré, le nouveau court encore.
      mock.timers.tick(600)
      await view.settled()
      assert.equal(copyButton(view, 'Reviewer')?.props.icon, 'check', 'the old timer did not end the new check')
      mock.timers.tick(panel.COPIED_FEEDBACK_MS - 600)
      await view.settled()
      assert.equal(copyButton(view, 'Reviewer')?.props.icon, 'copy')
      await expectClean(view)
    })
  })
})

// --- Section Consignes repliable ---------------------------------------------------------------------------------

const instructionsGroup = (view: View) => collapsibleTitled(view, EN.sectionInstructions) ?? collapsibleTitled(view, FR.sectionInstructions)

/** Le groupe Consignes, ou une erreur claire : les gestes (`toggle`, `valueOf`) le relisent à chaque appel, il change après un rendu. */
const requireInstructions = (view: View) => {
  const group = instructionsGroup(view)
  assert.ok(group)
  return group
}

test('the instructions group starts open when nothing is installed, hint and buttons included', async () => {
  const { view } = await open({ instructionsOpen: null, status: () => ({ targets: NONE_INSTALLED }) })
  const group = instructionsGroup(view)
  assert.ok(group)
  assert.equal(view.valueOf(group), true)
  assert.notEqual(view.find({ text: EN.instructionsHint }), null)
  assert.notEqual(view.find({ type: 'Button', text: EN.install }), null)
  assert.equal(group.props.description, EN.instructionsNotInstalled)
  await expectClean(view)
})

test('the instructions group starts closed when everything is installed, and the summary stays visible', async () => {
  const { view } = await open({ instructionsOpen: null, status: () => ({ targets: ALL_INSTALLED }) })
  const group = instructionsGroup(view)
  assert.ok(group)
  assert.equal(view.valueOf(group), false)
  assert.equal(group.props.title, EN.sectionInstructions)
  assert.equal(group.props.description, EN.instructionsInstalledCount(4, 4))
  // Le contenu d'un groupe replié n'est pas dessiné.
  assert.equal(view.find({ text: EN.instructionsHint }), null)
  assert.equal(view.find({ type: 'Button', text: EN.uninstall }), null)
  await expectClean(view)
})

test('opening the closed group shows the hint, the target rows and the buttons', async () => {
  const { view } = await open({ instructionsOpen: null, status: () => ({ targets: ALL_INSTALLED }) })
  await view.toggle(requireInstructions(view))
  assert.equal(view.valueOf(requireInstructions(view)), true)
  assert.notEqual(view.find({ text: EN.instructionsHint }), null)
  assert.notEqual(view.find({ type: 'Button', text: EN.uninstall }), null)
  await expectClean(view)
})

test('the user choice is persisted and wins over the default after a remount', async () => {
  const first = await open({ instructionsOpen: null, status: () => ({ targets: ALL_INSTALLED }) })
  assert.equal(first.view.persisted.plugin.instructionsOpen ?? null, null)
  await first.view.toggle(requireInstructions(first.view))
  assert.equal(first.view.persisted.plugin.instructionsOpen, true)
  const saved = first.view.persisted.plugin.instructionsOpen as boolean
  await first.view.unmount()

  // Rouvert avec le choix mémorisé : la section reste dépliée alors que tout est installé.
  const reopened = await open({ instructionsOpen: saved, status: () => ({ targets: ALL_INSTALLED }) })
  assert.equal(reopened.view.valueOf(requireInstructions(reopened.view)), true)
  // Fermée par l'utilisateur sur une installation vide : la section reste repliée.
  await reopened.view.toggle(requireInstructions(reopened.view))
  assert.equal(reopened.view.persisted.plugin.instructionsOpen, false)
  await reopened.view.unmount()
  const closed = await open({ instructionsOpen: false, status: () => ({ targets: NONE_INSTALLED }) })
  assert.equal(closed.view.valueOf(requireInstructions(closed.view)), false)
  await expectClean(closed.view)
})

// `mount` attend la fin des lectures en vol : l'état « en cours de lecture » ne se pose pas dans un panneau monté, on le pose à la règle.
test('the instructions group stays collapsed while the state loads and the user never chose', () => {
  assert.equal(panel.isInstructionsOpen(null, null, false), false)
  // Le choix de l'utilisateur l'emporte, même pendant la lecture.
  assert.equal(panel.isInstructionsOpen(true, null, false), true)
  assert.equal(panel.isInstructionsOpen(false, null, true), false)
  // La réponse arrive : rien d'installé, ouverte ; tout installé, repliée.
  assert.equal(panel.isInstructionsOpen(null, { targets: NONE_INSTALLED }, false), true)
  assert.equal(panel.isInstructionsOpen(null, { targets: ALL_INSTALLED }, false), false)
})

test('an install from the default-open state keeps the group open on its feedback, skipped warnings included', async () => {
  const report: InstallReport = {
    results: [
      { target: 'claude', file: '/f', outcome: 'written' },
      { target: 'shared', file: '/f', outcome: 'skipped-foreign' }
    ]
  }
  const { view } = await open({ instructionsOpen: null, status: () => ({ targets: NONE_INSTALLED }), install: () => report })
  assert.equal(view.valueOf(requireInstructions(view)), true)
  await view.press({ type: 'Button', text: EN.install })
  // Le worker annonce l'état installé : sans choix mémorisé, la section ne se referme pas sur le retour d'action.
  await view.post('skill.changed', { targets: ALL_INSTALLED })
  assert.equal(view.valueOf(requireInstructions(view)), true)
  const feedback = view.find({ testId: 'action-feedback' })
  assert.ok(feedback)
  assert.equal(feedback.props.tone, 'warning')
  assert.match(feedback.text, /Skipped: third-party folder/)
  await expectClean(view)
})

test('an update never forces the group open once the user closed it', async () => {
  const { view } = await open({ instructionsOpen: false, status: () => ({ targets: ALL_INSTALLED }) })
  await view.post('skill.changed', { targets: ONE_TARGET_OF_EACH_STATE })
  const group = instructionsGroup(view)
  assert.ok(group)
  assert.equal(view.valueOf(group), false)
  assert.equal(group.props.description, EN.instructionsUpdateAvailable)
  await expectClean(view)
})

test('the summary says an update is available while the group is closed', async () => {
  const { view } = await open({ instructionsOpen: null, status: () => ({ targets: ONE_TARGET_OF_EACH_STATE }) })
  const group = instructionsGroup(view)
  assert.ok(group)
  assert.equal(view.valueOf(group), false)
  assert.equal(group.props.description, EN.instructionsUpdateAvailable)
  await expectClean(view)
})

test('the instructions group is titled and summarized in French when locale is fr', async () => {
  const { view } = await open({ locale: 'fr-FR', instructionsOpen: null, status: () => ({ targets: ALL_INSTALLED }) })
  const group = instructionsGroup(view)
  assert.ok(group)
  assert.equal(group.props.title, FR.sectionInstructions)
  assert.equal(group.props.description, '4 sur 4 installées')
  await expectClean(view)
})

test('the instructions group has no summary when the state cannot be read, and stays open to show why', async () => {
  const { view } = await open({ instructionsOpen: null, status: () => ({ targets: [], error: 'boom' }) })
  const group = instructionsGroup(view)
  assert.ok(group)
  assert.equal(group.props.description, undefined)
  assert.equal(view.valueOf(group), true)
  assert.notEqual(view.find({ type: 'Callout', text: /boom/ }), null)
  await expectClean(view)
})

// --- Résumé de l'état des consignes ------------------------------------------------------------------------------

const summaryOf = (states: Parameters<typeof target>[0][], locale: 'en' | 'fr' = 'en') =>
  panel.instructionsSummary(
    MESSAGES[locale],
    { targets: states.map((state, index) => target(state, (['claude', 'shared', 'grok', 'antigravity'] as const)[index % 4], ['claude'])) }
  )

test('the summary is empty while loading, on an error, and without any harness to serve', () => {
  assert.equal(panel.instructionsSummary(EN, null), null)
  assert.equal(panel.instructionsSummary(EN, { targets: [], error: 'boom' }), null)
  assert.equal(summaryOf([]), null)
  assert.equal(summaryOf(['absent-harness', 'absent-harness']), null)
})

test('the summary counts installed targets among those whose harness exists', () => {
  assert.equal(summaryOf(['installed', 'installed', 'installed', 'absent-harness']), '3 of 3 installed')
  assert.equal(summaryOf(['installed', 'installed', 'installed', 'installed']), '4 of 4 installed')
  // Un dossier tiers n'est ni compté ni au total : rien n'est à y installer.
  assert.equal(summaryOf(['installed', 'not-installed', 'absent-harness', 'foreign']), '1 of 2 installed')
})

test('the summary counts an edited target as installed, since the instructions are there', () => {
  assert.equal(summaryOf(['installed', 'modified']), '2 of 2 installed')
  assert.equal(summaryOf(['modified', 'not-installed']), '1 of 2 installed')
  assert.equal(summaryOf(['foreign', 'modified']), '1 of 1 installed')
})

test('the summary is empty when only third-party folders and absent harnesses remain', () => {
  assert.equal(summaryOf(['foreign', 'foreign', 'absent-harness']), null)
})

test('the summary says none installed when every managed target is missing', () => {
  assert.equal(summaryOf(['not-installed', 'not-installed', 'absent-harness']), EN.instructionsNotInstalled)
  assert.equal(summaryOf(['foreign', 'not-installed']), EN.instructionsNotInstalled)
})

test('any outdated target turns the summary into an update notice, whatever the rest', () => {
  assert.equal(summaryOf(['installed', 'outdated']), EN.instructionsUpdateAvailable)
  assert.equal(summaryOf(['outdated', 'not-installed', 'absent-harness']), EN.instructionsUpdateAvailable)
})

test('the summary is localized', () => {
  assert.equal(summaryOf(['installed', 'installed', 'not-installed'], 'fr'), '2 sur 3 installées')
  assert.equal(summaryOf(['installed', 'not-installed'], 'fr'), '1 sur 2 installée')
  assert.equal(summaryOf(['not-installed'], 'fr'), 'Non installées')
  assert.equal(summaryOf(['outdated'], 'fr'), 'Mise à jour disponible')
})

// --- Section Messages repliable ----------------------------------------------------------------------------------

const messagesGroup = (view: View) => collapsibleTitled(view, EN.sectionMessages) ?? collapsibleTitled(view, FR.sectionMessages)

/** Le groupe Messages, ou une erreur claire : relu à chaque geste, car il change après un rendu. */
const requireMessages = (view: View) => {
  const group = messagesGroup(view)
  assert.ok(group)
  return group
}

test('the messages group starts closed when never chosen, with the counts as summary', async () => {
  const { view } = await open({ messagesOpen: null })
  const group = requireMessages(view)
  assert.equal(view.valueOf(group), false)
  assert.equal(group.props.title, EN.sectionMessages)
  assert.equal(group.props.description, '4 messages, 1 unread')
  // Le contenu d'un groupe replié n'est pas dessiné.
  assert.equal(view.find({ text: UNREAD_MESSAGE.subject }), null)
  assert.equal(view.find({ text: EN.unreadBadge }), null)
  await expectClean(view)
})

test('opening the messages group shows the rows, and the choice is persisted', async () => {
  const first = await open({ messagesOpen: null })
  assert.equal(first.view.persisted.plugin.messagesOpen ?? null, null)
  await first.view.toggle(requireMessages(first.view))
  assert.equal(first.view.valueOf(requireMessages(first.view)), true)
  assert.equal(first.view.persisted.plugin.messagesOpen, true)
  assert.notEqual(first.view.find({ text: UNREAD_MESSAGE.subject }), null)
  const saved = first.view.persisted.plugin.messagesOpen as boolean
  await first.view.unmount()

  // Rouvert avec le choix mémorisé : la section reste dépliée.
  const reopened = await open({ messagesOpen: saved })
  assert.equal(reopened.view.valueOf(requireMessages(reopened.view)), true)
  // Refermée par l'utilisateur : le choix est mémorisé, le résumé reste.
  await reopened.view.toggle(requireMessages(reopened.view))
  assert.equal(reopened.view.persisted.plugin.messagesOpen, false)
  assert.equal(requireMessages(reopened.view).props.description, '4 messages, 1 unread')
  await expectClean(reopened.view)
})

test('the messages group keeps its summary fresh while closed, as the feed polls', async () => {
  await withFakeTimers(async () => {
    const { view, state } = await open({ messagesOpen: null, feed: () => ({ items: [UNREAD_MESSAGE] }) })
    assert.equal(requireMessages(view).props.description, '1 message, 1 unread')
    state.feed = () => ({ items: FEED })
    mock.timers.tick(panel.FEED_POLL_MS)
    await view.settled()
    assert.equal(requireMessages(view).props.description, '4 messages, 1 unread')
    assert.equal(view.valueOf(requireMessages(view)), false)
    await expectClean(view)
  })
})

test('the messages group is titled and summarized in French when locale is fr', async () => {
  const { view } = await open({ locale: 'fr-FR', messagesOpen: null })
  const group = requireMessages(view)
  assert.equal(group.props.title, FR.sectionMessages)
  assert.equal(group.props.description, '4 messages, 1 non lu')
  await expectClean(view)
})

test('the closed messages group says when there is nothing, and when the feed is unavailable', async () => {
  const empty = await open({ messagesOpen: null, feed: () => ({ items: [] }) })
  assert.equal(requireMessages(empty.view).props.description, EN.noMessages)
  await expectClean(empty.view)

  const failing = await open({ messagesOpen: null, feed: () => ({ error: 'boom' }) })
  assert.equal(requireMessages(failing.view).props.description, EN.feedUnavailableTitle)
  assert.equal(failing.view.valueOf(requireMessages(failing.view)), false)
  await expectClean(failing.view)
})

test('an open messages group with an empty feed draws no body: the description already says it', async () => {
  const { view } = await open({ messagesOpen: true, feed: () => ({ items: [] }) })
  const group = requireMessages(view)
  assert.equal(view.valueOf(group), true)
  assert.equal(group.props.description, EN.noMessages)
  assert.equal(view.find({ type: 'Text', text: EN.noMessages }), null)
  assert.equal(view.findAll({ text: EN.noMessages }).length, 0)
  await expectClean(view)
})

test('the messages error and its retry are inside the group, visible once opened', async () => {
  const { view } = await open({ messagesOpen: true, feed: () => ({ error: 'boom' }) })
  assert.notEqual(view.find({ type: 'Callout', text: /boom/ }), null)
  assert.notEqual(view.find({ type: 'Button', text: EN.retry }), null)
  await expectClean(view)
})

// --- Résumé du fil -----------------------------------------------------------------------------------------------

const feedItem = (id: string, read: boolean) => ({ ...UNREAD_MESSAGE, id, read })

test('the messages summary is empty while loading, and names the failure on an error', () => {
  assert.equal(panel.messagesSummary(EN, null), null)
  assert.equal(panel.messagesSummary(EN, { error: 'boom' }), EN.feedUnavailableTitle)
  assert.equal(panel.messagesSummary(FR, { error: 'boom' }), FR.feedUnavailableTitle)
})

test('the messages summary says there is nothing without any message', () => {
  assert.equal(panel.messagesSummary(EN, { items: [] }), EN.noMessages)
  assert.equal(panel.messagesSummary(FR, { items: [] }), FR.noMessages)
})

test('the messages summary counts messages and unread ones, with singular forms', () => {
  assert.equal(panel.messagesSummary(EN, { items: [feedItem('a', true)] }), '1 message')
  assert.equal(panel.messagesSummary(EN, { items: [feedItem('a', true), feedItem('b', true)] }), '2 messages')
  assert.equal(panel.messagesSummary(EN, { items: [feedItem('a', false)] }), '1 message, 1 unread')
  assert.equal(panel.messagesSummary(EN, { items: [feedItem('a', false), feedItem('b', false), feedItem('c', true)] }), '3 messages, 2 unread')
  assert.equal(panel.messagesSummary(EN, { items: [feedItem('a', false), feedItem('b', true)] }), '2 messages, 1 unread')
})

test('the messages summary is localized', () => {
  assert.equal(panel.messagesSummary(FR, { items: [feedItem('a', true)] }), '1 message')
  assert.equal(panel.messagesSummary(FR, { items: [feedItem('a', true), feedItem('b', true)] }), '2 messages')
  assert.equal(panel.messagesSummary(FR, { items: [feedItem('a', false), feedItem('b', true)] }), '2 messages, 1 non lu')
  assert.equal(panel.messagesSummary(FR, { items: [feedItem('a', false), feedItem('b', false)] }), '2 messages, 2 non lus')
})
