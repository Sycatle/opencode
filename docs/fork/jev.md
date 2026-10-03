# Jev (TypeSafe) dans le fork

Jev est un classifieur structuré : un appel porte un `state` (texte) et des questions nommées, `choice` (une option parmi N), `score` (4 niveaux) ou `noul` (probabilité 0..1). Il ne génère jamais de texte. Client partagé : `packages/fork/src/jev.ts`.

## Règles communes

- Rien ne part sans `TYPESAFE_API_KEY`. Avec la clé, chaque usage est actif par défaut, sauf mention contraire dans le tableau.
- `OPENCODE_FORK_<ZONE>_JEV=0` coupe un usage ; `=shadow` fait tourner Jev à côté de l'ancien chemin, sans décider, et journalise la comparaison.
- Jev absent, lent (timeout 1,5 s), en 4xx/5xx ou illisible : le comportement d'avant est conservé. Pour une décision de sécurité, le défaut est de demander à l'utilisateur.
- Chaque appel est journalisé dans `fork_jev` (usage, latence, succès, décision, réponses de Jev). Le `state` envoyé n'est jamais stocké. `opencode usage --jev` résume : appels, taux de succès, p50/p95, décisions, accord avec l'ancien chemin en shadow.
- Ce que le modèle voit est écrit une seule fois, à la production, jamais calculé au rendu (le préfixe du prompt reste identique d'un tour à l'autre).

## Variables communes

| Variable | Défaut |
| --- | --- |
| `TYPESAFE_API_KEY` | absente : tout Jev est inactif |
| `OPENCODE_FORK_JEV_URL` | `https://api.typesafe.ai` |
| `OPENCODE_FORK_JEV_MODEL` | `jev-latest` |
| `OPENCODE_FORK_JEV_TIMEOUT_MS` | `1500` |

## Usages

| Usage | Interrupteur | Déclencheur | Ce qui part à `api.typesafe.ai` |
| --- | --- | --- | --- |
| Router | `OPENCODE_FORK_ROUTE_JEV` | nouveau message d'une session `router/auto` | extrait du message (3000 car.), début de la conversation (500 car.), nombre de messages, tokens de contexte approximatifs, noms d'outils (20 max), nom du modèle Jev. Ni fichiers, ni réponses de l'assistant, ni sorties d'outils. |
| Gate de suggestion | `OPENCODE_FORK_PROMPT_SUGGESTION_JEV` (seuil `_JEV_MIN`, 0,35) | fin de tour assistant, avant l'appel du petit modèle | dernier message utilisateur (800 car.), fin de la dernière réponse de l'assistant (1500 car.), nombre de todos ouvertes. |
| Hooks `classify` | aucun : l'entrée est explicite dans `hooks` (`OPENCODE_FORK_HOOKS=0` coupe tous les hooks) | événement du hook | le JSON de l'événement (arguments et sorties d'outils compris), tronqué à 3000 car. |
| `opencode auto` sans `--until` | `OPENCODE_FORK_AUTO_JEV` | fin de chaque run de l'agent, seulement sans `--until` | la tâche (2000 car.) et le dernier message de l'agent (2500 car.). Un `--until` qui échoue l'emporte toujours ; Jev indisponible arrête la boucle (`judge-unavailable`). |
