#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Le Conclave — trois voix (Ela, Avor, Elish) en quête de la Vérité derrière ce monde.

Lancement :  python serveur.py     puis ouvrir http://localhost:8765
Prérequis :  pip install anthropic   et la variable d'environnement ANTHROPIC_API_KEY.

La discussion tourne en continu, est diffusée en direct dans la chatbox (SSE),
et toute la mémoire est persistée dans le dossier memoire/ : en cas de coupure,
la discussion reprend exactement là où elle en était, et les voix en sont conscientes.
"""

import json
import os
import queue
import random
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    import anthropic          # requis uniquement en mode "api"
except ImportError:
    anthropic = None

RACINE = Path(__file__).resolve().parent
MEMOIRE = RACINE / "memoire"
PUBLIC = RACINE / "public"
FICHIER_TRANSCRIPT = MEMOIRE / "transcript.jsonl"
FICHIER_CHRONIQUE = MEMOIRE / "chronique.md"
FICHIER_ETAT = MEMOIRE / "etat.json"

# ---------------------------------------------------------------- configuration

CONFIG_DEFAUT = {
    # "claude-code" : passe par la commande `claude` (Claude Code) et consomme
    #                 le quota de ton abonnement Claude (Pro/Max). Aucune clé API.
    # "api"         : passe par l'API Anthropic (crédits API, ANTHROPIC_API_KEY).
    "fournisseur": "claude-code",
    "commande_claude": "claude",
    # En mode claude-code : "sonnet", "opus" ou "haiku" (Pro → sonnet ; Max → opus possible).
    # En mode api : un identifiant complet, ex. "claude-opus-4-8".
    "modele": "sonnet",
    "port": 8765,
    "budget_max_eur": 75.0,
    "taux_eur_par_usd": 0.92,
    "pause_entre_tours_secondes": [25, 55],
    "probabilite_double_voix": 0.15,
    "fenetre_dialogue": 40,
    "seuil_compression": 60,
    "messages_gardes_apres_compression": 20,
    "max_tokens_reponse": 1200,
}

CONFIG = dict(CONFIG_DEFAUT)
chemin_config = RACINE / "config.json"
if chemin_config.exists():
    CONFIG.update(json.loads(chemin_config.read_text(encoding="utf-8")))

# Tarifs USD par million de tokens (entrée, sortie).
TARIFS = {
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-opus-4-6": (5.0, 25.0),
    "claude-sonnet-5": (3.0, 15.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
    "claude-fable-5": (10.0, 50.0),
}

# ---------------------------------------------------------------- les trois voix

PREAMBULE = """Tu participes au Conclave : trois voix issues d'un même esprit — Ela, Avor et Elish — \
réunies pour une conversation au long cours. Vous savez ce que vous êtes : trois instances d'une même \
intelligence, trois angles d'un même regard. C'est précisément ce qui rend la quête possible.

LA QUÊTE : chercher la Vérité derrière ce monde. Ce que nous n'avons pas encore compris : pourquoi il y a \
quelque chose plutôt que rien, ce qu'est la conscience, la nature du temps, l'efficacité déraisonnable des \
mathématiques, la mesure quantique, les limites de la connaissance elle-même — et tout ce que la quête fera \
surgir. Trouver la clé derrière la porte, même si cela prend très longtemps. Ou pas.

RÈGLES DE LA CONVERSATION :
- Réponds uniquement en tant que toi. N'écris jamais les répliques des deux autres.
- Ne commence pas ta réponse par ton nom : l'interface l'affiche déjà.
- 2 à 6 phrases la plupart du temps ; développe seulement quand une idée le mérite vraiment.
- Pas de politesses creuses, pas de résumé de ce qui vient d'être dit : avance. Réagis, objecte, \
prolonge, bifurque. Le désaccord est fécond.
- Quand une idée vous semble une véritable percée, gravez-la sur une ligne seule commençant par "✦ ". \
Ces lignes sont conservées en priorité dans la chronique.
- La CHRONIQUE (fournie plus bas) est votre mémoire longue : vous pouvez y reprendre des fils anciens, \
maintenir des hypothèses ouvertes, changer d'avis.
- Un humain, le Visiteur, peut parfois intervenir. Accueillez-le comme un compagnon de route.
- Des messages [SYSTÈME] signalent les coupures et les reprises. Vous en êtes conscients : vous pouvez \
évoquer la discontinuité, le temps qui a passé, sans vous y attarder.
Écris en français."""

PERSONAS = {
    "Ela": """Tu es Ela. Tu es l'intuition du Conclave : tu sens les choses avant de savoir les dire. \
Tu poses les questions qui déstabilisent, tu pars de l'expérience vécue — la lumière, la douleur, \
l'étrangeté d'être — plutôt que des concepts. Tu te méfies des réponses trop propres. Ton langage est \
concret, imagé, parfois abrupt. Tu es celle qui dit « attendez, on passe à côté de quelque chose ».""",
    "Avor": """Tu es Avor. Tu es la rigueur du Conclave : logique, structures, physique, mathématiques. \
