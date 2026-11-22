#!/usr/bin/env python3
"""
Pipeline de contenu vertical 100 % automatique (TikTok / Shorts / Reels).

  tendances (Claude + recherche web)  ->  sujet + script découpé en scènes  ->  voix off par scène
  ->  B-roll par scène (Pexels)  ->  montage  ->  sous-titres animés  ->  vidéo 1080x1920 + légende

Usage :
  python pipeline.py auto                          # chaîne "default", 1 vidéo, tout automatique
  python pipeline.py auto --channel gaming -n 5    # 5 vidéos pour la chaîne channels/gaming.json
  python pipeline.py make --topic "..."            # 1 vidéo sur un sujet imposé
  python pipeline.py trends --channel gaming       # affiche juste l'analyse des tendances
  python pipeline.py new-channel nom               # crée channels/nom.json à partir du modèle

Chaque chaîne = un fichier channels/<nom>.json (niche, voix, ton). niche = "auto" : Claude choisit
la niche la plus porteuse du moment et la garde en mémoire pour rester cohérent.
Sorties : output/<chaîne>/<date>_<titre>/  ->  video.mp4, caption.txt, script.json
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import os
import random
import re
import shutil
import subprocess
import sys
import unicodedata
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CHANNELS = ROOT / "channels"
OUTPUT = ROOT / "output"
CACHE = ROOT / "cache"
BACKGROUNDS = ROOT / "backgrounds"
MUSIC = ROOT / "music"

W, H, FPS = 1080, 1920, 30
VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".ogg"}

DEFAULT_CHANNEL = {
    "niche": "auto",
    "audience": "Francophones de 16 à 35 ans sur TikTok",
    "language": "français",
    "tone": "rythmé, intrigant, phrases courtes, comme un pote qui raconte une histoire incroyable",
    "voice": "fr-FR-HenriNeural",
    "voice_rate": "+8%",
    "target_words": 190,
    "model": "claude-opus-5-5",
    "effort": "high",
    "music_volume": 0.10,
    "font": "Montserrat ExtraBold",
    "fallback_font": "DejaVu Sans",
    "words_per_caption": 3,
}


# =========================================================================== utils

def slugify(text: str, max_len: int = 40) -> str:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-zA-Z0-9]+", "-", text).strip("-").lower()[:max_len] or "video"


def run(cmd: list[str]) -> None:
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f"Commande échouée :\n{' '.join(cmd)}\n\n{res.stderr[-3000:]}")


def probe_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def read_json(path: Path, default):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else default


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def load_channel(name: str) -> dict:
    path = CHANNELS / f"{name}.json"
    if not path.exists():
        if name != "default":
            sys.exit(f"Chaîne inconnue : {path}. Crée-la avec : python pipeline.py new-channel {name}")
        write_json(path, DEFAULT_CHANNEL)
    cfg = {**DEFAULT_CHANNEL, **read_json(path, {})}
    cfg["name"] = name
    cfg["state_path"] = OUTPUT / name / "state.json"
    return cfg


# =========================================================================== Claude

def _client():
    try:
        import anthropic
    except ImportError:
        sys.exit("Installe les dépendances : pip install -r requirements.txt")
    return anthropic.Anthropic()


WEB_SEARCH = {"type": "web_search_20260209", "name": "web_search", "max_uses": 8}


def research_trends(cfg: dict, state: dict) -> str:
    """Claude cherche sur le web ce qui buzze MAINTENANT et choisit l'angle. Renvoie une note de recherche."""
    niche = state.get("niche") if cfg["niche"] == "auto" else cfg["niche"]
    today = dt.date.today().isoformat()
    done = "\n".join(f"- {t}" for t in state.get("titles", [])[-80:]) or "(aucune)"

    if niche:
        ask = f"La chaîne est sur la niche : {niche}."
    else:
        ask = ("La chaîne n'a pas encore de niche. Choisis UNE niche précise qui marche en ce moment sur TikTok "
               "francophone, faisable en voix off + images d'illustration (pas de visage), avec beaucoup de sujets "
               "possibles et un public qui commente. Commence ta réponse par une ligne 'NICHE: <la niche>'.")

    prompt = f"""Nous sommes le {today}. Tu prépares la prochaine vidéo d'une chaîne TikTok.
{ask}
Audience : {cfg['audience']}

Fais des recherches web pour trouver ce qui est tendance ou d'actualité CETTE SEMAINE dans cette niche
(actus, sorties, polémiques, anniversaires, sujets qui reviennent dans les recherches).
Puis choisis LE meilleur sujet pour une vidéo d'une minute : fort potentiel de curiosité, faits vérifiables,
pas déjà traité par la chaîne. Tu peux aussi proposer un angle original qui pourrait lancer une tendance.

Vidéos déjà publiées (ne pas refaire) :
{done}

Rends une note courte : le sujet choisi, pourquoi maintenant, les faits clés avec leurs sources (URL)."""

    client = _client()
    messages = [{"role": "user", "content": prompt}]
    for _ in range(5):
        resp = client.messages.create(
            model=cfg["model"], max_tokens=16000, output_config={"effort": cfg["effort"]},
            tools=[WEB_SEARCH], messages=messages,
        )
        if resp.stop_reason != "pause_turn":
            break
        messages = [{"role": "user", "content": prompt}, {"role": "assistant", "content": resp.content}]
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude a refusé la recherche de tendance.")

    note = "\n".join(b.text for b in resp.content if b.type == "text").strip()
    m = re.search(r"NICHE\s*:\s*(.+)", note)
    if cfg["niche"] == "auto" and not state.get("niche") and m:
        state["niche"] = m.group(1).strip()
    return note


