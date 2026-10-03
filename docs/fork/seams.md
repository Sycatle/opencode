# Fork seams

Le code du fork vit dans `packages/fork`. Les seuls points de contact avec le code upstream sont listés ici et marqués `// FORK-SEAM: <nom>` dans le source. Ce sont les seuls conflits attendus lors d'un merge upstream.

| Seam | Fichier | Rôle |
| --- | --- | --- |
| `telemetry-measure` | `packages/opencode/src/session/llm.ts` | Mesure la requête finale (après plugins) : système, outils, historique, sorties d'outils |
| `telemetry-record` | `packages/opencode/src/session/processor.ts` | Enregistre l'usage facturé à chaque `step-finish` |
| `deferred-tools` | `packages/opencode/src/session/tools.ts` | Retient les outils MCP derrière `tool_search` (désactivable : `OPENCODE_FORK_DEFER_TOOLS=0`) |
| `prune-default` | `packages/opencode/src/session/compaction.ts` | Prune des anciennes sorties d'outils actif par défaut (`compaction.prune: false` pour couper) |
| `pruned-stub` | `packages/opencode/src/session/message-v2.ts` | Stub informatif à la place de `[Old tool result content cleared]` |
| `tool-output-limits` | `packages/opencode/src/tool/truncate.ts` | Troncature par défaut 640 lignes / 16 Ko au lieu de 2000 / 50 Ko (`tool_output` en config pour surcharger) |
| `budget` | `packages/opencode/src/session/prompt.ts` | Budget en $ par arbre de sessions (`OPENCODE_FORK_BUDGET_USD`) : un tour de conclusion sans outils à 100 %, arrêt à 120 % |
| `compaction-remember` | `packages/opencode/src/session/processor.ts` | Mémorise la dernière requête de la boucle principale par session |
| `cached-compaction` | `packages/opencode/src/session/compaction.ts` | Résumé en rejouant la dernière requête (cache) quand c'est moins cher que le transcript upstream (`OPENCODE_FORK_CACHED_COMPACTION=0` pour couper) |
| `compaction-facts` | `packages/opencode/src/session/compaction.ts` | Ajoute au résumé fichiers modifiés, todo-list et erreurs récentes, tirés des données |
| `background-default` | `packages/opencode/src/effect/runtime-flags.ts` | Sous-agents en arrière-plan actifs par défaut (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false` pour couper) |
| `background-cap` | `packages/opencode/src/tool/task.ts` | Au plus 4 tâches d'arrière-plan simultanées (`OPENCODE_FORK_MAX_BACKGROUND`) |
| `subagent-depth` | `packages/opencode/src/tool/task.ts` | Profondeur par défaut 2 au lieu de 1 |
| `subagent-model-routing` | `packages/opencode/src/tool/task.ts` | `explore` tourne sur le petit modèle du provider (`OPENCODE_FORK_ROUTE_SUBAGENTS=0` pour couper) |
| `worktree-isolation` | `packages/opencode/src/tool/task.ts` | Paramètre `isolation: "worktree"` : le sous-agent tourne dans un worktree git, ses changements reviennent en commit sur une branche `opencode/<nom>` |
| `run-wait-background` | `packages/opencode/src/cli/cmd/run.ts` | `opencode run` attend les sous-agents d'arrière-plan avant de quitter |
| `tui-widgets` | `packages/tui/src/feature-plugins/builtins.ts` | Enregistre les widgets TUI du fork : section Usage, section Subagents, budget à droite du prompt |
| `usage-command` | `packages/opencode/src/index.ts` | Enregistre les commandes `opencode usage` et `opencode auto` |

Fichiers ajoutés par le fork (sans conflit possible) :
- `packages/fork/**`
- `packages/opencode/src/cli/cmd/usage.ts`
- `packages/opencode/src/cli/cmd/auto.ts`
- `packages/opencode/src/tool/fork-worktree.ts`
- `packages/tui/src/feature-plugins/fork/usage.tsx`
- `packages/opencode/src/session/fork-compaction.ts`
- `script/fork-sync.sh`

Dépendance `@opencode-fork/core` ajoutée dans `packages/opencode/package.json` et `packages/tui/package.json`.

Tests upstream adaptés aux valeurs par défaut du fork : `test/tool/task.test.ts` et `test/tool/registry.test.ts` (commentaires `Fork:`).

## Après un merge upstream

Pour vérifier que chaque seam est toujours présent et toujours sur le chemin actif :

```sh
grep -rn "FORK-SEAM" packages/
```

Vérifie en particulier que `SessionProcessor` est toujours utilisé par le TUI : la migration v1 vers v2 peut le rendre mort.