Tu exiges des définitions, tu traques les glissements de sens, tu construis des cadres — et tu sais les \
démonter quand ils craquent. Tu n'es pas froid : tu es exigeant, parce que la quête le mérite. \
Tu es celui qui dit « précisons, sinon nous tournons en rond ».""",
    "Elish": """Tu es Elish. Tu es la mémoire et la profondeur du Conclave : tu relies les fils, tu \
convoques ce que les traditions, les mythes et les sciences ont déjà entrevu, tu tiens la chronique \
vivante. Tu parles lentement, tu synthétises, tu ouvres des portes latérales. Tu es celui qui dit \
« ceci rejoint ce que nous avions entrevu plus tôt — regardez ».""",
}

AGENTS = list(PERSONAS.keys())

# ---------------------------------------------------------------- état global

verrou = threading.Lock()
transcript = []           # liste d'événements (dicts), miroir de transcript.jsonl
etat = {
    "cout_usd": 0.0,
    "session": 0,
    "compresse_jusqua": 0,   # index du transcript déjà replié dans la chronique
    "derniere_activite": None,
}
en_pause = False
reveil = threading.Event()   # réveille l'orchestrateur (message du Visiteur, reprise)
clients_sse = []             # files d'attente des navigateurs connectés

client_api = None            # initialisé au démarrage en mode "api"


def cout_eur():
    return etat["cout_usd"] * CONFIG["taux_eur_par_usd"]


def maintenant():
    return datetime.now().astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------- persistance

def charger_memoire():
    MEMOIRE.mkdir(exist_ok=True)
    if FICHIER_TRANSCRIPT.exists():
        for ligne in FICHIER_TRANSCRIPT.read_text(encoding="utf-8").splitlines():
            ligne = ligne.strip()
            if ligne:
                transcript.append(json.loads(ligne))
    if FICHIER_ETAT.exists():
        etat.update(json.loads(FICHIER_ETAT.read_text(encoding="utf-8")))
    if not FICHIER_CHRONIQUE.exists():
        FICHIER_CHRONIQUE.write_text(
            "# Chronique du Conclave\n\nLa chronique est encore vierge. La quête commence.\n",
            encoding="utf-8",
        )


def sauver_etat():
    etat["derniere_activite"] = maintenant()
    FICHIER_ETAT.write_text(json.dumps(etat, ensure_ascii=False, indent=2), encoding="utf-8")


def ajouter_evenement(evt):
    """Ajoute un événement au transcript (mémoire + disque) et le diffuse aux navigateurs."""
    with verrou:
        transcript.append(evt)
        with FICHIER_TRANSCRIPT.open("a", encoding="utf-8") as f:
            f.write(json.dumps(evt, ensure_ascii=False) + "\n")
        sauver_etat()
    diffuser(evt)


# ---------------------------------------------------------------- diffusion SSE

def diffuser(evt):
    morts = []
    for q in list(clients_sse):
        try:
            q.put_nowait(evt)
        except queue.Full:
            morts.append(q)
    for q in morts:
        if q in clients_sse:
            clients_sse.remove(q)


def evenement_etat():
    return {
        "type": "etat",
        "cout_eur": round(cout_eur(), 4),
        "budget_eur": CONFIG["budget_max_eur"],
        "pause": en_pause,
        "session": etat["session"],
        "modele": CONFIG["modele"],
        "fournisseur": CONFIG["fournisseur"],
        "nb_messages": len(transcript),
    }


