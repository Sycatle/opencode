# Sandbox de l'outil bash

Opt-in, Linux seulement, via bubblewrap (`bwrap`). Logique pure : `packages/fork/src/sandbox.ts` ;
colle côté outil : `packages/opencode/src/tool/fork-sandbox.ts` ; câblage : `packages/opencode/src/tool/shell.ts`.
Config : `packages/core/src/config/sandbox.ts`.

```json
{ "sandbox": { "enabled": true, "network": { "allow": ["github.com"] }, "write": ["~/.cache"], "read_deny": ["~/.ssh"] } }
```

| Clé | Effet |
| --- | --- |
| `enabled` | active la sandbox |
| `network.allow` | liste non vide : réseau **autorisé** (voir plus bas). Vide ou absente : réseau coupé |
| `write` | chemins en écriture en plus du projet (dossier + worktree) et de `/tmp` ; `~` accepté, relatif = depuis le projet |
| `read_deny` | chemins masqués ; remplace la liste par défaut `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh` |

`OPENCODE_FORK_SANDBOX=1` force l'activation, `=0` la désactivation (prioritaire sur la config).

## Ce que bwrap monte

`--ro-bind / /`, `--dev /dev`, `--proc /proc`, `--bind` du projet, de son worktree (sauf `/`), de `/tmp` et de `write`,
`--tmpfs` sur les dossiers de `read_deny` (`--ro-bind /dev/null` pour un fichier), `--unshare-all`, `--share-net` si
`network.allow` n'est pas vide, `--die-with-parent`. Les chemins absents sont ignorés (bwrap échoue sinon).
cwd et variables d'environnement sont inchangés. S'applique à l'outil `bash`, à son mode `background` et à `monitor`.
Le dossier de troncature d'opencode n'est pas monté : c'est opencode, hors sandbox, qui y écrit.

bwrap absent ou inutilisable (espaces de noms utilisateur désactivés, testé une fois par un vrai lancement) : les commandes
tournent sans sandbox, avec un seul avertissement dans le log.

## Réseau : tout ou rien

bwrap ne filtre pas par domaine. Un proxy CONNECT local avec liste blanche serait contournable (il faudrait que chaque
outil respecte `HTTP_PROXY`, alors que l'environnement doit rester identique) et ne ferait qu'ajouter une apparence de
filtrage. Choix : `network.allow` non vide = **réseau autorisé** dans son ensemble ; les domaines listés sont
documentaires. Vide ou absent = aucun réseau.

## Échappement

Paramètre `sandbox: false` de l'outil bash (`dangerouslyDisableSandbox: true` sous le profil Claude Code). Il déclenche
toujours la permission `sandbox_escape` (pattern = la commande, `always` vide donc jamais mémorisée). Quand la sandbox est
inactive il n'y a rien à demander.

Une commande en échec dont la sortie contient `Read-only file system`, `EROFS`, `EACCES`, `permission denied`, ou (réseau
coupé) une erreur de résolution ou de connexion reçoit une ligne `[sandbox] ...` indiquant l'échappement possible.

## Limites

- Les sockets Unix de l'hôte (docker, agent SSH) restent joignables : `/` est en lecture seule, pas invisible.
- `~/.cache`, `~/.bun`, `~/.npm`, etc. sont en lecture seule : ajouter ce qu'il faut à `write`.
- Le mode auto doit traiter `sandbox_escape` comme jamais auto-approuvé : l'outil ne contrôle pas le ruleset de l'agent.
