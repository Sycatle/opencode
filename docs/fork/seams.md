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
| `usage-command` | `packages/opencode/src/index.ts` | Enregistre la commande `opencode usage` |

Fichiers ajoutés par le fork (sans conflit possible) :
- `packages/fork/**`
- `packages/opencode/src/cli/cmd/usage.ts`
- `script/fork-sync.sh`

Une dépendance a aussi été ajoutée : `@opencode-fork/core` dans `packages/opencode/package.json`.

## Après un merge upstream

Pour vérifier que chaque seam est toujours présent et toujours sur le chemin actif :

```sh
grep -rn "FORK-SEAM" packages/
```

Vérifie en particulier que `SessionProcessor` est toujours utilisé par le TUI : la migration v1 vers v2 peut le rendre mort.