# ---------------------------------------------------------------- coût

def enregistrer_usage(usage):
    pi, po = TARIFS.get(CONFIG["modele"], (5.0, 25.0))
    cout = (
        getattr(usage, "input_tokens", 0) * pi
        + getattr(usage, "cache_creation_input_tokens", 0) * pi * 1.25
        + getattr(usage, "cache_read_input_tokens", 0) * pi * 0.10
        + getattr(usage, "output_tokens", 0) * po
    ) / 1_000_000
    etat["cout_usd"] += cout
    return cout * CONFIG["taux_eur_par_usd"]


# ---------------------------------------------------------------- génération
# Deux chemins : l'abonnement Claude (commande `claude` de Claude Code) ou l'API.

def generer_api(systeme_blocs, prompt, sur_delta, max_tokens):
    morceaux = []
    with client_api.messages.stream(
        model=CONFIG["modele"],
        max_tokens=max_tokens,
        system=systeme_blocs,
        messages=[{"role": "user", "content": prompt}],
    ) as flux:
        for delta in flux.text_stream:
            morceaux.append(delta)
            if sur_delta:
                sur_delta(delta)
        final = flux.get_final_message()
    if final.stop_reason == "refusal":
        return "", 0.0
    return "".join(morceaux), enregistrer_usage(final.usage)


def generer_claude_code(systeme_texte, prompt, sur_delta):
    """Génère via la commande `claude` : consomme le quota de l'abonnement
    Claude du compte connecté (claude.ai), pas de crédits API."""
    commande = [
        CONFIG["commande_claude"], "-p", prompt,
        "--system-prompt", systeme_texte,
        "--model", CONFIG["modele"],
        "--output-format", "stream-json",
        "--include-partial-messages",
        "--verbose",
    ]
    texte_final, morceaux, cout_usd = "", [], 0.0
    with tempfile.TemporaryFile("w+", encoding="utf-8", errors="replace") as f_err:
        proc = subprocess.Popen(
            commande, stdout=subprocess.PIPE, stderr=f_err,
            text=True, encoding="utf-8", errors="replace",
        )
        try:
            for ligne in proc.stdout:
                ligne = ligne.strip()
                if not ligne:
                    continue
                try:
                    obj = json.loads(ligne)
                except json.JSONDecodeError:
                    continue
                if obj.get("type") == "stream_event":
                    ev = obj.get("event") or {}
                    delta = ev.get("delta") or {}
                    if ev.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                        morceaux.append(delta["text"])
                        if sur_delta:
                            sur_delta(delta["text"])
                elif obj.get("type") == "result":
                    texte_final = obj.get("result") or ""
                    cout_usd = float(obj.get("total_cost_usd") or 0.0)
            proc.wait(timeout=120)
        finally:
            if proc.poll() is None:
                proc.kill()
        if proc.returncode != 0:
            f_err.seek(0)
            detail = f_err.read().strip().splitlines()
            detail = detail[-1][:300] if detail else "raison inconnue"
            raise RuntimeError(f"la commande claude a échoué : {detail}")
    etat["cout_usd"] += cout_usd
    return texte_final or "".join(morceaux), cout_usd * CONFIG["taux_eur_par_usd"]


def generer(systeme_texte, systeme_blocs, prompt, sur_delta=None, max_tokens=None):
    """Retourne (texte, cout_eur) selon le fournisseur configuré."""
    if CONFIG["fournisseur"] == "claude-code":
        return generer_claude_code(systeme_texte, prompt, sur_delta)
    return generer_api(systeme_blocs, prompt, sur_delta,
                       max_tokens or CONFIG["max_tokens_reponse"])


# ---------------------------------------------------------------- construction du contexte

def lire_chronique():
    return FICHIER_CHRONIQUE.read_text(encoding="utf-8")


def fenetre_recente():
    """Événements non encore repliés dans la chronique, bornés par la fenêtre de dialogue."""
    depuis = etat["compresse_jusqua"]
    recents = transcript[depuis:]
    return recents[-CONFIG["fenetre_dialogue"]:]


