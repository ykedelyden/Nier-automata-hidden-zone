# Pipeline de contenu vertical

Génère des vidéos TikTok / Shorts / Reels de plus de 61 s, prêtes à publier :
**script (Claude) → voix off → sous-titres animés → vidéo 1080x1920**.

## Installation (une fois)
1. Python 3.10+ et ffmpeg (Windows : `winget install ffmpeg`).
2. `pip install -r requirements.txt`
3. Clé API Anthropic (console.anthropic.com) :
   - Windows : `setx ANTHROPIC_API_KEY "ta-cle"` (puis rouvrir le terminal)
   - Mac / Linux : `export ANTHROPIC_API_KEY="ta-cle"`

## Configuration
Modifie `config.json` : **niche**, audience, voix (`fr-FR-HenriNeural`, `fr-FR-DeniseNeural`, `fr-FR-RemyMultilingualNeural`...).

- `backgrounds/` : tes vidéos de fond (gameplay que TU as enregistré, ou footage libre de droits).
  Sans vidéo, un fond dégradé est utilisé.
- `music/` : musiques libres de droits (optionnel).

## Utilisation
```
python pipeline.py ideas              # 15 idées de vidéos
python pipeline.py make               # 1 vidéo
python pipeline.py make --topic "..." # 1 vidéo sur un sujet précis
python pipeline.py batch 5            # 5 vidéos d'un coup
```
Chaque vidéo sort dans `output/<date>_<titre>/` : `video.mp4`, `caption.txt` (description + hashtags
+ faits à vérifier), `script.json`.

## Règles pour ne pas perdre le compte
- **Vérifie les faits** listés dans `caption.txt` avant de publier : une fake news = commentaires négatifs + signalements.
- **Publie toi-même** (ou via le planificateur officiel TikTok). Pas de bot qui simule un téléphone.
- **Ajoute ta patte** : ton angle, tes images, ta voix si possible. C'est ce qui rend le contenu « original ».
- Coût indicatif : quelques centimes de Claude par vidéo.
