# Hooks déclaratifs

Commandes shell déclarées dans la clé `hooks` de `opencode.json`. Logique pure et runner :
`packages/fork/src/hooks.ts` ; plugin : `packages/opencode/src/plugin/fork-hooks.ts`.
`OPENCODE_FORK_HOOKS=0` coupe tout.

```json
{ "hooks": { "PreToolUse": [{ "matcher": "bash|edit", "command": "./guard.sh", "timeout": 5000 }] } }
```

`timeout` en ms (défaut 60 000). Les entrées malformées sont ignorées silencieusement.

## Événements

| Événement | Déclenché | Matcher porte sur | Effet possible |
| --- | --- | --- | --- |
| `PreToolUse` | avant un outil | nom de l'outil | bloquer, réécrire `args` |
| `PostToolUse` | après un outil | nom de l'outil | `additionalContext` ajouté à la sortie |
| `UserPromptSubmit` | avant la persistance du message | (aucun) | bloquer, `additionalContext` en part synthétique |
| `PermissionRequest` | demande de permission | type de permission | `allow` / `deny` / `ask` |
| `PreCompact` | avant compaction | (aucun) | `additionalContext` ajouté au contexte du résumé |
| `SessionStart` | `session.created` | (aucun) | aucun (fire-and-forget) |
| `Stop` | `session.idle` | (aucun) | aucun (fire-and-forget) |

Matcher : absent, `""` ou `*` = tout. Sinon regex insensible à la casse sur le nom entier
(`^(?:matcher)$`) ; une regex invalide ne matche rien.

## Exécution

- `sh -c <command>`, cwd = répertoire du projet, env `OPENCODE_HOOK_EVENT=<événement>`.
- stdin : JSON `{ event, sessionID, cwd, tool?, args?, output?, prompt?, permission? }`.
- Tous les hooks d'un événement tournent en parallèle.
- Chaque hook tourne dans son propre groupe de processus (Unix) ; au timeout le groupe entier
  reçoit SIGKILL, petits-enfants compris. Sous Windows seul le processus direct est tué.

## Codes de sortie

- `0` : continue ; stdout peut contenir un objet JSON (voir ci-dessous).
- `2` : bloque, stderr sert de raison (« Blocked by hook » si vide).
- autre code ou timeout : erreur non bloquante, journalisée (`service: fork-hooks`) puis ignorée.

## Sortie JSON (exit 0, stdout commençant par `{`)

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
