/* Salary figures land like a slot machine: each digit spins down its reel and
   settles, left to right. The text stays the same for readers (aria-label).
   Clicking a figure spins them again (not while a spin is running). The
   breakdown table never spins. */
(() => {
  const box = document.querySelector('.sum-sal'); if (!box) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const REEL = '0123456789'.repeat(3).split('').map(d => `<span>${d}</span>`).join('');
  const SPIN = 700, STEP = 110, GAP = 120;   // ms: first reel, each next reel, second figure
  const figs = [...box.querySelectorAll('.sum-line b')];
  const texts = figs.map(b => b.textContent);
  let busyUntil = 0;
  function roll() {
    let longest = 0;
    figs.forEach((el, k) => {
      let i = 0;
      el.setAttribute('aria-label', texts[k]); el.classList.add('roll');
      el.innerHTML = [...texts[k]].map(ch => /\d/.test(ch)
        ? `<span class="rd" aria-hidden="true"><span class="rd-reel" style="--n:${20 + +ch};--d:${SPIN + i++ * STEP}ms;--w:${k * GAP}ms">${REEL}</span><span class="rd-sz">${ch}</span></span>`
        : `<span aria-hidden="true">${ch}</span>`).join('');
      longest = Math.max(longest, k * GAP + SPIN + Math.max(0, i - 1) * STEP);
    });
    busyUntil = performance.now() + longest;
  }
  roll();
  figs.forEach(b => {
    b.style.cursor = 'pointer'; b.title = 'Girar otra vez';
    b.addEventListener('click', e => {
      e.preventDefault();   // a figure spins; the rest of the row opens the breakdown
      if (performance.now() >= busyUntil) roll();
    });
  });
})();

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