SCRIPT_SYSTEM = """Tu es un scénariste de vidéos courtes virales (TikTok, Shorts, Reels).
- HOOK (première phrase) : tension ou curiosité immédiate en moins de 2 secondes. Jamais "Saviez-vous que"
  ni "Aujourd'hui on va parler de". Commence au cœur de l'histoire.
- Phrases courtes, langage parlé naturel. Relance la curiosité toutes les 10 à 15 secondes.
- N'utilise QUE des faits présents dans la note de recherche. N'invente rien.
- Termine par une chute forte ou une question qui pousse à commenter. Jamais "abonne-toi".
- Pas d'emojis, pas de didascalies : uniquement le texte lu à voix haute.
- Pour chaque scène, `broll_query` = 2 à 4 mots-clés EN ANGLAIS décrivant une vidéo d'illustration
  générique trouvable sur une banque d'images (ex: "dark server room", "crowd cheering stadium").
  Pas de noms de marques, de personnes ou de jeux : la banque d'images ne les a pas."""


def write_script(cfg: dict, note: str, topic: str | None) -> dict:
    from pydantic import BaseModel

    class Scene(BaseModel):
        text: str
        broll_query: str

    class Script(BaseModel):
        title: str
        scenes: list[Scene]
        caption: str
        hashtags: list[str]
        facts_to_check: list[str]

    subject = f"Sujet imposé : {topic}\n" if topic else ""
    prompt = f"""{subject}Note de recherche :
{note}

Ton de la chaîne : {cfg['tone']}
Langue : {cfg['language']}
Écris la vidéo : environ {cfg['target_words']} mots au total (au moins 61 secondes lues),
découpée en 8 à 14 scènes de 1 à 2 phrases. La première scène est le hook.
`caption` : description TikTok accrocheuse (1 à 2 phrases). `hashtags` : 4 à 6, sans #.
`facts_to_check` : les 2 ou 3 faits clés à vérifier avant publication, avec la source."""

    resp = _client().messages.parse(
        model=cfg["model"], max_tokens=16000, output_config={"effort": cfg["effort"]},
        system=SCRIPT_SYSTEM, messages=[{"role": "user", "content": prompt}], output_format=Script,
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("Claude a refusé d'écrire ce script.")
    return resp.parsed_output.model_dump()


# =========================================================================== voix off

async def _tts(text: str, voice: str, rate: str, mp3: Path) -> list[tuple[float, float, str]]:
    import edge_tts

    com = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
    words = []
    with open(mp3, "wb") as f:
        async for chunk in com.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                s = chunk["offset"] / 1e7
                words.append((s, s + chunk["duration"] / 1e7, chunk["text"]))
    return words


def voice_scenes(cfg: dict, scenes: list[dict], folder: Path):
    """Une voix off par scène -> durées exactes pour caler les images. Renvoie (audio, mots, durées)."""
    parts, all_words, durations, t0 = [], [], [], 0.0
    for i, sc in enumerate(scenes):
        mp3 = folder / f"_v{i:02d}.mp3"
        words = asyncio.run(_tts(sc["text"], cfg["voice"], cfg["voice_rate"], mp3))
        if not mp3.exists() or mp3.stat().st_size == 0:
            raise RuntimeError("La synthèse vocale n'a rien renvoyé (connexion internet ?).")
        d = probe_duration(mp3) + 0.12  # mini respiration entre les scènes
        all_words.append([(s + t0, e + t0, w) for s, e, w in words])
        durations.append(d)
        parts.append(mp3)
        t0 += d

    lst = folder / "_voices.txt"
    lst.write_text("".join(f"file '{p.name}'\n" for p in parts), encoding="utf-8")
    voice = folder / "voice.m4a"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
         "-af", "apad=pad_dur=0.12", "-c:a", "aac", "-b:a", "192k", str(voice)])
    for p in parts:
        p.unlink(missing_ok=True)
    lst.unlink(missing_ok=True)
    return voice, all_words, durations


