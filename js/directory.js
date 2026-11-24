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
  function apply(save = true) {
    const terms = norm(st.q).split(/\s+/).filter(Boolean);
    const shown = items.filter(i => (!st.p || i.p === st.p) && terms.every(t => i.q.includes(t)));
    const set = new Set(shown);
    items.forEach(i => { i.li.hidden = !set.has(i); });
    shown.sort(sorters[st.o] || sorters.az).forEach(i => list.appendChild(i.li));
    $('d-n').innerHTML = `<strong>${fmt(shown.length)}</strong> representante${shown.length === 1 ? '' : 's'}`;
    $('d-empty').hidden = shown.length > 0;
    if (save) sessionStorage.setItem('ft-dir', JSON.stringify(st));
  }
  $('d-q').addEventListener('input', e => { st.q = e.target.value.trim(); apply(); });
  $('d-p').addEventListener('change', e => { st.p = e.target.value; apply(); });
  $('d-o').addEventListener('change', e => { st.o = e.target.value; apply(); });
  // ?q= deep link (also the WebSite SearchAction target)
  const q = new URLSearchParams(location.search).get('q');
  if (q) { st.q = q; $('d-q').value = q; }
  if (st.q || st.p || st.o !== 'az') apply(false);
})();
