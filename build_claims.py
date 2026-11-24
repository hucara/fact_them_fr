#!/usr/bin/env python3
"""
build_claims.py — Generate a static HTML page for every claim in the
Facthem ES Supabase database and update sitemap.xml.

Run manually:
    pip install -r requirements.txt
    python build_claims.py

Or via GitHub Actions (workflow_dispatch) — see .github/workflows/build-claims.yml.
"""

import html
import json
import os
import re
import sqlite3
import sys
import unicodedata
import urllib.parse
from datetime import date, datetime
from pathlib import Path

import site_chrome

# ── Config ────────────────────────────────────────────────────────────────────
DEBUG_DB_PATH = os.environ.get("DEBUG_DB_PATH")
if not DEBUG_DB_PATH:
    env_file = Path(__file__).parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if line.startswith("DEBUG_DB_PATH=") and "=" in line:
                DEBUG_DB_PATH = line.split("=", 1)[1].strip().strip('"').strip("'")
                break

USE_SQLITE = bool(DEBUG_DB_PATH and Path(DEBUG_DB_PATH).exists())

if not USE_SQLITE:
    try:
        from supabase import create_client
    except ImportError:
        sys.exit("supabase package not installed.  Run: pip install -r requirements.txt")

SUPABASE_URL  = os.environ.get("SUPABASE_URL")
SUPABASE_ANON = os.environ.get("SUPABASE_ANON")

if not USE_SQLITE and (not SUPABASE_URL or not SUPABASE_ANON):
    sys.exit("Set SUPABASE_URL+SUPABASE_ANON, or DEBUG_DB_PATH (local SQLite).")
BASE_URL      = "https://facthem.es"
OUT_DIR       = Path(__file__).parent / "claim"
POL_OUT_DIR   = Path(__file__).parent / "politician"
PEOPLE_JSON   = Path(__file__).parent / "assets" / "people.json"
DIRECTORY_PATH = Path(__file__).parent / "representantes.html"
CLAIM_IDS_DIR = Path(__file__).parent / "assets" / "claim-ids"
SESSIONS_DIR  = Path(__file__).parent / "assets" / "sessions"
SESION_DIR    = Path(__file__).parent / "sesion"
STATS_PATH    = Path(__file__).parent / "estadisticas.html"
LLMS_PATH     = Path(__file__).parent / "llms.txt"
LLMS_FULL_PATH = Path(__file__).parent / "llms-full.txt"
INDEX_PATH    = Path(__file__).parent / "index.html"
INDEX_TEMPLATE = Path(__file__).parent / "templates" / "index.html"
SITEMAP_PATH  = Path(__file__).parent / "sitemap.xml"
SALARY_DATA_PATH = Path(__file__).parent / "assets" / "salary-data.js"
TODAY         = date.today().isoformat()

# ── Label maps (mirror app.js) ────────────────────────────────────────────────
TEMATICO_LABELS = {
    "agriculture":             "Agricultura",
    "defence":                 "Defensa",
    "economy":                 "Economía",
    "energy":                  "Energía",
    "environment":             "Medio ambiente",
    "equality":                "Igualdad",
    "health":                  "Salud",
    "housing":                 "Vivienda",
    "human_rights":            "Derechos humanos",
    "industry_and_labour":     "Industria y empleo",
    "internal_affairs":        "Asuntos internos",
    "international_relations": "Relaciones exteriores",
    "justice_and_corruption":  "Justicia y anticorrupción",
    "migration":               "Migración",
    "other":                   "Otros",
    "social_policy":           "Política social",
    "transport":               "Transporte",
}

# schema.org ClaimReview rating (1 = False … 5 = True)
CLAIM_REVIEW_RATINGS = {
    "CONFIRMADO":            (5, "True"),
    "CONFIRMADO CON MATIZ":  (4, "Mostly True"),
    "DESCONTEXTUALIZADO":    (3, "Out of Context"),
    "IMPRECISO":             (2, "Inaccurate"),
    "FALSO":                 (1, "False"),
    "NO VERIFICABLE":        (3, "Unverifiable"),
    "SOBREESTIMADO":         (2, "Overestimated"),
    "SUBESTIMADO":           (2, "Underestimated"),
}

def normalize_resultado_key(resultado):
    return str(resultado or "").strip().upper().replace("_", " ")

FUENTE_TIPO_ORDER = {
    "Primary": 0, "Academic": 1, "Secondary": 2, "Tertiary": 3,
    "Primaria": 0, "Académica": 1, "Secundaria": 2, "Terciaria": 3,
}
FUENTE_TIPO_LABELS = {
    "Primaria": "Primaria", "Académica": "Académica",
    "Secundaria": "Secundaria", "Terciaria": "Terciaria",
    "Primary": "Primaria", "Academic": "Académica",
    "Secondary": "Secundaria", "Tertiary": "Terciaria",
}

# ── Helpers ───────────────────────────────────────────────────────────────────

def esc(s):
    return html.escape(str(s or ""), quote=True)


def capitalize(s):
    s = str(s or "").strip()
    return s[0].upper() + s[1:] if s else s


def snake_to_label(s):
    return capitalize(str(s or "").replace("_", " "))


def is_valid(v):
    return v and v not in ("N/A", "-", "n/a")


def format_nombre(full_name):
    parts = str(full_name or "").split(",")
    if len(parts) == 2:
        return f"{parts[1].strip()} {parts[0].strip()}"
    return str(full_name or "")


def slugify(text, claim_id):
    """First 8 words of text, URL-safe, suffixed with the first segment of the claim UUID."""
    short_id = str(claim_id).split("-")[0]
    s = str(text or "").strip().lower()
    for src, dst in [("á","a"),("é","e"),("í","i"),("ó","o"),("ú","u"),
                     ("ä","a"),("ö","o"),("ü","u"),("ñ","n"),("ç","c")]:
        s = s.replace(src, dst)
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    words = s.split()[:8]
    slug = re.sub(r"-+", "-", "-".join(words)).strip("-")
    return f"{slug}-{short_id}" if slug else short_id


def slugify_politician(nombre_completo, partido=""):
    """URL-safe slug from a politician's full name + party (Apellido, Nombre format)."""
    name = format_nombre(nombre_completo)
    s = f"{name} {partido}".strip().lower()
    for src, dst in [("á","a"),("é","e"),("í","i"),("ó","o"),("ú","u"),
                     ("ä","a"),("ö","o"),("ü","u"),("ñ","n"),("ç","c")]:
        s = s.replace(src, dst)
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    slug = re.sub(r"-+", "-", "-".join(s.split())).strip("-")
    return slug or "desconocido"


# ── HTML renderers (mirror app.js) ────────────────────────────────────────────

def to_list_items(text):
    return [s.strip() for s in re.split(r"\n|;", re.sub(r"^[\s\-•*\d.]+", "", text))
            if s.strip()]


MONTHS_ES_ABBR = [
    "", "ene", "feb", "mar", "abr", "may", "jun",
    "jul", "ago", "sep", "oct", "nov", "dic",
]


def _date_short_es(raw):
    """'2026-06-17' → '17 jun 2026' ('' si no hay fecha válida)."""
    if not raw:
        return ""
    try:
        dt = datetime.fromisoformat(str(raw)[:10])
        return f"{dt.day} {MONTHS_ES_ABBR[dt.month]} {dt.year}"
    except ValueError:
        return ""


def _truncate_words(text, limit):
    """Recorta en límite de palabra y añade elipsis."""
    text = str(text or "").strip()
    if len(text) <= limit:
        return text
    cut = text[:limit].rsplit(" ", 1)[0].rstrip(" ,.;:")
    return f"{cut}…"


def _omisiones_items(raw):
    """Lista de omisiones (JSON list, or plain text split into items)."""
    if not is_valid(raw):
        return []
    try:
        items = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        items = to_list_items(raw)
    if not isinstance(items, list):
        return []
    return [str(i).strip() for i in items if str(i).strip()]


# ── ClaimReview schema.org ────────────────────────────────────────────────────

def build_claim_review_schema(claim, slug, pol_name, session_date):
    v = claim.get("verification") or []
    v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
    resultado_key = normalize_resultado_key(v.get("resultado"))
    rating_val, rating_name = CLAIM_REVIEW_RATINGS.get(resultado_key, (3, "Unverifiable"))

    sess = claim.get("session") or {}
    pol  = claim.get("politician") or {}

    schema = {
        "@context": "https://schema.org",
        "@type": "ClaimReview",
        "url": f"{BASE_URL}/claim/{slug}.html",
        "claimReviewed": str(claim.get("texto_normalizado") or "").strip(),
        "datePublished": session_date or TODAY,
        "inLanguage": "es",
        "author": {
            "@type": "Organization",
            "name": "Facthem",
            "url": BASE_URL,
            "logo": {"@type": "ImageObject", "url": f"{BASE_URL}/assets/android-chrome-512x512.png"},
            "sameAs": [
                "https://twitter.com/facthem_ES",
                "https://www.youtube.com/@facthem_es",
            ],
        },
        "reviewRating": {
            "@type": "Rating",
            "ratingValue": rating_val,
            "bestRating": 5,
            "worstRating": 1,
            "alternateName": rating_name,
        },
    }

    verified = str(v.get("created_at") or "")[:10]
    if verified and verified >= str(schema["datePublished"])[:10]:
        schema["dateModified"] = verified

    omis = _omisiones_items(v.get("omisiones"))
    if omis:
        schema["reviewRating"]["ratingExplanation"] = _truncate_words(
            capitalize(omis[0]), 300
        )

    if pol_name:
        author = {"@type": "Person", "name": pol_name}
        pol_slug = slugify_politician(pol.get("nombre_completo", ""), pol.get("partido", ""))
        if pol_slug and pol_slug != "desconocido":
            author["sameAs"] = [f"{BASE_URL}/politician/{pol_slug}.html"]
        item = {"@type": "Claim", "author": author}
        if session_date:
            item["datePublished"] = str(session_date)[:10]
        # The PDF is named by the Diario number, the last part of the session id
        # (DS-PL-210, DS-PL-XVI-1); `numero` is the sitting number and differs.
        leg, tipo, sitting = sess.get("legislatura"), sess.get("tipo"), sess.get("numero")
        dscd = str(sess.get("id") or "").rsplit("-", 1)[-1]
        num = int(dscd) if dscd.isdigit() else None
        # Only plenary sittings have a Diario de Sesiones PDF. TV debates
        # (DEB-2026-11-23-debate-a-8) would otherwise get a made-up DSCD URL.
        if leg and tipo == "PL" and num:
            appearance = {
                "@type": "CreativeWork",
                "name": (
                    f"Diario de Sesiones del Congreso de los Diputados — "
                    f"{sess.get('organo') or 'Pleno'} núm. {sitting or num}"
                ),
                "url": f"https://www.congreso.es/public_oficiales/L{leg}/CONG/DS/{tipo}/DSCD-{leg}-{tipo}-{num}.PDF",
            }
            if session_date:
                appearance["datePublished"] = str(session_date)[:10]
            item["appearance"] = appearance
        schema["itemReviewed"] = item

    return json.dumps(schema, ensure_ascii=False, indent=2)


# ── Page renderer ─────────────────────────────────────────────────────────────
# Claim page (redesign 2026): static, readable without JS. Layout from
# mockup/claim.html; chrome from site_chrome. URL, canonical, title,
# description, OG and JSON-LD are the same as before (tools/site_check.py).

def _errores_items(raw):
    if not is_valid(raw):
        return []
    try:
        parsed = json.loads(raw)
        items = parsed if isinstance(parsed, list) else [parsed]
    except (json.JSONDecodeError, TypeError):
        items = [raw]
    return [capitalize(str(i).strip()) for i in items if i and str(i).strip()]


def _fuentes_items(raw):
    """[(name, url, tipo_label, is_primary, dato)] sorted primary first."""
    if not is_valid(raw):
        return []
    try:
        items = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return [(i, "", "", False, "") for i in to_list_items(raw)]
    if not isinstance(items, list):
        return []
    out = []
    for s in sorted((s for s in items if isinstance(s, dict)),
                    key=lambda s: FUENTE_TIPO_ORDER.get(s.get("tipo", ""), 9)):
        tipo = s.get("tipo", "")
        out.append((s.get("nombre") or "Fuente", s.get("url") or "",
                    FUENTE_TIPO_LABELS.get(tipo, tipo or ""), tipo in ("Primaria", "Primary"),
                    s.get("dato_especifico") or ""))
    return out


def _host(url):
    try:
        return urllib.parse.urlparse(url).hostname.removeprefix("www.")
    except Exception:
        return ""


def session_label(sess, short=False):
    """'Pleno del Congreso · 12 nov 2026' / 'Debate a 8 · 23 nov 2026'."""
    sess = sess or {}
    d = _date_short_es(sess.get("fecha"))
    name = "Pleno del Congreso" if (sess.get("tipo") or "PL") == "PL" else (sess.get("organo") or "Debate")
    if short:
        return name
    return f"{name} · {d}" if d else name


