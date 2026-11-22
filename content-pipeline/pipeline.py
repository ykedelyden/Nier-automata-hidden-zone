#!/usr/bin/env python3
"""
Pipeline de contenu vertical (TikTok / Shorts / Reels).

  idée + script (Claude)  ->  voix off (edge-tts)  ->  sous-titres animés  ->  vidéo 1080x1920 (ffmpeg)

Usage :
  python pipeline.py ideas                 # propose 15 idées de vidéos pour ta niche
  python pipeline.py make                  # génère 1 vidéo complète (idée choisie par Claude)
  python pipeline.py make --topic "..."    # génère 1 vidéo sur un sujet précis
  python pipeline.py batch 5               # génère 5 vidéos d'un coup (sujets tous différents)

Les vidéos sortent dans output/<date>_<slug>/ avec video.mp4 + caption.txt (description + hashtags).
La publication reste manuelle (ou via le planificateur officiel TikTok) : 10 secondes par vidéo,
et ça protège ton compte.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import random
import re
import shutil
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONFIG = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
OUTPUT = ROOT / "output"
BACKGROUNDS = ROOT / "backgrounds"
MUSIC = ROOT / "music"
HISTORY = ROOT / "output" / "history.json"

W, H = 1080, 1920
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm"}


# --------------------------------------------------------------------------- utils

def slugify(text: str, max_len: int = 40) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    text = re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()
    return text[:max_len] or "video"


def run(cmd: list[str]) -> None:
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        sys.exit(f"Commande échouée :\n{' '.join(cmd)}\n\n{res.stderr[-3000:]}")


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    return float(out or 0)


def load_history() -> list[str]:
    if HISTORY.exists():
        return json.loads(HISTORY.read_text(encoding="utf-8"))
    return []


def save_history(titles: list[str]) -> None:
    HISTORY.parent.mkdir(parents=True, exist_ok=True)
    HISTORY.write_text(json.dumps(titles[-300:], ensure_ascii=False, indent=2), encoding="utf-8")


# --------------------------------------------------------------------------- 1. script (Claude)

def _client():
    try:
        import anthropic
    except ImportError:
        sys.exit("Installe les dépendances : pip install -r requirements.txt")
    return anthropic.Anthropic()


SYSTEM = """Tu es un scénariste de vidéos courtes virales (TikTok, Shorts, Reels).
Tu écris des scripts de voix off qui retiennent l'attention jusqu'à la dernière seconde.

Règles :
- Le HOOK (première phrase) doit créer une tension ou une curiosité immédiate en moins de 2 secondes.
  Pas de "Saviez-vous que", pas de "Aujourd'hui on va parler de". Commence au cœur de l'action.
- Phrases courtes, rythmées, langage parlé naturel. Une idée par phrase.
- Relance la curiosité toutes les 10 à 15 secondes ("mais le pire, c'est...", "sauf que...").
- Les faits doivent être exacts et vérifiables. Si tu n'es pas sûr d'un détail, ne l'invente pas : choisis un autre angle.
- Finis par une chute forte ou une question qui pousse à commenter. Pas de "abonne-toi".
- Pas d'emojis, pas de didascalies, pas de crochets : uniquement le texte lu à voix haute.
"""


def generate_script(topic: str | None = None, avoid: list[str] | None = None) -> dict:
    from pydantic import BaseModel

    class Script(BaseModel):
        title: str
        hook: str
        script: str
        caption: str
        hashtags: list[str]
        sources_to_check: list[str]

    avoid_txt = "\n".join(f"- {t}" for t in (avoid or [])[-60:]) or "(aucun)"
    subject = f"Sujet imposé : {topic}" if topic else "Choisis toi-même un sujet fort et précis dans la niche."
    prompt = f"""Niche : {CONFIG['niche']}
Audience : {CONFIG['audience']}
Langue : {CONFIG['language']}
{subject}

Sujets déjà traités (ne pas refaire) :
{avoid_txt}

