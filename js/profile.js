/* Profile page: filter the claim cards that are already in the HTML
   (verdict, topic, free text). Groups with nothing left are hidden. */
(() => {
  const list = document.getElementById('r-list'); if (!list) return;
  const $ = id => document.getElementById(id);
  const { norm } = window.FT;
  const cards = [...list.querySelectorAll('.card')].map(el => ({ el, v: el.dataset.v, t: el.dataset.t, q: norm(el.querySelector('.claim-q').textContent) }));
  const st = { v: '', t: '', q: '' };
  function apply() {
    let shown = 0;
    for (const c of cards) {
      const ok = (!st.v || c.v === st.v) && (!st.t || c.t === st.t) && (!st.q || c.q.includes(st.q));
      c.el.hidden = !ok; if (ok) shown++;
    }
    list.querySelectorAll('.r-group').forEach(g => {
      const n = g.querySelectorAll('.card:not([hidden])').length;
      g.hidden = !n; const lbl = g.querySelector('.r-n'); if (lbl) lbl.textContent = n;
    });
    $('r-empty').hidden = shown > 0;
  }
  $('r-v')?.addEventListener('change', e => { st.v = e.target.value; apply(); });
  $('r-t')?.addEventListener('change', e => { st.t = e.target.value; apply(); });
  $('r-q')?.addEventListener('input', e => { st.q = norm(e.target.value.trim()); apply(); });
})();
