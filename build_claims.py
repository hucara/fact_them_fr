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
import urllib.parse
from datetime import date
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


# ── ClaimReview schema.org ────────────────────────────────────────────────────

def build_claim_review_schema(claim, slug, pol_name, session_date):
    v = claim.get("verification") or []
    v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
    resultado_key = normalize_resultado_key(v.get("resultado"))
    rating_val, rating_name = CLAIM_REVIEW_RATINGS.get(resultado_key, (3, "Unverifiable"))

    schema = {
        "@context": "https://schema.org",
        "@type": "ClaimReview",
        "url": f"{BASE_URL}/claim/{slug}.html",
        "claimReviewed": str(claim.get("texto_normalizado") or "").strip(),
        "datePublished": session_date or TODAY,
        "author": {
            "@type": "Organization",
            "name": "Facthem",
            "url": BASE_URL,
            "sameAs": ["https://twitter.com/facthem_ES"],
        },
        "reviewRating": {
            "@type": "Rating",
            "ratingValue": rating_val,
            "bestRating": 5,
            "worstRating": 1,
            "alternateName": rating_name,
        },
    }
    if pol_name:
        schema["itemReviewed"] = {
            "@type": "Claim",
            "author": {"@type": "Person", "name": pol_name},
        }
    return json.dumps(schema, ensure_ascii=False, indent=2)


# ── Page renderer ─────────────────────────────────────────────────────────────

def render_page(claim, slug, session_date):
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

    # ── Meta ──
    title = (f"{pol_nombre} — {resultado_label} | Facthem"
             if pol_nombre else f"{resultado_label} | Facthem")
    desc_text = str(claim.get("texto_normalizado") or "").strip()
    desc      = (desc_text[:157] + "…") if len(desc_text) > 160 else desc_text
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
    pol_page_url = f"{BASE_URL}/?tab=parlamentarios&amp;politician={pol_slug}" if pol_slug else None

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

    <div id="modal-content">

      <header class="claim-header" style="margin-bottom:1.25rem">
        <div class="claim-meta-top">
          {pol_html}
        </div>
        <span class="resultado-badge resultado-{resultado_class}">{esc(resultado_label)}</span>
      </header>

      <blockquote class="claim-text modal-claim-text" title="{esc(texto_orig)}">
        {esc(texto_norm)}
      </blockquote>

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


# ── Supabase fetch ────────────────────────────────────────────────────────────

