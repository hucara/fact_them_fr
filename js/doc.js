/* Text pages: highlight the section being read in the table of contents. */
(() => {
  const links = [...document.querySelectorAll('.doc-toc a')]; if (!links.length) return;
  const byId = new Map(links.map(a => [decodeURIComponent(a.hash.slice(1)), a]));
  const heads = [...byId.keys()].map(id => document.getElementById(id)).filter(Boolean);
  const mark = id => links.forEach(a => a.classList.toggle('on', a === byId.get(id)));
  const io = new IntersectionObserver(es => {
    const vis = es.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
    if (vis.length) mark(vis[0].target.id);
  }, { rootMargin: '-80px 0px -65% 0px' });
  heads.forEach(h => io.observe(h));
})();
