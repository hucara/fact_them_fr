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

RESULTADO_EMOJIS = {
    "CONFIRMADO":            "✅",
    "CONFIRMADO CON MATIZ":  "⚠️",
    "FALSO":                 "❌",
    "DESCONTEXTUALIZADO":    "🟠",
    "IMPRECISO":             "🔸",
    "NO VERIFICABLE":        "❓",
    "SOBREESTIMADO":         "🟠",
    "SUBESTIMADO":           "🟠",
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


def render_errores(raw):
    if not is_valid(raw):
        return ""
    try:
        parsed = json.loads(raw)
        items = [str(i) for i in (parsed if isinstance(parsed, list) else [parsed]) if i]
    except (json.JSONDecodeError, TypeError):
        items = [raw.strip()] if raw and raw.strip() else []
    if not items:
        return ""
    inner = "<br><br>".join(f"<em>{esc(capitalize(i))}</em>" for i in items)
    return (
        f'<div class="detail-row detail-errores">\n'
        f'    <dt>Error detectado</dt>\n'
        f'    <dd>{inner}</dd>\n'
        f'  </div>'
    )


def render_omisiones(raw):
    if not is_valid(raw):
        return ""
    try:
        items = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        items = to_list_items(raw)
    if not isinstance(items, list) or not items:
        return ""
    lis = "".join(f"<li>{esc(capitalize(str(i)))}</li>" for i in items)
    return (
        f'<div class="detail-row">\n'
        f'    <dt>Omisiones</dt>\n'
        f'    <dd><ul class="detail-list omisiones">{lis}</ul></dd>\n'
        f'  </div>'
    )


def render_fuentes(raw):
    if not is_valid(raw):
        return ""
    try:
        items = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        plain = to_list_items(raw)
        if not plain:
            return ""
        lis = "".join(f"<li>{esc(i)}</li>" for i in plain)
        return (
            f'<div class="detail-row">\n'
            f'    <dt>Fuentes</dt>\n'
            f'    <dd><ul class="detail-list fuentes">{lis}</ul></dd>\n'
            f'  </div>'
        )
    if not isinstance(items, list) or not items:
        return ""

    sorted_items = sorted(items, key=lambda s: FUENTE_TIPO_ORDER.get(s.get("tipo", ""), 9))

    bullets = []
    for s in sorted_items:
        tipo       = s.get("tipo", "")
        is_primary = tipo in ("Primaria", "Primary")
        tipo_label = FUENTE_TIPO_LABELS.get(tipo, tipo or "")
        tipo_key   = re.sub(r"[^a-z]", "", tipo_label.lower()) or "other"
        name       = esc(s.get("nombre") or "Fuente")
        url        = s.get("url", "")
        link       = (f'<a class="source-link" href="{esc(url)}" target="_blank" rel="noopener">{name}</a>'
                      if url else f"<span>{name}</span>")
        tipo_badge = (f'<span class="source-tipo source-tipo--{tipo_key}">{esc(tipo_label)}</span>'
                      if tipo_label else "")
        dato       = s.get("dato_especifico", "")
        dato_html  = f'<span class="source-dato">{esc(dato)}</span>' if dato else ""
        css_class  = "fuente-item fuente-item--primary" if is_primary else "fuente-item"
        bullets.append(f'<li class="{css_class}">{tipo_badge}{link}{dato_html}</li>')

    lis = "".join(bullets)
    return (
        f'<div class="detail-row">\n'
        f'    <dt>Fuentes</dt>\n'
        f'    <dd><ul class="detail-list fuentes">{lis}</ul></dd>\n'
        f'  </div>'
    )


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
    """Lista de omisiones (mismo parseo que render_omisiones)."""
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
            "logo": {"@type": "ImageObject", "url": f"{BASE_URL}/assets/logo.svg"},
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
        leg, tipo, num = sess.get("legislatura"), sess.get("tipo"), sess.get("numero")
        if leg and tipo and num:
            appearance = {
                "@type": "CreativeWork",
                "name": (
                    f"Diario de Sesiones del Congreso de los Diputados — "
                    f"{sess.get('organo') or 'Pleno'} núm. {num}"
                ),
                "url": f"https://www.congreso.es/public_oficiales/L{leg}/CONG/DS/{tipo}/DSCD-{leg}-{tipo}-{num}.PDF",
            }
            if session_date:
                appearance["datePublished"] = str(session_date)[:10]
            item["appearance"] = appearance
        schema["itemReviewed"] = item

    return json.dumps(schema, ensure_ascii=False, indent=2)


# ── Page renderer ─────────────────────────────────────────────────────────────

def render_page(claim, slug, session_date, related_session=None, related_pol=None):
    v = claim.get("verification") or []
    v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
    pol = claim.get("politician") or {}

    resultado_class = resultado_to_class(v.get("resultado"))
    resultado_label = format_resultado(v.get("resultado"))
    score_raw       = v.get("confidence_score")
    score           = round(float(score_raw) * 100) if score_raw is not None else None

    pol_nombre       = format_nombre(pol.get("nombre_completo", ""))
    pol_partido      = pol.get("partido", "")
    pol_grupo        = pol.get("grupo_parlamentario", "")
    is_gobierno      = pol_grupo == "Cargo de Gobierno"

    texto_norm = capitalize(str(claim.get("texto_normalizado") or "").strip())
    texto_orig = str(claim.get("texto_original") or "").strip()

    # ── Meta (forma de cita, sin veredicto: preserva el clic) ──
    desc_text = str(claim.get("texto_normalizado") or "").strip()
    who = (f"{pol_nombre} ({pol_partido})" if pol_nombre and pol_partido
           else pol_nombre)
    quote_title = _truncate_words(desc_text, 60).rstrip(" .")
    quote_desc  = _truncate_words(desc_text, 130).rstrip(" .")
    title = (f"{who}: «{quote_title}» | Facthem" if who
             else f"«{quote_title}» | Facthem")
    desc  = (f"{who}: «{quote_desc}». Lo verificamos en Facthem." if who
             else f"«{quote_desc}». Lo verificamos en Facthem.")
    canon_url = f"{BASE_URL}/claim/{slug}.html"
    schema_ld = build_claim_review_schema(claim, slug, pol_nombre, session_date)

    # ── Back URL ──
    session_id = claim.get("session_id", "")
    back_url   = f"{BASE_URL}/?session={session_id}" if session_id else f"{BASE_URL}/"

    # ── Share text ──
    resultado_key  = normalize_resultado_key(v.get("resultado"))
    verdict_emoji  = RESULTADO_EMOJIS.get(resultado_key, "🔍")
    nombre_share   = pol_nombre or "Un político"
    partido_share  = f" ({pol_partido})" if pol_partido else ""
    texto_share    = desc_text[:200] + ("…" if len(desc_text) > 200 else "")
    share_text     = (
        f'🔍 {nombre_share}{partido_share} afirmó: "{texto_share}"\n'
        f'{verdict_emoji} {resultado_label} | facthem.es'
    )

    # ── Share URLs ──
    enc_url     = urllib.parse.quote(canon_url)
    enc_text    = urllib.parse.quote(share_text)
    enc_wa      = urllib.parse.quote(f"{share_text}\n{canon_url}")
    url_twitter = f"https://twitter.com/intent/tweet?text={enc_text}&url={enc_url}&via=facthem_ES"
    url_wa      = f"https://wa.me/?text={enc_wa}"
    url_tg      = f"https://t.me/share/url?url={enc_url}&text={enc_text}"

    # ── Politician line ──
    pol_slug     = slugify_politician(pol.get("nombre_completo", ""), pol_partido) if pol_nombre else None
    pol_page_url = f"{BASE_URL}/politician/{pol_slug}.html" if pol_slug else None

    if pol_nombre:
        name_inner = (
            f'<a href="{pol_page_url}" class="politician-link">{esc(pol_nombre)}</a>'
            if pol_page_url else esc(pol_nombre)
        )
        if is_gobierno:
            pol_html = (
                f'<span class="politician-name" style="font-size:1.05rem">'
                f'{name_inner}'
                f'<span class="politician-gobierno" title="Gobierno de España">🏛️</span>'
                f'</span>'
            )
        elif pol_partido:
            pol_html = (
                f'<span class="politician-name" style="font-size:1.05rem">'
                f'{name_inner}'
                f'<span class="politician-partido">· {esc(pol_partido)}</span>'
                f'</span>'
            )
        else:
            pol_html = (
                f'<span class="politician-name" style="font-size:1.05rem">'
                f'{name_inner}</span>'
            )
    else:
        pol_html = '<span class="politician-name unknown">Político desconocido</span>'

    # ── Tags ──
    tag_parts = []
    tematico = claim.get("ambito_tematico", "")
    geo      = claim.get("ambito_geografico", "")
    if tematico:
        label = TEMATICO_LABELS.get(tematico, snake_to_label(tematico))
        tag_parts.append(f'<span class="tag tag-tematico">{esc(label)}</span>')
    if geo:
        tag_parts.append(f'<span class="tag tag-geo">{esc(snake_to_label(geo))}</span>')
    tags_html = (
        f'<div class="claim-tags" style="margin-bottom:1.25rem">{"".join(tag_parts)}</div>'
        if tag_parts else ""
    )

    # ── Confidence bar ──
    confidence_html = ""
    if score is not None:
        confidence_html = (
            f'<div class="confidence-bar" style="margin-bottom:1rem" '
            f'title="Confianza del modelo: {score}%">\n'
            f'      <div class="confidence-track">\n'
            f'        <div class="confidence-fill confidence-{resultado_class}" '
            f'style="width:{score}%"></div>\n'
            f'      </div>\n'
            f'      <span class="confidence-label">{score}% confianza</span>\n'
            f'    </div>'
        )

    # ── Detail list ──
    detail_parts = [
        render_errores(v.get("errores")),
        render_omisiones(v.get("omisiones")),
        render_fuentes(v.get("fuentes")),
    ]
    detail_inner = "\n  ".join(p for p in detail_parts if p)
    details_html = f'<dl class="modal-detail-list">\n  {detail_inner}\n</dl>' if detail_inner else ""

    # ── Fecha de sesión (inline junto al nombre) ──
    sess_iso   = str(session_date or "")[:10]
    sess_short = _date_short_es(sess_iso)
    session_time_html = (
        f'<time class="claim-session-date" datetime="{sess_iso}">{sess_short}</time>'
        if sess_short else ""
    )

    # ── Miga de pan (visible + BreadcrumbList JSON-LD) ──
    crumbs = [{"@type": "ListItem", "position": 1, "name": "Inicio", "item": f"{BASE_URL}/"}]
    crumb_parts = [f'<a href="{BASE_URL}/">Inicio</a>']
    if pol_nombre and pol_page_url:
        crumbs.append({"@type": "ListItem", "position": 2, "name": pol_nombre, "item": pol_page_url})
        crumb_parts.append(f'<a class="crumb-pol" href="{pol_page_url}">{esc(pol_nombre)}</a>')
    crumbs.append({
        "@type": "ListItem",
        "position": len(crumbs) + 1,
        "name": f"«{_truncate_words(desc_text, 60)}»",
    })
    crumb_parts.append(f'<span class="current">«{esc(_truncate_words(texto_norm, 48))}»</span>')
    breadcrumb_ld = json.dumps(
        {"@context": "https://schema.org", "@type": "BreadcrumbList", "itemListElement": crumbs},
        ensure_ascii=False, indent=2,
    )
    sep = '\n      <span class="sep">›</span>\n      '
    breadcrumb_html = (
        '<nav class="cp-breadcrumb" aria-label="Miga de pan">\n      '
        + sep.join(crumb_parts)
        + "\n    </nav>"
    )

    # ── Bloques de afirmaciones relacionadas ──
    def _rel_block(header_html, items):
        if not items:
            return ""
        lis = "".join(
            f'<li><a class="rel-claim" href="{esc(it["url"])}">«{esc(it["text"])}»'
            f'<span class="rel-meta">{esc(it["meta"])}</span></a></li>'
            for it in items
        )
        return f"<h2>{header_html}</h2>\n    <ul>{lis}</ul>"

    sess_obj = claim.get("session") or {}
    sess_label = (sess_obj.get("organo") or "Pleno")
    if sess_obj.get("numero"):
        sess_label += f" núm. {sess_obj['numero']}"
    if sess_iso:
        sess_label += f", {_format_session_date_es(sess_iso)}"
    session_header = (
        f'Más de la misma sesión — <a href="{esc(back_url)}">{esc(sess_label)}</a>'
        if claim.get("session_id") else "Más de la misma sesión"
    )
    pol_header = (
        f'Más de <a href="{pol_page_url}">{esc(pol_nombre)}</a>'
        if pol_nombre and pol_page_url else "Más del mismo diputado"
    )
    rel_blocks = [
        _rel_block(session_header, related_session or []),
        _rel_block(pol_header, related_pol or []),
    ]
    rel_blocks = [b for b in rel_blocks if b]
    related_html = (
        '<aside class="cp-related">\n    ' + "\n\n    ".join(rel_blocks) + "\n  </aside>"
        if rel_blocks else ""
    )

    return f"""\
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{esc(title)}</title>
  <meta name="description" content="{esc(desc)}" />
  <link rel="canonical" href="{esc(canon_url)}" />

  <!-- Open Graph -->
  <meta property="og:type"        content="article" />
  <meta property="og:url"         content="{esc(canon_url)}" />
  <meta property="og:title"       content="{esc(title)}" />
  <meta property="og:description" content="{esc(desc)}" />
  <meta property="og:image"       content="{BASE_URL}/assets/portada_opt.png" />
  <meta property="og:locale"      content="es_ES" />
  <meta property="og:site_name"   content="Facthem" />

  <!-- Twitter / X -->
  <meta name="twitter:card"        content="summary_large_image" />
  <meta name="twitter:site"        content="@facthem_ES" />
  <meta name="twitter:title"       content="{esc(title)}" />
  <meta name="twitter:description" content="{esc(desc)}" />
  <meta name="twitter:image"       content="{BASE_URL}/assets/portada_opt.png" />

  <!-- Favicon -->
  <link rel="icon" href="../assets/favicon.ico" sizes="any" />
  <link rel="icon" type="image/png" sizes="32x32" href="../assets/favicon-32x32.png" />
  <link rel="icon" type="image/png" sizes="16x16" href="../assets/favicon-16x16.png" />
  <link rel="apple-touch-icon" href="../assets/apple-touch-icon.png" />
  <meta name="theme-color" content="#0f0f0f" />

  <!-- ClaimReview structured data -->
  <script type="application/ld+json">
{schema_ld}
  </script>

  <!-- BreadcrumbList structured data -->
  <script type="application/ld+json">
{breadcrumb_ld}
  </script>

  <!-- Fonts -->
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

  <!-- Site styles -->
  <link rel="stylesheet" href="../css/style.css" />

  <style>
    body {{
      display: flex;
      flex-direction: column;
      align-items: center;
      min-height: 100vh;
      padding: 2.5rem 1.25rem 4rem;
    }}

    /* ── Card: same as #modal-card but standalone ── */
    #modal-card {{
      max-height: none;
      animation: none;
    }}
    #modal-content {{
      padding-top: 2.5rem;
    }}

    /* ── Back button — sits where ✕ was ── */
    .cp-back {{
      position: absolute;
      top: 1rem;
      right: 1rem;
      background: rgba(255,255,255,.06);
      border: 1px solid var(--c-border);
      border-radius: var(--radius-xs);
      color: var(--c-text-muted);
      font-size: .78rem;
      font-weight: 600;
      font-family: inherit;
      padding: .35rem .65rem;
      text-decoration: none;
      cursor: pointer;
      transition: background .12s, color .12s;
      display: inline-flex;
      align-items: center;
      gap: .3rem;
    }}
    .cp-back:hover {{
      background: rgba(255,255,255,.12);
      color: var(--c-text);
    }}

    /* ── Subtle brand footer ── */
    .cp-brand {{
      margin-top: 1.5rem;
      font-size: .65rem;
      font-weight: 700;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: var(--c-text-muted);
      opacity: .35;
    }}

    /* ── Breadcrumb: en la franja del botón Volver ── */
    .cp-breadcrumb {{
      position: absolute;
      top: 1.35rem;
      left: 1.75rem;
      right: 7rem;
      font-size: .72rem;
      color: var(--c-text-muted);
      display: flex;
      gap: .35rem;
      align-items: center;
      white-space: nowrap;
      overflow: hidden;
    }}
    .cp-breadcrumb a {{
      color: var(--c-text-muted);
      text-decoration: none;
      border-bottom: 1px solid transparent;
      flex-shrink: 0;
    }}
    .cp-breadcrumb a:hover {{ color: var(--c-accent); border-color: var(--c-accent); }}
    .cp-breadcrumb a.crumb-pol {{
      flex-shrink: 1;
      min-width: 6ch;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }}
    .cp-breadcrumb .sep {{ opacity: .5; flex-shrink: 0; }}
    .cp-breadcrumb .current {{
      overflow: hidden;
      text-overflow: ellipsis;
      opacity: .7;
    }}
    @media (max-width: 560px) {{
      .cp-breadcrumb .current, .cp-breadcrumb .sep:last-of-type {{ display: none; }}
    }}

    /* ── Fecha de sesión: discreta, inline con el nombre ── */
    .claim-session-date {{
      font-size: .78rem;
      font-weight: 400;
      color: var(--c-text-muted);
      white-space: nowrap;
    }}
    .claim-session-date::before {{ content: "· "; opacity: .6; }}

    /* ── Afirmaciones relacionadas ── */
    .cp-related {{
      max-width: 640px;
      width: 100%;
    }}
    .cp-related h2 {{
      font-size: .78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .12em;
      color: var(--c-text-muted);
      margin: 1.75rem 0 .75rem;
    }}
    .cp-related h2 a {{ color: inherit; text-decoration: none; border-bottom: 1px solid transparent; }}
    .cp-related h2 a:hover {{ color: var(--c-accent); border-color: var(--c-accent); }}
    .cp-related ul {{ list-style: none; margin: 0; padding: 0; }}
    .cp-related li {{ border-bottom: 1px solid var(--c-border); }}
    .cp-related li:last-child {{ border-bottom: none; }}
    .cp-related a.rel-claim {{
      display: block;
      padding: .6rem .25rem;
      font-size: .88rem;
      line-height: 1.5;
      color: var(--c-text);
      text-decoration: none;
      transition: color .12s;
    }}
    .cp-related a.rel-claim:hover {{ color: var(--c-accent); }}
    .cp-related .rel-meta {{
      display: block;
      font-size: .7rem;
      color: var(--c-text-muted);
      margin-top: .15rem;
    }}
  </style>
</head>
<body>

  <!-- GTM noscript -->
  <noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-M6ZJVS39"
  height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>

  <div id="modal-card" data-resultado="{resultado_class}">

    <!-- Back button where ✕ used to be -->
    <a class="cp-back" href="{back_url}" id="cp-back-btn">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="15 18 9 12 15 6"/>
      </svg>
      Volver
    </a>

    {breadcrumb_html}

    <div id="modal-content">

      <header class="claim-header" style="margin-bottom:1.25rem">
        <div class="claim-meta-top">
          {pol_html}{session_time_html}
        </div>
        <span class="resultado-badge resultado-{resultado_class}">{esc(resultado_label)}</span>
      </header>

      <h1 class="claim-text modal-claim-text" title="{esc(texto_orig)}">
        {esc(texto_norm)}
      </h1>

      {confidence_html}

      {tags_html}

      {details_html}

      <!-- Share -->
      <div class="modal-share">
        <div class="share-wrapper">
          <button class="share-btn share-btn--labeled" id="cp-share-btn" aria-label="Compartir afirmación">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
            Compartir
          </button>
          <div class="share-menu" id="cp-share-menu" hidden>
            <a class="share-option" href="{url_wa}" target="_blank" rel="noopener">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347zM12 0C5.373 0 0 5.373 0 12c0 2.127.557 4.123 1.532 5.856L0 24l6.335-1.652A11.954 11.954 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/></svg>
              WhatsApp
            </a>
            <a class="share-option" href="{url_twitter}" target="_blank" rel="noopener">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              X / Twitter
            </a>
            <a class="share-option" href="https://www.facebook.com/sharer/sharer.php?u={enc_url}" target="_blank" rel="noopener">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
              Facebook
            </a>
            <a class="share-option" href="{url_tg}" target="_blank" rel="noopener">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
              Telegram
            </a>
            <button class="share-option share-copy-btn" id="cp-copy" data-url="{esc(canon_url)}">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              <span>Copiar enlace</span>
            </button>
          </div>
        </div>
      </div>

    </div>
  </div>

  {related_html}

  <p class="cp-brand">
    <a href="{BASE_URL}/" style="color:inherit;text-decoration:none">facthem.es</a>
    &nbsp;·&nbsp;
    <a href="{BASE_URL}/metodologia.html" style="color:inherit;text-decoration:none">Metodología</a>
    &nbsp;·&nbsp;
    <a href="{BASE_URL}/acerca.html" style="color:inherit;text-decoration:none">Acerca de</a>
    &nbsp;·&nbsp;
    <a href="{BASE_URL}/aviso.html" style="color:inherit;text-decoration:none">Aviso legal</a>
    &nbsp;·&nbsp;
    <a href="{BASE_URL}/archive.html" style="color:inherit;text-decoration:none">Todas las afirmaciones</a>
  </p>

  <script>
    // Share dropdown toggle
    document.getElementById('cp-share-btn').addEventListener('click', function (e) {{
      e.stopPropagation();
      var menu = document.getElementById('cp-share-menu');
      menu.hidden = !menu.hidden;
    }});
    document.addEventListener('click', function () {{
      document.getElementById('cp-share-menu').hidden = true;
    }});

    // Copy link
    document.getElementById('cp-copy').addEventListener('click', function () {{
      navigator.clipboard.writeText(this.dataset.url).then(() => {{
        this.querySelector('span').textContent = '¡Copiado!';
        setTimeout(() => {{ this.querySelector('span').textContent = 'Copiar enlace'; }}, 2000);
      }});
    }});

    (function () {{
      try {{
        var ref = document.referrer;
        if (ref && new URL(ref).origin === location.origin) {{
          document.getElementById('cp-back-btn').addEventListener('click', function (e) {{
            e.preventDefault();
            history.back();
          }});
        }}
      }} catch (e) {{}}
    }})();
  </script>

</body>
</html>
"""


# ── Related claims (internal linking) ─────────────────────────────────────────

RELATED_PER_BLOCK = 4


def _related_text(claim):
    return _truncate_words(
        capitalize(str(claim.get("texto_normalizado") or "").strip()), 90
    )


def build_related_indexes(claims_with_slugs):
    """{session_id: [(slug, claim)]}, {pol_id: [(slug, claim)]} — deterministas."""
    by_session, by_pol = {}, {}
    for slug, claim in claims_with_slugs:
        sid = claim.get("session_id")
        pid = (claim.get("politician") or {}).get("id")
        if sid:
            by_session.setdefault(sid, []).append((slug, claim))
        if pid:
            by_pol.setdefault(pid, []).append((slug, claim))
    # misma sesión: orden estable por slug
    for lst in by_session.values():
        lst.sort(key=lambda t: t[0])
    # mismo diputado: más reciente primero, desempate por slug
    for lst in by_pol.values():
        lst.sort(key=lambda t: ((t[1].get("session") or {}).get("fecha") or "", t[0]),
                 reverse=True)
    return by_session, by_pol


def build_related_blocks(claim, slug, by_session, by_pol):
    cid     = claim.get("id")
    sess_id = claim.get("session_id")
    pol_id  = (claim.get("politician") or {}).get("id")

    seen = {slug}
    session_items = []
    for sib_slug, sib in by_session.get(sess_id, []):
        if sib_slug in seen or sib.get("id") == cid:
            continue
        sib_pol = sib.get("politician") or {}
        who     = format_nombre(sib_pol.get("nombre_completo", "")) or "Político desconocido"
        partido = sib_pol.get("partido", "")
        session_items.append({
            "url":  f"{BASE_URL}/claim/{sib_slug}.html",
            "text": _related_text(sib),
            "meta": f"{who} · {partido}" if partido else who,
        })
        seen.add(sib_slug)
        if len(session_items) >= RELATED_PER_BLOCK:
            break

    pol_items = []
    for sib_slug, sib in by_pol.get(pol_id, []):
        if sib_slug in seen or sib.get("id") == cid:
            continue
        d = _format_session_date_es(((sib.get("session") or {}).get("fecha") or "")[:10])
        pol_items.append({
            "url":  f"{BASE_URL}/claim/{sib_slug}.html",
            "text": _related_text(sib),
            "meta": d,
        })
        seen.add(sib_slug)
        if len(pol_items) >= RELATED_PER_BLOCK:
            break

    return session_items, pol_items


# ── Supabase fetch ────────────────────────────────────────────────────────────

CLAIM_FIELDS = (
    "id, session_id, politician_id, texto_normalizado, texto_original, "
    "ambito_geografico, ambito_tematico"
)
POLITICIAN_FIELDS = "id, nombre_completo, partido, grupo_parlamentario"
SESSION_FIELDS = "id, fecha, organo, legislatura, tipo, numero"
VERIFICATION_FIELDS = "claim_id, resultado, confidence_score, omisiones, errores, fuentes"

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
               v.resultado, v.confidence_score, v.omisiones, v.errores, v.fuentes,
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
            k: v.get(k) for k in ("resultado", "confidence_score", "omisiones", "errores", "fuentes")
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


# ── Archive page ──────────────────────────────────────────────────────────────

ARCHIVE_PATH = Path(__file__).parent / "archive.html"


def generate_archive(claims_data):
    """
    Plain-HTML page listing every claim grouped by politician.
    noindex, follow — pure link graph for crawlers.
    """
    by_pol = {}
    for slug, claim in claims_data:
        pol = claim.get("politician") or {}
        name = format_nombre(pol.get("nombre_completo", "")) or "Político desconocido"
        by_pol.setdefault(name, []).append((slug, claim))

    rows = []
    for name in sorted(by_pol):
        sample_pol = by_pol[name][0][1].get("politician") or {}
        pol_slug = slugify_politician(sample_pol.get("nombre_completo", name), sample_pol.get("partido", ""))
        pol_url  = f"{BASE_URL}/politician/{pol_slug}.html"
        rows.append(f'  <h2><a href="{pol_url}" style="color:inherit;text-decoration:none">{esc(name)}</a></h2>\n  <ul>')
        for slug, claim in by_pol[name]:
            text = esc(str(claim.get("texto_normalizado") or slug).strip()[:120])
            url  = f"{BASE_URL}/claim/{slug}.html"
            rows.append(f'    <li><a href="{url}">{text}</a></li>')
        rows.append("  </ul>")

    body = "\n".join(rows)
    page = f"""<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Todas las afirmaciones — Facthem</title>
  <meta name="robots" content="noindex, follow" />
  <link rel="canonical" href="{BASE_URL}/archive.html" />
  <link rel="stylesheet" href="css/style.css" />
  <style>
    .archive-page {{
      flex: 1;
      max-width: 900px;
      margin: 0 auto;
      width: 100%;
      padding: 3rem 1.75rem 5rem;
    }}
    .archive-page h1 {{
      font-size: 1.4rem;
      font-weight: 900;
      letter-spacing: -.03em;
      background: linear-gradient(135deg, #f0b8c4 0%, #c8607a 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 2rem;
    }}
    .archive-page h2 {{
      font-size: .78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .12em;
      color: var(--c-text-muted);
      margin: 2rem 0 .5rem;
    }}
    .archive-page ul {{
      margin: 0 0 .5rem;
      padding-left: 1.2rem;
    }}
    .archive-page li {{
      margin: .3rem 0;
      font-size: .88rem;
      line-height: 1.5;
    }}
    .archive-page a {{
      color: var(--c-accent);
      text-decoration: none;
      border-bottom: 1px solid rgba(160,120,0,.3);
    }}
    .archive-page a:hover {{ border-color: var(--c-accent); }}
  </style>
</head>
<body>
  <header class="site-header">
    <nav class="tabs">
      <a href="{BASE_URL}/" class="tab-button" style="text-decoration:none">← Volver</a>
    </nav>
  </header>
  <div class="archive-page">
    <h1>Todas las afirmaciones</h1>
{body}
  </div>
</body>
</html>
"""
    ARCHIVE_PATH.write_text(page, encoding="utf-8")
    print(f"  archive.html generado — {sum(len(v) for v in by_pol.values())} afirmaciones, {len(by_pol)} políticos")


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

    generated, errors = {}, []

    print("Generando páginas…")
    for slug, claim in claims_with_slugs:
        try:
            session_date = session_dates.get(claim.get("session_id"), "")
            rel_session, rel_pol = build_related_blocks(claim, slug, by_session, by_pol)
            OUT_DIR.mkdir(exist_ok=True)
            (OUT_DIR / f"{slug}.html").write_text(
                render_page(claim, slug, session_date,
                            related_session=rel_session, related_pol=rel_pol),
                encoding="utf-8",
            )
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

    print("Hecho.")


if __name__ == "__main__":
    main()
