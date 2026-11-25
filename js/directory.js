/* Representantes: search, party filter and order over the prerendered list.
   The HTML already holds everyone A–Z, so the page works without this file. */
(() => {
  const list = document.getElementById('dir'); if (!list) return;
  const $ = id => document.getElementById(id);
  const { norm, fmt } = window.FT;
  const items = [...list.children].map(li => { const a = li.firstElementChild; return { li, o: a.dataset.o, p: a.dataset.p, k: +a.dataset.k, m: +a.dataset.m, q: a.dataset.q }; });
  const st = { q: '', p: '', o: 'az' };
  const sorters = { az: (a, b) => a.o.localeCompare(b.o, 'es'), k: (a, b) => b.k - a.k || a.o.localeCompare(b.o, 'es'), m: (a, b) => b.m - a.m || a.o.localeCompare(b.o, 'es') };
  // Restore the last search when coming back from a profile.
  try { Object.assign(st, JSON.parse(sessionStorage.getItem('ft-dir') || '{}')); } catch {}
  $('d-q').value = st.q; $('d-p').value = st.p; $('d-o').value = st.o;
  // One letter off ("sanches", "feijo", "rufian"): a word matches when it, or
  // its start, is within one edit of the term. Only used when nothing matches exactly.
  const near = (a, b) => {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  };
  const fuzzy = (q, t) => t.length >= 4 && q.split(/[\s,.-]+/).some(w =>
    near(t, w) || [t.length - 1, t.length, t.length + 1].some(n => n >= 4 && n < w.length && near(t, w.slice(0, n))));
  function apply(save = true) {
    const terms = norm(st.q).split(/\s+/).filter(Boolean);
    const inParty = i => !st.p || i.p === st.p;
    let shown = items.filter(i => inParty(i) && terms.every(t => i.q.includes(t)));
    const approx = !shown.length && terms.length > 0;
    if (approx) shown = items.filter(i => inParty(i) && terms.every(t => i.q.includes(t) || fuzzy(i.q, t)));
    const set = new Set(shown);
    items.forEach(i => { i.li.hidden = !set.has(i); });
    shown.sort(sorters[st.o] || sorters.az).forEach(i => list.appendChild(i.li));
    // Until the reader searches, filters or reorders, only the featured cards show.
    const browsing = !!(st.q || st.p || st.o !== 'az');
    list.hidden = !browsing; $('dir-top').hidden = browsing;
    $('d-n').innerHTML = `<strong>${fmt(shown.length)}</strong> representante${shown.length === 1 ? '' : 's'}`
      + (approx && shown.length ? ' <span class="muted">· parecidos a tu búsqueda</span>' : '');
    $('d-empty').hidden = !browsing || shown.length > 0;
    if (save) sessionStorage.setItem('ft-dir', JSON.stringify(st));
  }
  $('d-q').addEventListener('input', e => { st.q = e.target.value.trim(); apply(); });
  $('d-p').addEventListener('change', e => { st.p = e.target.value; apply(); });
  $('d-o').addEventListener('change', e => { st.o = e.target.value; apply(); });
  // ?q= deep link (also the WebSite SearchAction target)
  const q = new URLSearchParams(location.search).get('q');
  if (q) { st.q = q; $('d-q').value = q; }
  $('d-more').addEventListener('click', () => $('d-q').focus());
  apply(false);
})();
