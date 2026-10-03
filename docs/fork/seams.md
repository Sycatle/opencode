# Fork seams

Le code du fork vit dans `packages/fork`. Les seuls points de contact avec le code upstream sont listés ici et marqués `// FORK-SEAM: <nom>` dans le source. Ce sont les seuls conflits attendus lors d'un merge upstream.

Toutes les variables `OPENCODE_FORK_*` sont déclarées dans `packages/fork/src/flags.ts` (type, défaut, rôle) ; `test/flags.test.ts` échoue si une variable lue dans les sources n'y figure pas. La palette du TUI les liste avec leur valeur (« Fork features »). Le bloc `fork` d'`opencode.json` les fixe aussi, par nom sans préfixe (`{ "fork": { "MESSAGING": false, "BUDGET_USD": 5 } }`) ; une variable d'environnement l'emporte.

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
| `smart-compaction` | `packages/opencode/src/session/prompt.ts` | Compaction aux bons moments (`ForkCompactionTiming.decide`, `session/fork-smart-compaction.ts`) : en fin de tour sur une frontière de tâche (todo terminée ou réponse finale, contexte ≥ `OPENCODE_FORK_COMPACT_AT`, 0.5) et au début d'un tour après un cache froid (`OPENCODE_FORK_COMPACT_COLD_AT`, 0.3), seulement si le bénéfice dépasse le coût ; jamais en boucle d'outils, avec un job d'arrière-plan, en plan mode ni moins de `OPENCODE_FORK_COMPACT_MIN_TURNS` (3) tours après une compaction ; décisions dans `fork_compaction` (`opencode usage <session>`) (`OPENCODE_FORK_SMART_COMPACTION=0` pour couper) |
| `compaction-facts` | `packages/opencode/src/session/compaction.ts` | Ajoute au résumé fichiers modifiés, todo-list et erreurs récentes, tirés des données |
| `background-default` | `packages/opencode/src/effect/runtime-flags.ts` | Sous-agents en arrière-plan actifs par défaut (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=false` pour couper) |
| `background-cap` | `packages/opencode/src/tool/task.ts` | Au plus 4 tâches d'arrière-plan simultanées (`OPENCODE_FORK_MAX_BACKGROUND`) |
| `subagent-depth` | `packages/opencode/src/tool/task.ts` | Profondeur par défaut 2 au lieu de 1 |
| `subagent-model-routing` | `packages/opencode/src/tool/task.ts` | `explore` tourne sur le petit modèle du provider (`OPENCODE_FORK_ROUTE_SUBAGENTS=0` pour couper), avec son variant d'effort le plus bas (`OPENCODE_FORK_SUBAGENT_EFFORT=0` pour couper) |
| `worktree-isolation` | `packages/opencode/src/tool/task.ts` | Paramètre `isolation: "worktree"` : le sous-agent tourne dans un worktree git, ses changements reviennent en commit sur une branche `opencode/<nom>` |
| `run-wait-background` | `packages/opencode/src/cli/cmd/run.ts` | `opencode run` attend les sous-agents d'arrière-plan avant de quitter |
| `tui-widgets` | `packages/tui/src/feature-plugins/builtins.ts` | Enregistre les plugins TUI du fork : Usage, Subagents, budget, commandes « Pin messages for compaction » et « Compaction preview », statusline (`app_bottom`) et notification de fin de job d'arrière-plan (`OPENCODE_FORK_BACKGROUND_NOTIFY=0`) |
| `slim-tool-descriptions` | `packages/opencode/src/tool/registry.ts` | Descriptions d'outils compactes (−47 % sur les définitions natives ; `OPENCODE_FORK_SLIM_TOOLS=0` pour couper) |
| `slim-skills` | `packages/opencode/src/session/system.ts` | Liste des skills du prompt système sur une ligne par skill, sans `<location>` (l'outil skill renvoie le dossier), descriptions coupées à 400 caractères (−52 % avec les plugins Claude Code ; `OPENCODE_FORK_SLIM_SKILLS=0` pour couper) |
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
| `plan-enter` | `packages/opencode/src/tool/registry.ts`, `tool/plan.ts`, `cli/cmd/run/tool.ts` | Enregistre l'outil `plan_enter` (`tool/plan.ts`) à côté de `plan_exit` |
| `hooks-config` | `packages/core/src/config.ts`, `core/src/v1/config/config.ts`, `core/src/v1/config/migrate.ts` | Clé `hooks` de la config (PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, SessionStart, SessionEnd, Stop, SubagentStop, PreCompact, PermissionRequest, Notification ; types `command`, `http`, `prompt`) |
| `hooks-plugin` | `packages/opencode/src/plugin/index.ts` | Enregistre `ForkHooksPlugin` (hooks shell déclaratifs, `OPENCODE_FORK_HOOKS=0` pour couper) |
| `permission-ask-hook` | `packages/opencode/src/session/tools.ts`, `session/processor.ts` | Les demandes de permission passent par `askWithPlugins`, qui déclenche le hook plugin `permission.ask` (un `deny` du ruleset l'emporte toujours) |
| `statusline-config` | `packages/tui/src/config/index.tsx`, `packages/plugin/src/tui.ts` | Sans `statusline.command`, une ligne intégrée montre le modèle choisi par le Router et le prochain wakeup (commande palette « Cancel scheduled wakeup / loop ») ; clé `statusline { command, interval }` de la config TUI ; la commande reçoit sur stdin `{ sessionID, model, agent, cwd, quota? }` (`quota` : fenêtres 5h et 7j de l'abonnement, utilization 0-1 et reset en ms, si vues depuis moins de 6 h) |
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
| `permission-mode` | `packages/tui/src/context/permission.tsx`, `context/args.tsx`, `context/sync.tsx`, `config/keybind.ts`, `app.tsx`, `component/prompt/index.tsx`, `routes/session/permission.tsx`, `packages/opencode/src/cli/cmd/tui.ts` | Modes de permission à la Claude Code, retenus par session (règle marqueur `fork.mode`) : shift+tab fait tourner build, éditions acceptées, plan, auto (`agent_cycle` est sur f3 et `agent_cycle_reverse` sur shift+f3, voir `prompt-suggestion`) ; indicateur sous le prompt, raison du classifieur dans la demande ; `--auto` démarre en auto, `--yolo` approuve tout côté client |
| `auto-mode` | `packages/opencode/src/cli/cmd/run.ts` | `opencode run --auto` : session en mode auto ; `--yolo` ou classifieur coupé approuvent côté client, jamais `sandbox_escape` |
| `workflow-tool` | `packages/opencode/src/tool/registry.ts` | Outil `workflow` (`tool/workflow.ts`, `Workflow` sous le profil Claude Code) : lance `opencode workflow run` en job d'arrière-plan, permission `workflow`, budget restant hérité, notification de fin injectée ; `shell_output` / `shell_kill` / `monitor` l'acceptent (`OPENCODE_FORK_WORKFLOW_TOOL=0` pour couper) |
| `messaging` | `packages/opencode/src/session/prompt.ts`, `tool/registry.ts` | Messagerie entre sessions vivantes via `fork.db` (`fork_agents`, `fork_inbox`) : un watcher par session livre les messages par `prompt` en part synthétique `<session-message>` ; outils différés `list_agents` / `send_message` (`ListAgents` / `SendMessage`) ; livre aussi les réveils (`wakeups`) (`OPENCODE_FORK_MESSAGING=0` pour couper) |
| `session-worktree` | `packages/opencode/src/tool/tool.ts`, `tool/registry.ts`, `session/prompt.ts`, `agent/agent.ts`, `packages/tui/src/feature-plugins/sidebar/footer.tsx` | Outils `enter_worktree` / `exit_worktree` (`EnterWorktree` / `ExitWorktree`, différés) : la session principale travaille dans un worktree git (outils exécutés dans l'instance du worktree, permissions et événements restent dans l'instance d'origine) ; `exit_worktree` en `keep`, `merge` (commit avec les hooks du projet, merge, nettoyage ; conflit rapporté sans rien casser) ou `discard` (permission `worktree_discard`, toujours demandée, jamais en auto) ; le `path.cwd` des messages assistant porte le worktree (`OPENCODE_FORK_SESSION_WORKTREE=0` pour couper) |
| `prompt-suggestion` | `packages/opencode/src/session/prompt.ts`, `cli/cmd/tui.ts`, `packages/tui/src/component/prompt/index.tsx`, `config/keybind.ts`, `feature-plugins/home/tips-view.tsx` | En fin de boucle d'une session racine lancée depuis le TUI (`OPENCODE_FORK_INTERACTIVE=1`), le petit modèle (sans thinking, 30 tokens de sortie) propose la prochaine demande de l'utilisateur ; stockée dans `fork_suggestion` avec son coût, affichée en placeholder gris ; Tab l'insère (`prompt_suggestion_accept`), Entrée sur un champ vide n'envoie rien ; `agent_cycle` passe sur f3 et `agent_cycle_reverse` sur shift+f3 ; commande de palette pour couper (`OPENCODE_FORK_PROMPT_SUGGESTION=0`) |
| `small-output-cap` | `packages/opencode/src/session/llm.ts`, `session/llm/request.ts` | Paramètre `maxOutputTokens` d'un appel `llm.stream` (appels courts du petit modèle) |
| `wakeups` | `packages/opencode/src/tool/registry.ts`, `session/prompt.ts`, `session/fork-messaging.ts`, `command/index.ts` | Réveils dans la session : outil `schedule_wakeup` (`ScheduleWakeup`, différé), un réveil en attente par session dans `fork.db` (`fork_wakeups`), livré en message synthétique `<scheduled-wakeup>` par le watcher de la messagerie quand la session est idle ; commande intégrée `/loop [intervalle] <prompt>` ; champ `wakeup` du payload de statusline (`OPENCODE_FORK_WAKEUPS=0` pour couper, `OPENCODE_FORK_WAKEUP_MIN_SECONDS` abaisse la borne de 60 s en test) |
| `route-provider` | `packages/opencode/src/provider/provider.ts` | Provider virtuel `router` (`router/auto`, `fast`, `standard`, `reasoning`, `frontier`) ajouté aux providers connectés (`OPENCODE_FORK_ROUTE=0` pour couper) |
| `route-language` | `packages/opencode/src/provider/provider.ts` | Un modèle `router/*` passé à `getLanguage` (titre, compaction, hooks) tourne sur le modèle concret de son dernier tour |
| `route-turn` | `packages/opencode/src/session/prompt.ts` | Résout `router/*` en modèle concret à chaque tour : signaux de Jev (sinon du petit modèle) au nouveau message, politique de llm-router, changement conscient du cache (TTL 1h en interactif, cache chaud par modèle), journal `fork_route` ; `OPENCODE_FORK_ROUTE_TIERS` (JSON) et `OPENCODE_FORK_ROUTE_QUOTA` (0.9) |
| `guard-plugin` | `packages/opencode/src/plugin/index.ts` | Plugin interne `fork-guard` (sortie de `webfetch` et, en opt-in, des outils MCP) : Jev détecte une injection de prompt, un avertissement fixe est écrit une fois dans la sortie stockée et la session est marquée 10 min (le mode auto n'y approuve plus sur la seule parole de Jev) |
| `tools-preload` | `packages/opencode/src/session/tools.ts` (appelé depuis `prompt.ts`) | Au premier pas d'un message utilisateur, avant `defer`, Jev peut précharger des outils différés (opt-in `OPENCODE_FORK_DEFER_TOOLS_JEV=1`) : le choix est stocké dans une part texte `ignored` (`forkPreloaded`) que `loadedTools` relit à chaque tour, donc le bloc d'outils reste identique ; seulement au premier tour après un démarrage ou une compaction, ou cache expiré |
| `prune-keep` | `packages/opencode/src/session/compaction.ts` | Avant d'effacer un lot de sorties d'outils (`prune`), Jev peut en épargner jusqu'à un quart qu'il juge encore nécessaires (opt-in `OPENCODE_FORK_PRUNE_JEV=1`) ; une sortie épargnée est marquée `forkKept` et sera effacée au lot suivant |
| `route-effort` | `packages/opencode/src/session/prompt.ts` | Variante d'effort de raisonnement choisie par le Router pour le tour (`ForkRoute.effort`), sauf si l'utilisateur en a choisi une ; la variante est enregistrée dans `fork_route.variant` et ne change qu'avec le modèle ou à froid |
| `route-plan` | `packages/opencode/src/session/prompt.ts` | Sur une demande ambiguë à un agent `build` racine (`ambiguity` ≥ `OPENCODE_FORK_ROUTE_PLAN_AT`), une part synthétique rappelle `plan_enter`, une seule fois, au premier pas |
| `route-fallback` | `packages/opencode/src/session/processor.ts`, `session/prompt.ts` | Avant le premier octet, une erreur d'un tour `router/*` met le modèle ou le provider en cooldown et le tour est re-routé ; hors `router/*`, rien ne change |
| `outcome` | `packages/opencode/src/session/processor.ts`, `session/revert.ts` | Journalise dans `fork_outcome` les tours interrompus, en erreur ou annulés (revert), par message utilisateur ; `opencode usage --route` croise avec les décisions du Router (taux par modèle et tier, avec les escalades) |
| `unattended` | `packages/opencode/src/session/prompt.ts`, `session/tools.ts` | Session sans outil question (`opencode run`, `auto`, la plupart des subagents) : rappel après le prompt et après chaque skill chargé que personne ne peut répondre ni approuver, pour qu'un skill de process (brainstorming) ne fasse pas attendre une validation qui ne viendra pas (`OPENCODE_FORK_UNATTENDED=0` pour couper) |
| `route-subagent` | `packages/opencode/src/tool/task.ts` | Sous une session `router/*`, un sous-agent sans modèle propre est lui aussi routé |
| `usage-command` | `packages/opencode/src/index.ts` | Enregistre les commandes `opencode usage`, `auto`, `schedule` et `workflow` (un run dont le process est mort passe en `interrupted` ; son coût est lu dans `fork_usage` par session d'étape) |
| `fork-config` | `packages/core/src/config.ts`, `core/src/v1/config/config.ts`, `core/src/v1/config/migrate.ts`, `packages/opencode/src/config/config.ts` | Clé `fork` de la config, appliquée aux variables `OPENCODE_FORK_*` laissées vides par l'environnement (`ForkFlags.apply`) |
| `remote-attach` | `packages/opencode/src/cli/cmd/attach.ts` | `opencode attach` vers une autre machine pose `OPENCODE_FORK_REMOTE=1` : les widgets d'usage disent que les données du fork n'y sont pas disponibles |
| `native-tool-search` | `packages/opencode/src/session/tools.ts`, `session/message-v2.ts`, `session/system.ts`, `provider/provider.ts` | Modèles Anthropic (`@ai-sdk/anthropic`) : les outils différés partent avec `defer_loading` à côté de `tool_search_tool_bm25`, l'API les cherche elle-même et le bloc d'outils ne change plus au chargement (le cache tient) ; le résultat de recherche est rejoué en JSON, prune ou pas ; le prompt système décrit cette recherche ; sous `opencode-claude-auth`, qui préfixe tous les noms d'outils, le `fetch` global rend son nom fixe à l'outil serveur (`OPENCODE_FORK_NATIVE_TOOL_SEARCH=0` : `tool_search` du fork) |

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
- `packages/opencode/src/tool/fork-session-cwd.ts`
- `packages/opencode/src/tool/fork-session-worktree.ts`
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
- `packages/opencode/src/session/fork-smart-compaction.ts`
- `packages/opencode/src/session/fork-prune.ts`
- `packages/opencode/src/plugin/fork-guard.ts`
- `packages/opencode/src/session/fork-preload.ts`
- `packages/opencode/src/session/fork-suggest.ts`
- `script/fork-sync.sh`

Dépendance `@opencode-fork/core` ajoutée dans `packages/opencode/package.json` et `packages/tui/package.json`.

Tests upstream adaptés aux valeurs par défaut du fork : `test/tool/task.test.ts` et `test/tool/registry.test.ts` (commentaires `Fork:`).

## Après un merge upstream

Pour vérifier que chaque seam est toujours présent et toujours sur le chemin actif :

```sh
grep -rn "FORK-SEAM" packages/
```

Vérifie en particulier que `SessionProcessor` est toujours utilisé par le TUI : la migration v1 vers v2 peut le rendre mort.
