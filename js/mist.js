/**
 * Mist effect — fixed canvas at the bottom of the viewport.
 * Soft radial-gradient puffs drift slowly left/right, fading in and out.
 * Tuned to the dark rose-burgundy palette of portada.png.
 */

(function () {
  const PUFF_COUNT   = 24;
  const CANVAS_H     = 360;    // px — mist height from bottom
  const BASE_ALPHA   = 0.25;   // max opacity of a single puff
  const DRIFT_SPEED  = 0.14;   // px per frame horizontal drift (slower = dreamier)
  const BREATHE_FREQ = 0.0006; // alpha oscillation frequency

  // Warm rose-grey palette tuned to the hero image
  const COLORS = [
    '200, 96, 122',   // accent rose
    '185, 155, 160',  // warm grey
    '215, 195, 198',  // pale warm white
    '160, 110, 125',  // muted rose-grey
    '170, 70, 100',   // deeper rose
    '140, 100, 110',  // dusty mauve
  ];

  // ── Canvas setup ────────────────────────────────────────────────────────────
  const hero = document.querySelector('.hero');
  if (!hero) return;   // no hero, no mist

  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-hidden', 'true');
  Object.assign(canvas.style, {
    position:      'absolute',   // anchored to .hero, scrolls with it
    bottom:        '0',
    left:          '0',
    width:         '100%',
    height:        CANVAS_H + 'px',
    pointerEvents: 'none',
    zIndex:        '2',          // above hero gradient (::after), below nothing critical
    mixBlendMode:  'screen',
  });
  hero.appendChild(canvas);

  const ctx = canvas.getContext('2d');

  // ── Puff factory ────────────────────────────────────────────────────────────
  function randomPuff(forceX) {
    const w = canvas.width;
    return {
      x:     forceX !== undefined ? forceX : Math.random() * w,
      y:     CANVAS_H * (0.35 + Math.random() * 0.65), // spread across lower 65%
      rx:    180 + Math.random() * 280,  // larger horizontal radius
      ry:    60  + Math.random() * 110,  // taller vertical radius
      dx:    (Math.random() < 0.5 ? -1 : 1) * (DRIFT_SPEED * (0.35 + Math.random())),
      phase: Math.random() * Math.PI * 2,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      peakA: BASE_ALPHA * (0.45 + Math.random() * 0.9),
    };
  }

  // ── Resize handler ──────────────────────────────────────────────────────────
  function resize() {
    canvas.width  = window.innerWidth;
    canvas.height = CANVAS_H;
  }
  resize();
  window.addEventListener('resize', resize, { passive: true });

  // ── Populate puffs spread across the canvas ──────────────────────────────
  const puffs = Array.from({ length: PUFF_COUNT }, (_, i) =>
    randomPuff((canvas.width / PUFF_COUNT) * i + Math.random() * (canvas.width / PUFF_COUNT))
  );

  // ── Render loop ─────────────────────────────────────────────────────────────
  let frame = 0;
  function tick() {
    frame++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    puffs.forEach(p => {
      // Drift horizontally, wrap around
      p.x += p.dx;
      if (p.x - p.rx > canvas.width) p.x = -p.rx;
      if (p.x + p.rx < 0)            p.x = canvas.width + p.rx;

      // Breathing alpha — slow sine wave
      const alpha = p.peakA * (0.35 + 0.65 * (0.5 + 0.5 * Math.sin(frame * BREATHE_FREQ + p.phase)));

      // Radial gradient: opaque core → transparent edge
      const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.rx);
      grd.addColorStop(0,    `rgba(${p.color}, ${alpha})`);
      grd.addColorStop(0.45, `rgba(${p.color}, ${alpha * 0.4})`);
      grd.addColorStop(1,    `rgba(${p.color}, 0)`);

      ctx.save();
      ctx.scale(1, p.ry / p.rx);           // flatten ellipse vertically
      ctx.beginPath();
      ctx.arc(p.x, p.y * (p.rx / p.ry), p.rx, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
      ctx.restore();
    });

    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