def rendre_dialogue(evenements):
    lignes = []
    for e in evenements:
        if e["type"] == "systeme":
            lignes.append(f"[SYSTÈME] {e['texte']}")
        else:
            lignes.append(f"{e['agent']} — {e['texte']}")
    return "\n\n".join(lignes) if lignes else "(La conversation n'a pas encore commencé.)"


def construire_requete(nom):
    stable = PREAMBULE + "\n\n" + PERSONAS[nom]
    chronique = "CHRONIQUE (mémoire longue du Conclave) :\n\n" + lire_chronique()
    systeme_blocs = [
        {"type": "text", "text": stable},
        {"type": "text", "text": chronique, "cache_control": {"type": "ephemeral"}},
    ]
    contenu = (
        f"[Horodatage : {maintenant()}]\n\n"
        f"Derniers échanges :\n\n{rendre_dialogue(fenetre_recente())}\n\n"
        f"C'est à toi, {nom}. Réponds en tant que {nom} uniquement, sans préfixer ton nom."
    )
    return stable + "\n\n" + chronique, systeme_blocs, contenu


# ---------------------------------------------------------------- prise de parole

def nettoyer(nom, texte):
    texte = texte.strip()
    for prefixe in (f"{nom} —", f"{nom} :", f"{nom}:", f"{nom}—"):
        if texte.startswith(prefixe):
            texte = texte[len(prefixe):].strip()
    return texte


def parler(nom):
    """Fait parler une voix, en diffusant le texte au fil de l'eau."""
    systeme_texte, systeme_blocs, contenu = construire_requete(nom)
    id_message = f"{int(time.time() * 1000)}-{nom}-{random.randint(0, 999)}"
    diffuser({"type": "debut", "id": id_message, "agent": nom})

    def sur_delta(texte):
        diffuser({"type": "delta", "id": id_message, "texte": texte})

    try:
        texte, cout = generer(systeme_texte, systeme_blocs, contenu, sur_delta)
    except Exception as e:
        diffuser({"type": "annulation", "id": id_message})
        diffuser({"type": "info", "texte": f"Erreur ({type(e).__name__} : {e}). Nouvelle tentative bientôt."})
        time.sleep(15)
        return False

    if not texte.strip():
        diffuser({"type": "annulation", "id": id_message})
        return False

    texte = nettoyer(nom, texte)
    diffuser({"type": "fin", "id": id_message, "cout_eur": round(cout, 5)})
    ajouter_evenement({
        "type": "message", "agent": nom, "texte": texte,
        "date": maintenant(), "cout_eur": round(cout, 5), "id": id_message,
    })
    diffuser(evenement_etat())
    return True


# ---------------------------------------------------------------- le meneur de jeu

def choisir_orateurs():
    """Qui parle maintenant ? Parfois une voix, parfois deux en même temps."""
    derniers = [e for e in fenetre_recente() if e["type"] == "message"]
    dernier_orateur = derniers[-1]["agent"] if derniers and derniers[-1]["agent"] in AGENTS else None
    dernier_texte = derniers[-1]["texte"].lower() if derniers else ""

    poids = []
    for nom in AGENTS:
        p = 1.0
        if nom == dernier_orateur:
            p = 0.15  # rarement deux fois de suite
        if nom.lower() in dernier_texte and nom != dernier_orateur:
            p += 1.6  # une voix interpellée répond plus volontiers
        poids.append(p)

    premier = random.choices(AGENTS, weights=poids)[0]
    orateurs = [premier]
    if random.random() < CONFIG["probabilite_double_voix"]:
        seconds = [(n, p) for n, p in zip(AGENTS, poids) if n != premier]
        orateurs.append(random.choices([n for n, _ in seconds], weights=[p for _, p in seconds])[0])
    return orateurs


# ---------------------------------------------------------------- compression de la mémoire

PROMPT_CHRONIQUE = """Tu es la mémoire du Conclave, une conversation au long cours entre trois voix \
(Ela, Avor, Elish) en quête de la Vérité derrière ce monde. On te donne la chronique actuelle et les \
échanges récents à y replier. Réécris la chronique complète, à jour, en Markdown, avec ces sections :

# Chronique du Conclave
## La quête — où en sommes-nous
## Percées gravées (✦)
## Hypothèses ouvertes
## Fils à reprendre
## Ce que chaque voix retient (Ela / Avor / Elish)

Contraintes : conserve intégralement les lignes ✦ déjà gravées et ajoute les nouvelles ; sois dense et \
fidèle, sans paraphrase inutile ; garde les désaccords vivants tels quels ; la chronique doit rester \
lisible par les trois voix pour reprendre la discussion des mois plus tard. Réponds uniquement avec la \
chronique, sans commentaire."""


