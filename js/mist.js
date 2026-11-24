/* Hero mist (replaces the first js/mist.js).
   Soft rose-grey fog drifting along the bottom ~40% of the hero:
   · four layers (high wisps, far, mid, near): bigger, fainter and slower at
     the back, so the fog has depth; sizes scale with the hero width so phones
     get finer puffs instead of a few giant blobs;
   · puffs are clusters of small blobs with carved holes, pre-drawn once as
     sprites and drawn at full resolution (DPR capped at 1.5);
   · parallax with scroll and pointer; the scroll also zooms the hero image
     (--hero-zoom, up to 1.3×);
   · pauses off screen and in hidden tabs; prefers-reduced-motion: one still frame. */
(() => {
  const hero = document.querySelector('.hero');
  if (!hero) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const COLORS = ['217,112,138', '185,155,160', '215,195,198', '160,110,125', '170,70,100', '140,100,110'];
  const LAYERS = [
    { n: 5,  r: [160, 260], y: [0.12, 0.42], a: [0.14, 0.24], v: 0.05, par: 4 },  // high wisps
    { n: 9,  r: [240, 380], y: [0.40, 0.90], a: [0.22, 0.34], v: 0.07, par: 5 },  // far
    { n: 10, r: [170, 280], y: [0.65, 1.00], a: [0.26, 0.40], v: 0.14, par: 11 }, // mid
    { n: 7,  r: [110, 200], y: [0.78, 1.05], a: [0.30, 0.45], v: 0.26, par: 20 }, // near
  ];
  const SCALE = Math.min(1.5, devicePixelRatio || 1); // full resolution, capped
  const rand = (a, b) => a + Math.random() * (b - a);

  const canvas = document.createElement('canvas');
  canvas.className = 'mist';
  canvas.setAttribute('aria-hidden', 'true');
  hero.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  // Puff sprites are clusters of small soft blobs, not one round gradient:
  // lumpy, wispy edges read as fog instead of blur. 3 shapes per colour.
  const blob = (g, x, y, r, c, a) => {
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(${c},${a})`); grd.addColorStop(.5, `rgba(${c},${a * .45})`); grd.addColorStop(1, `rgba(${c},0)`);
    g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  const sprites = COLORS.flatMap(c => [0, 1, 2].map(() => {
    const S = 256, s = document.createElement('canvas'); s.width = s.height = S;
    const g = s.getContext('2d');
    blob(g, S / 2, S / 2, S * .46, c, .35);                            // soft body
    for (let i = 0; i < 14; i++) {                                      // wisps
      const ang = Math.random() * Math.PI * 2, d = Math.random() * S * .3;
      blob(g, S / 2 + Math.cos(ang) * d, S / 2 + Math.sin(ang) * d * .7, S * rand(.08, .2), c, rand(.25, .6));
    }
    // carve faint holes so the fog isn't uniform
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 6; i++) blob(g, S * rand(.2, .8), S * rand(.3, .7), S * rand(.05, .12), '0,0,0', rand(.2, .45));
    return s;
  }));

  let W = 0, H = 0, puffs = [];
  function build() {
    W = Math.ceil(canvas.clientWidth * SCALE); H = Math.ceil(canvas.clientHeight * SCALE);
    canvas.width = W; canvas.height = H;
    // Size puffs to the hero, not in fixed px: on a phone the desktop sizes
    // become a few giant blobs that cover everything.
    const k = Math.max(0.32, Math.min(1, canvas.clientWidth / 1200));
    const fade = k < 0.6 ? 0.8 : 1;
    puffs = LAYERS.flatMap((L, li) => { const n = Math.max(4, Math.round(L.n * (0.55 + 0.45 * k))); return Array.from({ length: n }, (_, i) => ({
      li, L,
      x: (W / n) * (i + Math.random()),
      y: H * rand(...L.y),
      rx: rand(...L.r) * k * SCALE, flat: rand(0.34, 0.5),
      dx: (Math.random() < .5 ? -1 : 1) * L.v * rand(.6, 1.3) * SCALE * (0.5 + 0.5 * k),
      a: rand(...L.a) * fade, ph: Math.random() * Math.PI * 2, bob: rand(.6, 1.4),
      sp: sprites[Math.floor(Math.random() * sprites.length)],
    })); });
  }

  // Parallax inputs: scroll through the hero, and pointer offset (desktop).
  let sy = 0, px = 0, tpx = 0;
  // Scroll: feeds the mist parallax and zooms the hero image (up to 1.3×).
  const onScroll = () => {
    sy = Math.min(1, scrollY / (hero.offsetHeight || 1));
    if (!still) hero.style.setProperty('--hero-zoom', (1 + sy * 0.3).toFixed(4));
  };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  hero.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') tpx = (e.clientX / innerWidth - .5) * 2; });
  hero.addEventListener('pointerleave', () => { tpx = 0; });

  let t = 0, raf = 0, running = false;
  function draw() {
    ctx.clearRect(0, 0, W, H);
    px += (tpx - px) * 0.04;                               // eased pointer
    for (const p of puffs) {
      if (!still) {
        p.x += p.dx;
        if (p.x - p.rx > W) p.x = -p.rx; else if (p.x + p.rx < 0) p.x = W + p.rx;
      }
      const breathe = 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(t * 0.0009 * p.bob + p.ph));
      const ox = -px * p.L.par * SCALE;                      // near layers move more
      const oy = (-sy * p.L.par * 2.2 + Math.sin(t * 0.0006 + p.ph) * 3) * SCALE;
      const ry = p.rx * p.flat;
      ctx.globalAlpha = p.a * breathe;
      ctx.drawImage(p.sp, p.x - p.rx + ox, p.y - ry + oy, p.rx * 2, ry * 2);
    }
    ctx.globalAlpha = 1;
  }
  function tick(ts) { t = ts; draw(); if (running) raf = requestAnimationFrame(tick); }
  const start = () => { if (running || still) return; running = true; raf = requestAnimationFrame(tick); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };

  build(); draw();
  new ResizeObserver(() => { build(); draw(); }).observe(canvas);
  new IntersectionObserver(([e]) => (e.isIntersecting && !document.hidden ? start() : stop())).observe(hero);
  document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
  if (still) draw();
})();
