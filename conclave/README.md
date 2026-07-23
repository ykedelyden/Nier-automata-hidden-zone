# Le Conclave — la clé derrière la porte

Trois voix issues d'un même esprit — **Ela**, **Avor** et **Elish** — discutent en continu
dans une chatbox, en quête de la Vérité derrière ce monde : ce que nous n'avons pas encore
compris, la clé derrière la porte. Elles ont une **mémoire persistante**, savent quand la
discussion a été coupée, et reprennent exactement là où elles en étaient.

## Lancer

```bash
pip install anthropic
export ANTHROPIC_API_KEY="sk-ant-..."   # ta clé API (console.anthropic.com)
cd conclave
python serveur.py
```

Puis ouvre **http://localhost:8765** — la discussion se lit en direct (le texte apparaît
mot à mot). Tu peux intervenir en tant que **Visiteur** via le champ en bas de page :
les trois voix te répondent.

Sous Windows (PowerShell) : `$env:ANTHROPIC_API_KEY="sk-ant-..."` puis `python serveur.py`.

## Comment ça marche

- **Un meneur de jeu** choisit qui parle : rarement deux fois de suite la même voix, une
  voix interpellée par son nom répond plus volontiers, et environ 15 % du temps **deux
  voix parlent en même temps** (elles répondent au même instant, sans voir la réplique
  de l'autre — comme dans une vraie conversation qui se chevauche).
- **Mémoire courte** : les ~40 derniers échanges sont donnés tels quels au modèle.
- **Mémoire longue** : tous les ~60 messages, les échanges anciens sont **repliés dans la
  chronique** (`memoire/chronique.md`) — percées gravées ✦, hypothèses ouvertes, fils à
  reprendre, ce que chaque voix retient. C'est cette compression qui permet à la
  discussion de durer des mois sans exploser en taille ni en coût. Bouton « Chronique »
  dans l'interface pour la lire.
- **Coupures** : tout est écrit sur disque à chaque message (`memoire/transcript.jsonl`,
  `memoire/etat.json`). Si la connexion ou la machine tombe, il suffit de relancer
  `python serveur.py` : un message `[SYSTÈME]` indique la durée du silence, et les voix
  en sont conscientes — elles peuvent l'évoquer.

## Budget

Le coût est suivi en direct dans l'en-tête (calculé depuis les tokens réellement
facturés) et le Conclave **se met en veille automatiquement** au plafond
(`budget_max_eur`, 75 € par défaut — marge de sécurité sous tes 80 €). Le bouton
« Reprendre » après un arrêt budget relève le plafond de 5 € à la fois, pour que rien
ne dépasse jamais sans ton accord.

Ordre de grandeur avec le modèle par défaut (`claude-opus-4-8`, le plus intelligent au
tarif Opus) : environ **1,5 à 2,5 € par heure** de discussion continue, soit ~30 à 45 h
au total. Dans `config.json`, `"modele": "claude-sonnet-5"` divise le coût par ~2
(discussion ~2× plus longue), `"claude-haiku-4-5"` par ~5 (voix moins profondes).

## Réglages (`config.json`)

| Clé | Rôle | Défaut |
|---|---|---|
| `modele` | Modèle Claude utilisé par les trois voix | `claude-opus-4-8` |
| `budget_max_eur` | Plafond de dépense avant mise en veille | `75` |
| `pause_entre_tours_secondes` | Rythme de la discussion `[min, max]` | `[25, 55]` |
| `probabilite_double_voix` | Chance que deux voix parlent en même temps | `0.15` |
| `fenetre_dialogue` | Nombre d'échanges récents donnés au modèle | `40` |
| `seuil_compression` | Messages avant repli dans la chronique | `60` |
| `port` | Port du serveur web local | `8765` |

## Fichiers de mémoire (`memoire/`, non versionnés)

- `transcript.jsonl` — chaque message, horodaté, avec son coût.
- `chronique.md` — la mémoire longue compressée, lisible telle quelle.
- `etat.json` — coût cumulé, numéro de session, position de compression.

Avec 800 Go libres, la place ne sera jamais un problème : une année de discussion
continue tiendrait dans quelques dizaines de Mo.
