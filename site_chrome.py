"""Shared markup for every page of facthem.es (redesign 2026).

One place for what all pages have in common, rendered server-side so crawlers
and LLMs see the navigation and nothing jumps when JS loads:

  head()      <head> contents: meta, OG/Twitter, favicons, fonts, CSS, GTM
  topbar()    sticky top bar + the phone menu (hidden until ☰)
  footer()    site footer
  page()      a whole document from the pieces above
  card()      the claim card, byte-for-byte the same structure js/ui.js builds
  vtag(), stack(), legend(), share()   small shared components
  render_static_pages()   refreshes the chrome and asset hashes inside the
                          hand-written pages (index.html, metodologia.html, …)

Verdicts, topics and party colours are defined here and mirrored in js/ui.js;
tools/test_parity.py checks the two agree.
"""
import hashlib
import html
import json
import re
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).parent
BASE_URL = "https://facthem.es"
DEFAULT_OG_IMAGE = f"{BASE_URL}/assets/portada_opt.png"
GTM_ID = "GTM-M6ZJVS39"


def esc(s):
    return html.escape(str(s if s is not None else ""), quote=True)


# ── Vocabulary ────────────────────────────────────────────────────────────────
# (key, short label, long label, symbol, colour token). Order = display order.
VERDICTS = [
    ("CONFIRMADO",           "Confirmado",         "Confirmado",           "✓", "var(--v-ok)"),
    ("CONFIRMADO_CON_MATIZ", "Con matiz",          "Confirmado con matiz", "≈", "var(--v-matiz)"),
    ("SOBREESTIMADO",        "Sobreestimado",      "Sobreestimado",        "↑", "var(--v-sobre)"),
    ("SUBESTIMADO",          "Subestimado",        "Subestimado",          "↓", "var(--v-sub)"),
    ("IMPRECISO",            "Inexacto",           "Inexacto",             "~", "var(--v-impreciso)"),
    ("DESCONTEXTUALIZADO",   "Descontextualizado", "Descontextualizado",   "⋯", "var(--v-descontext)"),
    ("FALSO",                "Falso",              "Falso",                "✕", "var(--v-falso)"),
    ("NO_VERIFICABLE",       "No verificable",     "No verificable",       "?", "var(--v-nv)"),
]
VK = {v[0]: v for v in VERDICTS}
HATCH = {"SUBESTIMADO"}

# Plain-language meaning, used under the verdict and in the methodology.
VERDICT_WHAT = {
    "CONFIRMADO":           "Los datos respaldan la afirmación.",
    "CONFIRMADO_CON_MATIZ": "Es esencialmente cierta, pero le falta contexto o precisión.",
    "SOBREESTIMADO":        "La cifra real es menor que la afirmada.",
    "SUBESTIMADO":          "La cifra real es mayor que la afirmada.",
    "IMPRECISO":            "La afirmación contiene datos inexactos.",
    "DESCONTEXTUALIZADO":   "El dato es real, pero sacado de su contexto cambia de sentido.",
    "FALSO":                "Los datos contradicen la afirmación.",
    "NO_VERIFICABLE":       "No hay datos públicos suficientes para comprobarla.",
}

