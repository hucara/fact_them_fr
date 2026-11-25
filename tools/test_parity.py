#!/usr/bin/env python3
"""JS ↔ Python parity: js/ui.js must produce the same slugs and the same card
markup as build_claims.py / site_chrome.py, or links built in the browser
would point at pages that don't exist.

  python tools/test_parity.py            # uses the cached fixture if present
  python tools/test_parity.py --refresh  # re-fetch claims + salaries from Supabase

Checks every claim slug, every politician slug (claim authors + salary roster)
and the card HTML for a few hundred real claims plus hand-made edge cases.
Needs `node`. Exit 1 on any mismatch.
"""
import json
import os
import random
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FIXTURE = ROOT / ".baseline" / "parity_fixture.json"
sys.path.insert(0, str(ROOT))


def supabase_env():
    """Public anon key from js/config.js; force Supabase even if .env points at SQLite."""
    import re
    cfg = (ROOT / "js" / "config.js").read_text()
    os.environ.setdefault("SUPABASE_URL", re.search(r"SUPABASE_URL\s*=\s*'([^']+)'", cfg).group(1))
    os.environ.setdefault("SUPABASE_ANON", re.search(r"SUPABASE_ANON\s*=\s*'([^']+)'", cfg).group(1))
    os.environ["DEBUG_DB_PATH"] = os.environ.get("DEBUG_DB_PATH") or "/nonexistent"


def fetch_fixture():
    supabase_env()
    import build_claims as bc
    from supabase import create_client
    sb = create_client(os.environ["SUPABASE_URL"], os.environ["SUPABASE_ANON"])
    claims = bc.fetch_all_claims(sb)
    salaries = bc.fetch_salaries(sb)
    keep = []
    for c in claims:
        pol = c.get("politician") or {}
        v = (c.get("verification") or [{}])[0] or {}
        keep.append({"id": c["id"], "text": c.get("texto_normalizado"), "tema": c.get("ambito_tematico"),
                     "geo": c.get("ambito_geografico"), "verdict": v.get("resultado"),
                     "pol": pol.get("nombre_completo"), "partido": pol.get("partido")})
    pols = sorted({(r.get("nombre_completo") or "", r.get("partido") or "") for r in salaries.values()}
                  | {(c["pol"] or "", c["partido"] or "") for c in keep if c["pol"]})
    FIXTURE.parent.mkdir(exist_ok=True)
    FIXTURE.write_text(json.dumps({"claims": keep, "politicians": pols}, ensure_ascii=False))
    print(f"fixture: {len(keep)} claims, {len(pols)} politicians → {FIXTURE}")


EDGE = [
    {"id": "aaaa-1", "text": "", "tema": None, "geo": None, "verdict": None},
    {"id": "bbbb-2", "text": "  «Comillas» y 'apóstrofes' & <etiquetas> — ¿100%?  ", "tema": "housing", "geo": "Galicia", "verdict": "falso"},
    {"id": "cccc-3", "text": "Über Ärzte Öl Ñandú çava", "tema": "nuevo_tema_raro", "geo": "", "verdict": "CONFIRMADO CON MATIZ"},
    {"id": "dddd-4", "text": "a  -  b -- c\tdé\nnueve diez once doce", "tema": "other", "geo": "España", "verdict": "IMPRECISO"},
    {"id": "eeee-5", "text": "!!!", "tema": "economy", "geo": None, "verdict": "DESCONTEXTUALIZADO"},
]

NODE = r"""
const fs = require('fs');
const noop = () => {};
const el = { addEventListener: noop, querySelectorAll: () => [], querySelector: () => null, getElementById: () => null, readyState: 'complete' };
Object.assign(globalThis, {
  window: globalThis, document: el, addEventListener: noop, matchMedia: () => ({ matches: false }),
  location: { search: '', href: 'https://facthem.es/' }, requestAnimationFrame: noop, scrollY: 0, innerHeight: 800,
});
if (!globalThis.navigator) globalThis.navigator = {};
eval(fs.readFileSync(process.argv[2], 'utf8'));
const FT = globalThis.FT;
const inp = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const out = {
  claim: inp.claims.map(c => FT.slugifyClaim(c.text, c.id)),
  pol: inp.politicians.map(([n, p]) => FT.slugifyPolitician(FT.formatNombre(n), p)),
  cards: inp.cards.map(([c, withWho]) => FT.cardHTML(c, { withWho })),
  stack: FT.stackHTML(inp.counts), legend: FT.legendHTML(inp.counts),
  tags: inp.tags.map(t => FT.tag(t)),
  tweets: inp.tweets.map(a => FT.tweetTextOf(...a)),
};
process.stdout.write(JSON.stringify(out));
"""


