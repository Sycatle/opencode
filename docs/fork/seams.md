# Fork seams

Le code du fork vit dans `packages/fork`. Les seuls points de contact avec le code upstream sont listés ici et marqués `// FORK-SEAM: <nom>` dans le source. Ce sont les seuls conflits attendus lors d'un merge upstream.

| Seam | Fichier | Rôle |
| --- | --- | --- |
| `telemetry-measure` | `packages/opencode/src/session/llm.ts` | Mesure la requête finale (après plugins) : système, outils, historique, sorties d'outils |
| `telemetry-record` | `packages/opencode/src/session/processor.ts` | Enregistre l'usage facturé à chaque `step-finish` |
| `deferred-tools` | `packages/opencode/src/session/tools.ts` | Retient les outils MCP et les outils natifs rares (`lsp`, `webfetch`, `websearch`, `question`, `plan_*`, `shell_output`, `shell_kill`) derrière `tool_search` (`OPENCODE_FORK_DEFER_TOOLS=0` coupe tout, `OPENCODE_FORK_DEFER_NATIVE=0` ou CSV pour les natifs) |
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
| `subagent-model-routing` | `packages/opencode/src/tool/task.ts` | `explore` tourne sur le petit modèle du provider (`OPENCODE_FORK_ROUTE_SUBAGENTS=0` pour couper), avec son variant d'effort le plus bas (`OPENCODE_FORK_SUBAGENT_EFFORT=0` pour couper) |
| `worktree-isolation` | `packages/opencode/src/tool/task.ts` | Paramètre `isolation: "worktree"` : le sous-agent tourne dans un worktree git, ses changements reviennent en commit sur une branche `opencode/<nom>` |
| `run-wait-background` | `packages/opencode/src/cli/cmd/run.ts` | `opencode run` attend les sous-agents d'arrière-plan avant de quitter |
| `tui-widgets` | `packages/tui/src/feature-plugins/builtins.ts` | Enregistre les plugins TUI du fork : Usage, Subagents, budget, commandes « Pin messages for compaction » et « Compaction preview » |
| `slim-tool-descriptions` | `packages/opencode/src/tool/registry.ts` | Descriptions d'outils compactes (−47 % sur les définitions natives ; `OPENCODE_FORK_SLIM_TOOLS=0` pour couper) |
| `cache-ttl` | `provider/transform.ts`, `session/processor.ts`, `cli/cmd/tui.ts` | TTL 1h sur le préfixe stable (outils + système) en session interactive, coût des écritures 1h corrigé. Sans effet avec `opencode-claude-auth` : le plugin déplace le prompt système dans le premier message et retire son `cache_control` |
| `no-upstream-autoupdate` | `packages/opencode/src/cli/upgrade.ts` | Le binaire du fork ne cherche pas de mise à jour upstream |
| `lsp-default` | `packages/opencode/src/effect/runtime-flags.ts` | Outil `lsp` actif par défaut (`OPENCODE_EXPERIMENTAL_LSP_TOOL=false` pour couper) |
| `lsp-format` | `packages/opencode/src/tool/lsp.ts` | Sortie LSP compacte `chemin:ligne:col` via `ForkLsp.format` (`OPENCODE_FORK_LSP_FORMAT=0` : JSON d'origine) |
| `background-shell` | `packages/opencode/src/tool/shell/prompt.ts`, `tool/shell.ts`, `tool/registry.ts` | Paramètre `background` de bash : job d'arrière-plan avec notification à la fin, outils `shell_output` / `shell_kill` (`OPENCODE_FORK_BACKGROUND_SHELL=0` pour couper) |
| `memory-index` | `packages/opencode/src/session/instruction.ts`, `session/prompt.ts` | Index `MEMORY.md` de la mémoire projet injecté après les instructions, figé une fois par session (`OPENCODE_FORK_MEMORY=0` pour couper) |
| `memory-permission` | `packages/opencode/src/agent/agent.ts` | L'agent build peut écrire dans `<data>/memory/<projet>/` sans demande |
| `usage-command` | `packages/opencode/src/index.ts` | Enregistre les commandes `opencode usage` et `opencode auto` |

Fichiers ajoutés par le fork (sans conflit possible) :
- `packages/fork/**`
- `packages/opencode/src/cli/cmd/usage.ts`
- `packages/opencode/src/cli/cmd/auto.ts`
- `packages/opencode/src/tool/fork-worktree.ts`
- `packages/opencode/src/tool/shell-background.ts`
- `packages/tui/src/feature-plugins/fork/usage.tsx`
- `packages/tui/src/feature-plugins/fork/compaction.tsx`
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