TEMA_LABELS = {
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

PARTY_COLORS = {
    "PSOE": "#d9474f", "PP": "#3d8fd1", "VOX": "#6fb043", "SUMAR": "#d8437a",
    "EAJ-PNV": "#3f9a5c", "ERC": "#e0a63c", "BNG": "#79b6de", "Podemos": "#8a5fb8",
    "EH Bildu": "#3dae9b", "JxCAT-JUNTS": "#3fb6b0",
}


def verdict_key(resultado):
    """DB value ('CONFIRMADO CON MATIZ', 'confirmado_con_matiz', None) → VK key."""
    k = str(resultado or "").strip().upper().replace(" ", "_")
    return k if k in VK else "NO_VERIFICABLE"


def tema_label(t):
    if not t:
        return ""
    return TEMA_LABELS.get(t) or str(t).replace("_", " ").strip().capitalize()


# ── Assets ────────────────────────────────────────────────────────────────────

@lru_cache(maxsize=None)
def _hash(rel):
    p = ROOT / rel.lstrip("/")
    return hashlib.sha1(p.read_bytes()).hexdigest()[:10] if p.exists() else "0"


def asset(rel):
    """Root-relative URL with a content-hash cache buster: /css/site.css?v=ab12cd34ef."""
    rel = "/" + rel.lstrip("/")
    return f"{rel}?v={_hash(rel)}"


# ── Icons ─────────────────────────────────────────────────────────────────────
ICON_SHARE = ('<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" '
              'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
              '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>'
              '<path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>')
ICON_SEARCH = ('<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><circle cx="11" cy="11" r="7" '
               'fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" '
               'stroke-width="2" stroke-linecap="round"/></svg>')


# ── Components (mirrored in js/ui.js) ────────────────────────────────────────

def vtag(key, cls=""):
    k, short, long_, icon, color = VK[verdict_key(key)]
    c = f"vtag {cls}".strip()
    return (f'<span class="{c}" style="--c:{color}"><span class="vi" aria-hidden="true">{icon}</span>'
            f'{esc(long_)}</span>')


def share(url, text, label=""):
    """Share button + desktop menu. On touch screens ui.js opens the system sheet instead."""
    # same set encodeURIComponent leaves alone, so JS builds identical markup
    u, t = quote(url, safe="!'()*"), quote(text, safe="!'()*")
    has = " has-label" if label else ""
    return (f'<div class="share"><button type="button" class="share-btn{has}" aria-haspopup="true" '
            f'aria-expanded="false" aria-label="Compartir" data-url="{esc(url)}" data-text="{esc(text)}">'
            f'{ICON_SHARE}{label}</button>'
            f'<div class="share-pop" role="menu" hidden>'
            f'<button type="button" role="menuitem" data-copy="{esc(url)}">Copiar enlace</button>'
            f'<a role="menuitem" href="https://x.com/intent/post?text={t}&amp;url={u}" target="_blank" rel="noopener">X</a>'
            f'<a role="menuitem" href="https://wa.me/?text={t}%20{u}" target="_blank" rel="noopener">WhatsApp</a>'
            f'<a role="menuitem" href="https://t.me/share/url?url={u}&amp;text={t}" target="_blank" rel="noopener">Telegram</a>'
            f'</div></div>')


def stack(counts, cls="stack"):
    total = sum(counts.get(v[0], 0) for v in VERDICTS) or 1
    label = ", ".join(f"{v[2]}: {counts.get(v[0], 0)}" for v in VERDICTS)
    parts = "".join(
        f'<span class="{"hatch" if v[0] in HATCH else ""}" style="--c:{v[4]};flex:{counts[v[0]] / total:.4f}" '
        f'title="{esc(v[2])}: {counts[v[0]]}"></span>'
        for v in VERDICTS if counts.get(v[0]))
    return f'<div class="{cls}" role="img" aria-label="{esc(label)}">{parts}</div>'


def legend(counts):
    items = "".join(f'<li style="--c:{v[4]}"><span class="dot"></span>{esc(v[1])} <span class="num">{counts[v[0]]}</span></li>'
                    for v in VERDICTS if counts.get(v[0]))
    return f'<ul class="legend">{items}</ul>'


def card(c, *, with_who=True, index=0):
    """Claim card. `c` keys: url, text, verdict, name, party, photo, tema, geo, id.

    The whole card is a link (stretched ::after on .card-link) with the share
    button above it. Without `with_who` (profile pages) the topic line takes the
    name row's place, as in the mockup.
    """
    k = verdict_key(c.get("verdict"))
    color = VK[k][4]
    name, party = c.get("name") or "", c.get("party") or ""
    share_text = f"{name} ({party}): «{c.get('text', '')}» — verificado en Facthem" if name else \
        f"«{c.get('text', '')}» — verificado en Facthem"
    meta = esc(tema_label(c.get("tema"))) + (f" · {esc(c['geo'])}" if c.get("geo") else "")
    url = c["url"]
    abs_url = url if url.startswith("http") else BASE_URL + url
    head = (f'<article class="card in" style="--c:{color};--i:{min(index, 18)}" data-id="{esc(c.get("id", ""))}" '
            f'data-v="{k}" data-t="{esc(c.get("tema") or "")}">{vtag(k)}'
            f'<p class="claim-q"><a class="card-link" href="{esc(url)}">{esc(c.get("text", ""))}</a></p>')
    if with_who:
        photo = (f'<img class="avatar" src="{esc(c["photo"])}" alt="" loading="lazy" width="28" height="28" />'
                 if c.get("photo") else '<span class="avatar" aria-hidden="true"></span>')
        return (f'{head}<div class="who">{photo}<span class="who-name">{esc(name)}</span>'
                f'<span class="who-party">{esc(party)}</span>{share(abs_url, share_text)}</div>'
                f'<div class="card-meta">{meta}</div></article>')
    return (f'{head}<div class="who"><span class="card-meta-inline">{meta}</span>'
            f'{share(abs_url, share_text)}</div></article>')


# ── Chrome ────────────────────────────────────────────────────────────────────
NAV = [
    ("/",                    "Sesiones",       "sesiones"),
    ("/representantes.html", "Representantes", "representantes"),
    ("/estadisticas.html",   "Estadísticas",   "estadisticas"),
    ("/metodologia.html",    "Metodología",    "metodologia"),
]


def _psearch(cls):
    return (f'<div class="psearch {cls}" role="search">'
            f'<label class="psearch-box">{ICON_SEARCH}<span class="sr">Buscar representante</span>'
            f'<input type="search" class="psearch-input" placeholder="Buscar diputado o ministro" '
            f'autocomplete="off" spellcheck="false" role="combobox" aria-expanded="false" '
            f'aria-autocomplete="list" /><kbd aria-hidden="true">/</kbd></label>'
            f'<ul class="psearch-list" role="listbox" hidden></ul></div>')


def topbar(active=""):
    on = ' class="is-active" aria-current="page"'
    cur = ' aria-current="page"'
    links = "".join(f'<a href="{h}"{on if k == active else ""}>{l}</a>' for h, l, k in NAV)
    mlinks = "".join(f'<a href="{h}"{cur if k == active else ""}>{l}</a>' for h, l, k in NAV)
    live_cls = " is-active" if active == "live" else ""
    return (
        '<a class="skip" href="#main">Saltar al contenido</a>'
        '<header class="topbar" id="topbar">'
        '<a class="wordmark" href="/" aria-label="Facthem, inicio">Facthem</a>'
        f'<nav class="nav" aria-label="Principal">{links}<span class="nav-ink" aria-hidden="true"></span></nav>'
        f'<div class="topbar-right">{_psearch("psearch-top")}'
        f'<a class="live-chip{live_cls}" href="/live/" data-live hidden><span class="pulse" aria-hidden="true"></span>En directo</a>'
        '<button type="button" class="menu-btn" aria-expanded="false" aria-controls="mnav" aria-label="Menú">'
        '<span></span><span></span><span></span></button>'
        '</div></header>'
        f'<nav class="mnav" id="mnav" aria-label="Menú" hidden>{_psearch("psearch-menu")}{mlinks}'
        '<a href="/live/" class="mnav-live" data-live hidden><span class="pulse" aria-hidden="true"></span>En directo</a>'
        '</nav>')


def footer():
    return (
        '<footer class="footer"><div class="footer-inner">'
        '<div><span class="wordmark">Facthem</span><p class="muted">Las verificaciones se generan mediante un '
        'proceso automatizado con IA y pueden contener inexactitudes. Cada una enlaza a sus fuentes.</p></div>'
        '<nav aria-label="Pie">'
        '<a href="/metodologia.html">Metodología</a><a href="/archive.html">Archivo</a><a href="/blog.html">Blog</a>'
        '<a href="/acerca.html">Acerca de</a><a href="/aviso.html">Aviso legal</a></nav>'
        '<div class="footer-social">'
        '<a href="https://x.com/facthem_es" target="_blank" rel="noopener">X</a>'
        '<a href="https://www.youtube.com/@facthem_es" target="_blank" rel="noopener">YouTube</a>'
        '<a class="footer-email" href="#" data-u="contacto" data-d="facthem.es">Contacto</a>'
        '<span class="footer-support">♥ Apóyanos: '
        '<a href="https://paypal.me/hcasero" target="_blank" rel="noopener">PayPal</a> · '
        '<a href="https://ko-fi.com/hugocasero" target="_blank" rel="noopener">Ko-fi</a></span>'
        '</div></div></footer>')


# Self-hosted Inter (css/site.css @font-face). Preload the latin subset only:
# it covers Spanish; latin-ext loads on demand for rarer names.
FONTS = '<link rel="preload" href="/assets/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin />'

# Only on the real site: local previews must not send page views to Analytics.
GTM_HEAD = ("<script>if(location.hostname==='facthem.es')addEventListener('load',function(){(function(w,d,s,l,i){w[l]=w[l]||[];"
            "w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],"
            "j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;"
            f"f.parentNode.insertBefore(j,f);}})(window,document,'script','dataLayer','{GTM_ID}');}});</script>")
GTM_BODY = (f'<noscript><iframe src="https://www.googletagmanager.com/ns.html?id={GTM_ID}" height="0" width="0" '
            'style="display:none;visibility:hidden"></iframe></noscript>')


def head(*, title, description, canonical, og_type="website", og_title=None, og_description=None,
         og_image=DEFAULT_OG_IMAGE, twitter_title=None, twitter_description=None, robots=None,
         jsonld=(), extra=""):
    ld = "".join(f'<script type="application/ld+json">{json.dumps(d, ensure_ascii=False)}</script>' for d in jsonld)
    rob = f'<meta name="robots" content="{esc(robots)}" />' if robots else ""
    return (
        '<meta charset="UTF-8" />'
        '<meta name="viewport" content="width=device-width, initial-scale=1.0" />'
        f'<title>{esc(title)}</title>'
        f'<meta name="description" content="{esc(description)}" />{rob}'
        f'<link rel="canonical" href="{esc(canonical)}" />'
        f'<meta property="og:type" content="{og_type}" />'
        f'<meta property="og:url" content="{esc(canonical)}" />'
        f'<meta property="og:title" content="{esc(og_title or title)}" />'
        f'<meta property="og:description" content="{esc(og_description or description)}" />'
        f'<meta property="og:image" content="{esc(og_image)}" />'
        '<meta property="og:locale" content="es_ES" /><meta property="og:site_name" content="Facthem" />'
        '<meta name="twitter:card" content="summary_large_image" /><meta name="twitter:site" content="@facthem_ES" />'
        f'<meta name="twitter:title" content="{esc(twitter_title or og_title or title)}" />'
        f'<meta name="twitter:description" content="{esc(twitter_description or og_description or description)}" />'
        f'<meta name="twitter:image" content="{esc(og_image)}" />'
        '<link rel="icon" href="/assets/favicon.ico" sizes="any" />'
        '<link rel="icon" type="image/png" sizes="32x32" href="/assets/favicon-32x32.png" />'
        '<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" />'
        '<link rel="manifest" href="/assets/site.webmanifest" />'
        '<meta name="theme-color" content="#120c0f" />'
        f'{FONTS}<link rel="stylesheet" href="{asset("css/site.css")}" />{ld}{extra}{GTM_HEAD}')


def page(*, body, active="", body_class="", scripts=("js/ui.js",), **head_kw):
    """A full document. `scripts` are deferred, root-relative, content-hashed."""
    js = "".join(f'<script src="{asset(s)}" defer></script>' for s in scripts)
    cls = f' class="{body_class}"' if body_class else ""
    return (f'<!DOCTYPE html>\n<html lang="es">\n<head>{head(**head_kw)}</head>\n'
            f'<body{cls}>{GTM_BODY}{topbar(active)}\n{body}\n{footer()}{js}</body>\n</html>\n')


# ── Old single-page-app URLs → the pages that replaced them ──────────────────
# Runs first thing in index.html's <head> (marker <!--#redirects-->), before
# anything paints. location.replace keeps the old URL out of history, and
# search engines follow it like a redirect.
#   /?claim=<id>                     → /claim/<slug>.html  (via assets/claim-ids/<xx>.json)
#   /?politician=<slug> (any tab)    → /politician/<slug>.html
#   /?tab=parlamentarios|busqueda|representantes|parlamentaries → /representantes.html
#   /?tab=estadisticas|statistics    → /estadisticas.html
#   /?q=<text>                       → /representantes.html?q=<text>
#   /?tab=sesiones|sessions, /?session=… stay on the home page.
REDIRECT_JS = (
    "(function(){var q=new URLSearchParams(location.search),t=(q.get('tab')||'').toLowerCase(),"
    "p=q.get('politician'),c=(q.get('claim')||'').trim().toLowerCase(),s=q.get('q'),h=location.hash,"
    "go=function(u){location.replace(u)},e=encodeURIComponent;"
    "if(c){var d=document.documentElement;d.style.visibility='hidden';"
    "var stay=function(){q.delete('claim');d.style.visibility='';"
    "history.replaceState(null,'',location.pathname+(q.toString()?'?'+q:'')+h)};"
    "fetch('/assets/claim-ids/'+e(c.slice(0,2))+'.json').then(function(r){return r.ok?r.json():{}})"
    ".then(function(m){m[c]?go('/claim/'+m[c]+'.html'+h):stay()}).catch(stay);return}"
    "if(p)return go('/politician/'+e(p)+'.html');"
    "if(/^(parlamentari[oe]s|busqueda|representantes)$/.test(t))return go('/representantes.html'+(s?'?q='+e(s):''));"
    "if(/^(estadisticas|statistics)$/.test(t))return go('/estadisticas.html');"
    "if(s)return go('/representantes.html?q='+e(s));"
    "})();")


# ── Hand-written pages: refresh chrome + asset hashes in place ───────────────
# Markers in the HTML:  <!--#topbar active="sesiones"--> … <!--/topbar-->
#                       <!--#footer--> … <!--/footer-->
# and any  href|src="/css|js|assets/…?v=…"  gets its hash refreshed.
STATIC_PAGES = ["index.html", "metodologia.html", "acerca.html", "aviso.html", "blog.html",
                "representantes.html", "estadisticas.html", "404.html"]

_TOP = re.compile(r'<!--#topbar(?: active="([a-z]*)")?-->.*?<!--/topbar-->', re.S)
_FOOT = re.compile(r'<!--#footer-->.*?<!--/footer-->', re.S)
_REDIR = re.compile(r'<!--#redirects-->.*?<!--/redirects-->', re.S)
_ASSET = re.compile(r'((?:href|src)=")(/(?:css|js|assets)/[^"?#]+)\?v=[^"]*(")')


def refresh_static(text):
    def top(m):
        act = m.group(1) or ""
        return f'<!--#topbar active="{act}"-->{topbar(act)}<!--/topbar-->'
    text = _TOP.sub(top, text)
    text = _FOOT.sub(lambda m: f"<!--#footer-->{footer()}<!--/footer-->", text)
    text = _REDIR.sub(lambda m: f"<!--#redirects--><script>{REDIRECT_JS}</script><!--/redirects-->", text)
    return _ASSET.sub(lambda m: f"{m.group(1)}{asset(m.group(2))}{m.group(3)}", text)


def render_static_pages(root=ROOT):
    changed = []
    for name in STATIC_PAGES:
        p = Path(root) / name
        if not p.exists():
            continue
        old = p.read_text(encoding="utf-8")
        new = refresh_static(old)
        if new != old:
            p.write_text(new, encoding="utf-8")
            changed.append(name)
    return changed


if __name__ == "__main__":
    print("refreshed:", render_static_pages() or "nothing")