def session_url(session_id):
    """The sitting's static page (/sesion/<id>.html); the home page still reads ?session=."""
    return f"/sesion/{_safe_id(session_id)}.html" if session_id else "/"


def _more_list(items):
    lis = []
    for it in items:
        color = site_chrome.VK[site_chrome.verdict_key(it["verdict"])][4]
        small = f'<small>{esc(it["meta"])}</small>' if it.get("meta") else ""
        lis.append(f'<li><a href="{esc(it["url"])}" style="--c:{color}"><span class="dot"></span>'
                   f'<span>{esc(it["text"])}{small}</span></a></li>')
    return f'<ul class="c-more">{"".join(lis)}</ul>'


def render_page(claim, slug, session_date, ctx=None):
    """ctx: photo, pol_slug, pol_total, same_session_pol, other_sessions_pol, same_session_others."""
    ctx = ctx or {}
    v = claim.get("verification") or []
    v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
    pol = claim.get("politician") or {}
    sess = claim.get("session") or {}

    vkey = site_chrome.verdict_key(v.get("resultado"))
    vcolor = site_chrome.VK[vkey][4]
    score_raw = v.get("confidence_score")
    score = round(float(score_raw) * 100) if score_raw is not None else None

    pol_nombre = format_nombre(pol.get("nombre_completo", ""))
    pol_partido = pol.get("partido", "")
    is_gobierno = pol.get("grupo_parlamentario", "") == "Cargo de Gobierno"
    first_name = pol_nombre.split(" ")[0] if pol_nombre else ""

    texto_norm = capitalize(str(claim.get("texto_normalizado") or "").strip())
    texto_orig = str(claim.get("texto_original") or "").strip()

    # ── Meta: quote form without the verdict (keeps the click) — unchanged ──
    desc_text = str(claim.get("texto_normalizado") or "").strip()
    who = f"{pol_nombre} ({pol_partido})" if pol_nombre and pol_partido else pol_nombre
    quote_title = _truncate_words(desc_text, 60).rstrip(" .")
    quote_desc = _truncate_words(desc_text, 130).rstrip(" .")
    title = f"{who}: «{quote_title}» | Facthem" if who else f"«{quote_title}» | Facthem"
    desc = (f"{who}: «{quote_desc}». Lo verificamos en Facthem." if who
            else f"«{quote_desc}». Lo verificamos en Facthem.")
    canon_url = f"{BASE_URL}/claim/{slug}.html"

    pol_slug = ctx.get("pol_slug") or (
        slugify_politician(pol.get("nombre_completo", ""), pol_partido) if pol_nombre else None)
    pol_url = f"/politician/{pol_slug}.html" if pol_slug else None

    # ── Breadcrumb (visible + JSON-LD; same JSON-LD items as before) ──
    crumbs = [{"@type": "ListItem", "position": 1, "name": "Inicio", "item": f"{BASE_URL}/"}]
    if pol_nombre and pol_url:
        crumbs.append({"@type": "ListItem", "position": 2, "name": pol_nombre, "item": BASE_URL + pol_url})
    crumbs.append({"@type": "ListItem", "position": len(crumbs) + 1, "name": f"«{_truncate_words(desc_text, 60)}»"})
    breadcrumb_ld = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": crumbs}
    claim_ld = json.loads(build_claim_review_schema(claim, slug, pol_nombre, session_date))

    sid = claim.get("session_id")
    crumb_html = (
        '<nav class="crumbs" aria-label="Ruta"><a href="/">Sesiones</a><span>/</span>'
        + (f'<a class="crumb-session" href="{esc(session_url(sid))}">{esc(session_label(sess))}</a>'
           f'<span class="crumb-session">/</span>' if sid else "")
        + (f'<a href="{esc(pol_url)}">{esc(pol_nombre)}</a>' if pol_nombre and pol_url else
           f'<span>{esc(pol_nombre or "Afirmación")}</span>')
        + '<span class="pager" id="pager"></span></nav>')

    # ── Header: photo + share, who, claim, verdict ──
    # as on the old claim pages ("afirmó"; cards say "ha afirmado")
    share_text = site_chrome.share_text(pol_nombre, pol_partido, desc_text, v.get("resultado"), verb="afirmó")
    photo = ctx.get("photo")
    initials = "".join(p[0] for p in pol_nombre.split()[:2]).upper() if pol_nombre else "?"
    photo_html = (f'<img class="c-photo" src="{esc(photo)}" alt="{esc(pol_nombre)}" width="120" height="148" />'
                  if photo else f'<span class="c-photo c-photo-none" aria-hidden="true">{esc(initials)}</span>')
    name_html = (f'<a href="{esc(pol_url)}">{esc(pol_nombre)}</a>' if pol_nombre and pol_url
                 else f'<span>{esc(pol_nombre or "Político desconocido")}</span>')
    party_bits = [b for b in (pol_partido, "Gobierno de España" if is_gobierno else "") if b]
    party_html = "".join(f'<span class="who-party">{esc(b)}</span>' for b in party_bits)
    sess_iso = str(session_date or "")[:10]
    date_html = (f'<span class="who-party"><time datetime="{sess_iso}">{esc(_date_short_es(sess_iso))}</time></span>'
                 if sess_iso and _date_short_es(sess_iso) else "")
    tema = site_chrome.tema_label(claim.get("ambito_tematico"))
    geo = snake_to_label(claim.get("ambito_geografico")) if claim.get("ambito_geografico") else ""
    tags = " · ".join(esc(t) for t in (tema, geo) if t)

    conf_html = (
        f'<div class="c-conf" style="--c:{vcolor};--p:{score}%" role="meter" aria-valuemin="0" '
        f'aria-valuemax="100" aria-valuenow="{score}" aria-label="Confianza de la verificación">'
        f'<div class="c-conf-track"><span></span></div>'
        f'<span class="c-conf-lbl">Confianza de la verificación <b>{score}%</b></span></div>'
        if score is not None else '<div class="c-conf"><div class="c-conf-track"></div></div>')

    # ── Body sections ──
    secs = []
    correcta = str(v.get("afirmacion_correcta") or "").strip()
    if is_valid(correcta):
        secs.append(f'<section class="c-sec c-lead"><h2>Lo que dicen los datos</h2><p>{esc(capitalize(correcta))}</p></section>')
    err = _errores_items(v.get("errores"))
    if err:
        secs.append(f'<section class="c-sec"><h2>Errores <span class="n">· {len(err)}</span></h2>'
                    f'<ul class="c-list" style="--b:var(--v-falso)">{"".join(f"<li>{esc(e)}</li>" for e in err)}</ul></section>')
    om = [capitalize(o) for o in _omisiones_items(v.get("omisiones"))]
    if om:
        secs.append(f'<section class="c-sec"><h2>Contexto que falta <span class="n">· {len(om)}</span></h2>'
                    f'<ul class="c-list" style="--b:var(--v-sobre)">{"".join(f"<li>{esc(o)}</li>" for o in om)}</ul></section>')
    src = _fuentes_items(v.get("fuentes"))
    if src:
        lis = []
        for name, url, tipo, prim, dato in src:
            link = (f'<a href="{esc(url)}" target="_blank" rel="noopener">{esc(name)}</a>' if url
                    else f'<span class="src-name">{esc(name)}</span>')
            kind = '<span class="prim">fuente primaria</span>' if prim else esc(tipo.lower())
            meta = " · ".join(x for x in (esc(_host(url)) if url else "", kind) if x)
            meta_html = f'<span class="meta">{meta}</span>' if meta else ""
            dato_html = f'<span class="dato">{esc(dato)}</span>' if dato else ""
            lis.append(f"<li>{link}{meta_html}{dato_html}</li>")
        secs.append(f'<section class="c-sec"><h2>Fuentes <span class="n">· {len(src)}</span></h2>'
                    f'<ol class="c-sources">{"".join(lis)}</ol></section>')
    # One plain sentence that answers "who said what, where, and what did Facthem
    # find": the line answer engines quote, with the canonical link.
    verified = str(v.get("created_at") or "")[:10]
    where = (f"el Pleno del Congreso del {_format_session_date_es(sess.get('fecha')).lstrip('0')}"
             if (sess.get("tipo") or "PL") == "PL" and sess.get("fecha") else
             f"el {sess.get('organo')} del {_format_session_date_es(sess.get('fecha')).lstrip('0')}"
             if sess.get("fecha") else "")
    who_cite = f"{pol_nombre} ({pol_partido})" if pol_nombre and pol_partido else (pol_nombre or "Un político")
    cite = (f"{esc(who_cite)} afirmó{' en ' + esc(where) if where else ''}: «{esc(desc_text.rstrip('.'))}». "
            f"Facthem lo verificó"
            + (f' el <time datetime="{verified}">{esc(_format_session_date_es(verified).lstrip("0"))}</time>' if verified else "")
            + f" como «{esc(site_chrome.VK[vkey][2])}»"
            + (f", con un {score} % de confianza" if score is not None else "") + ". "
            + f'<a href="{esc(canon_url)}">{esc(canon_url)}</a>')
    cite_html = f'<section class="c-sec c-cite"><h2>Cómo citar esta verificación</h2><p>{cite}</p></section>'
    if not secs:
        secs.append(f'<section class="c-sec c-lead"><h2>Lo que dicen los datos</h2>'
                    f'<p>{esc(site_chrome.VERDICT_WHAT[vkey])}</p></section>')

    # ── Side: more from this person, then from this sitting ──
    side = []
    if ctx.get("same_session_pol"):
        side.append(f'<section><h2>Más de {esc(first_name)} en este {"pleno" if (sess.get("tipo") or "PL") == "PL" else "debate"}</h2>'
                    f'{_more_list(ctx["same_session_pol"])}</section>')
    if ctx.get("other_sessions_pol"):
        side.append(f'<section><h2>Más de {esc(first_name)} en otras sesiones</h2>{_more_list(ctx["other_sessions_pol"])}</section>')
    if ctx.get("same_session_others"):
        side.append(f'<section><h2>Más de esta sesión</h2>{_more_list(ctx["same_session_others"])}</section>')
    if pol_url:
        n = ctx.get("pol_total") or 0
        side.append(f'<a class="all" href="{esc(pol_url)}">Todas sus afirmaciones{f" · {n}" if n else ""} →</a>')

    body = f"""<main class="claim-page stamp-on-load" id="main" data-session="{esc(sid or '')}" data-id="{esc(claim.get('id', ''))}">
{crumb_html}
<article>
<header class="c-head" style="--vc:{vcolor}">
<div class="p-pic">{photo_html}{site_chrome.share(canon_url, share_text, '<span>Compartir</span>')}</div>
<div>
<div class="c-who">{name_html}{party_html}{date_html}</div>
<h1 class="c-claim" title="{esc(texto_orig)}">{esc(texto_norm)}</h1>
<div class="c-verdict" style="--c:{vcolor}">{site_chrome.vtag(vkey, 'vtag-lg stamped')}{f'<span class="c-tags">{tags}</span>' if tags else ''}</div>
</div>
</header>
{conf_html}
<div class="c-cols">
<div class="c-main">{''.join(secs)}{cite_html}</div>
<aside class="c-side">{''.join(side)}</aside>
</div>
</article>
</main>"""

    return site_chrome.page(
        body=body, active="sesiones", scripts=("js/ui.js", "js/claim.js"),
        title=title, description=desc, canonical=canon_url, og_type="article",
        jsonld=(claim_ld, breadcrumb_ld))


# ── Related claims (internal linking) ─────────────────────────────────────────

RELATED_PER_BLOCK = 4


def _related_text(claim):
    return _truncate_words(
        capitalize(str(claim.get("texto_normalizado") or "").strip()), 90
    )


def _pol_key(claim):
    """Profile slug: groups duplicate politician records (same name + party)."""
    pol = claim.get("politician") or {}
    if not pol.get("nombre_completo"):
        return None
    return slugify_politician(pol["nombre_completo"], pol.get("partido", ""))


