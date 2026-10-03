# Fork seams

Le code du fork vit dans `packages/fork`. Les seuls points de contact avec le code upstream sont listés ici et marqués `// FORK-SEAM: <nom>` dans le source. Ce sont les seuls conflits attendus lors d'un merge upstream.

| Seam | Fichier | Rôle |
| --- | --- | --- |
| `telemetry-measure` | `packages/opencode/src/session/llm.ts` | Mesure la requête finale (après plugins) : système, outils, historique, sorties d'outils |
| `telemetry-record` | `packages/opencode/src/session/processor.ts` | Enregistre l'usage facturé à chaque `step-finish` |
| `deferred-tools` | `packages/opencode/src/session/tools.ts` | Retient les outils MCP et les outils natifs rares (`lsp`, `webfetch`, `websearch`, `question`, `shell_output`, `shell_kill`, `monitor`) derrière `tool_search` (`OPENCODE_FORK_DEFER_TOOLS=0` coupe tout, `OPENCODE_FORK_DEFER_NATIVE=0` ou CSV pour les natifs) |
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
| `tui-widgets` | `packages/tui/src/feature-plugins/builtins.ts` | Enregistre les plugins TUI du fork : Usage, Subagents, budget, commandes « Pin messages for compaction » et « Compaction preview », statusline (`app_bottom`) et notification de fin de job d'arrière-plan (`OPENCODE_FORK_BACKGROUND_NOTIFY=0`) |
| `slim-tool-descriptions` | `packages/opencode/src/tool/registry.ts` | Descriptions d'outils compactes (−47 % sur les définitions natives ; `OPENCODE_FORK_SLIM_TOOLS=0` pour couper) |
| `cache-ttl` | `provider/transform.ts`, `session/processor.ts`, `cli/cmd/tui.ts` | TTL 1h sur le préfixe stable (outils + système) en session interactive, coût des écritures 1h corrigé. Avec `opencode-claude-auth`, voir `auth-cache` |
| `auth-cache` | `packages/opencode/src/provider/provider.ts` | Avec `opencode-claude-auth` (qui déplace le système dans le premier message et retire son `cache_control`), pose un breakpoint 1h sur la fin du premier message user avant le fetch du plugin, en session interactive, requêtes Anthropic Messages seulement (`OPENCODE_FORK_AUTH_CACHE=0` pour couper) |
| `no-upstream-autoupdate` | `packages/opencode/src/cli/upgrade.ts` | Le binaire du fork ne cherche pas de mise à jour upstream |
| `lsp-default` | `packages/opencode/src/effect/runtime-flags.ts` | Outil `lsp` actif par défaut (`OPENCODE_EXPERIMENTAL_LSP_TOOL=false` pour couper) |
| `lsp-format` | `packages/opencode/src/tool/lsp.ts` | Sortie LSP compacte `chemin:ligne:col` via `ForkLsp.format` (`OPENCODE_FORK_LSP_FORMAT=0` : JSON d'origine) |
| `background-shell` | `packages/opencode/src/tool/shell/prompt.ts`, `tool/shell.ts`, `tool/registry.ts` | Paramètre `background` de bash : job d'arrière-plan avec notification à la fin, outils `shell_output` / `shell_kill` (`OPENCODE_FORK_BACKGROUND_SHELL=0` pour couper) |
| `memory-index` | `packages/opencode/src/session/instruction.ts`, `session/prompt.ts` | Index `MEMORY.md` de la mémoire projet injecté après les instructions, figé une fois par session (`OPENCODE_FORK_MEMORY=0` pour couper) |
| `memory-permission` | `packages/opencode/src/agent/agent.ts` | L'agent build peut écrire dans `<data>/memory/<projet>/` sans demande |
| `subagent-inherit` | `packages/opencode/src/tool/task.ts` | Paramètre `inherit` : le sous-agent reprend agent, modèle, permissions et historique du parent avant le tour courant, avec un préambule de fork (`OPENCODE_FORK_SUBAGENT_INHERIT=0` pour couper) |
| `monitor` | `packages/opencode/src/tool/registry.ts` | Outil `monitor` (`tool/monitor.ts`) : attend un motif dans la sortie d'un job shell, sa fin, ou le succès d'une commande relancée via l'outil bash |
| `plan-default` | `packages/opencode/src/effect/runtime-flags.ts` | Plan mode actif par défaut pour le client `cli` (ou avec `OPENCODE_EXPERIMENTAL`), `OPENCODE_EXPERIMENTAL_PLAN_MODE=false` pour couper |
| `plan-enter` | `packages/opencode/src/tool/registry.ts` | Enregistre l'outil `plan_enter` (`tool/plan.ts`) à côté de `plan_exit` |
| `hooks-config` | `packages/core/src/config.ts`, `core/src/v1/config/config.ts`, `core/src/v1/config/migrate.ts` | Clé `hooks` de la config (PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop, SubagentStop, PreCompact, PermissionRequest, Notification ; types `command`, `http`, `prompt`) |
| `hooks-plugin` | `packages/opencode/src/plugin/index.ts` | Enregistre `ForkHooksPlugin` (hooks shell déclaratifs, `OPENCODE_FORK_HOOKS=0` pour couper) |
| `permission-ask-hook` | `packages/opencode/src/session/tools.ts`, `session/processor.ts` | Les demandes de permission passent par `askWithPlugins`, qui déclenche le hook plugin `permission.ask` (un `deny` du ruleset l'emporte toujours) |
| `statusline-config` | `packages/tui/src/config/index.tsx`, `packages/plugin/src/tui.ts` | Clé `statusline { command, interval }` de la config TUI ; la commande reçoit sur stdin `{ sessionID, model, agent, cwd, quota? }` (`quota` : fenêtres 5h et 7j de l'abonnement, utilization 0-1 et reset en ms, si vues depuis moins de 6 h) |
| `quota-headers` | `packages/opencode/src/provider/provider.ts` | Lit les en-têtes `anthropic-ratelimit-unified-*` (fenêtres 5h et hebdo de l'abonnement) dans `timeoutFetch` ; alimente l'affichage Quota, le budget `--budget 20%` et l'attente de remise à zéro d'`opencode auto` |
| `tool-failure-hook` | `packages/plugin/src/index.ts`, `packages/opencode/src/session/processor.ts` | Hook plugin `tool.execute.failure` déclenché par `failToolCall` (sauf refus utilisateur) ; alimente `PostToolUseFailure`, qui peut ajouter du contexte à l'erreur |
| `prompt-block-hook` | `packages/opencode/src/session/prompt.ts` | Un `UserPromptSubmit` bloquant est signalé par un part marqué : le seam publie `session.error` avec la raison et arrête le prompt avant persistance (contrat des hooks : `docs/fork/hooks.md`) |
| `cc-plugins-skills` | `packages/opencode/src/skill/index.ts` | Ajoute aux skills ceux des plugins Claude Code activés (`~/.claude/plugins`), nommés `<plugin>:<skill>` (`OPENCODE_FORK_CC_PLUGINS=0` pour couper) |
| `cc-plugins-config` | `packages/opencode/src/config/config.ts` | Fusionne sous la config utilisateur les commandes, agents (subagents) et serveurs MCP des plugins Claude Code activés (`ForkClaudePlugins.config`) |
| `cc-plugins-hooks` | `packages/opencode/src/plugin/fork-hooks.ts` | Ajoute après les hooks de l'utilisateur ceux des plugins Claude Code activés ; le contexte d'un `SessionStart` est injecté dans le premier message d'une session racine |
| `cc-plugins-command` | `packages/opencode/src/index.ts` | Commande `opencode plugin-cc` (`add`, `list`, `rm`, `marketplace add`), qui écrit dans `~/.claude/plugins/*` et `~/.claude/settings.json` comme Claude Code |
| `claude-tools` | `packages/opencode/src/session/tools.ts`, `session/system.ts`, `session/reminders.ts` | Profil d'outils Claude Code pour les modèles Anthropic, avec le prompt système du fork (`ForkSystemPrompt`, `OPENCODE_FORK_SYSTEM_PROMPT=0` pour le prompt upstream) (`Read`, `Edit`, `Bash`, `Agent`, `TodoWrite`…, noms et schémas identiques) : map d'outils renommée (`ForkClaudeTools.wrap`), prompt système et rappel de plan mode qui les nomment (`OPENCODE_FORK_CC_TOOLS=0` pour couper) |
| `claude-tools-inbound` | `packages/opencode/src/session/processor.ts` | Reconvertit l'appel du modèle (nom et args Claude Code) au format opencode avant la persistance |
| `claude-tools-history` | `packages/opencode/src/session/message-v2.ts` | Rejoue l'historique stocké sous les noms et args Claude Code, de façon déterministe |
| `claude-tools-permission` | `packages/opencode/src/session/llm/request.ts` | Permissions et réglages d'outils évalués sur les noms opencode |
| `claude-tools-repair` | `packages/opencode/src/session/llm.ts` | Retrouve l'outil pour un nom mal casé (`opencode-claude-auth` met la première lettre en minuscule) |
| `grep-options` | `packages/opencode/src/tool/grep.ts` | Options Claude Code de grep (`output_mode`, `-i`, contexte, `type`, `head_limit`, `multiline`), masquées du schéma des autres modèles |
| `ripgrep-search` | `packages/core/src/ripgrep.ts` | `Ripgrep.search` : sortie texte de ripgrep avec les flags de l'appelant |
| `sandbox-config` | `packages/core/src/config.ts`, `core/src/v1/config/config.ts`, `core/src/v1/config/migrate.ts` | Clé `sandbox` de la config (`enabled`, `network.allow`, `write`, `read_deny`), voir `docs/fork/sandbox.md` |
| `sandbox` | `packages/opencode/src/tool/shell.ts`, `tool/shell/prompt.ts` | Commande bash (premier plan, `background`, `monitor`) enveloppée dans bwrap quand la sandbox est active ; paramètre `sandbox: false` (`dangerouslyDisableSandbox` sous le profil Claude Code) soumis à la permission `sandbox_escape` ; indice `[sandbox]` sur un échec typique (`OPENCODE_FORK_SANDBOX=1/0` pour forcer) |
| `permission-mode` | `packages/tui/src/context/permission.tsx`, `context/sync.tsx`, `config/keybind.ts`, `app.tsx`, `component/prompt/index.tsx`, `routes/session/permission.tsx`, `packages/opencode/src/cli/cmd/tui.ts` | Modes de permission à la Claude Code, retenus par session (règle marqueur `fork.mode`) : shift+tab fait tourner build, éditions acceptées, plan, auto (`agent_cycle_reverse` n'a plus de touche par défaut) ; indicateur sous le prompt, raison du classifieur dans la demande ; `--auto` démarre en auto, `--yolo` approuve tout côté client |
| `auto-mode` | `packages/opencode/src/cli/cmd/run.ts` | `opencode run --auto` : session en mode auto ; `--yolo` ou classifieur coupé approuvent côté client, jamais `sandbox_escape` |
| `workflow-tool` | `packages/opencode/src/tool/registry.ts` | Outil `workflow` (`tool/workflow.ts`, `Workflow` sous le profil Claude Code) : lance `opencode workflow run` en job d'arrière-plan, permission `workflow`, budget restant hérité, notification de fin injectée ; `shell_output` / `shell_kill` / `monitor` l'acceptent (`OPENCODE_FORK_WORKFLOW_TOOL=0` pour couper) |
| `messaging` | `packages/opencode/src/session/prompt.ts`, `tool/registry.ts` | Messagerie entre sessions vivantes via `fork.db` (`fork_agents`, `fork_inbox`) : un watcher par session livre les messages par `prompt` en part synthétique `<session-message>` ; outils différés `list_agents` / `send_message` (`ListAgents` / `SendMessage`) ; livre aussi les réveils (`wakeups`) (`OPENCODE_FORK_MESSAGING=0` pour couper) |
| `wakeups` | `packages/opencode/src/tool/registry.ts`, `session/prompt.ts`, `session/fork-messaging.ts`, `command/index.ts` | Réveils dans la session : outil `schedule_wakeup` (`ScheduleWakeup`, différé), un réveil en attente par session dans `fork.db` (`fork_wakeups`), livré en message synthétique `<scheduled-wakeup>` par le watcher de la messagerie quand la session est idle ; commande intégrée `/loop [intervalle] <prompt>` ; champ `wakeup` du payload de statusline (`OPENCODE_FORK_WAKEUPS=0` pour couper, `OPENCODE_FORK_WAKEUP_MIN_SECONDS` abaisse la borne de 60 s en test) |
| `route-provider` | `packages/opencode/src/provider/provider.ts` | Provider virtuel `router` (`router/auto`, `fast`, `standard`, `reasoning`, `frontier`) ajouté aux providers connectés (`OPENCODE_FORK_ROUTE=0` pour couper) |
| `route-language` | `packages/opencode/src/provider/provider.ts` | Un modèle `router/*` passé à `getLanguage` (titre, compaction, hooks) tourne sur le modèle concret de son dernier tour |
| `route-turn` | `packages/opencode/src/session/prompt.ts` | Résout `router/*` en modèle concret à chaque tour : signaux du petit modèle au nouveau message, politique de llm-router, changement conscient du cache (TTL 1h en interactif, cache chaud par modèle), journal `fork_route` ; `OPENCODE_FORK_ROUTE_TIERS` (JSON) et `OPENCODE_FORK_ROUTE_QUOTA` (0.9) |
| `route-fallback` | `packages/opencode/src/session/processor.ts`, `session/prompt.ts` | Avant le premier octet, une erreur d'un tour `router/*` met le modèle ou le provider en cooldown et le tour est re-routé ; hors `router/*`, rien ne change |
| `route-subagent` | `packages/opencode/src/tool/task.ts` | Sous une session `router/*`, un sous-agent sans modèle propre est lui aussi routé |
| `usage-command` | `packages/opencode/src/index.ts` | Enregistre les commandes `opencode usage`, `auto`, `schedule` et `workflow` (un run dont le process est mort passe en `interrupted` ; son coût est lu dans `fork_usage` par session d'étape) |

Fichiers ajoutés par le fork (sans conflit possible) :
- `packages/fork/**`
- `packages/opencode/src/cli/cmd/usage.ts`
- `packages/opencode/src/cli/cmd/auto.ts`
- `packages/opencode/src/tool/fork-worktree.ts`
- `packages/opencode/src/tool/shell-background.ts`
- `packages/opencode/src/tool/monitor.ts`
- `packages/opencode/src/plugin/fork-hooks.ts`
- `packages/opencode/src/plugin/fork-hooks-model.ts`
- `packages/opencode/src/session/fork-permission.ts`
- `packages/opencode/src/cli/cmd/schedule.ts`
- `packages/opencode/src/cli/cmd/workflow.ts`
- `packages/core/src/config/hooks.ts`
- `packages/core/src/config/sandbox.ts`
- `packages/opencode/src/tool/fork-sandbox.ts`
- `packages/opencode/src/tool/workflow.ts`
- `packages/opencode/src/tool/fork-wakeup.ts`
- `packages/opencode/src/tool/fork-messaging.ts`
- `packages/opencode/src/session/fork-messaging.ts`
- `packages/opencode/src/session/fork-classify.ts`
- `packages/opencode/src/session/fork-route.ts`
- `packages/opencode/src/provider/fork-route.ts`
- `packages/opencode/src/session/fork-small-model.ts`
- `packages/tui/src/feature-plugins/fork/statusline.tsx`
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
