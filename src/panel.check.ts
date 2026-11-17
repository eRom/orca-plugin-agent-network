// `orca plugin check` dessine le panneau une fois par scénario. Les réponses du worker sont posées ici (`requests`) :
// aucun hôte réel, aucun disque, aucun appel à `orca`.
import { defineCheck } from 'orca/testing'
import {
  ALL_FOREIGN,
  ALL_INSTALLED,
  EMPTY_WORKSPACE_AGENTS,
  FEED,
  LIVE_AGENTS,
  NONE_INSTALLED,
  NO_WORKSPACE_AGENTS,
  ONE_TARGET_OF_EACH_STATE
} from './test-fixtures'

const LOCALE_OK = { ok: true as const }
const COPY_OK = { ok: true as const }

export default defineCheck({
  // Réseau vivant : cinq agents dont un bloqué, le fil complet, aucune consigne posée.
  live: {
    requests: {
      'locale.set': LOCALE_OK,
      'network.copyHandle': COPY_OK,
      'network.agents': LIVE_AGENTS,
      'network.feed': { items: FEED },
      'skill.status': { targets: NONE_INSTALLED }
    }
  },
  // Même panneau en thème clair : c'est lui qui sert la variante d'icône `on-light/`.
  liveLight: {
    theme: 'light',
    requests: {
      'locale.set': LOCALE_OK,
      'network.copyHandle': COPY_OK,
      'network.agents': LIVE_AGENTS,
      'network.feed': { items: FEED },
      'skill.status': { targets: ALL_INSTALLED }
    }
  },
  // Aucun workspace ouvert : un seul état vide, les consignes restent.
  noWorkspace: {
    requests: {
      'locale.set': LOCALE_OK,
      'network.copyHandle': COPY_OK,
      'network.agents': NO_WORKSPACE_AGENTS,
      'network.feed': { items: [] },
      'skill.status': { targets: NONE_INSTALLED }
    }
  },
  // Workspace ouvert sans agent ni message.
  emptyWorkspace: {
    requests: {
      'locale.set': LOCALE_OK,
      'network.copyHandle': COPY_OK,
      'network.agents': EMPTY_WORKSPACE_AGENTS,
      'network.feed': { items: [] },
      'skill.status': { targets: ALL_INSTALLED }
    }
  },
  // Le fil échoue : les agents restent, l'erreur s'affiche à la place des messages.
  feedError: {
    requests: {
      'locale.set': LOCALE_OK,
      'network.copyHandle': COPY_OK,
      'network.agents': LIVE_AGENTS,
      'network.feed': { error: "Orca isn't answering: couldn't read the messages in time." },
      'skill.status': { targets: NONE_INSTALLED }
    }
  },
  // Quatre dossiers tiers : aucun bouton, une seule phrase d'explication sous la liste.
  allThirdParty: {
    requests: {
      'locale.set': LOCALE_OK,
      'network.copyHandle': COPY_OK,
      'network.agents': LIVE_AGENTS,
      'network.feed': { items: FEED },
      'skill.status': { targets: ALL_FOREIGN }
    }
  },
  // Une cible de chaque état des consignes (installé, à mettre à jour, modifié, tiers, harnais absent, non installé).
  everyTargetState: {
    requests: {
      'locale.set': LOCALE_OK,
      'network.copyHandle': COPY_OK,
      'network.agents': LIVE_AGENTS,
      'network.feed': { items: [] },
      'skill.status': { targets: ONE_TARGET_OF_EACH_STATE }
    }
  }
})
