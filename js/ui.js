/* Facthem shared UI (redesign 2026). Loaded on every page, deferred.

   window.FT exposes the vocabulary and the markup builders that pages use to
   render cards client-side. They mirror site_chrome.py exactly (same HTML for
   the same input): tools/test_parity.py checks both against each other.

   Also wires the chrome that the server renders into every page: phone menu,
   nav underline, share menus, the politician search, the "En directo" links
   and the footer e-mail. */
window.FT = (() => {
  const BASE_URL = 'https://facthem.es';

  // ── Text helpers ──────────────────────────────────────────────────────────
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const fmt = n => new Intl.NumberFormat('es-ES', { useGrouping: 'always', maximumFractionDigits: 2 }).format(n);
  const MES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sept', 'oct', 'nov', 'dic'];
  const fdate = (d, long) => {
    const x = new Date(String(d).slice(0, 10) + 'T12:00:00');
    return long ? x.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' })
      : `${x.getDate()} ${MES[x.getMonth()]} ${x.getFullYear()}`;
  };
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── Vocabulary (= site_chrome.VERDICTS / TEMA_LABELS / PARTY_COLORS) ─────
  const V = [
    { k: 'CONFIRMADO', l: 'Confirmado', long: 'Confirmado', i: '✓', c: 'var(--v-ok)' },
    { k: 'CONFIRMADO_CON_MATIZ', l: 'Con matiz', long: 'Confirmado con matiz', i: '≈', c: 'var(--v-matiz)' },
    { k: 'SOBREESTIMADO', l: 'Sobreestimado', long: 'Sobreestimado', i: '↑', c: 'var(--v-sobre)' },
    { k: 'SUBESTIMADO', l: 'Subestimado', long: 'Subestimado', i: '↓', c: 'var(--v-sub)', hatch: true },
    { k: 'IMPRECISO', l: 'Inexacto', long: 'Inexacto', i: '~', c: 'var(--v-impreciso)' },
    { k: 'DESCONTEXTUALIZADO', l: 'Descontextualizado', long: 'Descontextualizado', i: '⋯', c: 'var(--v-descontext)' },
    { k: 'FALSO', l: 'Falso', long: 'Falso', i: '✕', c: 'var(--v-falso)' },
    { k: 'NO_VERIFICABLE', l: 'No verificable', long: 'No verificable', i: '?', c: 'var(--v-nv)' },
  ];
  const VK = Object.fromEntries(V.map(v => [v.k, v]));
  const verdictKey = r => { const k = String(r || '').trim().toUpperCase().replace(/ /g, '_'); return VK[k] ? k : 'NO_VERIFICABLE'; };
  const WHAT = {
    CONFIRMADO: 'Los datos respaldan la afirmación.',
    CONFIRMADO_CON_MATIZ: 'Es esencialmente cierta, pero le falta contexto o precisión.',
    SOBREESTIMADO: 'La cifra real es menor que la afirmada.',
    SUBESTIMADO: 'La cifra real es mayor que la afirmada.',
    IMPRECISO: 'La afirmación contiene datos inexactos.',
    DESCONTEXTUALIZADO: 'El dato es real, pero sacado de su contexto cambia de sentido.',
    FALSO: 'Los datos contradicen la afirmación.',
    NO_VERIFICABLE: 'No hay datos públicos suficientes para comprobarla.',
  };
  const TEMA_LABELS = {
    agriculture: 'Agricultura', defence: 'Defensa', economy: 'Economía', energy: 'Energía',
    environment: 'Medio ambiente', equality: 'Igualdad', health: 'Salud', housing: 'Vivienda',
    human_rights: 'Derechos humanos', industry_and_labour: 'Industria y empleo',
    internal_affairs: 'Asuntos internos', international_relations: 'Relaciones exteriores',
    justice_and_corruption: 'Justicia y anticorrupción', migration: 'Migración', other: 'Otros',
    social_policy: 'Política social', transport: 'Transporte',
  };
  const temaLabel = t => {
    if (!t) return '';
    if (TEMA_LABELS[t]) return TEMA_LABELS[t];
    const s = String(t).replace(/_/g, ' ').trim();
    return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
  };
  const PARTY = {
    PSOE: '#d9474f', PP: '#3d8fd1', VOX: '#6fb043', SUMAR: '#d8437a', 'EAJ-PNV': '#3f9a5c', ERC: '#e0a63c',
    BNG: '#79b6de', Podemos: '#8a5fb8', 'EH Bildu': '#3dae9b', 'JxCAT-JUNTS': '#3fb6b0',
  };

  // ── Slugs (= build_claims.slugify / slugify_politician) ──────────────────
  const FOLD = [['á', 'a'], ['é', 'e'], ['í', 'i'], ['ó', 'o'], ['ú', 'u'], ['ä', 'a'], ['ö', 'o'], ['ü', 'u'], ['ñ', 'n'], ['ç', 'c']];
  const fold = s => FOLD.reduce((a, [x, y]) => a.replaceAll(x, y), s);
  // Python's str.split() drops empty strings; match it.
  const words = s => s.split(/\s+/).filter(Boolean);
  function slugifyClaim(text, claimId) {
    const shortId = String(claimId).split('-')[0];
    const s = fold(String(text ?? '').trim().toLowerCase()).replace(/[^a-z0-9\s-]/g, '');
    const slug = words(s).slice(0, 8).join('-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    return slug ? `${slug}-${shortId}` : shortId;
  }
  // `name` already in "Nombre Apellidos" order (format_nombre).
  function slugifyPolitician(name, partido = '') {
    const s = fold(`${name} ${partido}`.trim().toLowerCase()).replace(/[^a-z0-9\s-]/g, '');
    return words(s).join('-').replace(/-+/g, '-').replace(/^-+|-+$/g, '') || 'desconocido';
  }
  const formatNombre = full => { const p = String(full || '').split(','); return p.length === 2 ? `${p[1].trim()} ${p[0].trim()}` : String(full || ''); };
  const claimPath = (text, id) => `/claim/${slugifyClaim(text, id)}.html`;
  const politicianPath = (fullName, partido) => `/politician/${slugifyPolitician(formatNombre(fullName), partido)}.html`;

  // ── Components (= site_chrome.vtag / share / stack / legend / card) ───────
  const ICON_SHARE = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/></svg>';
  const tag = (key, cls = '') => { const v = VK[verdictKey(key)]; const c = `vtag ${cls}`.trim();
    return `<span class="${c}" style="--c:${v.c}"><span class="vi" aria-hidden="true">${v.i}</span>${esc(v.long)}</span>`; };
  // Share text as on the old site (= site_chrome.share_text).
  const EMOJI = { CONFIRMADO: '✅', CONFIRMADO_CON_MATIZ: '⚠️', FALSO: '❌', DESCONTEXTUALIZADO: '🟠',
    IMPRECISO: '🔸', NO_VERIFICABLE: '❓', SOBREESTIMADO: '🟠', SUBESTIMADO: '🟠' };
  const shareTextOf = (name, party, text, verdict, verb = 'ha afirmado') => {
    const k = verdictKey(verdict), x = String(text || '').trim();
    const t = x.slice(0, 200) + (x.length > 200 ? '…' : '');
    return `🔍 ${name || 'Un político'}${party ? ` (${party})` : ''} ${verb}: "${t}"\n${EMOJI[k] || '🔍'} ${VK[k].long}`;
  };
  const shareMenu = (url, text, label = '') => {
    const u = encodeURIComponent(url), t = encodeURIComponent(text);
    return `<div class="share"><button type="button" class="share-btn${label ? ' has-label' : ''}" aria-haspopup="true" `
      + `aria-expanded="false" aria-label="Compartir" data-url="${esc(url)}" data-text="${esc(text)}">${ICON_SHARE}${label}</button>`
      + `<div class="share-pop" role="menu" hidden>`
      + `<button type="button" role="menuitem" data-copy="${esc(url)}">Copiar enlace</button>`
      + `<a role="menuitem" href="https://twitter.com/intent/tweet?text=${t}&amp;url=${u}&amp;via=facthem_ES" target="_blank" rel="noopener">X</a>`
      + `<a role="menuitem" href="https://wa.me/?text=${t}%0A${u}" target="_blank" rel="noopener">WhatsApp</a>`
      + `<a role="menuitem" href="https://t.me/share/url?url=${u}&amp;text=${t}" target="_blank" rel="noopener">Telegram</a>`
      + `</div></div>`;
  };
  const stackHTML = (cnt, cls = 'stack') => {
    const total = V.reduce((a, v) => a + (cnt[v.k] || 0), 0) || 1;
    const label = V.filter(v => cnt[v.k]).map(v => `${v.long}: ${cnt[v.k]}`).join(', ');
    return `<div class="${cls}" role="img" aria-label="${esc(label)}">${V.filter(v => cnt[v.k]).map(v =>
      `<span class="${v.hatch ? 'hatch' : ''}" style="--c:${v.c};flex:${(cnt[v.k] / total).toFixed(4)}" title="${esc(v.long)}: ${cnt[v.k]}"></span>`).join('')}</div>`;
  };
  const legendHTML = cnt => `<ul class="legend">${V.filter(v => cnt[v.k]).map(v =>
    `<li style="--c:${v.c}"><span class="dot"></span>${esc(v.l)} <span class="num">${cnt[v.k]}</span></li>`).join('')}</ul>`;
  const counts = (list, get = c => c.verdict) => {
    const out = Object.fromEntries(V.map(v => [v.k, 0]));
    for (const c of list) out[verdictKey(get(c))]++;
    return out;
  };
  // c: { url, text, verdict, name, party, photo, tema, geo, id }. `inner` lets
  // the home page highlight search matches inside the (already escaped) text.
  function cardHTML(c, { withWho = true, index = 0, inner = null } = {}) {
    const k = verdictKey(c.verdict), color = VK[k].c;
    const name = c.name || '', party = c.party || '';
    const shareText = shareTextOf(name, party, c.text, c.verdict);
    const meta = esc(temaLabel(c.tema)) + (c.geo ? ` · ${esc(c.geo)}` : '');
    const absUrl = c.url.startsWith('http') ? c.url : BASE_URL + c.url;
    const head = `<article class="card in" style="--c:${color};--i:${Math.min(index, 18)}" data-id="${esc(c.id ?? '')}" `
      + `data-v="${k}" data-t="${esc(c.tema || '')}">${tag(k)}`
      + `<p class="claim-q"><a class="card-link" href="${esc(c.url)}">${inner ?? esc(c.text || '')}</a></p>`;
    if (withWho) {
      const photo = c.photo ? `<img class="avatar" src="${esc(c.photo)}" alt="" loading="lazy" width="28" height="28" />`
        : '<span class="avatar" aria-hidden="true"></span>';
      return `${head}<div class="who">${photo}<span class="who-name">${esc(name)}</span>`
        + `<span class="who-party">${esc(party)}</span>${shareMenu(absUrl, shareText)}</div>`
        + `<div class="card-meta">${meta}</div></article>`;
    }
    return `${head}<div class="who"><span class="card-meta-inline">${meta}</span>${shareMenu(absUrl, shareText)}</div></article>`;
  }

  // ── Share: system sheet on touch screens, our menu elsewhere ─────────────
  const NATIVE = !!navigator.share && matchMedia('(pointer: coarse)').matches;
  const closeShares = except => document.querySelectorAll('.share-pop:not([hidden])').forEach(p => {
    if (p === except) return;
    p.hidden = true; p.previousElementSibling.setAttribute('aria-expanded', 'false');
    p.closest('.card')?.classList.remove('menu-open');
  });
  document.addEventListener('click', e => {
    const btn = e.target.closest('.share-btn'), copy = e.target.closest('[data-copy]');
    if (btn) {
      e.preventDefault(); e.stopPropagation();
      if (NATIVE) { navigator.share({ title: 'Facthem', text: btn.dataset.text, url: btn.dataset.url }).catch(() => {}); return; }
      const pop = btn.nextElementSibling; closeShares(pop);
      pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden));
      if (!pop.hidden) {   // open upwards when there's no room below (screen edge or a scrolling feed)
        pop.classList.remove('up');
        let limit = innerHeight, n = pop.parentElement;
        while (n && n !== document.body) {
          const o = getComputedStyle(n).overflowY;
          if (o === 'auto' || o === 'scroll') { limit = Math.min(limit, n.getBoundingClientRect().bottom); break; }
          n = n.parentElement;
        }
        if (pop.getBoundingClientRect().bottom > limit - 8) pop.classList.add('up');
      }
      btn.closest('.card')?.classList.toggle('menu-open', !pop.hidden);
      return;
    }
    if (copy) {
      e.preventDefault(); e.stopPropagation();
      navigator.clipboard?.writeText(copy.dataset.copy).catch(() => {});
      copy.textContent = 'Enlace copiado ✓';
      setTimeout(() => { copy.textContent = 'Copiar enlace'; closeShares(); }, 900);
      return;
    }
    if (!e.target.closest('.share-pop')) closeShares();
  }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape') closeShares(); });

  // ── Top bar: underline, scrolled state, phone menu ───────────────────────
  function initTopbar() {
    const bar = document.getElementById('topbar'); if (!bar) return;
    const onScroll = () => bar.classList.toggle('is-scrolled', scrollY > 8);
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
    const ink = bar.querySelector('.nav-ink'), act = bar.querySelector('.nav a.is-active');
    if (ink && act) {
      const place = a => { ink.style.left = a.offsetLeft + 12 + 'px'; ink.style.width = a.offsetWidth - 24 + 'px'; };
      bar.querySelectorAll('.nav a').forEach(a => { a.onmouseenter = () => place(a); a.onmouseleave = () => place(act); });
      requestAnimationFrame(() => place(act));
      document.fonts?.ready.then(() => place(act));
      addEventListener('resize', () => place(act), { passive: true });   // nav is hidden on phones
    }
    const btn = bar.querySelector('.menu-btn'), nav = document.getElementById('mnav');
    if (!btn || !nav) return;
    const set = open => { nav.hidden = !open; btn.setAttribute('aria-expanded', String(open)); document.body.classList.toggle('menu-open', open); };
    btn.onclick = e => { e.stopPropagation(); set(nav.hidden); };
    document.addEventListener('click', e => { if (!nav.hidden && !nav.contains(e.target) && !btn.contains(e.target)) set(false); });
    addEventListener('keydown', e => { if (e.key === 'Escape') set(false); });
  }

  // ── "En directo": shown only while a broadcast is actually on ────────────
  // Same pointer the /live page reads. CORS on R2 allows facthem.es only, so
  // on localhost the links stay hidden; ?live=demo forces them on for testing.
  const LIVE_BASE = 'https://pub-4b0592b162234f079cbe05777d9aa1f2.r2.dev/';
  const LIVE_STALE_S = 15 * 60;
  async function isLive() {
    if (new URLSearchParams(location.search).get('live') === 'demo') return true;
    if (location.hostname !== 'facthem.es') return false;   // R2 CORS allows facthem.es only
    const one = async key => {
      try {
        const r = await fetch(`${LIVE_BASE}sessions/${key}.json`, { cache: 'no-store' });
        if (!r.ok) return false;
        const d = await r.json();
        const fresh = !d.updated || (Date.now() / 1000 - d.updated) < LIVE_STALE_S;
        return d.status && d.status !== 'ended' && d.listed !== false && fresh;
      } catch { return false; }
    };
    const res = await Promise.all([one('current'), one('current-tv')]);
    return res.some(Boolean);
  }
  async function initLive() {
    const els = document.querySelectorAll('[data-live]'); if (!els.length) return;
    if (!(await isLive())) return;
    els.forEach(el => { el.hidden = false; });
    // "Directos" always points at /live/ (the running directo, or the diferidos
    // grid when nothing is on air); while one runs it carries the pulse.
    document.querySelectorAll('.nav a[href="/live/"], .mnav a[href="/live/"]').forEach(a => {
      a.classList.add('is-on'); a.insertAdjacentHTML('afterbegin', '<span class="pulse" aria-hidden="true"></span>');
    });
  }

  // ── Politician search: name → profile, over /assets/people.json ──────────
  let people = null;
  const loadPeople = () => people ??= fetch('/assets/people.json').then(r => r.ok ? r.json() : []).catch(() => []);
  function initSearch(root) {
    const input = root.querySelector('.psearch-input'), list = root.querySelector('.psearch-list');
    let items = [], sel = -1;
    const close = () => { list.hidden = true; input.setAttribute('aria-expanded', 'false'); sel = -1; };
    const paint = () => [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sel)));
    async function run() {
      const q = norm(input.value.trim());
      if (q.length < 2) { close(); return; }
      const all = await loadPeople();
      const terms = q.split(/\s+/);
      items = all.filter(p => { const h = p._h ??= norm(`${p.n} ${p.p} ${p.c || ''}`); return terms.every(t => h.includes(t)); })
        .sort((a, b) => (b.k || 0) - (a.k || 0)).slice(0, 8);
      list.innerHTML = items.length ? items.map(p => `<li role="option"><a href="/politician/${esc(p.s)}.html">`
        + (p.f ? `<img src="${esc(p.f)}" alt="" loading="lazy" width="32" height="32" />` : '<span class="ph"></span>')
        + `<span><span class="nm">${esc(p.n)}</span><span class="mt">${esc(p.p)}${p.c ? ' · ' + esc(p.c) : ''}${p.k ? ` · ${p.k} afirmaciones` : ''}</span></span></a></li>`).join('')
        : '<li class="none">Nadie coincide.</li>';
      sel = items.length ? 0 : -1; paint();
      list.hidden = false; input.setAttribute('aria-expanded', 'true');
    }
    input.addEventListener('focus', loadPeople, { once: true });
    input.addEventListener('input', run);
    input.addEventListener('keydown', e => {
      if (list.hidden || !items.length) return;
      if (e.key === 'ArrowDown') { sel = (sel + 1) % items.length; paint(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = (sel - 1 + items.length) % items.length; paint(); e.preventDefault(); }
      else if (e.key === 'Enter' && sel >= 0) { location.href = `/politician/${items[sel].s}.html`; e.preventDefault(); }
      else if (e.key === 'Escape') close();
    });
    document.addEventListener('click', e => { if (!root.contains(e.target)) close(); });
  }

  // Contact address assembled at runtime (kept out of the HTML for scrapers).
  function initFooter() {
    document.querySelectorAll('a.footer-email').forEach(el => {
      const a = `${el.dataset.u || 'contacto'}@${el.dataset.d || 'facthem.es'}`;
      el.href = `mailto:${a}`; el.textContent = a;
    });
  }

  function init() {
    initTopbar();
    document.querySelectorAll('.psearch').forEach(initSearch);
    addEventListener('keydown', e => {   // "/" focuses the visible search
      if (e.key !== '/' || e.target.closest('input, textarea, select, [contenteditable]')) return;
      const inp = [...document.querySelectorAll('.psearch-input')].find(i => i.offsetParent);
      if (inp) { e.preventDefault(); inp.focus(); }
    });
    initLive();
    initFooter();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return {
    BASE_URL, esc, norm, fmt, fdate, MES, reduce, V, VK, verdictKey, WHAT, TEMA_LABELS, temaLabel, PARTY,
    slugifyClaim, slugifyPolitician, formatNombre, claimPath, politicianPath,
    ICON_SHARE, tag, shareMenu, stackHTML, legendHTML, counts, cardHTML, NATIVE, isLive,
  };
})();
