/* Claim page extras. The page is complete without this file (all content is
   in the HTML); it only adds:
   · ← / → to the previous / next claim, when the visitor came from a session
     grid (the home page stores the visible order in sessionStorage 'ft-order'
     as a list of claim paths);
   · keyboard: ← → (or k j) move, Esc goes back to the sitting. */
(() => {
  const main = document.getElementById('main'); if (!main) return;
  const here = location.pathname;
  let order = [];
  try { order = JSON.parse(sessionStorage.getItem('ft-order') || '[]'); } catch { order = []; }
  const at = order.indexOf(here);
  const prev = at > 0 ? order[at - 1] : null;
  const next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;
  const pager = document.getElementById('pager');
  if (pager && (prev || next)) {
    pager.innerHTML = (prev ? `<a class="icon-btn" href="${prev}" rel="prev" aria-label="Afirmación anterior">←</a>` : '')
      + (next ? `<a class="icon-btn" href="${next}" rel="next" aria-label="Afirmación siguiente">→</a>` : '');
  }
  const back = document.querySelector('.crumb-session')?.getAttribute('href') || '/';
  addEventListener('keydown', e => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable]')) return;
    if ((e.key === 'ArrowRight' || e.key === 'j') && next) location.href = next;
    else if ((e.key === 'ArrowLeft' || e.key === 'k') && prev) location.href = prev;
    else if (e.key === 'Escape' && !document.querySelector('.share-pop:not([hidden]), .mnav:not([hidden])')) location.href = back;
  });
})();
