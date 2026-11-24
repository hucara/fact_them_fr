# Facthem.es redesign: from the mockup to the real site

Branch `redesign-2026` in **fact_them_fr**, plus a matching branch in **fact_them_be** for `/live`.
Source of truth for the look: `mockup/` (index, claim, representante, representantes,
estadisticas, metodologia, live). You decide when it ships: nothing is merged to `main` without
your go-ahead (merging to `main` deploys through GitHub Pages).

Decisions already taken:
- Every deputy and minister gets a profile page. Those without claims show only the salary.
- `/live` is redesigned in the same effort (source in fact_them_be).
- The site moves to separate pages, and the old `?tab=` / `?politician=` / `?claim=` links redirect.
- Claim URLs stay exactly `/claim/<slug>.html`, and the slugs come from the same `slugify()`.

---

## 0. Ground rules

- **No URL breaks.** Before touching the build, snapshot every URL that exists today:
  `claim/*.html` (5 940), `politician/*.html` (302), `archive*.html` and `sitemap.xml` (5 425).
  After the rebuild, a script diffs the URL sets. Allowed differences: additions only (new
  salary-only profiles and new pages). Any missing URL fails the check.
- **Same data, same SEO payload.** Every claim page keeps its `ClaimReview` JSON-LD, canonical
  URL, OG/Twitter tags, the `appearance` link to the Diario de Sesiones PDF and the related-claims
  links. The markup around them changes; the data does not.
- **How the guard runs** (done 2026-11-24). The baseline is the current build from Supabase
  (7 607 claims, 320 politicians, 20 archive pages). It is a superset of the deployed
  sitemap, with 0 URLs missing. It is stored in `.baseline/snapshot.json` (gitignored, 31 MB).
  To regenerate it, build `main` in a scratch worktree and run
  `python3 tools/site_check.py snapshot <dir> .baseline/snapshot.json`.
  After each new build, run `python3 tools/site_check.py compare .baseline/snapshot.json .`.
  This fails on:
  - a removed URL
  - a changed canonical or robots tag
  - lost JSON-LD types or JSON-LD that doesn't parse
  - a changed ClaimReview verdict
  - a missing content string or source link

  It doesn't depend on markup: a full class and tag rewrite passes. All of the failure cases
  above were tested on a tampered copy. Note: new claims added after the snapshot show up as
  "added", which is fine.
- **One stylesheet, one typeface.** `css/style.css` is replaced by a new `css/site.css` built
  from `mockup/mock.css`. Inter is self-hosted (`assets/fonts/`, woff2, `font-display: swap`) so
  there's no Google Fonts round trip.
- **Real cache busting.** A build step stamps `?v=<content hash>` on CSS/JS in every generated
  page instead of hand-bumped strings.
- **The two pending fixes** carried over from `main` (session ordering by date in `app.js`, DSCD
  number in `build_claims.py`) are committed first as their own commit, so they don't hide in the
  redesign diff.

## 1. Shared foundation (`css/site.css`, `js/ui.js`)

1. Port the tokens, components and motion from `mock.css`:
   - top bar plus ☰ menu, footer
   - verdict tag (`.vtag`) and stamp keyframes
   - card, distribution bar and legend
   - `.msel` checkbox dropdown, calendar popover, share menu
   - summary panels, salary table, stats cards
   - `[hidden]`, reduced-motion and the overflow fixes found during the mockup work
2. `js/ui.js` replaces `common.js`. It takes the mockup helpers (`V`/`VK`, `tag`, `stackHTML`,
   `legendHTML`, `shareMenu` with the three-dots icon, `NATIVE` share sheet on touch, menu on
   desktop, `chrome()`, `phoneMenu()`) and wires them to real data instead of `MOCK`.
3. **Server-rendered chrome.** Top bar, menu and footer are written into every generated page by
   Python (a single `chrome.py` template shared by `build_claims.py`), not injected by JS. Crawlers
   and LLMs then see the navigation, and there's no layout jump.
4. A Python port of the card and tag markup (`render_card()`), so cards built in JS (home, search)
   and cards built statically (profiles, claim side column) are byte-identical in structure.

## 2. Claim pages: `build_claims.py → claim/<slug>.html`

Rewrite `render_page()` to the `claim.html` layout:
- header with the photo plus the attached Compartir bar, then name / party and the claim
- verdict with topic · region beside it
- confidence bar as the separator
- "Lo que dicen los datos", Errores, Contexto que falta, Fuentes
- side column "Más de X en este pleno" / "en otros plenos" / "Todas sus afirmaciones"