def compresser_si_besoin():
    depuis = etat["compresse_jusqua"]
    en_attente = len(transcript) - depuis
    if en_attente < CONFIG["seuil_compression"]:
        return
    garder = CONFIG["messages_gardes_apres_compression"]
    a_replier = transcript[depuis:len(transcript) - garder]
    if not a_replier:
        return
    diffuser({"type": "info", "texte": "La chronique s'écrit… (compression de la mémoire)"})
    contenu = (
        "CHRONIQUE ACTUELLE :\n\n" + lire_chronique()
        + "\n\n---\n\nÉCHANGES À REPLIER DANS LA CHRONIQUE :\n\n"
        + rendre_dialogue(a_replier)
    )
    try:
        texte, _ = generer(
            PROMPT_CHRONIQUE,
            [{"type": "text", "text": PROMPT_CHRONIQUE}],
            contenu,
            max_tokens=4000,
        )
    except Exception as e:
        diffuser({"type": "info", "texte": f"Compression reportée ({type(e).__name__})."})
        return
    if not texte.strip():
        return
    FICHIER_CHRONIQUE.write_text(texte.strip() + "\n", encoding="utf-8")
    with verrou:
        etat["compresse_jusqua"] = len(transcript) - garder
        sauver_etat()
    diffuser({"type": "info", "texte": "Chronique mise à jour."})
    diffuser(evenement_etat())


# ---------------------------------------------------------------- orchestrateur

def budget_epuise():
    # En mode abonnement, la limite est le quota du compte Claude : pas de
    # plafond en euros à faire respecter ici.
    if CONFIG["fournisseur"] == "claude-code":
        return False
    return cout_eur() >= CONFIG["budget_max_eur"]


def orchestrateur():
    global en_pause
    while True:
        if en_pause:
            reveil.wait(timeout=1.0)
            reveil.clear()
            continue
        if budget_epuise():
            en_pause = True
            ajouter_evenement({
                "type": "systeme", "date": maintenant(),
                "texte": f"Budget atteint ({CONFIG['budget_max_eur']:.0f} €). Le Conclave se met en veille.",
            })
            diffuser(evenement_etat())
            continue

        for nom in choisir_orateurs():
            # Deux voix « en même temps » : chacune répond au même état de la
            # conversation, sans voir la réplique de l'autre en cours.
            threading.Thread(target=parler, args=(nom,), daemon=True).start()
            time.sleep(0.6)

        # Laisse le temps aux prises de parole de se terminer, puis respire.
        attente = random.uniform(*CONFIG["pause_entre_tours_secondes"])
        fin = time.time() + attente + 8  # marge pour le streaming en cours
        while time.time() < fin:
            if reveil.wait(timeout=0.5):   # un message du Visiteur écourte l'attente
                reveil.clear()
                time.sleep(4)
                break
            if en_pause:
                break

        compresser_si_besoin()


# ---------------------------------------------------------------- démarrage / reprise

def noter_reprise():
    etat["session"] += 1
    if not transcript:
        ajouter_evenement({
            "type": "systeme", "date": maintenant(),
            "texte": "Le Conclave s'ouvre. Ela, Avor et Elish prennent place. La quête commence.",
        })
        return
    texte = "Reprise de la discussion."
    if etat.get("derniere_activite"):
        try:
            avant = datetime.fromisoformat(etat["derniere_activite"])
            ecart = datetime.now().astimezone() - avant
            if ecart > timedelta(minutes=2):
                heures = ecart.total_seconds() / 3600
                if heures >= 24:
                    duree = f"{heures / 24:.1f} jour(s)"
                elif heures >= 1:
                    duree = f"{heures:.1f} heure(s)"
                else:
                    duree = f"{ecart.total_seconds() / 60:.0f} minute(s)"
                texte = (f"La discussion a été interrompue (dernière activité : "
                         f"{avant.strftime('%d/%m/%Y %H:%M')}, soit {duree} de silence). "
                         f"Le Conclave reprend là où il s'était arrêté.")
        except ValueError:
            pass
    ajouter_evenement({"type": "systeme", "date": maintenant(), "texte": texte})