Écris une vidéo d'environ {CONFIG['target_words']} mots de voix off (au moins 61 secondes lues),
le champ `script` contient TOUT le texte lu, hook compris.
`caption` : description TikTok courte et accrocheuse (1 à 2 phrases).
`hashtags` : 4 à 6 hashtags pertinents, sans le #.
`sources_to_check` : les 2 ou 3 faits clés que l'humain doit vérifier avant de publier."""

    client = _client()
    resp = client.messages.parse(
        model=CONFIG["model"],
        max_tokens=16000,
        output_config={"effort": "medium"},
        system=SYSTEM,
        messages=[{"role": "user", "content": prompt}],
        output_format=Script,
    )
    if resp.stop_reason == "refusal":
        sys.exit("Claude a refusé ce sujet. Essaie un autre --topic.")
    return resp.parsed_output.model_dump()


def generate_ideas(n: int = 15) -> list[str]:
    from pydantic import BaseModel

    class Ideas(BaseModel):
        ideas: list[str]

    client = _client()
    resp = client.messages.parse(
        model=CONFIG["model"],
        max_tokens=8000,
        output_config={"effort": "medium"},
        system=SYSTEM,
        messages=[{"role": "user", "content": (
            f"Niche : {CONFIG['niche']}\nAudience : {CONFIG['audience']}\n"
            f"Propose {n} sujets de vidéos précis et vérifiables, chacun formulé comme un titre "
            f"accrocheur. Évite : {', '.join(load_history()[-60:]) or 'rien'}"
        )}],
        output_format=Ideas,
    )
    return resp.parsed_output.ideas


# --------------------------------------------------------------------------- 2. voix off (edge-tts)

