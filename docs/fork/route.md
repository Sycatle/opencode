# Router : classifieur Jev

Au nouveau message d'une session `router/auto`, le Router lit des signaux (type de tâche, complexité, raisonnement, outils, latence, ambiguïté, confiance). Source, dans l'ordre :

1. **Jev (TypeSafe)**, si `TYPESAFE_API_KEY` est définie : `POST {api}/v1/systemone`, `Authorization: Bearer <clé>`, timeout 1,5 s.
2. **Petit modèle** du provider (Haiku), si Jev est coupé, injoignable, lent, en 4xx/5xx ou renvoie une réponse inexploitable. L'erreur Jev est journalisée (`router signals`, `jev_error`).

La source (`jev` ou `small-model`) est enregistrée dans `signals.source` de la ligne `fork_route` et affichée par `opencode usage --route`.

## Affinages autour de la politique

- **Relances courtes** : un message de 80 caractères ou 12 mots au plus, après une décision confiante (≥ 0,6) vieille de moins de 30 min, réutilise ses signaux (`via reused`) sans appel au classifieur. Jamais au premier message. `OPENCODE_FORK_ROUTE_RECLASSIFY=0` classe chaque message.
- **Effort** : `reasoning` ≥ 0,67 donne la variante `high` (`xhigh` / `max` à `reasoning = 1` en tier frontier) ; `reasoning` ≤ 0,1 sur une question, une recherche ou une petite édition donne `low`. Seulement si le modèle a cette variante, et elle ne change qu'avec le modèle ou à cache froid (un nouveau réglage de thinking invalide le cache). Une variante choisie par l'utilisateur gagne. `OPENCODE_FORK_ROUTE_EFFORT=0` coupe.
- **Mode plan** : `ambiguity` ≥ `OPENCODE_FORK_ROUTE_PLAN_AT` (0,7) avec confiance suffisante, agent `build` racine et `plan_enter` disponible : un rappel synthétique unique au premier pas. `OPENCODE_FORK_ROUTE_PLAN=0` coupe.
- **Escalade** : trois outils en erreur parmi les six derniers appels du tour montent d'un tier pour le reste du message (ligne `ESCALATE` dans `usage --route`, sans appel Jev). `OPENCODE_FORK_ROUTE_ESCALATE=0` coupe. Le `doom_loop` n'est pas lu : il n'apparaît pas dans les messages.

## Confidentialité

Ce qui part à `api.typesafe.ai`, comme pour tous les usages de Jev : `docs/fork/jev.md`. Opt-out : `OPENCODE_FORK_ROUTE_JEV=0`, ou ne pas définir `TYPESAFE_API_KEY`. Le petit modèle (déjà connecté) lit alors le même extrait.

## Variables

| Variable | Défaut |
| --- | --- |
| `TYPESAFE_API_KEY` | absente : Jev inactif |
| `OPENCODE_FORK_ROUTE_JEV` | `0` coupe Jev |
| `OPENCODE_FORK_ROUTE_RECLASSIFY` | `0` classe chaque message |
| `OPENCODE_FORK_ROUTE_EFFORT` | `0` coupe la variante d'effort |
| `OPENCODE_FORK_ROUTE_PLAN` / `_PLAN_AT` | `0` coupe le rappel ; seuil d'ambiguïté `0.7` |
| `OPENCODE_FORK_ROUTE_ESCALATE` | `0` coupe l'escalade |
| `OPENCODE_FORK_JEV_URL` | `https://api.typesafe.ai` |
| `OPENCODE_FORK_JEV_MODEL` | `jev-latest` |
| `OPENCODE_FORK_JEV_TIMEOUT_MS` | `1500` |
