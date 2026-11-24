#!/usr/bin/env python3
"""Guard rails for the redesign: no URL, SEO field or content may be lost.

  python tools/site_check.py snapshot <site_dir> <out.json>
      Record every generated page (claim/, politician/, archive*.html): URL, SEO
      head (title, description, canonical, robots, og:/twitter:), parsed JSON-LD,
      the content strings a reader sees and the outbound source/profile links.

  python tools/site_check.py compare <snapshot.json> <site_dir> [--sample N]
      Check a new build against a snapshot. FAILS on: a removed URL, a changed
      canonical, a lost JSON-LD @type, a changed ClaimReview verdict/claim, a
      content string or source link missing from the new page, JSON-LD that does
      not parse. WARNS on title/description/og changes. Exit code 1 on failure.

Markup-agnostic on purpose: content is compared as normalised text contained in
the new page's visible text, so the redesign can change every class and tag.
Standard library only (runs in CI without extra deps).
"""
import json
import random
import re
import sys
import unicodedata
from html.parser import HTMLParser
from pathlib import Path

BASE = "https://facthem.es"
SKIP_TAGS = {"script", "style", "noscript", "template", "svg"}
# Old-page regions that are chrome, not content (nav, related lists, share).
CHROME_CLASSES = {"cp-related", "share-wrapper", "share-menu", "modal-share",
                  "cp-breadcrumb", "site-footer", "cp-brand", "cp-back"}
CONTENT_TAGS = {"h1", "h2", "dd", "li", "p", "td", "th", "time"}
MIN_ITEM = 25
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "source", "track", "wbr"}


def norm(s):
    s = unicodedata.normalize("NFKC", s or "").replace(" ", " ")
    return re.sub(r"\s+", " ", s).strip().casefold()


def squash(s):
    """Whitespace-free form: containment survives re-wrapping and re-nesting."""
    return re.sub(r"\s+", "", norm(s))


class Page(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []            # (tag, is_chrome)
        self.title = ""
        self.meta = {}
        self.canonical = None
        self.jsonld_raw = []
        self._in_title = self._in_ld = False
        self._ld_buf = []
        self.text = []             # all visible text (for containment)
        self.items = []            # content strings (old-page snapshot)
        self._item = None          # (depth, buffer)
        self.links = set()

    @property
    def chrome(self):
        return any(c for _, c in self.stack)

    @property
    def hidden(self):
        return any(t in SKIP_TAGS for t, _ in self.stack)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = set((a.get("class") or "").split())
        if tag == "meta":
            k = a.get("name") or a.get("property")
            if k:
                self.meta[k.lower()] = a.get("content") or ""
            return
        if tag == "link" and "canonical" in (a.get("rel") or "").split():
            self.canonical = a.get("href")
            return
        if tag == "title":
            self._in_title = True
        if tag == "script" and (a.get("type") or "") == "application/ld+json":
            self._in_ld, self._ld_buf = True, []
        if tag == "a" and a.get("href") and not self.chrome and not self.hidden:
            self.links.add(a["href"])
        if tag in VOID:
            return
        self.stack.append((tag, bool(cls & CHROME_CLASSES) or tag in ("nav", "footer")))
        if tag in CONTENT_TAGS and self._item is None and not self.chrome and not self.hidden:
            self._item = (len(self.stack), [])

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        if tag == "script" and self._in_ld:
            self._in_ld = False
            self.jsonld_raw.append("".join(self._ld_buf))
        if tag in VOID:
            return
        # pop to the matching tag (tolerate sloppy HTML)
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                if self._item and self._item[0] > i:
                    self._item = None
                del self.stack[i:]
                break

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        if self._in_ld:
            self._ld_buf.append(data)
            return
        if self.hidden:
            return
        self.text.append(data)
        # Content = each text fragment of a reader-facing element, long enough
        # to be real content (headings/labels like "Omisiones" may be renamed).
        if self._item and not self.chrome:
            t = norm(data)
            if len(t) >= MIN_ITEM:
                self.items.append(t)


def parse(path):
    p = Page()
    p.feed(path.read_text(encoding="utf-8"))
    p.close()
    ld, bad = [], 0
    for raw in p.jsonld_raw:
        try:
            ld.append(json.loads(raw))
        except json.JSONDecodeError:
            bad += 1
    return p, ld, bad


def ld_types(ld):
    out = set()
    def walk(o):
        if isinstance(o, dict):
            t = o.get("@type")
            if isinstance(t, str):
                out.add(t)
            elif isinstance(t, list):
                out.update(t)
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)
    walk(ld)
    return sorted(out)


def claim_review(ld):
    def walk(o):
        if isinstance(o, dict):
            if o.get("@type") == "ClaimReview":
                r = o.get("reviewRating") or {}
                return {"claimReviewed": norm(o.get("claimReviewed")),
                        "alternateName": norm(r.get("alternateName")),
                        "ratingValue": r.get("ratingValue")}
            for v in o.values():
                x = walk(v)
                if x:
                    return x
        elif isinstance(o, list):
            for v in o:
                x = walk(v)
                if x:
                    return x
    return walk(ld)


