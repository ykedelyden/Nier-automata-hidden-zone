# Pipeline de contenu vertical (automatique)

Une commande → une vidéo TikTok / Shorts / Reels de plus de 61 s, prête à publier :

1. **Tendances** : Claude fait des recherches web sur ce qui buzze cette semaine et choisit le sujet
   (et la niche, si la chaîne est en `"niche": "auto"`).
2. **Script** découpé en scènes, avec des mots-clés d'illustration pour chaque scène.
3. **Voix off** par scène (edge-tts, gratuit).
4. **Images de fond** : une vidéo Pexels par scène (libre de droits), sinon `backgrounds/`, sinon dégradé.
5. **Montage** 1080x1920 + **sous-titres animés** + musique optionnelle.
6. **Légende** : description, hashtags, faits à vérifier.

## Installation (une fois)
1. Python 3.10+ et ffmpeg (Windows : `winget install ffmpeg`).
2. `pip install -r requirements.txt`
3. Clés API (variables d'environnement) :
   - `ANTHROPIC_API_KEY` : console.anthropic.com (**facturée à l'usage, séparée de l'abonnement Claude**)
   - `PEXELS_API_KEY` : gratuite sur pexels.com/api
   - Windows : `setx ANTHROPIC_API_KEY "..."` puis rouvrir le terminal.

## Utilisation
```
python pipeline.py auto                         # 1 vidéo, chaîne "default", tout automatique
python pipeline.py auto --channel gaming -n 5   # 5 vidéos pour la chaîne "gaming"
python pipeline.py make --topic "..."           # sujet imposé
python pipeline.py trends                       # voir seulement l'analyse des tendances
python pipeline.py new-channel gaming           # crée channels/gaming.json
```
Sorties : `output/<chaîne>/<date>_<titre>/` → `video.mp4`, `caption.txt`, `script.json`, `research.md`.

## Chaînes
Un fichier `channels/<nom>.json` par compte : `niche` (ou `"auto"`), `tone`, `voice`
(`fr-FR-HenriNeural`, `fr-FR-DeniseNeural`, `fr-FR-RemyMultilingualNeural`...), `target_words`, `effort`.
La chaîne garde en mémoire sa niche et ses sujets déjà traités (`output/<chaîne>/state.json`).

## Avant de publier
- Lis `caption.txt` et vérifie les faits listés.
- Publie toi-même ou avec le planificateur officiel TikTok.
