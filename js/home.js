/* Home page: sitting rail, calendar, filters, card grid.

   The build prerenders the latest sitting into the HTML (readable and
   crawlable without JS) and writes every sitting to /assets/sessions/<id>.json
   plus the list of sittings into #sessions-index. This file wires the
   prerendered page and renders other sittings from those files with
   FT.cardHTML, which produces the same markup as the build. */
(() => {
  const FT = window.FT;
  const { esc, norm, V, VK, temaLabel, cardHTML, reduce, fmt, shareMenu } = FT;
  const $ = (s, el = document) => el.querySelector(s);
  const index = JSON.parse($('#sessions-index')?.textContent || '[]');
  if (!index.length || !$('#session')) return;
  const byId = Object.fromEntries(index.map(s => [s.id, s]));
  const byDay = index.reduce((m, s) => ((m[s.fecha] ||= []).push(s), m), {});
  Object.values(byDay).forEach(l => l.sort((a, b) => a.id.localeCompare(b.id, 'es', { numeric: true })));   // a day's sittings in the order they happened
  const fileId = id => String(id).replace(/[^A-Za-z0-9_-]/g, '_');
  const cache = {};
  const load = id => (cache[id] ??= fetch(`/assets/sessions/${fileId(id)}.json`).then(r => (r.ok ? r.json() : [])).catch(() => []));
  const state = { ids: [], recs: [], v: new Set(), tema: '', party: '', q: '' };
  const prerendered = $('#session').dataset.ids.split(',');
  // On /sesion/<id>.html the page IS one sitting: no rail, no calendar, no switching.
  const SITTING_PAGE = document.body.classList.contains('sesion-page');
  const sittingUrl = id => `${FT.BASE_URL}/sesion/${fileId(id)}.html`;
  const HOME_TITLE = document.title;

  // ── Hero counters ────────────────────────────────────────────────────────
  document.querySelectorAll('.hero-stats [data-count]').forEach(el => {
    const to = +el.dataset.count;
    if (reduce) { el.textContent = fmt(to); return; }
    const t0 = performance.now() + 300, dur = 1400;
    const step = t => {
      const p = Math.max(0, Math.min(1, (t - t0) / dur));
      el.textContent = fmt(Math.round(to * (1 - Math.pow(1 - p, 4))));
      if (p < 1) requestAnimationFrame(step);
    };
    el.textContent = '0'; requestAnimationFrame(step);
  });

  // ── Rail ─────────────────────────────────────────────────────────────────
  const rail = $('#rail') || document.createElement('ol');
  document.querySelectorAll('[data-rail]').forEach(b => b.addEventListener('click', () =>
    rail.scrollBy({ left: +b.dataset.rail * Math.max(300, rail.clientWidth * 0.8), behavior: reduce ? 'auto' : 'smooth' })));
  rail.addEventListener('click', e => {
    const a = e.target.closest('a[data-s]'); if (!a || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault(); select([a.dataset.s], { push: true, scroll: true });
  });
  const markRail = () => rail.querySelectorAll('a[data-s]').forEach(a => {
    const on = state.ids.includes(a.dataset.s);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });

  // ── Calendar ─────────────────────────────────────────────────────────────
  const calBtn = $('#cal-btn') || document.createElement('button'), cal = $('#cal') || document.createElement('div');
  let calMonth = new Date(index[0].fecha + 'T12:00:00');
  function drawCal() {
    const y = calMonth.getFullYear(), m = calMonth.getMonth();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7, n = new Date(y, m + 1, 0).getDate();
    const cells = ['L', 'M', 'X', 'J', 'V', 'S', 'D'].map(d => `<span class="dow">${d}</span>`);
    for (let i = 0; i < lead; i++) cells.push('<span></span>');
    for (let d = 1; d <= n; d++) {
      const key = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`, ss = byDay[key];
      if (!ss) { cells.push(`<span>${d}</span>`); continue; }
      const deb = ss.every(s => s.tipo !== 'PL'), cur = ss.some(s => state.ids.includes(s.id));
      const label = ss.map(s => `${s.title} (${s.n})`).join(' · ');
      cells.push(`<button type="button" data-day="${key}" class="${deb ? 'deb' : ''}"${cur ? ' aria-current="date"' : ''} title="${esc(label)}" aria-label="${esc(label)}">${d}</button>`);
    }
    const title = calMonth.toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
    const has = dm => index.some(s => s.fecha.startsWith(dm));
    const prev = new Date(y, m - 1, 1), next = new Date(y, m + 1, 1);
    const ym = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    cal.innerHTML = `<div class="cal-head"><button class="icon-btn" data-m="-1" aria-label="Mes anterior"${has(ym(prev)) || prev > new Date(index.at(-1).fecha) ? '' : ' disabled'}>←</button>`
      + `${title[0].toUpperCase() + title.slice(1)}<button class="icon-btn" data-m="1" aria-label="Mes siguiente"${next <= new Date(index[0].fecha + 'T12:00:00') ? '' : ' disabled'}>→</button></div>`
      + `<div class="cal-grid">${cells.join('')}</div><div class="cal-legend"><span><i></i>Pleno</span><span><i class="deb"></i>Debate</span></div>`;
  }
  cal.addEventListener('click', e => {
    e.stopPropagation();
    const mb = e.target.closest('[data-m]');
    if (mb) { calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + +mb.dataset.m, 1); drawCal(); return; }
    const db = e.target.closest('[data-day]');
    if (db) { closeCal(); select(byDay[db.dataset.day].map(s => s.id), { push: true, scroll: true }); }
  });
  const closeCal = () => { cal.hidden = true; calBtn.setAttribute('aria-expanded', 'false'); };
  calBtn.addEventListener('click', e => {
    e.stopPropagation();
    const open = cal.hidden; cal.hidden = !open; calBtn.setAttribute('aria-expanded', String(open));
    if (open) { const s = byId[state.ids[0]]; if (s) calMonth = new Date(s.fecha + 'T12:00:00'); drawCal(); }
  });
  document.addEventListener('click', e => { if (!cal.hidden && !cal.contains(e.target) && e.target !== calBtn) closeCal(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') closeCal(); });

  // ── Filters ──────────────────────────────────────────────────────────────
  const msel = $('#f-res'), mselBtn = $('.msel-btn', msel), mselPop = $('.msel-pop', msel);
  mselBtn.addEventListener('click', e => { e.stopPropagation(); const open = mselPop.hidden; mselPop.hidden = !open; mselBtn.setAttribute('aria-expanded', String(open)); });
  document.addEventListener('click', e => { if (!mselPop.hidden && !msel.contains(e.target)) { mselPop.hidden = true; mselBtn.setAttribute('aria-expanded', 'false'); } });
  mselPop.addEventListener('change', e => { const k = e.target.value; state.v.has(k) ? state.v.delete(k) : state.v.add(k); update(); });
  $('#x-stack').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; const k = b.dataset.v; state.v.has(k) ? state.v.delete(k) : state.v.add(k); update(); });
  $('#f-tema').addEventListener('change', e => { state.tema = e.target.value; update(); });
  $('#f-party').addEventListener('change', e => { state.party = e.target.value; update(); });
  let qT; $('#f-q').addEventListener('input', e => { clearTimeout(qT); qT = setTimeout(() => { state.q = e.target.value.trim(); update(); }, 120); });
  $('#f-clear').addEventListener('click', () => { clearFilters(); update(); });
  $('#filters-toggle').addEventListener('click', e => {
    const open = !$('#panel').classList.contains('open');
    $('#panel').classList.toggle('open', open); e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  function clearFilters() {
    state.v.clear(); state.tema = state.party = state.q = '';
    $('#f-tema').value = $('#f-party').value = $('#f-q').value = '';
  }
  const tally = (arr, f) => arr.reduce((m, c) => { const k = f(c); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
  const options = (o, label) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<option value="${esc(k)}">${esc(label(k))} (${n})</option>`).join('');
  function fillSelects() {
    $('#f-tema').innerHTML = '<option value="">Temática</option>' + options(tally(state.recs, r => r.tm || 'other'), temaLabel);
    $('#f-party').innerHTML = '<option value="">Partido</option>' + options(tally(state.recs, r => r.p), p => p);
  }

  const base = () => {
    const q = norm(state.q);
    return state.recs.filter(r => (!state.tema || (r.tm || 'other') === state.tema) && (!state.party || r.p === state.party)
      && (!q || (r._q ??= norm(`${r.t} ${r.n} ${r.p}`)).includes(q)));
  };
  const hl = t => {
    if (!state.q) return null;
    const re = new RegExp(esc(state.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return esc(t).replace(re, m => `<mark>${m}</mark>`);
  };
  const toCard = (r, i) => cardHTML({ url: `/claim/${r.u}.html`, text: r.t, verdict: r.v, name: r.n, party: r.p, photo: r.f, tema: r.tm, geo: r.g, id: r.i }, { index: i, inner: hl(r.t) });

  function update({ grid = true } = {}) {
    const b = base();
    const visible = b.filter(r => !state.v.size || state.v.has(r.v));   // speaking order, as built
    try { sessionStorage.setItem('ft-order', JSON.stringify(visible.map(r => `/claim/${r.u}.html`))); } catch {}
    const counts = Object.fromEntries(V.map(v => [v.k, 0])); b.forEach(r => counts[r.v]++);
    mselPop.innerHTML = V.filter(v => counts[v.k] || state.v.has(v.k)).map(v => `<label class="msel-opt" style="--c:${v.c}">
      <input type="checkbox" value="${v.k}"${state.v.has(v.k) ? ' checked' : ''} /><span class="vi" aria-hidden="true">${v.i}</span><span>${esc(v.long)}</span><span class="n">${counts[v.k]}</span></label>`).join('');
    const n = $('.msel-n', msel); n.hidden = !state.v.size; n.textContent = state.v.size;
    msel.classList.toggle('is-set', state.v.size > 0);
    const active = state.v.size + !!state.tema + !!state.party + !!state.q;
    $('#f-clear').hidden = !active;
    $('#ft-badge').hidden = !active; $('#ft-badge').textContent = active;
    const stack = $('#x-stack');
    stack.classList.toggle('is-filtering', state.v.size > 0);
    stack.querySelectorAll('[data-v]').forEach(btn => {
      const k = btn.dataset.v; btn.title = `${VK[k].long}: ${counts[k]}`;
      btn.classList.toggle('on', state.v.has(k)); btn.style.setProperty('--w', counts[k]);
    });
    stack.setAttribute('aria-label', V.map(v => `${v.long}: ${counts[v.k]}`).join(', '));
    $('#x-legend').innerHTML = V.filter(v => counts[v.k]).map(v => `<li style="--c:${v.c}"><span class="dot"></span>${esc(v.l)} <span class="num">${counts[v.k]}</span></li>`).join('');
    const total = state.recs.length;
    const line = visible.length === total ? `<strong>${fmt(total)}</strong> afirmaciones` : `<strong>${fmt(visible.length)}</strong> de ${fmt(total)}`;
    $('#count-line').innerHTML = line; $('#ft-count').innerHTML = line;
    if (grid) $('#grid').innerHTML = visible.length ? visible.map(toCard).join('') : '<p class="empty">Ninguna afirmación coincide con estos filtros.</p>';
  }

  // ── Session switching ───────────────────────────────────────────────────
  function renderHead(ss) {
    const s = ss[0], n = ss.reduce((a, x) => a + x.n, 0);
    $('#s-eyebrow').textContent = s.tipo === 'PL' ? `Congreso de los Diputados${s.leg ? ` · ${s.leg} Legislatura` : ''}` : 'Debate electoral';
    $('#session-title').textContent = ss.length > 1 ? `${s.title} · ${ss.length} sesiones` : s.title;
    const url = ss.length === 1 ? sittingUrl(s.id) : `${FT.BASE_URL}/?session=${ss.map(x => x.id).join(',')}`;
    $('#s-actions').innerHTML = ss.filter(x => x.pdf).map(x => `<a class="btn btn-ghost btn-sm" href="${esc(x.pdf)}" target="_blank" rel="noopener">Diario de sesiones${ss.length > 1 ? ` ${esc(x.id.split('-').pop())}` : ''} ↗</a>`).join('')
      + shareMenu(url, `${s.title}: ${n} afirmaciones verificadas en Facthem`, '<span>Compartir</span>');
    document.title = ss.length === 1 && s.id === index[0].id ? HOME_TITLE : `${s.title} — ${n} afirmaciones verificadas | Facthem`;
  }
  async function select(ids, { push = false, scroll = false } = {}) {
    ids = ids.filter(id => byId[id]);
    if (!ids.length) return;
    state.ids = ids; markRail(); clearFilters();
    $('#session').dataset.ids = ids.join(',');
    renderHead(ids.map(id => byId[id]));
    $('#grid').setAttribute('aria-busy', 'true');
    const parts = await Promise.all(ids.map(load));
    if (state.ids !== ids) return;   // a newer selection won
    state.recs = parts.flat();
    $('#grid').removeAttribute('aria-busy');
    fillSelects(); update();
    if (push) history.pushState({ ids }, '', ids[0] === index[0].id && ids.length === 1 ? location.pathname : `?session=${ids.join(',')}`);
    if (scroll) { const top = $('#session').getBoundingClientRect().top; if (top < 60 || top > innerHeight * 0.6) $('#session').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' }); }
    rail.querySelector('a[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
  }
  if (!SITTING_PAGE) addEventListener('popstate', () => select(idsFromUrl(), { scroll: true }));
  const idsFromUrl = () => {
    if (SITTING_PAGE) return prerendered;
    const raw = new URLSearchParams(location.search).get('session');
    const ids = (raw || '').split(',').map(s => s.trim()).filter(id => byId[id]);
    return ids.length ? ids : [index[0].id];
  };

  // Card click: name photo + text so the browser morphs them into the claim
  // page header (cross-document View Transitions, where supported).
  $('#grid').addEventListener('click', e => {
    const card = e.target.closest('.card'); if (!card || e.target.closest('.share')) return;
    const av = card.querySelector('.avatar'); if (av) av.style.viewTransitionName = 'claim-photo';
    card.querySelector('.claim-q').style.viewTransitionName = 'claim-text';
  });
  addEventListener('pageshow', () => document.querySelectorAll('#grid [style*="view-transition-name"]').forEach(el => { el.style.viewTransitionName = ''; }));

  // ── Start: hydrate the prerendered sitting, or render the one in the URL ──
  const want = idsFromUrl();
  if (want.join() === prerendered.join()) {
    state.ids = want; markRail();
    load(want[0]).then(recs => { state.recs = recs; update({ grid: false }); });
  } else {
    select(want);
  }
})();