def pages(site):
    site = Path(site)
    for sub in ("claim", "politician"):
        for f in sorted((site / sub).glob("*.html")):
            yield f"{BASE}/{sub}/{f.name}", f
    for f in sorted(site.glob("archive*.html")):
        yield f"{BASE}/{f.name}", f


def is_content_link(h):
    return h.startswith("http") and not h.startswith(BASE) or "/politician/" in h or "/claim/" in h


def snapshot(site, out):
    data = {}
    for url, f in pages(site):
        p, ld, bad = parse(f)
        keep_items = "/claim/" in url or "/politician/" in url
        data[url] = {
            "title": norm(p.title),
            "description": norm(p.meta.get("description")),
            "canonical": p.canonical,
            "robots": p.meta.get("robots"),
            "og": {k: v for k, v in p.meta.items() if k.startswith(("og:", "twitter:"))},
            "ld_types": ld_types(ld),
            "ld_bad": bad,
            "claim_review": claim_review(ld),
            # dedupe, keep order; archive pages are link lists: links only
            "items": list(dict.fromkeys(p.items)) if keep_items else [],
            "links": sorted(h for h in p.links if is_content_link(h)),
        }
    Path(out).write_text(json.dumps(data, ensure_ascii=False, indent=0))
    kinds = {k: sum(1 for u in data if f"/{k}" in u) for k in ("claim/", "politician/", "archive")}
    print(f"snapshot: {len(data)} pages {kinds} → {out}")


EXPECTED = Path(__file__).with_name("expected_changes.json")


def compare(snap_path, site, sample=None):
    old = json.loads(Path(snap_path).read_text())
    exp = json.loads(EXPECTED.read_text()) if EXPECTED.exists() else {}
    allowed_lost = {}   # url -> set of @types whose loss is intended
    for t, spec in (exp.get("ld_types_lost") or {}).items():
        for u in spec["urls"]:
            allowed_lost.setdefault(u, set()).add(t)
    seen_allowed = set()
    new_urls = dict(pages(site))
    fails, warns = [], []
    missing = sorted(set(old) - set(new_urls))
    for u in missing:
        fails.append(f"URL removed: {u}")
    added = sorted(set(new_urls) - set(old))
    urls = sorted(set(old) & set(new_urls))
    if sample:
        random.seed(0)
        urls = random.sample(urls, min(sample, len(urls)))
    for u in urls:
        o = old[u]
        p, ld, bad = parse(new_urls[u])
        text = squash(" ".join(p.text))
        if bad:
            fails.append(f"{u}: {bad} JSON-LD block(s) do not parse")
        if p.canonical != o["canonical"]:
            fails.append(f"{u}: canonical {o['canonical']!r} → {p.canonical!r}")
        lost = set(o["ld_types"]) - set(ld_types(ld))
        if lost & allowed_lost.get(u, set()):
            seen_allowed.add(u)
        lost -= allowed_lost.get(u, set())
        if lost:
            fails.append(f"{u}: JSON-LD types lost {sorted(lost)}")
        if o["claim_review"] and claim_review(ld) != o["claim_review"]:
            fails.append(f"{u}: ClaimReview changed {o['claim_review']} → {claim_review(ld)}")
        for s in o["items"]:
            if squash(s) not in text:
                fails.append(f"{u}: content missing: {s[:90]!r}")
        hrefs = p.links | {h for h in re.findall(r'href="([^"]+)"', new_urls[u].read_text(encoding="utf-8"))}
        for h in o["links"]:
            if h not in hrefs and h.replace(BASE, "") not in hrefs:
                fails.append(f"{u}: link missing: {h}")
        if norm(p.title) != o["title"]:
            warns.append(f"{u}: title changed")
        if norm(p.meta.get("description")) != o["description"]:
            warns.append(f"{u}: description changed")
        if (p.meta.get("robots") or None) != (o["robots"] or None):
            fails.append(f"{u}: robots {o['robots']!r} → {p.meta.get('robots')!r}")
    if not sample:
        unused = set(allowed_lost) - seen_allowed
        for u in sorted(unused):
            fails.append(f"{u}: listed in expected_changes.json but the change did not happen")
    print(f"compare: {len(urls)} pages checked, {len(missing)} removed, {len(added)} added, "
          f"{len(seen_allowed)} expected change(s) seen")
    for w in warns[:20]:
        print("  warn", w)
    if len(warns) > 20:
        print(f"  … {len(warns) - 20} more warnings")
    if "--all" in sys.argv:
        for f in fails[60:]:
            print("  FAIL", f)
    for f in fails[:60]:
        print("  FAIL", f)
    if len(fails) > 60:
        print(f"  … {len(fails) - 60} more failures")
    print("OK" if not fails else f"{len(fails)} failure(s)")
    return 1 if fails else 0


if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) == 3 and a[0] == "snapshot":
        snapshot(a[1], a[2])
    elif len(a) >= 3 and a[0] == "compare":
        n = int(a[a.index("--sample") + 1]) if "--sample" in a else None
        sys.exit(compare(a[1], a[2], n))
    else:
        sys.exit(__doc__)