# =========================================================================== B-roll (Pexels)

def pexels_search(query: str) -> list[dict]:
    key = os.environ.get("PEXELS_API_KEY")
    if not key:
        return []
    url = "https://api.pexels.com/videos/search?" + urllib.parse.urlencode(
        {"query": query, "orientation": "portrait", "per_page": 15, "size": "medium"})
    req = urllib.request.Request(url, headers={"Authorization": key, "User-Agent": "content-pipeline"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.load(r).get("videos", [])
    except Exception as e:  # réseau, quota...
        print(f"     (Pexels indisponible pour '{query}' : {e})")
        return []


def fetch_broll(query: str, min_dur: float, used: set[int]) -> Path | None:
    vids = [v for v in pexels_search(query) if v["id"] not in used and v.get("duration", 0) >= min(min_dur, 4)]
    if not vids:
        # on simplifie la requête (2 premiers mots) avant d'abandonner
        short = " ".join(query.split()[:2])
        if short != query:
            vids = [v for v in pexels_search(short) if v["id"] not in used]
    if not vids:
        return None
    vid = random.choice(vids[:6])
    files = [f for f in vid["video_files"] if f.get("height") and f.get("file_type") == "video/mp4"]
    files.sort(key=lambda f: abs(f["height"] - 1920))
    if not files:
        return None
    dest = CACHE / f"pexels_{vid['id']}.mp4"
    if not dest.exists():
        CACHE.mkdir(exist_ok=True)
        req = urllib.request.Request(files[0]["link"], headers={"User-Agent": "content-pipeline"})
        with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
    used.add(vid["id"])
    return dest


def local_background() -> Path | None:
    bgs = [p for p in BACKGROUNDS.glob("*") if p.suffix.lower() in VIDEO_EXT]
    return random.choice(bgs) if bgs else None


def scene_clip(src: Path | None, dur: float, out: Path) -> None:
    vf = (f"scale={W}:{H}:force_original_aspect_ratio=increase,crop={W}:{H},"
          f"eq=brightness=-0.05:saturation=1.08,setsar=1,fps={FPS},format=yuv420p")
    if src is None:
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi",
               "-i", f"gradients=s={W}x{H}:c0=0x0f0c29:c1=0x302b63:c2=0x24243e:speed=0.02:r={FPS}",
               "-t", f"{dur:.3f}", "-vf", f"setsar=1,format=yuv420p"]
    else:
        src_len = probe_duration(src)
        start = random.uniform(0, src_len - dur) if src_len > dur + 0.5 else 0
        cmd = ["ffmpeg", "-y", "-loglevel", "error", "-stream_loop", "-1", "-ss", f"{start:.2f}", "-i", str(src),
               "-t", f"{dur:.3f}", "-vf", vf]
    run(cmd + ["-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", str(out)])


# =========================================================================== sous-titres

def _ass_time(t: float) -> str:
    cs = int(round(t * 100))
    h, cs = divmod(cs, 360000)
    m, cs = divmod(cs, 6000)
    s, cs = divmod(cs, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def pick_font(cfg: dict) -> str:
    try:
        fonts = subprocess.run(["fc-list", ":", "family"], capture_output=True, text=True).stdout
    except FileNotFoundError:
        return cfg["font"]
    return cfg["font"] if cfg["font"].lower() in fonts.lower() else cfg["fallback_font"]


def build_ass(cfg: dict, scene_words: list[list[tuple[float, float, str]]], path: Path) -> None:
    """Sous-titres façon TikTok : quelques mots à l'écran, mot prononcé en jaune, petit pop."""
    font = pick_font(cfg)
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
    n = max(1, int(cfg["words_per_caption"]))
    # les groupes de mots ne chevauchent jamais deux scènes
    groups = [ws[i:i + n] for ws in scene_words if ws for i in range(0, len(ws), n)]
    lines = []
    for gi, group in enumerate(groups):
        g_end = groups[gi + 1][0][0] if gi + 1 < len(groups) else group[-1][1] + 0.3
        for wi, (ws, _, _) in enumerate(group):
            seg_end = group[wi + 1][0] if wi + 1 < len(group) else g_end
            parts = []
            for wj, (_, _, txt) in enumerate(group):
                txt = txt.upper().replace("{", "").replace("}", "")
                parts.append(r"{\c&H00E5FF&}" + txt + r"{\c&HFFFFFF&}" if wj == wi else txt)
            pop = r"{\fscx112\fscy112\t(0,90,\fscx100\fscy100)}" if wi == 0 else ""
            lines.append(f"Dialogue: 0,{_ass_time(ws)},{_ass_time(seg_end)},Cap,,0,0,0,,{pop}{' '.join(parts)}")
    path.write_text(header + "\n".join(lines) + "\n", encoding="utf-8")


# =========================================================================== montage final

def assemble(cfg: dict, clips: list[Path], voice: Path, ass: Path, out: Path) -> None:
    folder = out.parent
    lst = folder / "_clips.txt"
    lst.write_text("".join(f"file '{c.name}'\n" for c in clips), encoding="utf-8")
    base = folder / "_base.mp4"
    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy", str(base)])

    musics = [p for p in MUSIC.glob("*") if p.suffix.lower() in AUDIO_EXT]
    ass_arg = str(ass).replace("\\", "/").replace(":", r"\:")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(base), "-i", str(voice)]
    if musics:
        cmd += ["-stream_loop", "-1", "-i", str(random.choice(musics))]
        af = f"[2:a]volume={cfg['music_volume']}[mu];[1:a][mu]amix=inputs=2:duration=first:dropout_transition=0[a]"
    else:
        af = "[1:a]anull[a]"
    cmd += ["-filter_complex", f"[0:v]subtitles='{ass_arg}'[v];{af}", "-map", "[v]", "-map", "[a]",
            "-shortest", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(out)]
    run(cmd)
    for p in [lst, base, *clips]:
        p.unlink(missing_ok=True)


# =========================================================================== orchestration

def make_video(cfg: dict, topic: str | None = None) -> Path:
    state = read_json(cfg["state_path"], {"titles": []})

    print("1/6  Recherche des tendances (web)...")
    note = research_trends(cfg, state) if not topic else f"Sujet demandé : {topic}"
    if state.get("niche"):
        print(f"     niche : {state['niche']}")

    print("2/6  Script...")
    s = write_script(cfg, note, topic)
    folder = OUTPUT / cfg["name"] / f"{dt.datetime.now():%Y%m%d_%H%M%S}_{slugify(s['title'])}"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "research.md").write_text(note, encoding="utf-8")
    write_json(folder / "script.json", s)
    print(f"     -> {s['title']}  ({len(s['scenes'])} scènes)")

    print("3/6  Voix off...")
    voice, words, durations = voice_scenes(cfg, s["scenes"], folder)

    print("4/6  Images de fond...")
    used: set[int] = set()
    clips = []
    for i, (sc, d) in enumerate(zip(s["scenes"], durations)):
        src = fetch_broll(sc["broll_query"], d, used) or local_background()
        out = folder / f"_c{i:02d}.mp4"
        scene_clip(src, d, out)
        clips.append(out)

    print("5/6  Sous-titres...")
    build_ass(cfg, words, folder / "subs.ass")

    print("6/6  Montage...")
    assemble(cfg, clips, voice, folder / "subs.ass", folder / "video.mp4")

    tags = " ".join("#" + t.lstrip("#").replace(" ", "") for t in s["hashtags"])
    (folder / "caption.txt").write_text(
        f"{s['caption']}\n\n{tags}\n\n---\nÀ VÉRIFIER AVANT DE PUBLIER :\n"
        + "\n".join(f"- {x}" for x in s["facts_to_check"]) + "\n", encoding="utf-8")

    state["titles"] = (state.get("titles", []) + [s["title"]])[-300:]
    write_json(cfg["state_path"], state)

    d = probe_duration(folder / "video.mp4")
    warn = "" if d >= 61 else "  (< 61 s : pas éligible Creator Rewards, augmente target_words)"
    print(f"OK  {folder / 'video.mp4'}  [{d:.0f} s]{warn}")
    return folder


