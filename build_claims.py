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

RESULTADO_LABELS = {
    "CONFIRMADO":            "Confirmado",
    "CONFIRMADO CON MATIZ":  "Confirmado con matiz",
    "DESCONTEXTUALIZADO":    "Descontextualizado",
    "FALSO":                 "Falso",
    "IMPRECISO":             "Inexacto",
    "NO VERIFICABLE":        "No verificable",
    "SOBREESTIMADO":         "Sobreestimado",
    "SUBESTIMADO":           "Subestimado",
}

RESULTADO_TO_CLASS = {
    "CONFIRMADO":            "verdadero",
    "CONFIRMADO CON MATIZ":  "parcial",
    "DESCONTEXTUALIZADO":    "enganoso",
    "IMPRECISO":             "nv",
    "FALSO":                 "falso",
    "NO VERIFICABLE":        "nv",
    "SOBREESTIMADO":         "enganoso",
    "SUBESTIMADO":           "enganoso",
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


def resultado_to_class(resultado):
    if not resultado:
        return "nv"
    return RESULTADO_TO_CLASS.get(normalize_resultado_key(resultado), "nv")


def format_resultado(resultado):
    if not resultado:
        return "No verificado"
    return RESULTADO_LABELS.get(normalize_resultado_key(resultado), snake_to_label(resultado))


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
    return f"/?session={urllib.parse.quote(str(session_id))}" if session_id else "/"


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
    share_text = (f"{pol_nombre} ({pol_partido}): «{desc_text}» — verificado en Facthem" if pol_nombre
                  else f"«{desc_text}» — verificado en Facthem")
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
<div class="c-main">{''.join(secs)}</div>
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
    "id, session_id, politician_id, texto_normalizado, texto_original, "
    "ambito_geografico, ambito_tematico"
)
POLITICIAN_FIELDS = "id, nombre_completo, partido, grupo_parlamentario"
SESSION_FIELDS = "id, fecha, organo, legislatura, tipo, numero"
VERIFICATION_FIELDS = "claim_id, resultado, confidence_score, afirmacion_correcta, omisiones, errores, fuentes"

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
               c.ambito_geografico, c.ambito_tematico,
               p.id AS pol_id,
               p.nombre_completo AS pol_nombre, p.partido AS pol_partido,
               p.grupo_parlamentario AS pol_grupo,
               v.resultado, v.confidence_score, v.afirmacion_correcta,
               v.omisiones, v.errores, v.fuentes,
               s.fecha AS session_fecha, s.organo AS session_organo,
               s.legislatura AS session_legislatura, s.tipo AS session_tipo,
               s.numero AS session_numero
        FROM claim c
        LEFT JOIN politician p ON p.id = c.politician_id
        LEFT JOIN session s ON s.id = c.session_id
        LEFT JOIN verification v ON v.claim_id = c.id
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
                    "omisiones": r["omisiones"],
                    "errores": r["errores"],
                    "fuentes": r["fuentes"]}]
        claims.append({
            "id": r["id"], "session_id": r["session_id"],
            "texto_normalizado": r["texto_normalizado"],
            "texto_original": r["texto_original"],
            "ambito_geografico": r["ambito_geografico"],
            "ambito_tematico": r["ambito_tematico"],
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
                                  "omisiones", "errores", "fuentes")
        })

    raw_claims = _paginate_table(supabase, "claim", CLAIM_FIELDS, "afirmaciones", page_size=500)

    claims = []
    for c in raw_claims:
        claims.append({
            "id": c["id"],
            "session_id": c.get("session_id"),
            "texto_normalizado": c.get("texto_normalizado"),
            "texto_original": c.get("texto_original"),
            "ambito_geografico": c.get("ambito_geografico"),
            "ambito_tematico": c.get("ambito_tematico"),
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
    ("https://facthem.es/?tab=parlamentarios", "2026-05-21T00:00:00+00:00", "weekly",  "0.8"),
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


def update_sitemap(slug_dates, politician_dates):
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>\n',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n',
    ]
    for loc, lastmod, changefreq, priority in STATIC_URLS:
        parts.append(
            f"  <url>\n    <loc>{_loc(loc)}</loc>\n    <lastmod>{_iso(lastmod)}</lastmod>\n"
            f"    <changefreq>{changefreq}</changefreq>\n    <priority>{priority}</priority>\n  </url>\n"
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


ARCHIVE_STYLE_ES = """
    .archive-page {
      flex: 1;
      max-width: 900px;
      margin: 0 auto;
      width: 100%;
      padding: 3rem 1.75rem 5rem;
    }
    .archive-page h1 {
      font-size: 1.4rem;
      font-weight: 900;
      letter-spacing: -.03em;
      background: linear-gradient(135deg, #f0b8c4 0%, #c8607a 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: .5rem;
    }
    .archive-caption {
      font-size: .82rem;
      color: var(--c-text-muted);
      margin: 0 0 1.5rem;
    }
    .archive-page h2 {
      font-size: .78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .12em;
      color: var(--c-text-muted);
      margin: 2rem 0 .5rem;
    }
    .archive-page ul {
      margin: 0 0 .5rem;
      padding-left: 1.2rem;
    }
    .archive-page li {
      margin: .3rem 0;
      font-size: .88rem;
      line-height: 1.5;
    }
    .archive-page a {
      color: var(--c-accent);
      text-decoration: none;
      border-bottom: 1px solid rgba(160,120,0,.3);
    }
    .archive-page a:hover { border-color: var(--c-accent); }
    .archive-nav {
      display: flex;
      flex-wrap: wrap;
      gap: .3rem;
      margin: 0 0 2rem;
    }
    .archive-nav + h2 { margin-top: 0; }
    .archive-page .archive-letter {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 2rem;
      height: 2rem;
      padding: 0 .35rem;
      border: 1px solid var(--c-border);
      border-radius: var(--radius-xs);
      font-size: .82rem;
      font-weight: 700;
      color: var(--c-accent);
      text-decoration: none;
    }
    .archive-page .archive-letter:hover {
      border-color: var(--c-accent);
      background: rgba(255,255,255,.05);
    }
    .archive-page .archive-letter--current {
      background: rgba(255,255,255,.12);
      border-color: var(--c-accent);
      color: var(--c-text);
    }
    .archive-page .archive-letter--empty {
      color: var(--c-text-muted);
      opacity: .3;
      border-color: transparent;
    }
"""


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
            rows.append(f'  <h2><a href="{pol_url}" style="color:inherit;text-decoration:none">{esc(name)}</a></h2>\n  <ul>')
            for slug, claim in by_pol[name]:
                text = esc(str(claim.get("texto_normalizado") or slug).strip()[:120])
                url  = f"{BASE_URL}/claim/{slug}.html"
                rows.append(f'    <li><a href="{url}">{text}</a></li>')
            rows.append("  </ul>")
        return "\n".join(rows)

    def _page(letter):
        nav   = _archive_nav(file_for, letter)
        body  = _letter_body(letter)
        canon = f"{BASE_URL}/{file_for[letter]}"
        n_pol = len(buckets[letter])
        pol_word = "representante" if n_pol == 1 else "representantes"
        return f"""<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Todas las afirmaciones — {esc(letter)} | Facthem</title>
  <meta name="robots" content="noindex, follow" />
  <link rel="canonical" href="{esc(canon)}" />
  <link rel="stylesheet" href="css/style.css" />
  <style>{ARCHIVE_STYLE_ES}  </style>
</head>
<body>
  <header class="site-header">
    <nav class="tabs">
      <a href="{BASE_URL}/" class="tab-button" style="text-decoration:none">← Volver</a>
    </nav>
  </header>
  <div class="archive-page">
    <h1>Todas las afirmaciones</h1>
    <p class="archive-caption">Representantes cuya inicial es «{esc(letter)}» · {n_pol} {pol_word}</p>
    {nav}
{body}
    {nav}
  </div>
</body>
</html>
"""

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

def generate_politician_pages(claims_with_slugs, salaries=None):
    """One static page per politician listing all their claims."""
    salaries = salaries or {}
    salary_by_name = {
        row.get("nombre_completo"): row
        for row in salaries.values()
        if row.get("nombre_completo")
    }
    # Group by nombre_completo first, then derive slug from best available partido
    by_nombre = {}
    for claim_slug, claim in claims_with_slugs:
        if not claim.get("verification"):
            continue
        pol = claim.get("politician") or {}
        nombre_completo = pol.get("nombre_completo", "")
        if not nombre_completo:
            continue
        entry = by_nombre.setdefault(nombre_completo, {
            "pol_id":  pol.get("id"),
            "nombre":  format_nombre(nombre_completo),
            "partido": pol.get("partido", ""),
            "grupo":   pol.get("grupo_parlamentario", ""),
            "claims":  [],
        })
        if not entry["pol_id"] and pol.get("id"):
            entry["pol_id"] = pol["id"]
        # Keep the first non-empty partido we see
        if not entry["partido"] and pol.get("partido"):
            entry["partido"] = pol["partido"]
        if not entry["grupo"] and pol.get("grupo_parlamentario"):
            entry["grupo"] = pol["grupo_parlamentario"]
        entry["claims"].append((claim_slug, claim))

    # Re-key by slug now that partido is stable
    by_pol = {}
    for nombre_completo, info in by_nombre.items():
        pol_slug = slugify_politician(nombre_completo, info["partido"])
        salary = salaries.get(info["pol_id"]) if info.get("pol_id") else None
        if not salary:
            salary = salary_by_name.get(nombre_completo)
        info["salary"] = salary
        by_pol[pol_slug] = info

    POL_OUT_DIR.mkdir(exist_ok=True)
    for f in POL_OUT_DIR.glob("*.html"):
        f.unlink()

    slug_dates = {}
    for pol_slug, info in by_pol.items():
        _write_politician_page(pol_slug, info)
        # lastmod = fecha de sesión más reciente entre sus claims (determinista,
        # evita marcar la página como modificada en cada build con TODAY)
        fechas = [
            (claim.get("session") or {}).get("fecha", "")[:10]
            for _, claim in info["claims"]
            if (claim.get("session") or {}).get("fecha")
        ]
        slug_dates[pol_slug] = max(fechas) if fechas else TODAY

    print(f"  politician/ generado — {len(by_pol)} páginas")
    return slug_dates


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


def render_politician_panel(salary, nombre, partido, grupo, claim_count, falsos=0, pct_falsos=0):
    """Returns (panel_html, json_ld_dict_or_None, photo_url)."""
    photo = _salary_photo_src(salary) if salary else ""
    photo_src = f"..{photo}" if photo.startswith("/assets/") else photo
    province = _salary_value(salary, ["province", "provincia", "district", "circunscripcion"]) if salary else None

    base_raw       = float(_salary_value(salary, ["base_monthly_eur", "base_mensual_eur", "base_monthly"]) or 0)
    indemnity_raw  = float(_salary_value(salary, ["indemnizacion_monthly_eur", "indemnity_monthly_eur", "indemnizacion_mensual_eur"]) or 0)
    complements_raw= float(_salary_value(salary, ["complements_monthly_eur", "complement_monthly_eur", "complementos_mensuales_eur"]) or 0)
    base        = _format_eur(base_raw) if base_raw else None
    indemnity   = _format_eur(indemnity_raw) if indemnity_raw else None
    complements = _format_eur(complements_raw) if complements_raw else None
    monthly = _format_eur(_salary_value(salary, ["total_monthly_eur", "monthly_total_eur", "salary_monthly_total_eur", "monthly_with_indemnity_eur"]))
    annual  = _format_eur(_salary_value(salary, ["total_annual_eur", "annual_total_eur", "salary_annual_total_eur"]), compact=True)

    source_url = _salary_value(salary, ["source_url", "profile_url", "congress_url"])
    bd = _salary_breakdown(salary) or {}
    role = (bd.get("complements") or {}).get("commission", {}).get("role") or ""
    gov_role_raw = _salary_value(salary, ["government_role"])
    gov_role_label = GOVERNMENT_ROLE_LABELS.get(gov_role_raw, snake_to_label(gov_role_raw)) if gov_role_raw else ""
    province_meta = "" if str(province or "").casefold() == str(grupo or "").casefold() else province

    if not salary:
        return "", "", ""

    stats = "".join(filter(None, [
        f'<div class="politician-panel-stat politician-panel-stat--primary"><span>Sueldo mensual total</span><strong>{monthly}</strong></div>' if monthly else "",
        f'<div class="politician-panel-stat politician-panel-stat--annual"><span>Salario anual</span><strong>{annual}</strong></div>' if annual else "",
        f'<div class="politician-panel-stat"><span>Salario base mensual</span><strong>{base}</strong></div>' if base else "",
        f'<div class="politician-panel-stat"><span>Indemnización</span><strong>{indemnity}</strong></div>' if indemnity else "",
        f'<div class="politician-panel-stat"><span>Complementos</span><strong>{complements}</strong></div>' if complements else "",
    ]))

    meta_items = []
    seen_meta = set()
    for label, class_name in [
        (partido, ""),
        (province_meta, ""),
        (grupo, ""),
        (gov_role_label, "politician-panel-meta-gov"),
    ]:
        label = str(label or "").strip()
        key = label.casefold()
        if not label or key in seen_meta:
            continue
        seen_meta.add(key)
        class_attr = f' class="{class_name}"' if class_name else ""
        meta_items.append(f"<span{class_attr}>{esc(label)}</span>")
    meta = "".join(meta_items)

    count_badge = f"""
          <div class="search-count-badge politician-panel-count-badge">
            <span><strong>{claim_count}</strong> afirmaci{'ón' if claim_count == 1 else 'ones'}</span>
            <span class="badge-sep">·</span>
            <span><strong>{falsos}</strong> falsa{'' if falsos == 1 else 's'}</span>
            <span class="badge-sep">·</span>
            <span><strong>{pct_falsos}%</strong> falsas</span>
          </div>"""
    photo_html = (
        f'<img class="politician-panel-photo" src="{esc(photo_src)}" alt="{esc(nombre)}" '
        'loading="lazy" '
        'onerror="this.closest(\'.politician-panel\')?.classList.add(\'politician-panel--no-photo\');this.remove()">'
        if photo else ""
    )

    source_link = (
        f' · <a class="politician-panel-source-link" href="{esc(source_url)}" '
        f'target="_blank" rel="noopener">fuente oficial</a>'
        if is_valid(source_url) else ""
    )
    public_caption = (
        f'<p class="politician-panel-source">Retribuciones públicas oficiales{source_link}</p>'
        if stats else ""
    )

    panel = f"""
    <section class="politician-panel{'' if photo else ' politician-panel--no-photo'}" aria-label="Resumen del representante y salario público">
      {photo_html}
      <div class="politician-panel-body">
        <div class="politician-panel-header">
          <div>
            <h1>{esc(nombre)}</h1>
            {f'<div class="politician-panel-meta">{meta}</div>' if meta else ''}
          </div>
{count_badge}
        </div>
        {f'<div class="politician-panel-stats">{stats}</div>' if stats else '<p class="politician-panel-empty">Sin datos salariales disponibles.</p>'}
        {public_caption}
        {f'<p class="politician-panel-role">{esc(role)}</p>' if role else ''}
      </div>
    </section>"""

    return panel, photo, source_url or ""


def _verdict_counts(claims):
    counts = {}
    for _, claim in claims:
        v = claim.get("verification") or []
        v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
        r = normalize_resultado_key(v.get("resultado") or "NO VERIFICABLE")
        counts[r] = counts.get(r, 0) + 1
    return counts


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


def _render_politician_claim_card(claim_slug, claim):
    v = claim.get("verification") or []
    v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
    pol = claim.get("politician") or {}

    resultado_class = resultado_to_class(v.get("resultado") if v else None)
    resultado_label = format_resultado(v.get("resultado") if v else None)
    score_raw = v.get("confidence_score") if v else None
    try:
        score = round(float(score_raw) * 100) if score_raw is not None else None
    except (TypeError, ValueError):
        score = None

    tags = "".join(filter(None, [
        f'<span class="tag tag-tematico">{esc(TEMATICO_LABELS.get(claim.get("ambito_tematico"), snake_to_label(claim.get("ambito_tematico"))))}</span>'
        if claim.get("ambito_tematico") else "",
        f'<span class="tag tag-geo">{esc(snake_to_label(claim.get("ambito_geografico")))}</span>'
        if claim.get("ambito_geografico") else "",
    ]))

    if pol:
        partido_html = (
            f'<span class="politician-partido">· {esc(pol.get("partido"))}</span>'
            if pol.get("partido") else ""
        )
        pol_html = (
            f'<span class="politician-name">{esc(format_nombre(pol.get("nombre_completo")))}'
            f'{partido_html}</span>'
        )
    else:
        pol_html = '<span class="politician-name unknown">Político desconocido</span>'
    confidence_html = (
        f"""
        <div class="confidence-bar" title="Confianza del modelo: {score}%">
          <div class="confidence-track">
            <div class="confidence-fill confidence-{resultado_class}" style="width:{score}%"></div>
          </div>
          <span class="confidence-label">{score}% confianza</span>
        </div>"""
        if score is not None else ""
    )
    claim_url = f"../claim/{claim_slug}.html"
    return f"""
    <article class="claim-card" data-resultado="{resultado_class}"{(' data-gobierno' if pol.get('grupo_parlamentario') == 'Cargo de Gobierno' else '')}>
      <header class="claim-header">
        <div class="claim-meta-top">
          {pol_html}
        </div>
        <span class="resultado-badge resultado-{resultado_class}">{esc(resultado_label)}</span>
      </header>

      <blockquote class="claim-text" title="{esc(claim.get('texto_original'))}">
        {esc(capitalize(claim.get('texto_normalizado')))}
      </blockquote>

      {confidence_html}

      {f'<div class="claim-tags">{tags}</div>' if tags else ''}

      <div class="claim-actions">
        {f'<a class="claim-toggle" href="{claim_url}">Ver más →</a>' if v else ''}
        <div class="share-wrapper">
          <button class="share-btn" data-claim-id="{esc(claim.get('id'))}" aria-label="Compartir afirmación">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
          </button>
          <div class="share-menu" hidden></div>
        </div>
      </div>
    </article>"""


def _render_politician_claim_groups(claims):
    grouped = {}
    for claim_slug, claim in claims:
        session = claim.get("session") or {}
        key = session.get("id") or claim.get("session_id") or "unknown"
        if key not in grouped:
            grouped[key] = {"session": session, "claims": []}
        grouped[key]["claims"].append((claim_slug, claim))

    # Sesiones de más reciente a más antigua (por fecha de sesión).
    ordered = sorted(
        grouped,
        key=lambda k: (grouped[k]["session"] or {}).get("fecha") or "",
        reverse=True,
    )

    groups = []
    for key in ordered:
        group = grouped[key]
        session = group["session"] or {}
        fecha = _format_session_date_es(session.get("fecha"))
        organ = f' · {esc(session.get("organo"))}' if session.get("organo") else ""
        cards = "".join(_render_politician_claim_card(slug, claim) for slug, claim in group["claims"])
        groups.append(f"""<section class="search-session-group">
      <h3 class="search-session-header">
        <span class="search-session-date">{esc(fecha)}</span>
        <span class="search-session-organ">{organ}</span>
      </h3>
      <div class="search-claims-grid">{cards}</div>
    </section>""")
    return "".join(groups)


def _write_politician_page(pol_slug, info):
    nombre  = info["nombre"]
    partido = info["partido"]
    grupo   = info["grupo"]
    claims  = info["claims"]
    salary  = info.get("salary")
    pol_url = f"{BASE_URL}/politician/{pol_slug}.html"

    counts = _verdict_counts(claims)
    total  = len(claims)
    falsos = counts.get("FALSO", 0)
    pct_falsos = round((falsos / total) * 100) if total else 0

    title = f"{nombre} — salario y afirmaciones verificadas | Facthem"
    desc_who = f"{nombre} ({partido})" if partido else nombre
    desc = _salary_seo_description(salary, desc_who, total, grupo)
    if total and falsos:
        desc += f" {falsos} falsa{'s' if falsos != 1 else ''}."

    panel_html, photo_url, congress_url = render_politician_panel(
        salary, nombre, partido, grupo, total, falsos, pct_falsos
    )

    person_ld = {
        "@type": "Person",
        "@id": f"{pol_url}#person",
        "name": nombre,
        "url": pol_url,
        "jobTitle": "Diputado/a",
        "description": desc,
    }
    if partido:
        person_ld["affiliation"] = {"@type": "Organization", "name": partido}
    if photo_url:
        person_ld["image"] = photo_url if photo_url.startswith("http") else f"{BASE_URL}{photo_url}"
    if congress_url:
        person_ld["sameAs"] = [congress_url]
    graph = [
        {
            "@type": "WebPage",
            "@id": f"{pol_url}#webpage",
            "url": pol_url,
            "name": title,
            "description": desc,
            "isPartOf": {"@type": "WebSite", "name": "Facthem", "url": BASE_URL},
            "about": {"@id": f"{pol_url}#person"},
        },
        person_ld,
    ]
    person_ld_json = json.dumps({"@context": "https://schema.org", "@graph": graph}, ensure_ascii=False)

    if photo_url:
        og_image = photo_url if photo_url.startswith("http") else f"{BASE_URL}{photo_url}"
    else:
        og_image = f"{BASE_URL}/assets/portada_opt.png"
    og_image = esc(og_image)

    claims_html = _render_politician_claim_groups(claims)

    page = f"""<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(desc)}" />
  <link rel="canonical" href="{esc(pol_url)}" />
  <meta property="og:type"        content="website" />
  <meta property="og:url"         content="{esc(pol_url)}" />
  <meta property="og:title"       content="{esc(title)}" />
  <meta property="og:description" content="{esc(desc)}" />
  <meta property="og:image"       content="{og_image}" />
  <meta property="og:locale"      content="es_ES" />
  <meta property="og:site_name"   content="Facthem" />
  <meta name="twitter:card"        content="summary_large_image" />
  <meta name="twitter:site"        content="@facthem_ES" />
  <meta name="twitter:title"       content="{esc(title)}" />
  <meta name="twitter:description" content="{esc(desc)}" />
  <meta name="twitter:image"       content="{og_image}" />
  <link rel="icon" href="../assets/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="../assets/favicon-32x32.png" />
  <link rel="apple-touch-icon" href="../assets/apple-touch-icon.png" />
  <meta name="theme-color" content="#0f0f0f" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preload"
        href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap"
        as="style" onload="this.onload=null;this.rel='stylesheet'" />
  <noscript>
    <link rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" />
  </noscript>
  <!-- Google Tag Manager -->
  <script>(function(w,d,s,l,i){{w[l]=w[l]||[];w[l].push({{'gtm.start':new Date().getTime(),event:'gtm.js'}});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);}})(window,document,'script','dataLayer','GTM-M6ZJVS39');</script>
  <link rel="stylesheet" href="../css/style.css" />
  <script type="application/ld+json">{person_ld_json}</script>
  <style>
    .pol-page {{
      max-width: 1200px;
      margin: 0 auto;
      width: 100%;
      padding: 2rem 1.75rem 5rem;
    }}
    .pol-page h1 {{
      font-size: 1.5rem;
      font-weight: 900;
      letter-spacing: -.03em;
      background: linear-gradient(135deg, #f0b8c4 0%, #c8607a 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: .15rem;
    }}
  </style>
</head>
<body>
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-M6ZJVS39"
  height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>

  <header class="site-header">
    <nav class="tabs">
      <a href="{BASE_URL}/" class="tab-button" style="text-decoration:none">← Volver</a>
    </nav>
  </header>

  <div class="pol-page">
    {panel_html}
{claims_html}
  </div>

  <footer class="site-footer">
    <p class="footer-links">
      <a href="{BASE_URL}/aviso.html" class="footer-link">Aviso legal</a>
      &nbsp;·&nbsp;
      <a href="{BASE_URL}/metodologia.html" class="footer-link">Metodología</a>
      &nbsp;·&nbsp;
      <a href="{BASE_URL}/acerca.html" class="footer-link">Acerca de</a>
      &nbsp;·&nbsp;
      <a href="{BASE_URL}/blog.html" class="footer-link">Blog</a>
      &nbsp;·&nbsp;
      <a href="{BASE_URL}/archive.html" class="footer-link">Archivo</a>
    </p>
    <p class="footer-links footer-links--secondary">
      <a href="https://www.youtube.com/@facthem_es" class="footer-link" target="_blank" rel="noopener">YouTube</a>
      &nbsp;·&nbsp;
      ♥ Apóyanos:
      <a href="https://paypal.me/hcasero" class="donate-btn" target="_blank" rel="noopener">PayPal</a>
      <a href="https://ko-fi.com/hugocasero" class="donate-btn" target="_blank" rel="noopener">Ko-fi</a>
    </p>
  </footer>
</body>
</html>
"""
    (POL_OUT_DIR / f"{pol_slug}.html").write_text(page, encoding="utf-8")


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
    politician_dates = generate_politician_pages(claims_with_slugs, salaries)

    print("Actualizando sitemap…")
    update_sitemap(generated, politician_dates)

    print("Generando página de archivo…")
    generate_archive(claims_with_slugs)

    # Hand-written pages: shared top bar/footer + content-hashed asset URLs.
    changed = site_chrome.render_static_pages()
    print(f"  chrome actualizado en: {', '.join(changed) if changed else 'ninguna página'}")

    print("Hecho.")


if __name__ == "__main__":
    main()