Keep the slug, canonical URL, JSON-LD (fix the `@type`/fields only if validation finds issues),
OG image and the breadcrumbs. Add `BreadcrumbList` JSON-LD.

Small JS only (`js/claim.js`): stamp-on-load, share, view-transition name. The page must be
fully readable with JS off.

**Checks:**
- Validate 20 random pages plus edge cases with the Schema.org validator logic (ClaimReview
  required fields): no verification, no politician, very long claim, no sources, government
  member, `NO_VERIFICABLE`.
- Lighthouse SEO and accessibility ≥ 95 on a sample.

## 3. Profiles: `politician/<slug>.html` (static, now for everyone)

- Data: the salary table (`fetch_salaries`) gives the full roster (350 deputies plus the
  Government). Claims are joined by id, falling back to name matching as today.
- **Slug stability:** the 302 existing slugs must come out identical. New people get a slug from
  the same `slugify_politician()`. If two people would collide, add a suffix only to the new one.
- Layout from `representante.html`:
  - crumbs
  - photo plus attached share
  - two stacked foldable panels (claims with the verdict bar and topics; salary showing month and
    year closed, the full table, note and roles when open)
  - one-line filters
  - claims grid grouped by sitting, newest first
- Salary-only people: the claims panel reads "Sin afirmaciones verificadas todavía", and the
  page is `index,follow` (the salary is the content).
- JSON-LD: `Person` (name, party `memberOf`, `jobTitle`, image, `sameAs` congreso.es profile
  when we have it) plus `BreadcrumbList`.
- Filters run client-side over the cards already in the HTML (no fetch).

## 4. Directory: `representantes.html` (new, static)

Built by Python with all people prerendered (name, party dot, constituency, photo, salary).
Search, party filter and A–Z/Sueldo ordering in JS over the DOM. Linked from the ☰ menu and the
footer. Added to the sitemap.

## 5. Home: `index.html` (session page)

- Hero:
  - mirrored Lady Justice with the phone crop
  - scroll zoom, new `mist.js` (replacing `js/mist.js`)
  - two-line slogan
  - "En directo" button (shown only when live, see §8) next to "Ver el último pleno", and
    "Cómo verificamos"
  - counters on desktop only
- Session rail plus calendar (session days filled, debates in blue), the panel with the
  folding "Filtros" on phones, the distribution bar plus legend, and a 3-column card grid in
  session order.
- Data: keep the current Supabase fetches (`loadSessions`, `loadSession`, `?session=` deep
  links) but render with `ui.js`. Cards are plain links to `/claim/<slug>.html` (the slug comes
  from the same `slugifyClaim()`, which needs a parity test against Python). The modal is removed.
- **SEO:** at build time, prerender the latest sitting's cards into `index.html` (a
  `<noscript>`-free static list that JS hydrates/replaces). Crawlers then get real content and
  links on the home page instead of an empty container.
- Infinite-scroll batching stays for big sittings (142+ cards).

## 6. Stats: `estadisticas.html` (new page)

The `mockup/stats.js` port of `renderDashboard`: the same 26 cards and wording, equal-height
grid, live data from `dashboard_stats`. Static shell plus fetched numbers. At build time, write
the current numbers into the HTML too, so the page has content without JS.

## 7. Other pages

- `metodologia.html`, `acerca.html`, `aviso.html` and `blog.html` move onto the mockup's
  text-page template: same text, same URLs.
- The `archive*.html` letter pages are regenerated with the new chrome.
- Add a `404.html` (GitHub Pages serves it) with search and links.

## 8. `/live` (fact_them_be `live/frontend` → `fact_them_fr/live/`)

Port the mockup's look onto the **real** `live.js`. That file has 2 300 lines of polling, buckets,
YouTube sync, replay and diferido, and that logic stays. Only the presentation layer changes:
- `makeCard`: reserved actions row, topic/region, no confidence bar or conclusion in the preview
- unfolded card mirroring the claim page (confidence bar separator, same headings, no
  "Abrir la ficha")
- stamp lift-and-smack, no coloured top lines, "Verificando Ns"
- fixed-height transcript with speaker separators
- unverifiable drawer at the bottom of the feed
- phone layout: video fixed on top and one combined header, bar plus legend, auto-scrolling feed
  with no captions or counter
- no "40 s de retraso · beta", no "RTVE"
- share icon and menu from `ui.js`

