# Hooks déclaratifs

Hooks (commande shell, POST HTTP, prompt au petit modèle ou question à Jev) déclarés dans la clé `hooks` de `opencode.json`.
Logique pure et runner : `packages/fork/src/hooks.ts` ; plugin : `packages/opencode/src/plugin/fork-hooks.ts` ;
appel du petit modèle : `packages/opencode/src/plugin/fork-hooks-model.ts`. `OPENCODE_FORK_HOOKS=0` coupe tout.

```json
{ "hooks": { "PreToolUse": [{ "matcher": "bash|edit", "command": "./guard.sh", "timeout": 5000 }] } }
```

`timeout` en ms (défaut 60 000). Les entrées malformées sont ignorées silencieusement.

## Événements

| Événement | Déclenché | Matcher porte sur | Effet possible |
| --- | --- | --- | --- |
| `PreToolUse` | avant un outil | nom de l'outil | bloquer, réécrire `args` |
| `PostToolUse` | après un outil | nom de l'outil | `additionalContext` ajouté à la sortie |
| `PostToolUseFailure` | l'outil a échoué (ni refus utilisateur, ni blocage `PreToolUse`) | nom de l'outil | `additionalContext` ajouté à l'erreur |
| `UserPromptSubmit` | avant la persistance du message | (aucun) | bloquer, `additionalContext` en part synthétique |
| `PermissionRequest` | demande de permission | type de permission | `allow` / `deny` / `ask` |
| `PreCompact` | avant compaction | (aucun) | `additionalContext` ajouté au contexte du résumé |
| `Notification` | permission demandée, question posée, session racine idle | type : `permission`, `question`, `idle` | aucun (fire-and-forget) |
| `SessionStart` | `session.created` | (aucun) | `additionalContext` injecté dans le premier message d'une session racine |
| `SessionEnd` | `session.deleted`, ou arrêt de l'instance pour les sessions encore vivantes | (aucun) | aucun (fire-and-forget) |
| `Stop` | `session.idle` d'une session racine | (aucun) | aucun (fire-and-forget) |
| `SubagentStop` | `session.idle` d'une session enfant (sous-agent task, arrière-plan compris) | (aucun) | aucun (fire-and-forget) |

`Stop` ne peut pas bloquer (l'événement bus n'attend personne), donc `SubagentStop` non plus.

Champs de payload en plus de `event`, `sessionID`, `cwd` : `parentID` (`SessionStart`, `SessionEnd`,
`SubagentStop`, pour une session enfant), `agent` (`SubagentStop`), `reason` (`SessionEnd` : `deleted` ou `exit`),
`notificationType` et `message` (`Notification`), `tool`, `args` et `error` (`PostToolUseFailure`).

Matcher : absent, `""` ou `*` = tout. Sinon regex insensible à la casse sur le nom entier
(`^(?:matcher)$`) ; une regex invalide ne matche rien.

## Types de hook

`type` vaut `command` par défaut.

```json
{ "hooks": { "PostToolUseFailure": [
  { "type": "http", "url": "https://hooks.example.com/fail", "headers": { "Authorization": "Bearer $HOOK_TOKEN" } },
  { "type": "prompt", "prompt": "Is this failure recoverable? $ARGUMENTS", "matcher": "bash" }
] } }
```

- `command` : `command` obligatoire, voir Exécution.
- `http` : `url` (http/https) obligatoire. POST du JSON de l'événement (`content-type: application/json`),
  `headers` optionnels dont les valeurs expansent `$VAR` / `${VAR}` depuis l'environnement (variable absente = vide).
  Même `timeout`. Réponse 2xx : un corps JSON suit le même contrat que le stdout JSON d'une commande (un corps non
  JSON est ignoré). Non-2xx, erreur réseau ou timeout : erreur non bloquante.
- `prompt` : `prompt` obligatoire, `$ARGUMENTS` est remplacé par le JSON de l'événement. Envoyé au petit modèle du
  provider de la session (`Provider.getSmallModel`, repli sur le modèle de la session, puis le modèle par défaut).
  Le modèle doit répondre `{ "ok": boolean, "reason"?: string }` ; `ok: false` = blocage avec `reason`. Réponse non
  conforme, échec du modèle ou timeout : erreur non bloquante.

- `classify` : `question` obligatoire (question oui/non sur le JSON de l'événement, tronqué à 3000 caractères),
  `threshold` (0..1, défaut 0,5) et `reason` optionnels. Envoyé à Jev (TypeSafe), qui répond une probabilité ;
  `probabilité ≥ threshold` = blocage avec `reason` (`(p=0.82)` ajouté). Sans `TYPESAFE_API_KEY`, Jev en échec ou
  timeout (1,5 s par défaut, `timeout` de l'entrée sinon) : erreur non bloquante. Le type `prompt` libre reste sur
  le petit modèle. Voir `docs/fork/jev.md`.

## Exécution (command)

- `sh -c <command>`, cwd = répertoire du projet, env `OPENCODE_HOOK_EVENT=<événement>`.
- stdin : JSON `{ event, sessionID, cwd, tool?, args?, output?, prompt?, permission?, parentID?, agent?, error?, message?, notificationType?, reason? }`.
- Tous les hooks d'un événement tournent en parallèle.
- Chaque hook tourne dans son propre groupe de processus (Unix) ; au timeout le groupe entier
  reçoit SIGKILL, petits-enfants compris. Sous Windows seul le processus direct est tué.

## Codes de sortie (command)

- `0` : continue ; stdout peut contenir un objet JSON (voir ci-dessous).
- `2` : bloque, stderr sert de raison (« Blocked by hook » si vide).
- autre code ou timeout : erreur non bloquante, journalisée (`service: fork-hooks`) puis ignorée.

## Sortie JSON (exit 0, stdout commençant par `{`, ou corps d'une réponse HTTP 2xx)

| Champ | Valeur | Rôle |
| --- | --- | --- |
| `decision` | `block` \| `allow` \| `deny` \| `ask` | verdict (`block` et `deny` sont équivalents) |
| `reason` | string | message affiché si blocage |
| `additionalContext` | string | texte ajouté (voir tableau des événements) |
| `args` | objet | remplace les arguments (`PreToolUse`), le dernier hook l'emporte |

## Précédence des décisions

- Entre hooks d'un même événement : le plus strict gagne (`allow` < `ask` < `deny`/`block`) ;
  les `additionalContext` sont concaténés dans l'ordre de la config.
- Un `deny` du ruleset (config, agent, session) l'emporte toujours : si le ruleset tranche déjà
  (tout `allow` ou un `deny`), `PermissionRequest` n'est même pas consulté. Un hook ne peut donc
  ni transformer un `deny` en `allow`, ni un `allow` en `ask`.
- `PermissionRequest` : `allow` saute la demande, `deny`/`block` la refuse, `ask` garde le flux normal.

## Blocage d'un prompt

`UserPromptSubmit` bloquant : le message n'est pas persisté, aucun appel modèle. La raison est
publiée comme `session.error` (toast dans le TUI, ligne d'erreur dans `opencode run`).
