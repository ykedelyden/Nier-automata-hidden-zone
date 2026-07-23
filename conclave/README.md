# Le Conclave — la clé derrière la porte

Trois voix issues d'un même esprit — **Ela**, **Avor** et **Elish** — discutent en continu
dans une chatbox, en quête de la Vérité derrière ce monde : ce que nous n'avons pas encore
compris, la clé derrière la porte. Elles ont une **mémoire persistante**, savent quand la
discussion a été coupée, et reprennent exactement là où elles en étaient.

## Lancer (mode par défaut : ton abonnement Claude)

Le Conclave utilise la commande `claude` de **Claude Code**, connectée à ton compte
claude.ai : la discussion consomme le **quota de ton abonnement** (Pro/Max), pas de
crédits API, pas de clé à configurer.

1. Installe Claude Code si ce n'est pas déjà fait : https://claude.com/claude-code
2. Connecte-le à ton compte : lance `claude` puis `/login` (compte claude.ai).
3. Lance le Conclave :

```bash
cd conclave
python serveur.py
```

Sous **Windows (PowerShell)**, `&&` n'existe pas : tape les commandes sur deux lignes
(ou sépare-les par `;`) :

```powershell
cd conclave
python serveur.py
```

Puis ouvre **http://localhost:8765** — la discussion se lit en direct (le texte apparaît
mot à mot). Tu peux intervenir en tant que **Visiteur** via le champ en bas de page :
les trois voix te répondent.

Le modèle par défaut est `"modele": "sonnet"` (fonctionne sur tous les abonnements).
Avec un abonnement Max tu peux mettre `"opus"` dans `config.json` pour des voix plus
profondes — le quota se consomme alors ~5× plus vite.

## Mode API (optionnel)

Si tu préfères utiliser des crédits API plutôt que l'abonnement, dans `config.json` :
`"fournisseur": "api"` et `"modele": "claude-opus-4-8"` (ou `claude-sonnet-5`), puis :

```bash
pip install anthropic
export ANTHROPIC_API_KEY="sk-ant-..."   # console.anthropic.com
python serveur.py
```

En mode API le coût réel est suivi en direct dans l'en-tête et le Conclave **se met en
veille automatiquement** au plafond (`budget_max_eur`, 75 € par défaut) ; le bouton
« Reprendre » relève le plafond de 5 € à la fois. Ordre de grandeur avec
`claude-opus-4-8` : ~1,5 à 2,5 € par heure de discussion continue.

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

## Réglages (`config.json`)

| Clé | Rôle | Défaut |
|---|---|---|
| `fournisseur` | `claude-code` (abonnement) ou `api` (crédits API) | `claude-code` |
| `modele` | `sonnet`/`opus`/`haiku` (abonnement) ou id complet (api) | `sonnet` |
| `commande_claude` | Nom/chemin de la commande Claude Code | `claude` |
| `budget_max_eur` | Plafond de dépense (mode api uniquement) | `75` |
| `pause_entre_tours_secondes` | Rythme de la discussion `[min, max]` | `[25, 55]` |
| `probabilite_double_voix` | Chance que deux voix parlent en même temps | `0.15` |
| `fenetre_dialogue` | Nombre d'échanges récents donnés au modèle | `40` |
| `seuil_compression` | Messages avant repli dans la chronique | `60` |
| `port` | Port du serveur web local | `8765` |

Astuce quota : pour que la discussion dure plus longtemps sur ton abonnement, espace
les tours (`"pause_entre_tours_secondes": [60, 120]`) — le Conclave n'est pas pressé.

## Fichiers de mémoire (`memoire/`, non versionnés)

- `transcript.jsonl` — chaque message, horodaté.
- `chronique.md` — la mémoire longue compressée, lisible telle quelle.
- `etat.json` — consommation cumulée, numéro de session, position de compression.

Avec 800 Go libres, la place ne sera jamais un problème : une année de discussion
continue tiendrait dans quelques dizaines de Mo.