"En directo" button on the home page: read the same R2 pointer/manifest that `/live` reads. Show
the button only while `status` is live, and hide it on error.

**Checks:**
- Run a full replay of Debate a 8 (`?replay=` / diferido) on desktop and phone: cards grow in,
  stamp, fold, share, the drawer and auto-scroll.
- Run a simulated live run from the runner's test buckets on aton, if available.
- Rebuild with `python -m fact_them_be.live.frontend.build` and commit the output into
  `fact_them_fr/live/`.

## 9. Old URL redirects (in `index.html`, run before anything renders)

| Old | New |
|---|---|
| `/?claim=<id>` | `/claim/<slug>.html` (look up the slug by id, then `location.replace`) |
| `/?tab=busqueda&politician=<slug>` | `/politician/<slug>.html` |
| `/?tab=busqueda` | `/representantes.html` |
| `/?tab=estadisticas` | `/estadisticas.html` |
| `/?tab=sesiones`, `/?session=…` | stay on the home page (still supported) |

GitHub Pages has no server redirects, so these are JS `location.replace` calls plus a canonical
tag. Each one is tested with a list of real links pulled from past tweets and shares.

## 10. LLM SEO

- `llms.txt` (what Facthem is, the methodology, how verdicts work, links to the stats,
  directory and sitemap) and `llms-full.txt` (methodology plus verdict definitions in plain text).
- Every claim page opens with a plain-text sentence an LLM can quote: "{Name} ({party}) dijo en el
  Pleno del {date}: «…». Veredicto de Facthem: {verdict}."
- Keep `robots.txt` open to AI crawlers. Say so explicitly for GPTBot, ClaudeBot and
  PerplexityBot.
- Add `dateModified` and a visible "Verificado el …" date on claim pages.

## 11. Verification (my responsibility before you decide to ship)

1. **Build:** `python build_claims.py` locally against Supabase (using `.env`). It must finish with
   no errors, and print counts that match the old build.
2. **URL diff:** the old and new sets of claim/politician/archive URLs show no removals. The
   sitemap is valid XML and contains the new profiles and pages.
3. **Content parity:** for 50 random claims, the old page text (verdict, summary, errores,
   omisiones, fuentes) is contained in the new page text.
4. **Structured data:** JSON-LD parses on every generated page. ClaimReview, Person and
   Breadcrumb carry their required fields.
5. **Slug parity:** the JS `slugifyClaim`/`slugifyPolitician` and the Python versions agree on
   every claim and politician.
6. **Browser pass** in the built-in browser, at 1280 px and 375 px, on each page type:
   - home (filters, calendar, share, infinite scroll, a `?session=` link)
   - claim (with and without photo or sources)
   - profile (with claims; salary only; minister)
   - directory, stats, text pages, 404, every redirect
   - live (replay)

   Also check: console clean, no horizontal overflow (`scrollWidth == innerWidth`), reduced
   motion, and keyboard navigation of the menus.
7. **Performance:** the home page's LCP image is preloaded, self-hosted font, mist paused off
   screen, CLS ≈ 0. Lighthouse on home, claim and profile (mobile).
8. **Report:** a short summary with screenshots, the counts, and anything left open. Then a PR
   from `redesign-2026`, unmerged. The merge date is yours.

## Order of work

0 → 1 → 2 → 3 → 4 → 9 → 5 → sesion pages → 6 → 7 → 10 → 8 → 11. Claim and profile pages come first because
they carry the SEO and the URLs. Live goes last because it has its own repo and needs a replay
to test.

## Decisions on the former open questions (2026-11-24)

1. **Sitting pages: yes.** Each sitting gets a static page, `/sesion/<id>.html`, built by
   `build_claims.py`. It has the same layout as the home panel (bar, legend, filters, card
   grid), an `ItemList` JSON-LD and a sitemap entry. The home rail and the calendar link to
   these pages. `/?session=<id>` keeps working on the home page.
2. **Claim share image: removed.** `generateShareImage`, `handleShareImage` and the "imagen"
   share option go away. The share menu keeps only the link and text shares (native sheet on
   phones; on desktop the menu with X, WhatsApp, Telegram and copy link). og:image stays the
   generic site image.
3. **Blog: restyle only.** Same content and URLs, on the text-page template.
4. **Filter pills: dropped. Politician autocomplete: kept.** It moves into the top bar
   (desktop) and the ☰ menu (phone) as a search that jumps to `/politician/<slug>.html`, using
   the directory data. The directory page reuses it.