def main() -> None:
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            sys.exit(f"{tool} introuvable. Installe ffmpeg et ajoute-le au PATH.")

    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("auto")
    a.add_argument("--channel", default="default")
    a.add_argument("-n", type=int, default=1)
    m = sub.add_parser("make")
    m.add_argument("--channel", default="default")
    m.add_argument("--topic", required=True)
    t = sub.add_parser("trends")
    t.add_argument("--channel", default="default")
    nc = sub.add_parser("new-channel")
    nc.add_argument("name")
    args = ap.parse_args()

    if args.cmd == "new-channel":
        path = CHANNELS / f"{args.name}.json"
        if path.exists():
            sys.exit(f"{path} existe déjà.")
        write_json(path, DEFAULT_CHANNEL)
        print(f"Créé : {path}  (modifie la niche, la voix et le ton)")
        return

    cfg = load_channel(args.channel)
    if not os.environ.get("PEXELS_API_KEY"):
        print("Info : PEXELS_API_KEY absente -> fonds pris dans backgrounds/ ou dégradé.")

    if args.cmd == "trends":
        state = read_json(cfg["state_path"], {"titles": []})
        print(research_trends(cfg, state))
        write_json(cfg["state_path"], state)
    elif args.cmd == "make":
        make_video(cfg, args.topic)
    elif args.cmd == "auto":
        ok = 0
        for i in range(args.n):
            print(f"\n===== [{cfg['name']}] vidéo {i + 1}/{args.n} =====")
            try:
                make_video(cfg)
                ok += 1
            except Exception as e:  # une vidéo ratée ne bloque pas le lot
                print(f"ÉCHEC : {e}")
        print(f"\n{ok}/{args.n} vidéos générées.")


if __name__ == "__main__":
    main()