SELECT_FIELDS = """
  id, session_id, texto_normalizado, texto_original,
  ambito_geografico, ambito_tematico,
  politician:politician_id (nombre_completo, partido, grupo_parlamentario),
  verification (resultado, confidence_score, omisiones, errores, fuentes)
"""


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
               p.nombre_completo AS pol_nombre, p.partido AS pol_partido,
               p.grupo_parlamentario AS pol_grupo,
               v.resultado, v.confidence_score, v.omisiones, v.errores, v.fuentes
        FROM claim c
        LEFT JOIN politician p ON p.id = c.politician_id
        LEFT JOIN verification v ON v.claim_id = c.id
    """).fetchall()
    con.close()
    claims = []
    for r in rows:
        pol = None
        if r["pol_nombre"]:
            pol = {"nombre_completo": r["pol_nombre"],
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
            "verification": ver,
        })
    return claims


def fetch_session_dates_sqlite():
    con = _sqlite_conn()
    rows = con.execute("SELECT id, fecha FROM session").fetchall()
    con.close()
    return {r["id"]: (r["fecha"] or "")[:10] for r in rows}


def fetch_all_claims(supabase):
    """Paginate through all claims. Keep going until an empty batch."""
    total = supabase.from_("claim").select("id", count="exact", head=True).execute().count
    print(f"  DB reporta {total} afirmaciones en la tabla claim")
    all_claims, page_size, offset = [], 1000, 0
    while True:
        resp = (
            supabase.from_("claim")
            .select(SELECT_FIELDS)
            .order("id")
            .range(offset, offset + page_size - 1)
            .execute()
        )
        batch = resp.data or []
        all_claims.extend(batch)
        if not batch:
            break
        offset += len(batch)
    return all_claims


def fetch_session_dates(supabase):
    """Returns {session_id: fecha_iso_string}."""
    resp = supabase.from_("session").select("id, fecha").execute()
    return {s["id"]: (s["fecha"] or "")[:10] for s in (resp.data or [])}


# ── Sitemap ───────────────────────────────────────────────────────────────────

STATIC_URLS = [
    ("https://facthem.es/",                  "2026-03-11T00:00:00+00:00", "weekly",  "1.0"),
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


def update_sitemap(slug_dates, politician_slugs):
    parts = [
        '<?xml version="1.0" encoding="UTF-8"?>\n',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n',
    ]
    for loc, lastmod, changefreq, priority in STATIC_URLS:
        parts.append(
            f"  <url>\n    <loc>{_loc(loc)}</loc>\n    <lastmod>{_iso(lastmod)}</lastmod>\n"
            f"    <changefreq>{changefreq}</changefreq>\n    <priority>{priority}</priority>\n  </url>\n"
        )
    for slug in sorted(politician_slugs):
        url = f"{BASE_URL}/politician/{slug}.html"
        parts.append(
            f"  <url>\n    <loc>{_loc(url)}</loc>\n    <lastmod>{_iso(TODAY)}</lastmod>\n"
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
    print(f"  sitemap.xml actualizado — {len(politician_slugs)} políticos, {len(slug_dates)} afirmaciones")


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

def generate_politician_pages(claims_with_slugs):
    """One static page per politician listing all their claims."""
    # Group by nombre_completo first, then derive slug from best available partido
    by_nombre = {}
    for claim_slug, claim in claims_with_slugs:
        pol = claim.get("politician") or {}
        nombre_completo = pol.get("nombre_completo", "")
        if not nombre_completo:
            continue
        entry = by_nombre.setdefault(nombre_completo, {
            "nombre":  format_nombre(nombre_completo),
            "partido": pol.get("partido", ""),
            "grupo":   pol.get("grupo_parlamentario", ""),
            "claims":  [],
        })
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
        by_pol[pol_slug] = info

    POL_OUT_DIR.mkdir(exist_ok=True)
    for f in POL_OUT_DIR.glob("*.html"):
        f.unlink()

    for pol_slug, info in by_pol.items():
        _write_politician_page(pol_slug, info)

    print(f"  politician/ generado — {len(by_pol)} páginas")
    return list(by_pol.keys())


def _verdict_counts(claims):
    counts = {}
    for _, claim in claims:
        v = claim.get("verification") or []
        v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
        r = normalize_resultado_key(v.get("resultado") or "NO VERIFICABLE")
        counts[r] = counts.get(r, 0) + 1
    return counts


def _write_politician_page(pol_slug, info):
    nombre  = info["nombre"]
    partido = info["partido"]
    grupo   = info["grupo"]
    claims  = info["claims"]
    pol_url = f"{BASE_URL}/politician/{pol_slug}.html"

    title = f"{nombre} — Afirmaciones verificadas | Facthem"
    desc  = f"Todas las afirmaciones de {nombre} verificadas por Facthem."
    if partido:
        desc = f"Afirmaciones de {nombre} ({partido}) verificadas por Facthem."

    # ── Stats bar ──
    counts = _verdict_counts(claims)
    total  = len(claims)
    stats_items = []
    for resultado, label in RESULTADO_LABELS.items():
        n = counts.get(resultado, 0)
        if n:
            cls = RESULTADO_TO_CLASS.get(resultado, "nv")
            stats_items.append(
                f'<span class="resultado-badge resultado-{cls}" style="font-size:.7rem">'
                f'{esc(label)}: {n}</span>'
            )
    stats_html = (
        f'<div style="display:flex;flex-wrap:wrap;gap:.4rem;margin-bottom:1.5rem">'
        f'{"".join(stats_items)}</div>'
        if stats_items else ""
    )

    # ── Claim list ──
    rows = []
    for claim_slug, claim in claims:
        v = claim.get("verification") or []
        v = v[0] if isinstance(v, list) and v else (v if isinstance(v, dict) else {})
        resultado    = normalize_resultado_key(v.get("resultado"))
        res_class    = RESULTADO_TO_CLASS.get(resultado, "nv")
        res_label    = RESULTADO_LABELS.get(resultado, resultado.lower().replace("_", " ").capitalize())
        texto        = esc(capitalize(str(claim.get("texto_normalizado") or "").strip())[:160])
        claim_url    = f"{BASE_URL}/claim/{claim_slug}.html"
        rows.append(
            f'  <article class="claim-card" data-resultado="{res_class}" style="margin-bottom:.75rem">\n'
            f'    <header class="claim-header">\n'
            f'      <span class="resultado-badge resultado-{res_class}">{esc(res_label)}</span>\n'
            f'    </header>\n'
            f'    <blockquote class="claim-text" style="margin:.5rem 0 .75rem">\n'
            f'      <a href="{claim_url}" style="color:inherit;text-decoration:none">{texto}</a>\n'
            f'    </blockquote>\n'
            f'  </article>'
        )
    claims_html = "\n".join(rows)

    # ── Subtitle ──
    subtitle_parts = []
    if partido:
        subtitle_parts.append(esc(partido))
    if grupo and grupo != partido:
        subtitle_parts.append(esc(grupo))
    subtitle_html = (
        f'<p style="font-size:.82rem;color:var(--c-text-muted);margin:.25rem 0 2rem">'
        f'{"&nbsp;·&nbsp;".join(subtitle_parts)}</p>'
        if subtitle_parts else '<div style="margin-bottom:2rem"></div>'
    )

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
  <meta property="og:image"       content="{BASE_URL}/assets/portada_opt.png" />
  <meta property="og:locale"      content="es_ES" />
  <meta property="og:site_name"   content="Facthem" />
  <meta name="twitter:card"        content="summary_large_image" />
  <meta name="twitter:site"        content="@facthem_ES" />
  <meta name="twitter:title"       content="{esc(title)}" />
  <meta name="twitter:description" content="{esc(desc)}" />
  <meta name="twitter:image"       content="{BASE_URL}/assets/portada_opt.png" />
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
  <style>
    .pol-page {{
      max-width: 760px;
      margin: 0 auto;
      width: 100%;
      padding: 3rem 1.25rem 5rem;
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
    .pol-total {{
      font-size: .72rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: .1em;
      color: var(--c-text-muted);
      margin-bottom: 1.25rem;
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
    <h1>{esc(nombre)}</h1>
    {subtitle_html}
    <p class="pol-total">{total} afirmaci{"ón" if total == 1 else "ones"} verificadas</p>
    {stats_html}
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
    else:
        print("Conectando a Supabase…")
        supabase = create_client(SUPABASE_URL, SUPABASE_ANON)
        print("Obteniendo afirmaciones…")
        claims = fetch_all_claims(supabase)
        print(f"  {len(claims)} afirmaciones obtenidas")
        print("Obteniendo fechas de sesión…")
        session_dates = fetch_session_dates(supabase)

    OUT_DIR.mkdir(exist_ok=True)
    for f in OUT_DIR.glob("*.html"):
        f.unlink()

    generated, errors = {}, []

    print("Generando páginas…")
    for claim in claims:
        try:
            slug         = slugify(str(claim.get("texto_normalizado") or ""), claim["id"])
            session_date = session_dates.get(claim.get("session_id"), "")
            OUT_DIR.mkdir(exist_ok=True)
            (OUT_DIR / f"{slug}.html").write_text(
                render_page(claim, slug, session_date), encoding="utf-8"
            )
            generated[slug] = session_date or TODAY
        except Exception as exc:
            errors.append((claim.get("id"), str(exc)))

    print(f"  {len(generated)} páginas escritas en claim/")
    if errors:
        print(f"  {len(errors)} error(es):")
        for cid, err in errors[:20]:
            print(f"    claim {cid}: {err}")

    claims_with_slugs = []
    for claim in claims:
        try:
            slug = slugify(str(claim.get("texto_normalizado") or ""), claim["id"])
            claims_with_slugs.append((slug, claim))
        except Exception:
            pass

    print("Generando páginas de políticos…")
    POL_OUT_DIR.mkdir(exist_ok=True)
    politician_slugs = generate_politician_pages(claims_with_slugs)

    print("Actualizando sitemap…")
    update_sitemap(generated, politician_slugs)

    print("Generando página de archivo…")
    generate_archive(claims_with_slugs)

    print("Hecho.")


if __name__ == "__main__":
    main()
