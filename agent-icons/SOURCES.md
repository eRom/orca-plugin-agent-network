# Origine des icônes d'agents

Ces icônes illustrent les agents dans le volet « Network ». Elles viennent du dépôt d'Orca
(https://github.com/stablyai/orca, licence MIT), commit `ed507d41f4d`, via le plugin agent-profiles
(même auteur), qui les a déjà converties.

## Copies directes (3 fichiers)

Copiés tels quels depuis `src/shared/agent-icons/`, mêmes noms de fichier :

antigravity, dsh, grok.

## Conversions (2 fichiers)

Orca dessine ces deux agents avec des composants JSX et non avec un PNG. Chaque composant a été
transcrit en SVG autonome, puis rendu avec `rsvg-convert -w 128 -h 128` en PNG transparent de 128 px.
`currentColor` est remplacé par `#D97757` pour Claude et par `#E4E4E7` pour Codex (lisible sur fond
sombre, comme dans Orca) ; les couleurs explicites restent.

| Fichier | Composant d'Orca | Fichier source |
|---|---|---|
| `claude.png` | `ClaudeIcon` | `src/renderer/src/components/status-bar/accounts/provider-icons.tsx` |
| `codex.png` | `OpenAIIcon` | `src/renderer/src/components/status-bar/accounts/provider-icons.tsx` |

## Variante par thème

Pourquoi : Orca dessine Codex avec `currentColor`, donc lisible dans les deux thèmes. Notre PNG est figé en
`#E4E4E7` et disparaît sur fond clair. Le panneau garde le chemin de base (`agent-icons/codex.png`) et choisit la
variante au rendu selon `env.theme.colorScheme` (`src/icons.ts`, table `ICON_VARIANTS`).

| Variante | Thème | Glyphe |
|---|---|---|
| `on-light/codex.png` | clair | `#18181B` |

Recette (à partir de l'icône de base, qui garde sa transparence) :

```
magick agent-icons/codex.png -fill '#18181B' -colorize 100 agent-icons/on-light/codex.png
```

## Licences

Le code d'Orca est sous licence MIT, « Copyright (c) 2026 Lovecast Inc. ». Les logos restent des
marques de leurs détenteurs respectifs : ils servent ici uniquement à reconnaître l'agent.