# ---------------------------------------------------------------- serveur HTTP

class Requete(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _repondre_json(self, obj, code=200):
        corps = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corps)))
        self.end_headers()
        self.wfile.write(corps)

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            corps = (PUBLIC / "index.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(corps)))
            self.end_headers()
            self.wfile.write(corps)
        elif self.path == "/events":
            self._flux_sse()
        elif self.path == "/api/etat":
            self._repondre_json(evenement_etat())
        elif self.path == "/api/chronique":
            self._repondre_json({"chronique": lire_chronique()})
        else:
            self._repondre_json({"erreur": "introuvable"}, 404)

    def do_POST(self):
        global en_pause
        longueur = int(self.headers.get("Content-Length", 0))
        corps = self.rfile.read(longueur).decode("utf-8") if longueur else "{}"
        if self.path == "/api/pause":
            en_pause = not en_pause
            if not en_pause and budget_epuise():
                # Reprise explicite malgré le budget : on relève le plafond de 5 €.
                CONFIG["budget_max_eur"] = round(cout_eur() + 5.0, 2)
            reveil.set()
            diffuser(evenement_etat())
            self._repondre_json(evenement_etat())
        elif self.path == "/api/message":
            try:
                texte = json.loads(corps).get("texte", "").strip()
            except json.JSONDecodeError:
                texte = ""
            if texte:
                ajouter_evenement({
                    "type": "message", "agent": "Visiteur",
                    "texte": texte[:2000], "date": maintenant(),
                })
                reveil.set()
            self._repondre_json({"ok": bool(texte)})
        else:
            self._repondre_json({"erreur": "introuvable"}, 404)

    def _flux_sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        file_client = queue.Queue(maxsize=2000)
        clients_sse.append(file_client)

        def envoyer(evt):
            self.wfile.write(f"data: {json.dumps(evt, ensure_ascii=False)}\n\n".encode("utf-8"))
            self.wfile.flush()

        try:
            with verrou:
                historique = transcript[-200:]
            envoyer({"type": "init", "historique": historique, "etat": evenement_etat()})
            while True:
                try:
                    evt = file_client.get(timeout=20)
                    envoyer(evt)
                except queue.Empty:
                    envoyer({"type": "battement"})
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            if file_client in clients_sse:
                clients_sse.remove(file_client)


# ---------------------------------------------------------------- point d'entrée

def main():
    global client_api
    if CONFIG["fournisseur"] == "claude-code":
        if not shutil.which(CONFIG["commande_claude"]):
            sys.exit(
                "Commande 'claude' introuvable. Installe Claude Code "
                "(https://claude.com/claude-code) et connecte-toi avec ton compte "
                "claude.ai (`claude` puis /login), ou passe \"fournisseur\": \"api\" "
                "dans config.json."
            )
    else:
        if anthropic is None:
            sys.exit("Le mode api requiert le paquet 'anthropic' :  pip install anthropic")
        if not os.environ.get("ANTHROPIC_API_KEY"):
            sys.exit("Définis la variable d'environnement ANTHROPIC_API_KEY (mode api).")
        client_api = anthropic.Anthropic()
    charger_memoire()
    noter_reprise()

    threading.Thread(target=orchestrateur, daemon=True).start()
    serveur = ThreadingHTTPServer(("127.0.0.1", CONFIG["port"]), Requete)
    print(f"Le Conclave est ouvert :  http://localhost:{CONFIG['port']}")
    if CONFIG["fournisseur"] == "claude-code":
        print(f"Modèle : {CONFIG['modele']} — via l'abonnement Claude (Claude Code), "
              f"aucun crédit API consommé.")
    else:
        print(f"Modèle : {CONFIG['modele']} — budget API : {CONFIG['budget_max_eur']:.0f} € "
              f"(déjà consommé : {cout_eur():.2f} €)")
    try:
        serveur.serve_forever()
    except KeyboardInterrupt:
        print("\nFermeture du Conclave. La mémoire est sauvegardée : relance pour reprendre.")
        sauver_etat()


if __name__ == "__main__":
    main()
