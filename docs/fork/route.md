# Router : classifieur Jev

Au nouveau message d'une session `router/auto`, le Router lit des signaux (type de tâche, complexité, raisonnement, outils, latence, ambiguïté, confiance). Source, dans l'ordre :

1. **Jev (TypeSafe)**, si `TYPESAFE_API_KEY` est définie : `POST {api}/v1/systemone`, `Authorization: Bearer <clé>`, timeout 1,5 s.
2. **Petit modèle** du provider (Haiku), si Jev est coupé, injoignable, lent, en 4xx/5xx ou renvoie une réponse inexploitable. L'erreur Jev est journalisée (`router signals`, `jev_error`).

La source (`jev` ou `small-model`) est enregistrée dans `signals.source` de la ligne `fork_route` et affichée par `opencode usage --route`.

## Confidentialité

Ce qui part à `api.typesafe.ai`, comme pour tous les usages de Jev : `docs/fork/jev.md`. Opt-out : `OPENCODE_FORK_ROUTE_JEV=0`, ou ne pas définir `TYPESAFE_API_KEY`. Le petit modèle (déjà connecté) lit alors le même extrait.

## Variables

| Variable | Défaut |
| --- | --- |
| `TYPESAFE_API_KEY` | absente : Jev inactif |
| `OPENCODE_FORK_ROUTE_JEV` | `0` coupe Jev |
| `OPENCODE_FORK_JEV_URL` | `https://api.typesafe.ai` |
| `OPENCODE_FORK_JEV_MODEL` | `jev-latest` |
| `OPENCODE_FORK_JEV_TIMEOUT_MS` | `1500` |