def write_claim_id_shards(claims_with_slugs):
    """assets/claim-ids/<xx>.json: {claim id: slug}, sharded by the id's first two
    characters. Old /?claim=<id> links resolve through one ~3 KB file."""
    shards = {}
    for slug, claim in claims_with_slugs:
        cid = str(claim.get("id") or "").lower()
        if len(cid) >= 2:
            shards.setdefault(cid[:2], {})[cid] = slug
    CLAIM_IDS_DIR.mkdir(parents=True, exist_ok=True)
    for f in CLAIM_IDS_DIR.glob("*.json"):
        f.unlink()
    for key, m in shards.items():
        (CLAIM_IDS_DIR / f"{key}.json").write_text(
            json.dumps(m, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    print(f"  assets/claim-ids/ — {sum(len(m) for m in shards.values())} ids en {len(shards)} ficheros")


def build_related_indexes(claims_with_slugs):
    """{session_id: [(slug, claim)]}, {pol_slug: [(slug, claim)]} — deterministic."""
    by_session, by_pol = {}, {}
    for slug, claim in claims_with_slugs:
        if not claim.get("verification"):
            continue
        sid = claim.get("session_id")
        pk = _pol_key(claim)
        if sid:
            by_session.setdefault(sid, []).append((slug, claim))
        if pk:
            by_pol.setdefault(pk, []).append((slug, claim))
    for lst in by_session.values():
        lst.sort(key=lambda t: t[0])
    # same person: newest sitting first, then slug
    for lst in by_pol.values():
        lst.sort(key=lambda t: ((t[1].get("session") or {}).get("fecha") or "", t[0]), reverse=True)
    return by_session, by_pol


def _rel_item(sib_slug, sib, meta=""):
    v = (sib.get("verification") or [{}])[0] or {}
    return {"url": f"/claim/{sib_slug}.html", "text": _related_text(sib),
            "verdict": v.get("resultado"), "meta": meta}


def build_claim_ctx(claim, slug, by_session, by_pol, photo_for):
    """Side column + photo for one claim page."""
    sid, pk = claim.get("session_id"), _pol_key(claim)
    mine = by_pol.get(pk, []) if pk else []
    same_pol = [_rel_item(s, c) for s, c in mine if c.get("session_id") == sid and s != slug][:3]
    other_pol = [_rel_item(s, c, _date_short_es((c.get("session") or {}).get("fecha")))
                 for s, c in mine if c.get("session_id") != sid][:4]
    others = []
    for s, c in by_session.get(sid, []):
        if _pol_key(c) == pk or s == slug:
            continue
        p = c.get("politician") or {}
        who = format_nombre(p.get("nombre_completo", "")) or "Político desconocido"
        others.append(_rel_item(s, c, f"{who} · {p['partido']}" if p.get("partido") else who))
        if len(others) >= 4:
            break
    return {"photo": photo_for(claim.get("politician") or {}), "pol_slug": pk, "pol_total": len(mine),
            "same_session_pol": same_pol, "other_sessions_pol": other_pol, "same_session_others": others}


def make_photo_resolver(salaries):
    """politician dict → '/assets/photos/…' or ''.

    1. the salary row (deputies and Government: same rule as profile pages);
    2. a file whose name tokens are exactly the person's name tokens
       (TV-debate guests: delgado-orgaz-emilio_frente-amplio.jpg).
    """
    by_id = {pid: row for pid, row in salaries.items()}
    by_name = {row.get("nombre_completo"): row for row in salaries.values() if row.get("nombre_completo")}
    photos_dir = Path(__file__).parent / "assets" / "photos"
    by_tokens = {}
    for f in sorted(photos_dir.glob("*")):
        stem = f.stem.split("_")[0].removeprefix("gobierno-")
        by_tokens.setdefault(frozenset(stem.split("-")), f.name)
    cache = {}

    def photo_for(pol):
        key = (pol.get("id"), pol.get("nombre_completo"))
        if key in cache:
            return cache[key]
        src = ""
        row = by_id.get(pol.get("id")) or by_name.get(pol.get("nombre_completo"))
        if row:
            src = _salary_photo_src(row)
        if not src and pol.get("nombre_completo"):
            toks = frozenset(_slugify_photo(pol["nombre_completo"]).split("-"))
            if toks in by_tokens:
                src = f"/assets/photos/{urllib.parse.quote(by_tokens[toks])}"
        cache[key] = src
        return src
    return photo_for


# ── Supabase fetch ────────────────────────────────────────────────────────────

CLAIM_FIELDS = (
    "id, session_id, politician_id, intervention_id, texto_normalizado, texto_original, "
    "ambito_geografico, ambito_tematico"
)
POLITICIAN_FIELDS = "id, nombre_completo, partido, grupo_parlamentario"
SESSION_FIELDS = "id, fecha, organo, legislatura, tipo, numero"
VERIFICATION_FIELDS = "claim_id, resultado, confidence_score, afirmacion_correcta, omisiones, errores, fuentes, created_at"

SALARY_TABLE = "politician_salary"


def _sqlite_conn():
    con = sqlite3.connect(DEBUG_DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def fetch_all_claims_sqlite():
    con = _sqlite_conn()
    total = con.execute("SELECT COUNT(*) FROM claim").fetchone()[0]
    print(f"  SQLite reporta {total} afirmaciones en la tabla claim")
    rows = con.execute("""
        SELECT c.id, c.session_id, c.texto_normalizado, c.texto_original,
               c.ambito_geografico, c.ambito_tematico, i.orden AS orden,
               p.id AS pol_id,
               p.nombre_completo AS pol_nombre, p.partido AS pol_partido,
               p.grupo_parlamentario AS pol_grupo,
               v.resultado, v.confidence_score, v.afirmacion_correcta,
               v.omisiones, v.errores, v.fuentes, v.created_at AS verified_at,
               s.fecha AS session_fecha, s.organo AS session_organo,
               s.legislatura AS session_legislatura, s.tipo AS session_tipo,
               s.numero AS session_numero
        FROM claim c
        LEFT JOIN politician p ON p.id = c.politician_id
        LEFT JOIN session s ON s.id = c.session_id
        LEFT JOIN verification v ON v.claim_id = c.id
        LEFT JOIN intervention i ON i.id = c.intervention_id
        ORDER BY c.session_id DESC
    """).fetchall()
    con.close()
    claims = []
    for r in rows:
        pol = None
        if r["pol_nombre"]:
            pol = {"id": r["pol_id"],
                   "nombre_completo": r["pol_nombre"],
                   "partido": r["pol_partido"],
                   "grupo_parlamentario": r["pol_grupo"]}
        ver = []
        if r["resultado"]:
            ver = [{"resultado": r["resultado"],
                    "confidence_score": r["confidence_score"],
                    "afirmacion_correcta": r["afirmacion_correcta"],
                    "created_at": r["verified_at"],
                    "omisiones": r["omisiones"],
                    "errores": r["errores"],
                    "fuentes": r["fuentes"]}]
        claims.append({
            "id": r["id"], "session_id": r["session_id"],
            "texto_normalizado": r["texto_normalizado"],
            "texto_original": r["texto_original"],
            "ambito_geografico": r["ambito_geografico"],
            "ambito_tematico": r["ambito_tematico"],
            "orden": r["orden"],
            "politician": pol,
            "session": {
                "id": r["session_id"],
                "fecha": r["session_fecha"],
                "organo": r["session_organo"],
                "legislatura": r["session_legislatura"],
                "tipo": r["session_tipo"],
                "numero": r["session_numero"],
            } if r["session_fecha"] else None,
            "verification": ver,
        })
    return claims


def fetch_session_dates_sqlite():
    con = _sqlite_conn()
    rows = con.execute("SELECT id, fecha FROM session").fetchall()
    con.close()
    return {r["id"]: (r["fecha"] or "")[:10] for r in rows}


def _paginate_table(supabase, table, fields, label, page_size=1000):
    """Keyset-paginate a table by id with no joins."""
    rows, last_id = [], None
    while True:
        query = (
            supabase.from_(table)
            .select(fields)
            .order("id")
            .limit(page_size)
        )
        if last_id is not None:
            query = query.gt("id", last_id)
        batch = (query.execute().data) or []
        rows.extend(batch)
        if not batch:
            break
        last_id = batch[-1].get("id")
        print(f"  {len(rows)} {label} leídas…")
        if len(batch) < page_size:
            break
    return rows


def _paginate_verifications(supabase, page_size=1000):
    """Verification rows are keyed by claim_id, not id."""
    rows, last_claim = [], None
    while True:
        query = (
            supabase.from_("verification")
            .select(VERIFICATION_FIELDS)
            .order("claim_id")
            .limit(page_size)
        )
        if last_claim is not None:
            query = query.gt("claim_id", last_claim)
        batch = (query.execute().data) or []
        rows.extend(batch)
        if not batch:
            break
        last_claim = batch[-1].get("claim_id")
        print(f"  {len(rows)} verificaciones leídas…")
        if len(batch) < page_size:
            break
    return rows


def fetch_all_claims(supabase):
    """Fetch claims, politicians, sessions, verifications separately and join in memory.

    Why: embedding politician/session/verification in a single PostgREST select
    triggers statement-timeout (57014) on Supabase for the full claim table.
    """
    total = supabase.from_("claim").select("id", count="exact", head=True).execute().count
    print(f"  DB reporta {total} afirmaciones en la tabla claim")

    politicians = {
        p["id"]: p
        for p in _paginate_table(supabase, "politician", POLITICIAN_FIELDS, "políticos", page_size=1000)
    }
    sessions = {
        s["id"]: s
        for s in _paginate_table(supabase, "session", SESSION_FIELDS, "sesiones", page_size=1000)
    }
    verifications = {}
    for v in _paginate_verifications(supabase):
        verifications.setdefault(v["claim_id"], []).append({
            k: v.get(k) for k in ("resultado", "confidence_score", "afirmacion_correcta",
                                  "omisiones", "errores", "fuentes", "created_at")
        })

    raw_claims = _paginate_table(supabase, "claim", CLAIM_FIELDS, "afirmaciones", page_size=500)
    orden = {i["id"]: i.get("orden") for i in
             _paginate_table(supabase, "intervention", "id, orden", "intervenciones", page_size=1000)}

    claims = []
    for c in raw_claims:
        claims.append({
            "id": c["id"],
            "session_id": c.get("session_id"),
            "texto_normalizado": c.get("texto_normalizado"),
            "texto_original": c.get("texto_original"),
            "ambito_geografico": c.get("ambito_geografico"),
            "ambito_tematico": c.get("ambito_tematico"),
            "orden": orden.get(c.get("intervention_id")),
            "politician": politicians.get(c.get("politician_id")),
            "session": sessions.get(c.get("session_id")),
            "verification": verifications.get(c["id"], []),
        })
    return claims


def fetch_session_dates(supabase):
    """Returns {session_id: fecha_iso_string}."""
    resp = supabase.from_("session").select("id, fecha").execute()
    return {s["id"]: (s["fecha"] or "")[:10] for s in (resp.data or [])}


def fetch_salaries(supabase):
    """Returns {politician_id: salary_row}."""
    try:
        resp = supabase.from_(SALARY_TABLE).select("*").execute()
    except Exception as exc:
        print(f"  aviso: no se pudo leer {SALARY_TABLE} ({exc})")
        return {}
    out = {}
    for row in (resp.data or []):
        pid = row.get("politician_id")
        if pid:
            out[pid] = row
    return out


def fetch_salaries_sqlite():
    con = _sqlite_conn()
    try:
        rows = con.execute(f"SELECT * FROM {SALARY_TABLE}").fetchall()
    except sqlite3.OperationalError:
        con.close()
        return {}
    con.close()
    return {r["politician_id"]: dict(r) for r in rows if r["politician_id"]}


def generate_salary_data(salaries):
    """Generated frontend fallback: salary facts from DB, photo paths from assets."""
    keys = [
        "politician_id", "nombre_completo", "grupo_parlamentario", "partido",
        "circunscripcion", "cod_parlamentario", "base_monthly_eur",
        "indemnizacion_monthly_eur", "complements_monthly_eur",
        "total_monthly_eur", "total_annual_eur", "breakdown",
        "government_role",
    ]
    rows = []
    for row in salaries.values():
        item = {k: row.get(k) for k in keys if row.get(k) not in (None, "")}
        if item.get("politician_id") and item.get("nombre_completo"):
            rows.append(item)
    rows.sort(key=lambda r: str(r.get("nombre_completo", "")))
    SALARY_DATA_PATH.parent.mkdir(exist_ok=True)
    payload = json.dumps(rows, ensure_ascii=False, separators=(",", ":"))
    SALARY_DATA_PATH.write_text(f"window.FACTHEM_SALARIES={payload};\n", encoding="utf-8")
    print(f"  {SALARY_DATA_PATH.relative_to(Path(__file__).parent)} generado — {len(rows)} retribuciones")


# ── Sitemap ───────────────────────────────────────────────────────────────────

STATIC_URLS = [
    ("https://facthem.es/",                  "2026-03-11T00:00:00+00:00", "weekly",  "1.0"),
    ("https://facthem.es/representantes.html", TODAY,                       "weekly",  "0.8"),
    ("https://facthem.es/estadisticas.html",   TODAY,                       "weekly",  "0.6"),
    ("https://facthem.es/aviso.html",        "2026-03-11T00:00:00+00:00", "yearly",  "0.3"),
    ("https://facthem.es/metodologia.html",  "2026-05-05T00:00:00+00:00", "yearly",  "0.4"),
    ("https://facthem.es/acerca.html",       "2026-05-05T00:00:00+00:00", "yearly",  "0.4"),
    ("https://facthem.es/blog.html",         "2026-03-13T00:00:00+00:00", "monthly", "0.5"),
]


def _iso(date_str):
    if not date_str:
        return f"{TODAY}T00:00:00+00:00"
    if "T" in date_str:
        return date_str
    return f"{date_str}T00:00:00+00:00"


def _loc(url):
    return (url.replace("&", "&amp;")
               .replace('"', "&quot;")
               .replace("'", "&apos;")
               .replace("<", "&lt;")
               .replace(">", "&gt;"))


def update_sitemap(slug_dates, politician_dates, session_dates=None):
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>\n',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n',
    ]
    for loc, lastmod, changefreq, priority in STATIC_URLS:
        parts.append(
            f"  <url>\n    <loc>{_loc(loc)}</loc>\n    <lastmod>{_iso(lastmod)}</lastmod>\n"
            f"    <changefreq>{changefreq}</changefreq>\n    <priority>{priority}</priority>\n  </url>\n"
        )
    for sid, lastmod in sorted((session_dates or {}).items(), key=lambda kv: kv[1], reverse=True):
        url = BASE_URL + session_url(sid)
        parts.append(
            f"  <url>\n    <loc>{_loc(url)}</loc>\n    <lastmod>{_iso(lastmod)}</lastmod>\n"
            f"    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n"
        )
    for slug, lastmod in sorted(politician_dates.items()):
        url = f"{BASE_URL}/politician/{slug}.html"
        parts.append(
            f"  <url>\n    <loc>{_loc(url)}</loc>\n    <lastmod>{_iso(lastmod)}</lastmod>\n"
            f"    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>\n"
        )
    for slug, lastmod in sorted(slug_dates.items()):
        url = f"{BASE_URL}/claim/{slug}.html"
        parts.append(
            f"  <url>\n    <loc>{_loc(url)}</loc>\n    <lastmod>{_iso(lastmod)}</lastmod>\n"
            f"    <changefreq>monthly</changefreq>\n    <priority>0.7</priority>\n  </url>\n"
        )
    parts.append("</urlset>\n")
    SITEMAP_PATH.write_bytes("".join(parts).encode("utf-8"))
    print(f"  sitemap.xml actualizado — {len(politician_dates)} políticos, {len(slug_dates)} afirmaciones")


# ── Archive page (paginated A–Z) ──────────────────────────────────────────────

ARCHIVE_PATH = Path(__file__).parent / "archive.html"

# Spanish alphabet order: Ñ is its own letter, sorted right after N.
# Plus '#' for names that don't start with a letter.
ARCHIVE_BUCKETS = list("ABCDEFGHIJKLMN") + ["Ñ"] + list("OPQRSTUVWXYZ") + ["#"]


def _archive_bucket_of(name):
    """First-letter bucket for a display name: 'A'..'Z', 'Ñ' or '#'."""
    s = str(name or "").strip()
    if not s:
        return "#"
    first = s[0]
    if first in ("Ñ", "ñ"):
        return "Ñ"
    stripped = "".join(
        c for c in unicodedata.normalize("NFD", first) if unicodedata.category(c) != "Mn"
    )
    ch = (stripped[:1] or first).upper()
    return ch if "A" <= ch <= "Z" else "#"


def _archive_bucket_file(letter):
    if letter == "#":
        return "archive-num.html"
    if letter == "Ñ":
        return "archive-enye.html"
    return f"archive-{letter.lower()}.html"


def _archive_nav(file_for, current):
    """A–Z index bar. Active letters link to their page; the rest are dimmed."""
    items = []
    for letter in ARCHIVE_BUCKETS:
        if letter in file_for:
            cls = "archive-letter" + (" archive-letter--current" if letter == current else "")
            items.append(f'<a class="{cls}" href="{BASE_URL}/{file_for[letter]}">{esc(letter)}</a>')
        else:
            items.append(f'<span class="archive-letter archive-letter--empty">{esc(letter)}</span>')
    return (
        '<nav class="archive-nav" aria-label="Índice alfabético">\n      '
        + "".join(items)
        + "\n    </nav>"
    )


def generate_archive(claims_data):
    """
    Plain-HTML archive paginated A–Z by politician initial.
    noindex, follow — pure link graph for crawlers.
    archive.html = first active letter; archive-<x>.html = the rest.
    """
    by_pol = {}
    for slug, claim in claims_data:
        pol = claim.get("politician") or {}
        name = format_nombre(pol.get("nombre_completo", "")) or "Político desconocido"
        by_pol.setdefault(name, []).append((slug, claim))

    buckets = {}
    for name in by_pol:
        buckets.setdefault(_archive_bucket_of(name), []).append(name)

    active_ordered = [L for L in ARCHIVE_BUCKETS if L in buckets]
    file_for = {
        L: ("archive.html" if i == 0 else _archive_bucket_file(L))
        for i, L in enumerate(active_ordered)
    }

    # Clean stale per-letter pages from previous builds.
    for f in Path(__file__).parent.glob("archive-*.html"):
        f.unlink()

    def _letter_body(letter):
        rows = []
        for name in sorted(buckets[letter], key=str.casefold):
            sample_pol = by_pol[name][0][1].get("politician") or {}
            pol_slug = slugify_politician(sample_pol.get("nombre_completo", name), sample_pol.get("partido", ""))
            pol_url  = f"{BASE_URL}/politician/{pol_slug}.html"
            rows.append(f'  <h2><a href="{pol_url}">{esc(name)}</a></h2>\n  <ul>')
            for slug, claim in by_pol[name]:
                text = esc(str(claim.get("texto_normalizado") or slug).strip()[:120])
                url  = f"{BASE_URL}/claim/{slug}.html"
                rows.append(f'    <li><a href="{url}">{text}</a></li>')
            rows.append("  </ul>")
        return "\n".join(rows)

    def _page(letter):
        nav = _archive_nav(file_for, letter)
        canon = f"{BASE_URL}/{file_for[letter]}"
        n_pol = len(buckets[letter])
        caption = f"Representantes cuya inicial es «{letter}» · {n_pol} {'representante' if n_pol == 1 else 'representantes'}"
        body = (f'<main class="page archive-page" id="main"><header class="page-head"><h1>Todas las afirmaciones</h1>'
                f'<p class="muted">{esc(caption)}</p></header>{nav}\n{_letter_body(letter)}\n{nav}</main>')
        # noindex, follow: a plain link graph for crawlers (unchanged).
        return site_chrome.page(body=body, title=f"Todas las afirmaciones — {letter} | Facthem",
                                description=f"Archivo de afirmaciones verificadas por Facthem. {caption}.",
                                canonical=canon, robots="noindex, follow")

    if not active_ordered:
        ARCHIVE_PATH.write_text(
            '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">'
            '<title>Todas las afirmaciones — Facthem</title>'
            '<meta name="robots" content="noindex, follow"></head>'
            "<body><p>Sin afirmaciones.</p></body></html>",
            encoding="utf-8",
        )
        print("  archive.html generado — 0 afirmaciones")
        return

    for letter in active_ordered:
        (Path(__file__).parent / file_for[letter]).write_text(_page(letter), encoding="utf-8")

    total_claims = sum(len(v) for v in by_pol.values())
    print(
        f"  archivo paginado — {len(active_ordered)} letras, "
        f"{len(by_pol)} políticos, {total_claims} afirmaciones"
    )


# ── Politician pages ──────────────────────────────────────────────────────────

# ── Salary panel helpers (mirror js/app.js renderPoliticianPanel) ─────────────

GOVERNMENT_ROLE_LABELS = {
    "presidente_gobierno":     "Presidente del Gobierno",
    "vicepresidente_gobierno": "Vicepresidente/a del Gobierno",
    "ministro":                "Ministro/a",
    "secretario_estado":       "Secretario/a de Estado",
}


def _salary_value(row, keys):
    if not row:
        return None
    for k in keys:
        v = row.get(k)
        if v is not None and v != "":
            return v
    return None


def _format_eur(value, compact=False):
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n:  # NaN
        return None
    if compact:
        return f"{n:,.0f} €".replace(",", ".")
    whole = f"{n:,.2f}"
    # es-ES style: 1.234,56
    int_part, dec = whole.split(".")
    return f"{int_part.replace(',', '.')},{dec} €"


def _salary_amount(row, keys):
    try:
        n = float(_salary_value(row, keys) or 0)
    except (TypeError, ValueError):
        return 0
    if n != n or n <= 0:
        return 0
    return n


def _salary_seo_description(salary, nombre, total, grupo):
    if not salary:
        return f"Afirmaciones verificadas de {nombre} en Facthem. Busca representantes y políticos del Congreso por nombre, partido y sesión parlamentaria."
    monthly_raw = _salary_amount(salary, ["total_monthly_eur", "monthly_total_eur", "salary_monthly_total_eur", "monthly_with_indemnity_eur"])
    annual_raw = _salary_amount(salary, ["total_annual_eur", "annual_total_eur", "salary_annual_total_eur"])
    monthly = _format_eur(monthly_raw) if monthly_raw else None
    annual = _format_eur(annual_raw, compact=True) if annual_raw else None
    scope = "salario público" if grupo == "Cargo de Gobierno" or _salary_value(salary, ["government_role"]) else "salario en el Congreso"
    claim_text = f" {total} afirmaciones verificadas por Facthem." if total else ""
    if monthly and annual:
        return f"{scope[0].upper()}{scope[1:]} de {nombre}: sueldo mensual total {monthly} y salario anual {annual}.{claim_text}"
    return f"{scope[0].upper()}{scope[1:]} de {nombre} y afirmaciones verificadas por Facthem."


def _salary_breakdown(row):
    raw = _salary_value(row, ["breakdown", "salary_breakdown", "calculation_breakdown"])
    if not raw:
        return None
    if isinstance(raw, dict):
        return raw
    try:
        return json.loads(raw)
    except (TypeError, ValueError):
        return None


def _slugify_photo(value):
    s = str(value or "").strip().lower().replace(",", " ")
    s = s.replace("ª", "a").replace("º", "o")
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"[^a-z0-9\s-]", "", s)
    return re.sub(r"-+", "-", "-".join(s.split())).strip("-")


def _format_photo_name(value):
    parts = str(value or "").split(",", 1)
    if len(parts) == 2:
        return f"{parts[1].strip()} {parts[0].strip()}"
    return str(value or "")


def _government_photo_file(row):
    full_name = _salary_value(row, ["full_name", "nombre_completo", "name", "politician_name"])
    group = _salary_value(row, ["parliamentary_group", "grupo_parlamentario", "group"])
    gov_role = _salary_value(row, ["government_role"])
    if not full_name or (group != "Cargo de Gobierno" and not gov_role):
        return ""

    names = {_format_photo_name(full_name)}
    for name in list(names):
        names.add(re.sub(r"\bAbed\b", "", name).strip())
        names.add(re.sub(r"\bi\b", "", name).strip())

    photos_dir = Path(__file__).parent / "assets" / "photos"
    for name in names:
        slug = _slugify_photo(name)
        if not slug:
            continue
        for ext in (".jpg", ".png", ".webp"):
            candidate = f"gobierno-{slug}{ext}"
            if (photos_dir / candidate).exists():
                return candidate
    return ""


def _salary_photo_src(row):
    file = _government_photo_file(row)
    if not file:
        full_name = _salary_value(row, ["full_name", "nombre_completo", "name", "politician_name"])
        party = _salary_value(row, ["party", "partido"])
        code = _salary_value(row, ["cod_parlamentario", "congress_code", "code"])
        if full_name and party and code:
            candidate = f"{_slugify_photo(full_name)}_{code}_{_slugify_photo(party)}.jpg"
            if (Path(__file__).parent / "assets" / "photos" / candidate).exists():
                file = candidate
    return f"/assets/photos/{urllib.parse.quote(file)}" if file else ""


MONTHS_ES = [
    "", "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]


def _format_session_date_es(raw):
    if not raw:
        return "Sesión desconocida"
    try:
        dt = datetime.fromisoformat(str(raw)[:10])
        return f"{dt.day:02d} de {MONTHS_ES[dt.month]} de {dt.year}"
    except ValueError:
        return str(raw)


def build_roster(claims_with_slugs, salaries=None):
    """Every person who gets a profile: claim authors + the salary table.

    Claim authors keep the slug they have always had (name + party of the
    politician record). Salary rows attach to the author with the same
    politician id or full name; the rest (deputies and Government members
    without claims yet) get a page of their own, salary only.
    Returns {slug: info}.
    """
    salaries = salaries or {}
    by_nombre = {}
    for claim_slug, claim in claims_with_slugs:
        if not claim.get("verification"):
            continue
        pol = claim.get("politician") or {}
        nc = pol.get("nombre_completo", "")
        if not nc:
            continue
        e = by_nombre.setdefault(nc, {"pol_ids": set(), "nombre_completo": nc, "nombre": format_nombre(nc),
                                      "partido": pol.get("partido", ""), "grupo": pol.get("grupo_parlamentario", ""),
                                      "claims": []})
        if pol.get("id"):
            e["pol_ids"].add(pol["id"])
        e["partido"] = e["partido"] or pol.get("partido", "")
        e["grupo"] = e["grupo"] or pol.get("grupo_parlamentario", "")
        e["claims"].append((claim_slug, claim))

    roster, by_id, by_name = {}, {}, {}
    for nc, e in by_nombre.items():
        slug = slugify_politician(nc, e["partido"])
        e["salary"] = None
        roster[slug] = e
        for pid in e["pol_ids"]:
            by_id[pid] = slug
        by_name[nc] = slug

    for row in sorted(salaries.values(), key=lambda r: r.get("nombre_completo") or ""):
        slug = by_id.get(row.get("politician_id")) or by_name.get(row.get("nombre_completo"))
        if slug:
            roster[slug]["salary"] = roster[slug]["salary"] or row
            continue
        nc = row.get("nombre_completo") or ""
        if not nc:
            continue
        slug = slugify_politician(nc, row.get("partido") or "")
        if slug in roster:          # different record, same name+party: keep both, never overwrite
            slug = f"{slug}-{(row.get('cod_parlamentario') or row.get('politician_id') or 'x')[:8]}"
        roster[slug] = {"pol_ids": {row.get("politician_id")}, "nombre_completo": nc, "nombre": format_nombre(nc),
                        "partido": row.get("partido") or "", "grupo": row.get("grupo_parlamentario") or "",
                        "claims": [], "salary": row}
    return roster


def _person_role(info):
    """'Ministro/a' / 'Diputado/a por Asturias' / '' (debate guests)."""
    sal = info.get("salary") or {}
    gov = _salary_value(sal, ["government_role"])
    if gov:
        return GOVERNMENT_ROLE_LABELS.get(gov, snake_to_label(gov))
    if info.get("grupo") == "Cargo de Gobierno":
        return "Miembro del Gobierno"
    if sal:
        circ = sal.get("circunscripcion")
        return f"Diputado/a por {circ}" if circ and circ.casefold() != "cargo de gobierno" else "Diputado/a"
    return ""


def _strip_since(role):
    return re.sub(r"\s+desde el .*$", "", str(role or "")).strip()


def _salary_panel(sal):
    """(<details> html, monthly, annual) for the salary panel; ('', None, None) without data."""
    if not sal:
        return "", None, None
    monthly = _salary_amount(sal, ["total_monthly_eur"])
    annual = _salary_amount(sal, ["total_annual_eur"])
    if not monthly and not annual:
        return "", None, None
    bd = _salary_breakdown(sal) or {}
    pays = (bd.get("base") or {}).get("payments") or 14
    gov = bd.get("government") or {}
    gov_label = GOVERNMENT_ROLE_LABELS.get(gov.get("role"), snake_to_label(gov.get("role"))) if gov.get("role") else ""
    rows = []   # (concept, detail, monthly, annual)
    base = (bd.get("base") or {}).get("monthly_eur") or _salary_amount(sal, ["base_monthly_eur"])
    if base:
        # A Government salary is set per year; use that figure, not monthly × 14 (cents differ).
        rows.append(("Sueldo base", f"Retribución como {gov_label}" if gov_label else "Asignación constitucional",
                     base, gov.get("annual_eur") or base * pays))
    for c in (bd.get("complements") or {}).values():
        if c.get("monthly_eur"):
            rows.append((f"Complemento · {c.get('kind') or 'cargo'}", _strip_since(c.get("role")),
                         c["monthly_eur"], c["monthly_eur"] * pays))
    ind = (bd.get("indemnizacion") or {}).get("monthly_eur") or _salary_amount(sal, ["indemnizacion_monthly_eur"])
    if ind:
        rows.append(("Indemnización", "Gastos de ejercicio del cargo · exenta de IRPF", ind, ind * pays))
    body = "".join(f'<tr><th scope="row">{esc(k)}<small>{esc(sub)}</small></th><td>{_format_eur(m)}</td>'
                   f'<td>{_format_eur(a)}</td></tr>' for k, sub, m, a in rows)
    taxable = _salary_amount(sal, ["taxable_annual_eur"])
    exempt = _salary_amount(sal, ["indemnizacion_annual_eur"])
    src = _salary_value(sal, ["salary_source_url", "source_url"])
    note = []
    if taxable and exempt:
        note.append(f"{_format_eur(taxable, compact=True)} al año tributan IRPF y {_format_eur(exempt, compact=True)} están exentos.")
    note.append(f"Retribuciones públicas oficiales · {pays} pagas; si ocupa varios cargos del mismo tipo, "
                "cuenta solo el mejor pagado.")
    if is_valid(src):
        note.append(f'<a href="{esc(src)}" target="_blank" rel="noopener">Fuente oficial ↗</a>')
    profile = _salary_value(sal, ["source_url"])
    if is_valid(profile) and profile != src:
        label = "Ficha en el Congreso" if "congreso.es" in profile else "Ficha oficial"
        note.append(f'<a href="{esc(profile)}" target="_blank" rel="noopener">{label} ↗</a>')
    try:
        roles = json.loads(sal.get("roles") or "[]")
    except (TypeError, ValueError):
        roles = []
    roles = [GOVERNMENT_ROLE_LABELS.get(r, r) for r in roles if r]
    roles_html = (f'<div class="sum-block"><h3>Cargos · {len(roles)}</h3><ul class="roles">'
                  + "".join(f"<li>{esc(r)}</li>" for r in roles) + "</ul></div>") if roles else ""
    chev = ('<svg class="chev" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m6 9 6 6 6-6" '
            'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>')
    html_ = (
        '<details class="sum sum-sal"><summary><span class="sum-line"><span class="sum-k">Salario</span>'
        f'<b>{_format_eur(monthly, compact=True)}</b><span class="sum-unit">/mes</span><span class="sum-sep">·</span>'
        f'<b>{_format_eur(annual, compact=True)}</b><span class="sum-unit">/año</span></span>{chev}</summary>'
        '<div class="sum-body"><table class="sal-table"><thead><tr><th scope="col">Concepto</th>'
        '<th scope="col">Mensual</th><th scope="col">Anual</th></tr></thead>'
        f'<tbody>{body}</tbody><tfoot><tr><th scope="row">Total</th><td>{_format_eur(monthly)}</td>'
        f'<td>{_format_eur(annual)}</td></tr></tfoot></table>'
        f'<p class="side-note">{" ".join(note)}</p>{roles_html}</div></details>')
    return html_, monthly, annual


def _claims_panel(claims):
    if not claims:
        return ('<div class="sum sum-empty"><span class="sum-line"><span class="sum-k">Afirmaciones</span>'
                '<span class="sum-dim">Sin afirmaciones verificadas todavía.</span></span></div>')
    cnt = {k: 0 for k, *_ in site_chrome.VERDICTS}
    temas = {}
    for _, c in claims:
        v = (c.get("verification") or [{}])[0] or {}
        cnt[site_chrome.verdict_key(v.get("resultado"))] += 1
        t = c.get("ambito_tematico") or "other"
        temas[t] = temas.get(t, 0) + 1
    total = len(claims)
    wrong = cnt["FALSO"] + cnt["SOBREESTIMADO"] + cnt["SUBESTIMADO"] + cnt["IMPRECISO"] + cnt["DESCONTEXTUALIZADO"]
    sessions = len({c.get("session_id") for _, c in claims})
    top = sorted(temas.items(), key=lambda kv: -kv[1])
    tlist = top[:5] + ([("__otros", sum(n for _, n in top[5:]))] if top[5:] else [])
    tc = ["#c9a2ae", "#a7808d", "#8a6672", "#715360", "#5d4450", "#4b3741"]
    tname = lambda t: "Otros temas" if t == "__otros" else site_chrome.tema_label(t)
    chev = ('<svg class="chev" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="m6 9 6 6 6-6" '
            'fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>')
    pct = round(wrong / total * 100)
    return (
        '<details class="sum"><summary><span class="sum-line"><span class="sum-k">Afirmaciones</span>'
        f'<b>{total}</b><span class="sum-unit only-m">afirmaciones</span><span class="sum-sep">·</span><b>{pct}%</b>'
        '<span class="sum-dim"><span class="only-d">falsas o exageradas</span><span class="only-m">falsas</span></span>'
        f'</span>{chev}{site_chrome.stack(cnt, "stack stack-static sum-bar")}</summary>'
        f'<div class="sum-body"><div class="sum-block">{site_chrome.legend(cnt)}'
        f'<p class="side-note">{total} afirmaciones en {sessions} sesiones · {wrong} falsas, exageradas o inexactas</p></div>'
        '<div class="sum-block"><h3>Temas</h3><div class="stack stack-static" role="img" aria-label="Temas">'
        + "".join(f'<span style="--c:{tc[i]};flex:{n}" title="{esc(tname(t))}: {n}"></span>' for i, (t, n) in enumerate(tlist))
        + '</div><ul class="legend">'
        + "".join(f'<li style="--c:{tc[i]}"><span class="dot"></span>{esc(tname(t))} <span class="num">{n}</span></li>'
                  for i, (t, n) in enumerate(tlist))
        + '</ul></div></div></details>')


def _write_politician_page(pol_slug, info, photo_for):
    nombre, partido, grupo = info["nombre"], info["partido"], info["grupo"]
    claims, salary = info["claims"], info.get("salary")
    pol_url = f"{BASE_URL}/politician/{pol_slug}.html"
    total = len(claims)
    falsos = sum(1 for _, c in claims
                 if site_chrome.verdict_key(((c.get("verification") or [{}])[0] or {}).get("resultado")) == "FALSO")

    # Title / description: same formula as before.
    title = f"{nombre} — salario y afirmaciones verificadas | Facthem"
    desc = _salary_seo_description(salary, f"{nombre} ({partido})" if partido else nombre, total, grupo)
    if total and falsos:
        desc += f" {falsos} falsa{'s' if falsos != 1 else ''}."

    photo = (_salary_photo_src(salary) if salary else "") or photo_for(
        {"id": next(iter(info["pol_ids"]), None), "nombre_completo": info["nombre_completo"]})
    role = _person_role(info)
    congress_url = _salary_value(salary, ["source_url"]) if salary and not _salary_value(salary, ["government_role"]) else None

    person = {"@type": "Person", "@id": f"{pol_url}#person", "name": nombre, "url": pol_url, "description": desc}
    if role:
        person["jobTitle"] = re.sub(r" por .*$", "", role)
    if partido:
        person["affiliation"] = {"@type": "Organization", "name": partido}
    if photo:
        person["image"] = f"{BASE_URL}{photo}"
    if is_valid(congress_url):
        person["sameAs"] = [congress_url]
    graph = {"@context": "https://schema.org", "@graph": [
        {"@type": "WebPage", "@id": f"{pol_url}#webpage", "url": pol_url, "name": title, "description": desc,
         "isPartOf": {"@type": "WebSite", "name": "Facthem", "url": BASE_URL}, "about": {"@id": f"{pol_url}#person"}},
        person]}
    crumbs_ld = {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
        {"@type": "ListItem", "position": 1, "name": "Representantes", "item": f"{BASE_URL}/representantes.html"},
        {"@type": "ListItem", "position": 2, "name": nombre}]}

    initials = "".join(p[0] for p in nombre.split()[:2]).upper() or "?"
    photo_html = (f'<img class="p-photo" src="{esc(photo)}" alt="{esc(nombre)}" width="132" height="164" />' if photo
                  else f'<span class="p-photo c-photo-none" aria-hidden="true">{esc(initials)}</span>')
    share_text = f"{nombre} ({partido}) en Facthem" if partido else f"{nombre} en Facthem"
    meta = " · ".join(esc(x) for x in (partido, role) if x)
    sal_html, monthly, annual = _salary_panel(salary)

    # Claims grouped by sitting, newest first; filters work on these cards (js/profile.js).
    groups = {}
    for cs, c in claims:
        groups.setdefault(c.get("session_id") or "", []).append((cs, c))
    order = sorted(groups, key=lambda k: ((groups[k][0][1].get("session") or {}).get("fecha") or ""), reverse=True)
    sec = []
    for sid in order:
        sess = groups[sid][0][1].get("session") or {}
        cards = "".join(site_chrome.card({
            "url": f"/claim/{cs}.html", "text": capitalize(str(c.get("texto_normalizado") or "").strip()),
            "verdict": ((c.get("verification") or [{}])[0] or {}).get("resultado"), "name": nombre, "party": partido,
            "tema": c.get("ambito_tematico"),
            "geo": snake_to_label(c.get("ambito_geografico")) if c.get("ambito_geografico") else "",
            "id": c.get("id")}, with_who=False) for cs, c in groups[sid])
        when = _format_session_date_es(sess.get("fecha"))
        sec.append(f'<section class="r-group" data-session="{esc(sid)}"><h3><a href="{esc(session_url(sid))}">{esc(when)}</a>'
                   f'<span>{esc(session_label(sess, short=True))} · <span class="r-n">{len(groups[sid])}</span></span></h3>'
                   f'<div class="grid">{cards}</div></section>')

    temas = {}
    vcount = {}
    for _, c in claims:
        temas[c.get("ambito_tematico") or "other"] = temas.get(c.get("ambito_tematico") or "other", 0) + 1
        k = site_chrome.verdict_key(((c.get("verification") or [{}])[0] or {}).get("resultado"))
        vcount[k] = vcount.get(k, 0) + 1
    filters = ""
    if total > 3:
        vopts = "".join(f'<option value="{k}">{esc(lg)} ({vcount[k]})</option>'
                        for k, _s, lg, *_ in site_chrome.VERDICTS if vcount.get(k))
        topts = "".join(f'<option value="{esc(t)}">{esc(site_chrome.tema_label(t))} ({n})</option>'
                        for t, n in sorted(temas.items(), key=lambda kv: -kv[1]))
        filters = (
            '<div class="quiet-filters" id="p-filters">'
            f'<label class="select"><span class="sr">Resultado</span><select id="r-v"><option value="">Resultado</option>{vopts}</select></label>'
            f'<label class="select"><span class="sr">Temática</span><select id="r-t"><option value="">Temática</option>{topts}</select></label>'
            f'<label class="search">{site_chrome.ICON_SEARCH}<input id="r-q" type="search" placeholder="Buscar" '
            'aria-label="Buscar en sus afirmaciones" /></label></div>')
    claims_html = (
        f'<section class="p-sec p-claims"><div class="p-sec-head"><h2>Afirmaciones</h2>{filters}</div>'
        f'<div id="r-list">{"".join(sec)}</div><p class="empty" id="r-empty" hidden>Ninguna afirmación coincide.</p></section>'
        if claims else
        '<section class="p-sec p-claims"><p class="side-note">Todavía no hemos verificado ninguna afirmación suya. '
        'Aparecerán aquí cuando intervenga en un pleno o debate que verifiquemos.</p></section>')

    body = f"""<main class="page page-narrow" id="main">
<nav class="crumbs" aria-label="Ruta"><a href="/representantes.html">Representantes</a><span>/</span><span>{esc(nombre)}</span></nav>
<header class="p-head">
<div class="p-pic">{photo_html}{site_chrome.share(pol_url, share_text, '<span>Compartir</span>')}</div>
<div class="p-id"><h1>{esc(nombre)}</h1>{f'<p class="p-meta">{meta}</p>' if meta else ''}</div>
</header>
<div class="sums">{_claims_panel(claims)}{sal_html or '<div class="sum sum-empty"><span class="sum-line"><span class="sum-k">Salario</span><span class="sum-dim">Sin datos salariales disponibles.</span></span></div>'}</div>
{claims_html}
</main>"""
    og_image = f"{BASE_URL}{photo}" if photo else f"{BASE_URL}/assets/portada_opt.png"
    page = site_chrome.page(body=body, active="representantes", scripts=("js/ui.js", "js/profile.js"),
                            title=title, description=desc, canonical=pol_url, og_image=og_image,
                            jsonld=(graph, crumbs_ld))
    (POL_OUT_DIR / f"{pol_slug}.html").write_text(page, encoding="utf-8")
    return {"n": nombre, "p": partido, "s": pol_slug, "f": photo, "c": role, "k": total,
            "m": round(monthly or 0, 2), "a": round(annual or 0, 2),
            "o": info["nombre_completo"] if "," in info["nombre_completo"] else nombre}


def generate_politician_pages(claims_with_slugs, salaries=None, photo_for=None):
    """One static page per person (claim authors + salary roster).

    Also writes assets/people.json, the index behind the top-bar search and the
    directory. Returns {slug: lastmod}.
    """
    photo_for = photo_for or make_photo_resolver(salaries or {})
    roster = build_roster(claims_with_slugs, salaries)
    POL_OUT_DIR.mkdir(exist_ok=True)
    for f in POL_OUT_DIR.glob("*.html"):
        f.unlink()
    slug_dates, people = {}, []
    for slug, info in sorted(roster.items()):
        people.append(_write_politician_page(slug, info, photo_for))
        fechas = [((c.get("session") or {}).get("fecha") or "")[:10] for _, c in info["claims"]]
        fechas = [f for f in fechas if f]
        fetched = str((info.get("salary") or {}).get("fetched_at") or "")[:10]
        slug_dates[slug] = max(fechas) if fechas else (fetched or TODAY)
    people.sort(key=lambda p: (-p["k"], p["n"]))
    PEOPLE_JSON.write_text(json.dumps(people, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    with_claims = sum(1 for p in people if p["k"])
    print(f"  politician/ generado — {len(people)} páginas ({with_claims} con afirmaciones, "
          f"{len(people) - with_claims} solo salario) · assets/people.json")
    generate_directory(people)
    return slug_dates


def party_color(p):
    """Party dot colour; regional federations take the national party's colour."""
    pc = site_chrome.PARTY_COLORS
    if p in pc:
        return pc[p]
    for k in ("PSOE", "PP", "VOX", "SUMAR"):
        if k in str(p or "").upper():
            return pc[k]
    return "var(--muted)"


def _sort_key(s):
    s = unicodedata.normalize("NFD", str(s or "").lower())
    return "".join(ch for ch in s if unicodedata.category(ch) != "Mn")


def generate_directory(people):
    """representantes.html: everyone, prerendered A–Z (by surname); js/directory.js
    adds search, party filter and the other orders over these same links."""
    people = sorted(people, key=lambda p: _sort_key(p["o"]))
    parties = {}
    for p in people:
        parties[p["p"] or "Sin partido"] = parties.get(p["p"] or "Sin partido", 0) + 1
    items = []
    for i, p in enumerate(people):
        photo = (f'<img src="{esc(p["f"])}" alt="" loading="lazy" width="44" height="44" />' if p["f"]
                 else f'<span class="person-ph" aria-hidden="true">{esc("".join(w[0] for w in p["n"].split()[:2]).upper())}</span>')
        meta = " · ".join(esc(x) for x in (p["p"], re.sub(r"^Diputado/a por ", "", p["c"])) if x)
        stats = []
        if p["k"]:
            stats.append(f'<span class="person-k">{p["k"]} afirmaci{"ón" if p["k"] == 1 else "ones"}</span>')
        if p["m"]:
            stats.append(f'<span class="person-sal">{_format_eur(p["m"], compact=True)}/mes</span>')
        items.append(
            f'<li><a class="person" href="/politician/{esc(p["s"])}.html" data-o="{esc(_sort_key(p["o"]))}" '
            f'data-p="{esc(p["p"] or "Sin partido")}" data-k="{p["k"]}" data-m="{p["m"]}" '
            f'data-q="{esc(_sort_key(p["n"] + " " + p["p"] + " " + p["c"]))}">{photo}'
            f'<span class="person-txt"><span class="person-name">{esc(p["n"])}</span>'
            f'<span class="person-meta"><span class="pdot" style="--pc:{party_color(p["p"])}"></span>{meta}</span></span>'
            f'<span class="person-stats">{"".join(stats)}</span></a></li>')
    # Featured (shown until the reader searches): the head of Government, then the
    # most-verified person of each party — one per party, so the pick is neutral.
    top, seen = [], set()
    for p in sorted(people, key=lambda p: (p["c"] != "Presidente del Gobierno", -p["k"], _sort_key(p["o"]))):
        if p["k"] and p["p"] and p["p"] not in seen:
            seen.add(p["p"]); top.append(p)
    vips = []
    for p in top:
        photo = (f'<img src="{esc(p["f"])}" alt="" width="88" height="88" />' if p["f"]
                 else f'<span class="person-ph" aria-hidden="true">{esc("".join(w[0] for w in p["n"].split()[:2]).upper())}</span>')
        role = re.sub(r"^Diputado/a por .*$", "Diputado/a", p["c"]) or ""
        stats = [f'{p["k"]} afirmaci{"ón" if p["k"] == 1 else "ones"}']
        if p["m"]:
            stats.append(f'{_format_eur(p["m"], compact=True)}/mes')
        vips.append(
            f'<li><a class="vip" href="/politician/{esc(p["s"])}.html">{photo}'
            f'<span class="vip-name">{esc(p["n"])}</span>'
            f'<span class="vip-meta"><span class="pdot" style="--pc:{party_color(p["p"])}"></span>{esc(p["p"])}'
            f'{" · " + esc(role) if role else ""}</span>'
            f'<span class="vip-stats">{"".join(f"<span>{x}</span>" for x in stats)}</span></a></li>')
    popts = "".join(f'<option value="{esc(k)}">{esc(k)} ({n})</option>'
                    for k, n in sorted(parties.items(), key=lambda kv: -kv[1]))
    n_dip = sum(1 for p in people if p["c"].startswith("Diputado"))
    n_gov = sum(1 for p in people if p["c"] and not p["c"].startswith("Diputado"))
    body = f"""<main class="page" id="main">
<header class="page-head"><h1>Representantes</h1>
<p class="muted">Diputados del Congreso y miembros del Gobierno: sus afirmaciones verificadas y su retribución pública.</p></header>
<div class="dir-bar">
<label class="search search-lg">{site_chrome.ICON_SEARCH.replace('width="14" height="14"', 'width="16" height="16"')}<span class="sr">Buscar representante</span>
<input id="d-q" type="search" placeholder="Busca un nombre, un partido o una provincia" autocomplete="off" /></label>
<div class="quiet-filters">
<label class="select"><span class="sr">Partido</span><select id="d-p"><option value="">Partido</option>{popts}</select></label>
<label class="select"><span class="sr">Orden</span><select id="d-o"><option value="az">A–Z</option><option value="k">Más afirmaciones</option><option value="m">Mayor sueldo</option></select></label>
</div>
<p class="panel-count" id="d-n" aria-live="polite"><strong>{len(people)}</strong> representantes</p>
</div>
<section class="dir-top" id="dir-top" aria-labelledby="dir-top-h"><h2 id="dir-top-h" class="dir-top-h">Los más verificados de cada partido</h2>
<ul class="vips">{''.join(vips)}</ul>
<p class="dir-more"><button type="button" class="btn btn-ghost" id="d-more">Busca para mostrar más <span class="muted">· {len(people)} representantes</span></button></p></section>
<ul class="dir" id="dir" hidden>{''.join(items)}</ul>
<noscript><style>#dir[hidden] {{ display: grid !important; }} .dir-more {{ display: none; }}</style></noscript>
<p class="empty" id="d-empty" hidden>Nadie coincide con la búsqueda.</p>
</main>"""
    url = f"{BASE_URL}/representantes.html"
    title = "Diputados del Congreso: afirmaciones verificadas y sueldos | Facthem"
    desc = (f"Los {n_dip} diputados del Congreso y {n_gov} miembros del Gobierno: sus afirmaciones "
            "verificadas en el Pleno y su retribución pública, mes a mes y al año.")
    ld = [{"@context": "https://schema.org", "@type": "CollectionPage", "url": url, "name": title, "description": desc,
           "isPartOf": {"@type": "WebSite", "name": "Facthem", "url": BASE_URL},
           "mainEntity": {"@type": "ItemList", "numberOfItems": len(people), "itemListElement": [
               {"@type": "ListItem", "position": i + 1, "url": f"{BASE_URL}/politician/{p['s']}.html", "name": p["n"]}
               for i, p in enumerate(people)]}},
          # was on the old home page (url ?tab=parlamentarios, now this page)
          {"@context": "https://schema.org", "@type": "Dataset",
           "name": "Salarios de políticos del Congreso de los Diputados",
           "description": "Sueldo mensual, salario anual, salario base, complementos e indemnizaciones de los "
                          "diputados del Congreso y los miembros del Gobierno incluidos en Facthem.",
           "url": url, "inLanguage": "es",
           "keywords": ["salario políticos Congreso", "sueldo diputados", "salario anual políticos",
                        "retribuciones Congreso", "complementos diputados", "indemnizaciones parlamentarias"],
           "publisher": {"@type": "Organization", "name": "Facthem", "url": BASE_URL},
           "variableMeasured": ["sueldo mensual total", "salario anual", "salario base mensual",
                                "complementos", "indemnización"]}]
    DIRECTORY_PATH.write_text(site_chrome.page(
        body=body, active="representantes", scripts=("js/ui.js", "js/directory.js"),
        title=title, description=desc, canonical=url, jsonld=ld), encoding="utf-8")
    print(f"  representantes.html generado — {len(people)} personas")


# ── Sittings: data files, rail, session block, home page ──────────────────────
# The home page is static: the build writes one JSON per sitting
# (assets/sessions/<id>.json) and prerenders the latest sitting into index.html.
# js/home.js renders other sittings from those files with the same markup
# (site_chrome.card ↔ FT.cardHTML), so nothing at runtime talks to Supabase.

ROMAN = {"10": "X", "11": "XI", "12": "XII", "13": "XIII", "14": "XIV", "15": "XV", "16": "XVI", "17": "XVII"}
MONTHS_SHORT = ["", "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"]


def claim_record(slug, claim, photo_for):
    """Compact claim for the session JSON and the cards (keys kept short: ~7.6k claims)."""
    pol = claim.get("politician") or {}
    v = (claim.get("verification") or [{}])[0] or {}
    return {
        "i": claim.get("id"), "u": slug,
        "t": capitalize(str(claim.get("texto_normalizado") or "").strip()),
        "v": site_chrome.verdict_key(v.get("resultado")),
        "n": format_nombre(pol.get("nombre_completo", "")), "p": pol.get("partido") or "",
        "f": photo_for(pol) if pol else "",
        "tm": claim.get("ambito_tematico") or "",
        "g": snake_to_label(claim.get("ambito_geografico")) if claim.get("ambito_geografico") else "",
    }


def record_card(r, index=0):
    return site_chrome.card({"url": f"/claim/{r['u']}.html", "text": r["t"], "verdict": r["v"], "name": r["n"],
                             "party": r["p"], "photo": r["f"], "tema": r["tm"], "geo": r["g"], "id": r["i"]},
                            index=index)


def session_pdf_url(sess):
    leg, tipo = sess.get("legislatura"), sess.get("tipo")
    dscd = str(sess.get("id") or "").rsplit("-", 1)[-1]
    if leg and tipo == "PL" and dscd.isdigit():
        return f"https://www.congreso.es/public_oficiales/L{leg}/CONG/DS/{tipo}/DSCD-{leg}-{tipo}-{int(dscd)}.PDF"
    return ""


def session_title(sess):
    when = _format_session_date_es(sess.get("fecha")).lstrip("0")
    if (sess.get("tipo") or "PL") == "PL":
        return f"Pleno del {when}"
    return f"{sess.get('organo') or 'Debate'} · {when}"


def write_session_data(claims_with_slugs, photo_for):
    """assets/sessions/<id>.json for every sitting; returns (index newest first, {id: records})."""
    by = {}
    for slug, c in claims_with_slugs:
        if c.get("verification") and c.get("session_id") and c.get("session"):
            by.setdefault(c["session_id"], []).append((slug, c))
    SESSIONS_DIR.mkdir(parents=True, exist_ok=True)
    for f in SESSIONS_DIR.glob("*.json"):
        f.unlink()
    index, recs_by = [], {}
    for sid, items in by.items():
        # speaking order: intervention order, then claim id (stable)
        items.sort(key=lambda t: (t[1].get("orden") if t[1].get("orden") is not None else 10**9, str(t[1].get("id"))))
        recs = [claim_record(slug, c, photo_for) for slug, c in items]
        sess = items[0][1]["session"]
        d = {k: 0 for k, *_ in site_chrome.VERDICTS}
        for r in recs:
            d[r["v"]] += 1
        index.append({"id": sid, "fecha": str(sess.get("fecha") or "")[:10], "tipo": sess.get("tipo") or "PL",
                      "organo": sess.get("organo") or "", "leg": ROMAN.get(str(sess.get("legislatura")), ""),
                      "title": session_title(sess), "pdf": session_pdf_url(sess),
                      "n": len(recs), "d": {k: n for k, n in d.items() if n}})
        recs_by[sid] = recs
        (SESSIONS_DIR / f"{_safe_id(sid)}.json").write_text(
            json.dumps(recs, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    index.sort(key=lambda s: (s["fecha"], s["id"]), reverse=True)
    (SESSIONS_DIR / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"  assets/sessions/ — {len(index)} sesiones")
    return index, recs_by


def _safe_id(sid):
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(sid))


def render_rail(index, current):
    lis = []
    for s in index:
        y, m, d = (s["fecha"].split("-") + ["", "", ""])[:3]
        deb = s["tipo"] != "PL"
        cnt = {k: s["d"].get(k, 0) for k, *_ in site_chrome.VERDICTS}
        cur = ' aria-current="page"' if s["id"] == current else ""
        day = str(int(d)) if d.isdigit() else ""
        mon = f'{MONTHS_SHORT[int(m)]} {y}' if m.isdigit() else ""
        kind = "Debate" if deb else "Pleno · Congreso"
        org = s["organo"] if deb else "Sesión plenaria"
        lis.append(
            f'<li><a href="{esc(session_url(s["id"]))}" data-s="{esc(s["id"])}"{cur}>'
            f'<span class="r-type{" deb" if deb else ""}">{kind}</span>'
            f'<span class="r-date"><span class="r-day">{day}</span><span class="r-mon">{mon}</span></span>'
            f'<span class="r-org">{esc(org)}</span>{site_chrome.stack(cnt, "mini-stack")}'
            f'<span class="r-n">{s["n"]} afirmaciones</span></a></li>')
    return f'<ol class="rail" id="rail">{"".join(lis)}</ol>'


def session_eyebrow(s):
    return f'Congreso de los Diputados · {s["leg"]} Legislatura' if s["tipo"] == "PL" and s["leg"] else \
        ("Congreso de los Diputados" if s["tipo"] == "PL" else "Debate electoral")


def session_actions(s):
    url = BASE_URL + session_url(s["id"])
    pdf = (f'<a class="btn btn-ghost btn-sm" href="{esc(s["pdf"])}" target="_blank" rel="noopener">'
           f'Diario de sesiones ↗</a>') if s.get("pdf") else ""
    return pdf + site_chrome.share(url, f"{s['title']}: {s['n']} afirmaciones verificadas en Facthem",
                                   "<span>Compartir</span>")


CHEV = ('<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" '
        'stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg>')


def render_session_block(s, recs):
    """Session head + filter panel + card grid. js/home.js fills the same ids."""
    cnt = {k: 0 for k, *_ in site_chrome.VERDICTS}
    temas, parties = {}, {}
    for r in recs:
        cnt[r["v"]] += 1
        temas[r["tm"] or "other"] = temas.get(r["tm"] or "other", 0) + 1
        if r["p"]:
            parties[r["p"]] = parties.get(r["p"], 0) + 1
    topts = "".join(f'<option value="{esc(t)}">{esc(site_chrome.tema_label(t))} ({n})</option>'
                    for t, n in sorted(temas.items(), key=lambda kv: -kv[1]))
    popts = "".join(f'<option value="{esc(p)}">{esc(p)} ({n})</option>'
                    for p, n in sorted(parties.items(), key=lambda kv: -kv[1]))
    total = len(recs) or 1
    stack = "".join(
        f'<button type="button" class="{"hatch" if k in site_chrome.HATCH else ""}" style="--c:{c};--w:{cnt[k]}" '
        f'data-v="{k}" aria-label="{esc(lg)}" title="{esc(lg)}: {cnt[k]}"{"" if cnt[k] else " hidden"}></button>'
        for k, _s, lg, _i, c in site_chrome.VERDICTS if k not in RETIRED_VERDICTS)
    cards = "".join(record_card(r, i) for i, r in enumerate(recs))
    return f"""<section class="session" id="session" aria-labelledby="session-title" data-ids="{esc(s['id'])}">
<header class="session-head"><div><p class="eyebrow" id="s-eyebrow">{esc(session_eyebrow(s))}</p>
<h2 id="session-title">{esc(s['title'])}</h2></div>
<div class="session-actions" id="s-actions">{session_actions(s)}</div></header>
<div class="panel" id="panel">
<div class="panel-toggle-row"><button type="button" class="filters-toggle" id="filters-toggle" aria-expanded="false" aria-controls="panel-controls"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M4 6h16M8 12h12M12 18h8"/></svg>Filtros<span class="ft-badge" id="ft-badge" hidden></span><svg class="chev" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/></svg></button><span class="ft-count" id="ft-count"><strong>{len(recs)}</strong> afirmaciones</span></div>
<div class="panel-controls" id="panel-controls">
<div class="msel" id="f-res"><button type="button" class="msel-btn" aria-haspopup="true" aria-expanded="false"><span class="msel-label">Resultado</span><span class="msel-n" hidden></span>{CHEV}</button><div class="msel-pop" role="group" aria-label="Filtrar por resultado" hidden></div></div>
<label class="select"><span class="sr">Temática</span><select id="f-tema"><option value="">Temática</option>{topts}</select></label>
<label class="select"><span class="sr">Partido</span><select id="f-party"><option value="">Partido</option>{popts}</select></label>
<label class="search">{site_chrome.ICON_SEARCH}<input id="f-q" type="search" placeholder="Buscar" aria-label="Buscar en esta sesión" /></label>
<button type="button" class="link-btn" id="f-clear" hidden>Limpiar</button>
<p class="panel-count" id="count-line" aria-live="polite"><strong>{len(recs)}</strong> afirmaciones</p>
</div>
<div class="stack" id="x-stack" role="img">{stack}</div>
{site_chrome.legend(cnt).replace('<ul class="legend">', '<ul class="legend" id="x-legend">', 1)}
</div>
<div class="grid" id="grid">{cards}</div>
</section>"""


def generate_session_pages(index, recs_by):
    """/sesion/<id>.html for every sitting: the session block of the home page
    as its own crawlable page (filters via js/home.js). Returns {id: fecha}."""
    SESION_DIR.mkdir(exist_ok=True)
    for f in SESION_DIR.glob("*.html"):
        f.unlink()
    data = json.dumps(index, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    dates = {}
    for i, s in enumerate(index):
        recs = recs_by[s["id"]]
        url = BASE_URL + session_url(s["id"])
        cnt = {}
        for r in recs:
            cnt[r["v"]] = cnt.get(r["v"], 0) + 1
        bits = [f"{n} {site_chrome.VK[k][2].lower()}" for k, *_ in site_chrome.VERDICTS for n in [cnt.get(k, 0)] if n]
        where = "del Pleno del Congreso" if s["tipo"] == "PL" else f"del {s['organo']}"
        when = _format_session_date_es(s["fecha"]).lstrip("0")
        title = (f"Pleno del Congreso del {when}: {s['n']} afirmaciones verificadas | Facthem" if s["tipo"] == "PL"
                 else f"{s['organo']} ({when}): {s['n']} afirmaciones verificadas | Facthem")
        desc = f"Verificación de las {s['n']} afirmaciones {where} del {when}: {', '.join(bits)}. Cada una con sus fuentes."
        newer, older = (index[i - 1] if i > 0 else None), (index[i + 1] if i + 1 < len(index) else None)
        nav = '<nav class="s-nav" aria-label="Otras sesiones">' + (
            f'<a class="btn btn-ghost btn-sm" href="{esc(session_url(older["id"]))}" rel="prev">← {esc(older["title"])}</a>' if older else "<span></span>") + (
            f'<a class="btn btn-ghost btn-sm" href="{esc(session_url(newer["id"]))}" rel="next">{esc(newer["title"])} →</a>' if newer else "<span></span>") + "</nav>"
        body = (f'<main id="main"><nav class="crumbs" aria-label="Ruta"><a href="/">Sesiones</a><span>/</span>'
                f'<span>{esc(s["title"])}</span></nav>{render_session_block(s, recs)}{nav}</main>'
                f'<script type="application/json" id="sessions-index">{data}</script>')
        ld = [{"@context": "https://schema.org", "@type": "CollectionPage", "url": url, "name": title, "description": desc,
               "datePublished": s["fecha"], "inLanguage": "es",
               "isPartOf": {"@type": "WebSite", "name": "Facthem", "url": BASE_URL},
               "mainEntity": {"@type": "ItemList", "numberOfItems": len(recs), "itemListElement": [
                   {"@type": "ListItem", "position": j + 1, "url": f"{BASE_URL}/claim/{r['u']}.html",
                    "name": _truncate_words(r["t"], 110)} for j, r in enumerate(recs)]}},
              {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
                  {"@type": "ListItem", "position": 1, "name": "Sesiones", "item": f"{BASE_URL}/"},
                  {"@type": "ListItem", "position": 2, "name": s["title"]}]}]
        (SESION_DIR / f"{_safe_id(s['id'])}.html").write_text(site_chrome.page(
            body=body, active="sesiones", body_class="sesion-page", scripts=("js/ui.js", "js/home.js"),
            title=title, description=desc, canonical=url, jsonld=ld), encoding="utf-8")
        dates[s["id"]] = s["fecha"]
    print(f"  sesion/ — {len(dates)} páginas de sesión")
    return dates


def fetch_dashboard_stats(supabase=None):
    """The dashboard_stats row the old dashboard read ({} if unavailable)."""
    try:
        if supabase is not None:
            row = supabase.from_("dashboard_stats").select("stats").eq("id", 1).single().execute().data or {}
        else:
            con = _sqlite_conn()
            r = con.execute("SELECT stats FROM dashboard_stats WHERE id = 1").fetchone()
            con.close()
            row = {"stats": r["stats"]} if r else {}
        st = row.get("stats") or {}
        return json.loads(st) if isinstance(st, str) else st
    except Exception as exc:
        print(f"  aviso: no se pudo leer dashboard_stats ({exc})")
        return {}


def generate_stats_page(stats):
    """estadisticas.html: the dashboard prerendered by js/stats.js under Node
    (same function the browser uses). Without Node the page still works: the
    stats JSON is embedded and the browser renders it."""
    import subprocess
    inner = ""
    if stats:
        try:
            res = subprocess.run(
                ["node", "-e", "const {renderStats}=require(process.argv[1]);let d='';"
                 "process.stdin.on('data',c=>d+=c).on('end',()=>process.stdout.write(renderStats(JSON.parse(d))))",
                 str(Path(__file__).parent / "js" / "stats.js")],
                input=json.dumps(stats), capture_output=True, text=True, timeout=60, check=True)
            inner = res.stdout
        except Exception as exc:
            print(f"  aviso: estadísticas sin prerenderizar ({exc}); se pintan en el navegador")
    total, sessions = stats.get("total_claims") or 0, stats.get("total_sessions") or 0
    data = json.dumps(stats, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    body = (f'<main class="page" id="main"><div id="stats">{inner}</div></main>'
            f'<script type="application/json" id="stats-data">{data}</script>')
    url = f"{BASE_URL}/estadisticas.html"
    title = "Estadísticas de las verificaciones del Congreso | Facthem"
    desc = (f"{total:,} afirmaciones verificadas en {sessions} sesiones del Congreso: qué partido y qué diputado "
            "acumulan más falsedades, exageraciones y verdades a medias, por tema y por pleno.").replace(",", ".")
    ld = [{"@context": "https://schema.org", "@type": "WebPage", "url": url, "name": title, "description": desc,
           "inLanguage": "es", "isPartOf": {"@type": "WebSite", "name": "Facthem", "url": BASE_URL}},
          {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": [
              {"@type": "ListItem", "position": 1, "name": "Inicio", "item": f"{BASE_URL}/"},
              {"@type": "ListItem", "position": 2, "name": "Estadísticas"}]}]
    STATS_PATH.write_text(site_chrome.page(body=body, active="estadisticas", scripts=("js/ui.js", "js/stats.js"),
                                           title=title, description=desc, canonical=url, jsonld=ld), encoding="utf-8")
    print(f"  estadisticas.html — {'prerenderizada' if inner else 'sin prerenderizar'}")


def _html_to_text(fragment):
    """Readable Markdown-ish text from one of our own pages' HTML."""
    t = re.sub(r"<(script|style|aside|nav)[^>]*>.*?</\1>", "", fragment, flags=re.S)
    # the contact address is assembled by JS (kept from scrapers): point to the page instead
    t = re.sub(r'<a[^>]*class="footer-email"[^>]*>.*?</a>', "la dirección de contacto que aparece en https://facthem.es/aviso.html",
               t, flags=re.S)
    t = re.sub(r"<h1[^>]*>(.*?)</h1>", lambda m: f"\n# {m.group(1)}\n", t, flags=re.S)
    t = re.sub(r"<h2[^>]*>(.*?)</h2>", lambda m: f"\n## {m.group(1)}\n", t, flags=re.S)
    t = re.sub(r"<h3[^>]*>(.*?)</h3>", lambda m: f"\n### {m.group(1)}\n", t, flags=re.S)
    t = re.sub(r"<li[^>]*>", "\n- ", t)
    t = re.sub(r"<(tr)[^>]*>", "\n", t)
    t = re.sub(r"</t[dh]>", " | ", t)
    t = re.sub(r"</?(p|div|ul|ol|table|tbody|thead|section|article|figure|br)[^>]*>", "\n", t)
    t = html.unescape(re.sub(r"<[^>]+>", "", t))
    t = re.sub(r"[ \t]+", " ", t)
    t = re.sub(r"\n\s*\n\s*\n+", "\n\n", t)
    return "\n".join(l.strip() for l in t.splitlines()).strip()


def generate_llms_txt(index, n_people, stats):
    """llms.txt (a map of the site for language models, llmstxt.org) and
    llms-full.txt (the same plus the full methodology as text)."""
    total = sum(s["n"] for s in index)
    n = lambda x: f"{x:,}".replace(",", ".")
    verdicts = "\n".join(f"- **{lg}**: {site_chrome.VERDICT_WHAT[k]}" for k, _s, lg, *_ in site_chrome.VERDICTS
                          if k not in RETIRED_VERDICTS)
    recent = []
    for s in index[:15]:
        bits = ", ".join(f"{c} {site_chrome.VK[k][2].lower()}" for k, *_ in site_chrome.VERDICTS for c in [s["d"].get(k, 0)] if c)
        recent.append(f"- [{s['title']}]({BASE_URL}{session_url(s['id'])}): {s['n']} afirmaciones ({bits})")
    head = f"""# Facthem

> Facthem verifica las afirmaciones factuales que hacen los diputados y los miembros del Gobierno en el Congreso de los Diputados de España, y publica la retribución pública de cada uno. {n(total)} afirmaciones verificadas en {len(index)} sesiones; {n(n_people)} perfiles de representantes. Cada verificación enlaza a sus fuentes.

Facthem es un proyecto independiente. Las verificaciones se generan con un proceso automatizado con IA (extracción de afirmaciones de la transcripción oficial, búsqueda de fuentes y veredicto) y pueden contener errores; cada ficha muestra sus fuentes y la confianza de la verificación. Neutralidad: todos los grupos se verifican con el mismo criterio.

Veredictos:
{verdicts}

## Páginas principales

- [Sesiones]({BASE_URL}/): la última sesión verificada y el acceso a todas las anteriores.
- [Representantes]({BASE_URL}/representantes.html): los diputados y miembros del Gobierno, con sus afirmaciones verificadas y su sueldo.
- [Estadísticas]({BASE_URL}/estadisticas.html): qué partidos y diputados acumulan más afirmaciones falsas, exageradas o con matices.
- [Metodología]({BASE_URL}/metodologia.html): cómo se extraen y verifican las afirmaciones y qué significa cada veredicto.
- [Todas las afirmaciones]({BASE_URL}/archive.html): índice A–Z de todas las fichas.
- [Sitemap]({BASE_URL}/sitemap.xml)

## Sesiones recientes

{chr(10).join(recent)}

## Estructura

- Cada afirmación verificada tiene una ficha estable en `{BASE_URL}/claim/<slug>.html` con la cita, el veredicto, lo que dicen los datos, los errores, el contexto que falta y las fuentes, y datos estructurados schema.org `ClaimReview`. Cada ficha incluye una frase para citarla.
- Cada representante tiene un perfil en `{BASE_URL}/politician/<slug>.html` con su sueldo mensual y anual desglosado (fuentes oficiales del Congreso y del Gobierno) y todas sus afirmaciones.
- Cada sesión tiene una página en `{BASE_URL}/sesion/<id>.html` con todas sus afirmaciones en el orden en que se dijeron.

## Optional

- [Metodología completa en texto]({BASE_URL}/llms-full.txt)
- [Blog]({BASE_URL}/blog.html): correcciones y novedades.
- [Acerca de]({BASE_URL}/acerca.html)
- [Aviso legal]({BASE_URL}/aviso.html)
"""
    LLMS_PATH.write_text(head, encoding="utf-8")
    full = head
    for page in ("metodologia.html", "acerca.html", "aviso.html"):
        p = Path(__file__).parent / page
        if p.exists():
            src = p.read_text(encoding="utf-8")
            m = re.search(r'<article class="doc-body">(.*?)</article>', src, re.S)
            if m:
                full += f"\n\n---\n\nFuente: {BASE_URL}/{page}\n\n" + _html_to_text(m.group(1)) + "\n"
    LLMS_FULL_PATH.write_text(full, encoding="utf-8")
    print(f"  llms.txt + llms-full.txt ({len(full) // 1024} KB)")


def render_home(index, recs_by, n_people):
    """Fill index.html's markers: hero counters, rail, latest sitting, sitting index JSON."""
    if not index or not INDEX_TEMPLATE.exists():
        return
    latest = index[0]
    total = sum(s["n"] for s in index)
    stats = (f'<dl class="hero-stats"><div><dt>Afirmaciones verificadas</dt><dd data-count="{total}">{total:,}</dd></div>'
             f'<div><dt>Sesiones</dt><dd data-count="{len(index)}">{len(index)}</dd></div>'
             f'<div><dt>Representantes</dt><dd data-count="{n_people}">{n_people}</dd></div></dl>').replace(",", ".")
    data = json.dumps(index, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    parts = {
        "home-stats": stats,
        "home-rail": render_rail(index, latest["id"]),
        "home-session": render_session_block(latest, recs_by[latest["id"]]),
        "home-data": f'<script type="application/json" id="sessions-index">{data}</script>',
    }
    html_ = INDEX_TEMPLATE.read_text(encoding="utf-8")
    for name, inner in parts.items():
        html_, n = re.subn(rf"<!--#{name}-->.*?<!--/{name}-->", lambda m, i=inner, k=name: f"<!--#{k}-->{i}<!--/{k}-->",
                           html_, flags=re.S)
        if not n:
            print(f"  aviso: marcador {name} no encontrado en index.html")
    INDEX_PATH.write_text(site_chrome.refresh_static(html_), encoding="utf-8")
    print(f"  index.html — última sesión {latest['id']} ({latest['n']} afirmaciones) prerenderizada")


RETIRED_VERDICTS = {"IMPRECISO", "DESCONTEXTUALIZADO"}


def write_retired_redirects(retired):
    for slug, claim in retired:
        pol = claim.get("politician") or {}
        target = (f"/politician/{slugify_politician(format_nombre(pol['nombre_completo']), pol.get('partido') or '')}.html"
                  if pol.get("nombre_completo") else "/")
        OUT_DIR.mkdir(exist_ok=True)
        (OUT_DIR / f"{slug}.html").write_text(
            '<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8" /><title>Facthem</title>'
            f'<meta name="robots" content="noindex" /><link rel="canonical" href="{BASE_URL}{target}" />'
            f'<meta http-equiv="refresh" content="0; url={target}" /></head>'
            f'<body><script>location.replace({json.dumps(target)})</script><a href="{target}">Facthem</a></body></html>',
            encoding="utf-8")
    if retired:
        print(f"  {len(retired)} afirmaciones con veredicto retirado → redirección al perfil")


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    if USE_SQLITE:
        print(f"Modo DEBUG: leyendo SQLite local ({DEBUG_DB_PATH})")
        print("Obteniendo afirmaciones…")
        claims = fetch_all_claims_sqlite()
        print(f"  {len(claims)} afirmaciones obtenidas")
        print("Obteniendo fechas de sesión…")
        session_dates = fetch_session_dates_sqlite()
        salaries = fetch_salaries_sqlite()
        stats = fetch_dashboard_stats()
    else:
        print("Conectando a Supabase…")
        supabase = create_client(SUPABASE_URL, SUPABASE_ANON)
        print("Obteniendo afirmaciones…")
        claims = fetch_all_claims(supabase)
        print(f"  {len(claims)} afirmaciones obtenidas")
        print("Obteniendo fechas de sesión…")
        session_dates = fetch_session_dates(supabase)
        print("Obteniendo retribuciones…")
        salaries = fetch_salaries(supabase)
        print(f"  {len(salaries)} retribuciones obtenidas")
        stats = fetch_dashboard_stats(supabase)

    generate_salary_data(salaries)

    OUT_DIR.mkdir(exist_ok=True)
    for f in OUT_DIR.glob("*.html"):
        f.unlink()

    # Slug por claim (una sola vez) + índices de afirmaciones relacionadas.
    claims_with_slugs = []
    for claim in claims:
        try:
            slug = slugify(str(claim.get("texto_normalizado") or ""), claim["id"])
            claims_with_slugs.append((slug, claim))
        except Exception:
            pass
    # Retired verdicts (old taxonomy: Inexacto, Descontextualizado) are never shown:
    # no card, no count, no sitemap entry. Their pages were public, so the URL stays
    # alive as a noindex redirect to the speaker's profile (or the home page).
    retired = [(sl, c) for sl, c in claims_with_slugs
               if site_chrome.verdict_key(((c.get("verification") or [{}])[0] or {}).get("resultado")) in RETIRED_VERDICTS]
    claims_with_slugs = [x for x in claims_with_slugs if x not in retired]
    write_claim_id_shards(claims_with_slugs + retired)
    write_retired_redirects(retired)
    by_session, by_pol = build_related_indexes(claims_with_slugs)
    photo_for = make_photo_resolver(salaries)

    generated, errors = {}, []

    print("Generando páginas…")
    for slug, claim in claims_with_slugs:
        try:
            session_date = session_dates.get(claim.get("session_id"), "")
            ctx = build_claim_ctx(claim, slug, by_session, by_pol, photo_for)
            OUT_DIR.mkdir(exist_ok=True)
            (OUT_DIR / f"{slug}.html").write_text(
                render_page(claim, slug, session_date, ctx), encoding="utf-8")
            generated[slug] = session_date or TODAY
        except Exception as exc:
            errors.append((claim.get("id"), str(exc)))

    print(f"  {len(generated)} páginas escritas en claim/")
    if errors:
        print(f"  {len(errors)} error(es):")
        for cid, err in errors[:20]:
            print(f"    claim {cid}: {err}")

    print("Generando páginas de políticos…")
    POL_OUT_DIR.mkdir(exist_ok=True)
    politician_dates = generate_politician_pages(claims_with_slugs, salaries, photo_for)

    print("Generando portada y datos de sesiones…")
    index, recs_by = write_session_data(claims_with_slugs, photo_for)
    render_home(index, recs_by, n_people=len(politician_dates))
    session_dates = generate_session_pages(index, recs_by)
    generate_stats_page(stats)
    generate_llms_txt(index, len(politician_dates), stats)

    print("Actualizando sitemap…")
    update_sitemap(generated, politician_dates, session_dates)

    print("Generando página de archivo…")
    generate_archive(claims_with_slugs)

    # Hand-written pages: shared top bar/footer + content-hashed asset URLs.
    changed = site_chrome.render_static_pages()
    print(f"  chrome actualizado en: {', '.join(changed) if changed else 'ninguna página'}")

    print("Hecho.")


if __name__ == "__main__":
    main()