async def _tts(text: str, mp3: Path) -> list[tuple[float, float, str]]:
    import edge_tts

    com = edge_tts.Communicate(text, CONFIG["voice"], rate=CONFIG["voice_rate"], boundary="WordBoundary")
    words: list[tuple[float, float, str]] = []
    with open(mp3, "wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                start = chunk["offset"] / 1e7
                words.append((start, start + chunk["duration"] / 1e7, chunk["text"]))
    return words


def synthesize(text: str, mp3: Path) -> list[tuple[float, float, str]]:
    words = asyncio.run(_tts(text, mp3))
    if not words or mp3.stat().st_size == 0:
        sys.exit("La synthèse vocale n'a rien renvoyé (connexion internet ?).")
    return words


# --------------------------------------------------------------------------- 3. sous-titres (ASS)

def _ass_time(t: float) -> str:
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def pick_font() -> str:
    wanted = CONFIG["font"]
    try:
        fonts = subprocess.run(["fc-list", ":", "family"], capture_output=True, text=True).stdout
        if wanted.lower() in fonts.lower():
            return wanted
    except FileNotFoundError:
        return wanted  # Windows : pas de fc-list, on fait confiance à la config
    return CONFIG["fallback_font"]


def build_ass(words: list[tuple[float, float, str]], path: Path) -> None:
    """Sous-titres façon TikTok : 2-3 mots à l'écran, mot courant en jaune, pop à l'apparition."""
    font = pick_font()
    header = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {W}
PlayResY: {H}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,{font},92,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,7,3,5,60,60,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    lines = []
    n = max(1, int(CONFIG["words_per_caption"]))
    groups = [words[i:i + n] for i in range(0, len(words), n)]
    for gi, group in enumerate(groups):
        g_end = groups[gi + 1][0][0] if gi + 1 < len(groups) else group[-1][1] + 0.3
        for wi, (ws, we, _) in enumerate(group):
            seg_end = group[wi + 1][0] if wi + 1 < len(group) else g_end
            parts = []
            for wj, (_, _, txt) in enumerate(group):
                txt = txt.upper().replace("{", "").replace("}", "")
                parts.append(r"{\c&H00E5FF&}" + txt + r"{\c&HFFFFFF&}" if wj == wi else txt)
            pop = r"{\fscx112\fscy112\t(0,90,\fscx100\fscy100)}" if wi == 0 else ""
            lines.append(f"Dialogue: 0,{_ass_time(ws)},{_ass_time(seg_end)},Cap,,0,0,0,,{pop}{' '.join(parts)}")

    path.write_text(header + "\n".join(lines) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- 4. rendu (ffmpeg)

def render(audio: Path, ass: Path, out: Path) -> None:
    dur = probe_duration(audio) + 0.6
    bgs = [p for p in BACKGROUNDS.iterdir() if p.suffix.lower() in VIDEO_EXT] if BACKGROUNDS.exists() else []
    musics = [p for p in MUSIC.iterdir() if p.suffix.lower() in {".mp3", ".wav", ".m4a", ".ogg"}] if MUSIC.exists() else []

    cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error"]
    if bgs:
        bg = random.choice(bgs)
        bg_len = probe_duration(bg)
        start = random.uniform(0, max(0.0, bg_len - dur - 1)) if bg_len > dur + 1 else 0
        cmd += ["-stream_loop", "-1", "-ss", f"{start:.2f}", "-i", str(bg)]
        vf = (f"[0:v]scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
              f"eq=brightness=-0.06:saturation=1.1,setsar=1,fps=30")
    else:
        # fond animé de secours si tu n'as pas encore mis de vidéos dans backgrounds/
        cmd += ["-f", "lavfi", "-i", f"gradients=s={W}x{H}:c0=0x0f0c29:c1=0x302b63:c2=0x24243e:speed=0.01:d={dur:.2f}:r=30"]
        vf = "[0:v]setsar=1,fps=30"

    cmd += ["-i", str(audio)]
    ass_arg = str(ass).replace("\\", "/").replace(":", r"\:")
    vf += f",subtitles='{ass_arg}'[v]"

    if musics:
        cmd += ["-stream_loop", "-1", "-i", str(random.choice(musics))]
        af = (f"[1:a]volume=1.0[vo];[2:a]volume={CONFIG['music_volume']}[mu];"
              f"[vo][mu]amix=inputs=2:duration=first:dropout_transition=0[a]")
    else:
        af = "[1:a]anull[a]"

    cmd += ["-filter_complex", f"{vf};{af}", "-map", "[v]", "-map", "[a]",
            "-t", f"{dur:.2f}", "-c:v", "libx264", "-preset", "medium", "-crf", "20",
            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    run(cmd)


# --------------------------------------------------------------------------- orchestration

def make_video(topic: str | None = None) -> Path:
    history = load_history()
    print("1/4  Écriture du script avec Claude...")
    s = generate_script(topic, history)

    folder = OUTPUT / f"{dt.datetime.now():%Y%m%d_%H%M%S}_{slugify(s['title'])}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "script.json").write_text(json.dumps(s, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"     -> {s['title']}")
    print("2/4  Voix off...")
    words = synthesize(s["script"], folder / "voice.mp3")

    print("3/4  Sous-titres...")
    build_ass(words, folder / "subs.ass")

    print("4/4  Rendu vidéo...")
    render(folder / "voice.mp3", folder / "subs.ass", folder / "video.mp4")

    tags = " ".join("#" + t.lstrip("#").replace(" ", "") for t in s["hashtags"])
    (folder / "caption.txt").write_text(
        f"{s['caption']}\n\n{tags}\n\n---\nÀ VÉRIFIER AVANT DE PUBLIER :\n"
        + "\n".join(f"- {x}" for x in s["sources_to_check"]) + "\n",
        encoding="utf-8",
    )
    save_history(history + [s["title"]])

    d = probe_duration(folder / "video.mp4")
    warn = "" if d >= 61 else "  (moins de 61 s : pas éligible au Creator Rewards, augmente target_words)"
    print(f"OK  {folder / 'video.mp4'}  [{d:.0f} s]{warn}")
    return folder


def main() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} introuvable. Installe ffmpeg (https://ffmpeg.org) et ajoute-le au PATH.")

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("ideas")
    mk = sub.add_parser("make")
    mk.add_argument("--topic")
    bt = sub.add_parser("batch")
    bt.add_argument("n", type=int)
    args = ap.parse_args()

    if args.cmd == "ideas":
        for i, idea in enumerate(generate_ideas(), 1):
            print(f"{i:2d}. {idea}")
    elif args.cmd == "make":
        make_video(args.topic)
    elif args.cmd == "batch":
        for i in range(args.n):
            print(f"\n===== Vidéo {i + 1}/{args.n} =====")
            make_video()


if __name__ == "__main__":
    main()
