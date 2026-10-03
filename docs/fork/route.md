# Router : classifieur Jev

Au nouveau message d'une session `router/auto`, le Router lit des signaux (type de tâche, complexité, raisonnement, outils, latence, ambiguïté, confiance). Source, dans l'ordre :

1. **Jev (TypeSafe)**, si `TYPESAFE_API_KEY` est définie : `POST {api}/v1/systemone`, `Authorization: Bearer <clé>`, timeout 1,5 s.
2. **Petit modèle** du provider (Haiku), si Jev est coupé, injoignable, lent, en 4xx/5xx ou renvoie une réponse inexploitable. L'erreur Jev est journalisée (`router signals`, `jev_error`).

La source (`jev` ou `small-model`) est enregistrée dans `signals.source` de la ligne `fork_route` et affichée par `opencode usage --route`.

## Confidentialité

Quand la clé est définie, chaque nouveau message utilisateur envoie à `api.typesafe.ai` :

- un extrait du message (3000 caractères max) ;
- le début de la conversation (500 caractères max), le nombre de messages, le nombre approximatif de tokens de contexte et les noms d'outils (20 max) ;
- le nom du modèle Jev (`jev-latest`).

Rien d'autre (ni fichiers, ni réponses de l'assistant, ni sorties d'outils).

Opt-out : `OPENCODE_FORK_ROUTE_JEV=0`, ou ne pas définir `TYPESAFE_API_KEY`. Le petit modèle (déjà connecté) lit alors le même extrait.

## Variables

| Variable | Défaut |
| --- | --- |
| `TYPESAFE_API_KEY` | absente : Jev inactif |
| `OPENCODE_FORK_ROUTE_JEV` | `0` coupe Jev |
| `OPENCODE_FORK_ROUTE_JEV_URL` | `https://api.typesafe.ai` |
| `OPENCODE_FORK_ROUTE_JEV_MODEL` | `jev-latest` |
| `OPENCODE_FORK_ROUTE_JEV_TIMEOUT_MS` | `1500` |