def main():
    if "--refresh" in sys.argv or not FIXTURE.exists():
        fetch_fixture()
    os.environ.setdefault("SUPABASE_URL", "x"); os.environ.setdefault("SUPABASE_ANON", "x")
    os.environ["DEBUG_DB_PATH"] = os.environ.get("DEBUG_DB_PATH") or "/nonexistent"
    import build_claims as bc
    import site_chrome as sc
    fx = json.loads(FIXTURE.read_text())
    claims = fx["claims"] + EDGE
    pols = [tuple(p) for p in fx["politicians"]] + [("Ñúñez, Ángela", "EH Bildu"), ("Sin Coma", ""), ("", "")]

    random.seed(1)
    sample = random.sample(fx["claims"], min(300, len(fx["claims"]))) + EDGE
    cards = []
    for i, c in enumerate(sample):
        d = {"url": f"/claim/{bc.slugify(c['text'] or '', c['id'])}.html", "text": c["text"] or "",
             "verdict": c["verdict"], "name": bc.format_nombre(c.get("pol") or ""), "party": c.get("partido") or "",
             "photo": "/assets/photos/x.jpg" if i % 2 else None, "tema": c["tema"], "geo": c["geo"], "id": c["id"],
             "handle": ["", "alberto_aim", "Santi_ABASCAL", "un_handle_muy_largo_x"][i % 4]}
        cards.append((d, i % 3 != 0))
    counts = {"CONFIRMADO": 31, "CONFIRMADO_CON_MATIZ": 69, "SOBREESTIMADO": 22, "SUBESTIMADO": 0,
              "IMPRECISO": 1, "DESCONTEXTUALIZADO": 0, "FALSO": 3, "NO_VERIFICABLE": 16}
    tags = [k for k, *_ in sc.VERDICTS] + [None, "confirmado con matiz", "raro"]

    # X share texts: every sampled claim (long ones exercise the shortening steps
    # and the cut), with and without a handle, party, topic and region.
    tweets = [[bc.format_nombre(c.get("pol") or ""), c.get("partido") or "", ["", "alberto_aim", "x"][i % 3],
               c["text"] or "", c["verdict"], c["tema"], c["geo"], f"https://facthem.es/claim/{c['id']}.html"]
              for i, c in enumerate(sample)]
    tweets += [[ "María José Rodríguez de Millán Parro", "JxCAT-JUNTS", "un_handle_muy_largo_x", "palabra " * 60,
                "SOBREESTIMADO", "economía", "Comunidad de Madrid", "https://facthem.es/claim/z.html"],
               ["", "", "", "", None, None, None, "https://facthem.es/claim/e.html"]]
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
        json.dump({"claims": claims, "politicians": pols, "cards": cards, "counts": counts, "tags": tags, "tweets": tweets},
                  f, ensure_ascii=False)
        inp = f.name
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(NODE)
        runner = f.name
    js = json.loads(subprocess.run(["node", runner, str(ROOT / "js" / "ui.js"), inp],
                                   capture_output=True, text=True, check=True).stdout)

    bad = []
    for c, s in zip(claims, js["claim"]):
        py = bc.slugify(c["text"] or "", c["id"])
        if py != s:
            bad.append(f"claim slug {c['id']}: py={py!r} js={s!r}")
    for (n, p), s in zip(pols, js["pol"]):
        py = bc.slugify_politician(n, p)
        if py != s:
            bad.append(f"politician slug {n!r}/{p!r}: py={py!r} js={s!r}")
    for (d, who), s in zip(cards, js["cards"]):
        py = sc.card(d, with_who=who)
        if py != s:
            i = next((k for k in range(min(len(py), len(s))) if py[k] != s[k]), min(len(py), len(s)))
            bad.append(f"card {d['id']}: differs at {i}: py=…{py[max(0, i-40):i+60]!r} js=…{s[max(0, i-40):i+60]!r}")
    for a, s_ in zip(tweets, js["tweets"]):
        py = sc.tweet_text(*a)
        if py != s_:
            bad.append(f"tweet {a[7]}: py={py!r}\n        js={s_!r}")
        elif sc.x_len(py) > sc.TWEET_BUDGET:
            bad.append(f"tweet {a[7]} too long: {sc.x_len(py)} > {sc.TWEET_BUDGET}")
    if sc.stack(counts) != js["stack"]:
        bad.append(f"stack: py={sc.stack(counts)!r}\n        js={js['stack']!r}")
    if sc.legend(counts) != js["legend"]:
        bad.append(f"legend: py={sc.legend(counts)!r}\n        js={js['legend']!r}")
    for t, s in zip(tags, js["tags"]):
        if sc.vtag(t) != s:
            bad.append(f"vtag {t!r}: py={sc.vtag(t)!r} js={s!r}")

    print(f"parity: {len(claims)} claim slugs, {len(pols)} politician slugs, {len(cards)} cards, {len(tweets)} X texts, "
          f"{len(tags)} tags, stack + legend")
    for b in bad[:30]:
        print("  FAIL", b)
    print("OK" if not bad else f"{len(bad)} mismatch(es)")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
