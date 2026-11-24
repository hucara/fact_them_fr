/* Facthem — directo
 *
 * Renders the live event stream. The one non-obvious mechanic: the page runs
 * on its own *viewer clock*, not on the <video> element's currentTime.
 *
 * The pipeline runs ahead of the viewer — that head start is what pays for the
 * LLM. So the page keeps a clock chasing `pipelineTime - delay`, reveals each
 * event when the clock passes its media timestamp, and slaves the video to the
 * clock. Tying reveal to the video instead meant a blocked autoplay froze the
 * entire feed at zero, which is exactly what it looked like: nothing happening.
 */

// The public page has no operator markup at all (page.py strips it), so an
// id may be missing: hand back a detached element and the code that drives
// the admin controls runs against nothing instead of crashing.
const _stubs = {};
const $ = (id) => document.getElementById(id) || (_stubs[id] ||= document.createElement('div'));

/* ── motion helpers ──────────────────────────────────────────────────────
   Motion is a signal ("this just changed"), never decoration: one-shot,
   short, and gone under prefers-reduced-motion. */
const reducedMotion = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);

// Nothing moves while the page is (re)building from history: a reload replays
// the whole session in one go, and eighty cards animating at once is noise,
// not information. Motion starts once the replay has settled.
let settled = false;
document.body.classList.add('settling');
if (window.LIVE_ADMIN) document.body.classList.add('admin');
function markSettled() {
  if (settled) return;
  settled = true;
  document.body.classList.remove('settling');
}
const motion = () => settled && !reducedMotion;

// Re-trigger a one-shot CSS animation class on an element.
function pulseClass(el, cls, ms = 1000) {
  if (!el || !motion()) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
  clearTimeout(el._pulseT?.[cls]);
  (el._pulseT ||= {})[cls] = setTimeout(() => el.classList.remove(cls), ms);
}
const bumpEl = (el) => pulseClass(el, 'bump', 450);

// FLIP: children of `container` matched by `keyOf` glide from where they were
// to where `run()` puts them, so a list reorder or an insert at the top reads
// as movement rather than a jump. New children get `flip-new`.
function flipChildren(container, selector, keyOf, run) {
  if (!motion() || !Element.prototype.animate) { run(); return; }
  const before = new Map();
  for (const el of container.querySelectorAll(selector)) { const k = keyOf(el); if (k) before.set(k, el.getBoundingClientRect()); }
  run();
  for (const el of container.querySelectorAll(selector)) {
    const k = keyOf(el);
    const b = k && before.get(k);
    if (!b) { if (before.size) { el.classList.add('flip-new'); setTimeout(() => el.classList.remove('flip-new'), 400); } continue; }
    const a = el.getBoundingClientRect();
    const dx = b.left - a.left, dy = b.top - a.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
      { duration: 340, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}

/* ── verdict vocabulary (shared with the rest of Facthem) ───────────────── */
const RESULTADO_LABELS = {
  CONFIRMADO: 'Confirmado',
  CONFIRMADO_CON_MATIZ: 'Confirmado con matiz',
  DESCONTEXTUALIZADO: 'Descontextualizado',
  FALSO: 'Falso',
  IMPRECISO: 'Inexacto',
  NO_VERIFICABLE: 'No verificable',
  SOBREESTIMADO: 'Sobreestimado',
  SUBESTIMADO: 'Subestimado',
};

/* Same tag as the rest of facthem.es (site_chrome.VERDICTS / js/ui.js): a
   coloured square with a symbol, then the label. Order = display order. */
const VERDICTS = [
  ['CONFIRMADO', 'Confirmado', 'Confirmado', '✓', 'var(--v-ok)'],
  ['CONFIRMADO_CON_MATIZ', 'Con matiz', 'Confirmado con matiz', '≈', 'var(--v-matiz)'],
  ['SOBREESTIMADO', 'Sobreestimado', 'Sobreestimado', '↑', 'var(--v-sobre)'],
  ['SUBESTIMADO', 'Subestimado', 'Subestimado', '↓', 'var(--v-sub)'],
  ['IMPRECISO', 'Inexacto', 'Inexacto', '~', 'var(--v-impreciso)'],
  ['DESCONTEXTUALIZADO', 'Descontextualizado', 'Descontextualizado', '⋯', 'var(--v-descontext)'],
  ['FALSO', 'Falso', 'Falso', '✕', 'var(--v-falso)'],
  ['NO_VERIFICABLE', 'No verificable', 'No verificable', '?', 'var(--v-nv)'],
];
const VKEY = Object.fromEntries(VERDICTS.map((v) => [v[0], v]));
const verdictKey = (r) => { const k = String(r || '').trim().toUpperCase().replaceAll(' ', '_'); return VKEY[k] ? k : 'NO_VERIFICABLE'; };
const vtagInner = (k) => `<span class="vi" aria-hidden="true">${VKEY[k][3]}</span>${esc(VKEY[k][2])}`;

function resultadoToClass(resultado) {
  const map = {
    CONFIRMADO: 'verdadero',
    CONFIRMADO_CON_MATIZ: 'parcial',
    DESCONTEXTUALIZADO: 'enganoso',
    IMPRECISO: 'nv',
    FALSO: 'falso',
    NO_VERIFICABLE: 'nv',
    SOBREESTIMADO: 'enganoso',
    SUBESTIMADO: 'enganoso',
  };
  return map[String(resultado || '').toUpperCase().replaceAll(' ', '_')] ?? 'nv';
}

const SOURCE_LABEL = {
  face: 'reconocimiento facial · quien mueve la boca',
  face_onscreen: 'reconocimiento facial · en pantalla',
  face_sticky: 'reconocimiento facial · mantenido (sigue pareciendo la misma persona)',
  face_carry: 'última identidad conocida (sin cara en plano)',
  voice: 'reconocimiento de voz',
  voice_override: 'reconocimiento de voz (en pantalla, otra persona)',
  hint: 'etiqueta del subtítulo',
  roundrobin: 'turno estimado',
  unknown: 'sin identificar',
};

/* ── state ──────────────────────────────────────────────────────────────── */
let session = null;
let VOCAB = {};                 // claim-field vocabularies, from /vocabularies
let rosterByKey = new Map();
const claims = new Map();       // claim_id → {el, startedAt, done}
const heldVerdicts = new Map(); // verdicts that arrived before their claim card
let pending = [];               // events the viewer clock hasn't reached yet
let delaySeconds = 180;
let liveMode = true;            // see "live mode" below; declared here because applyDebug() runs at load
let adminOn = false;            // set only once the runner has accepted the token (setupAdmin)
let adminToken = '';
let canSeekRunner = false;
let savedDelay = null;
try { liveMode = localStorage.getItem('facthem-live-mode') !== '0'; } catch { /* ignore */ }
/* Scrubbing the video does not change the delay: the delay is the viewer's
   setting, the scrub is a temporary displacement on top of it. The clock
   chases `pipelineTime - delaySeconds - scrubOffset`; Sincronizar clears the
   displacement. Positive = further back in the debate than the delay alone. */
let scrubOffset = 0;
let pipelineTime = 0;
let clock = 0;
let clockLastMs = null;
let autoplayOk = true;
let sessionEnded = false;       // source finished: clock stops chasing pipelineTime
let holding = false;            // picture ran ahead of the clock; paused, not rewound
const stats = {};

const player = $('player');

/* ── modes ────────────────────────────────────────────────────────────────
   'ws'      → local FastAPI (POST /debates + WebSocket). Media is a file.
   'buckets' → static page polling immutable JSON buckets published by
               fact_them_be.live.run (aton → R2 / dir). Media is YouTube.
   Detected at boot: sessions/current.json wins if it exists. */
let mode = 'ws';
let bucketCfg = null;      // sessions/current.json
let nextBucket = 0;        // next bucket to fetch
let bucketMisses = 0;
let bucketBase = '';
let yt = null;             // YT.Player
let ytReady = false;
let ytOffset = null;       // YouTube currentTime − pipeline media time
let seeking = false;
let replayMode = false;    // diferido: a past session replayed against a YouTube video
let replayEvents = [];     // the whole replay file, sorted by media time



/* ── helpers ────────────────────────────────────────────────────────────── */
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mmss = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return h ? `${h}:${mmss}` : mmss;
};
const esc = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function photoFor(sp) {
  if (!sp) return '';
  return (rosterByKey.get(sp.politician_id) || rosterByKey.get(sp.name))?.photo_url || '';
}
/* First name + first surname. The roster carries it from the DB; for a
   speaker not in the roster, a heuristic on the display form. */
const PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'do', 'dos', 'van', 'von', 'di']);
const COMPOUND_FIRST = new Set(['jose', 'josé', 'maria', 'maría', 'juan', 'ana', 'luis', 'miguel', 'francisco', 'carlos', 'angel', 'ángel', 'jesus', 'jesús', 'pedro', 'antonio', 'rosa', 'marta', 'jaime', 'enrique', 'gabriel']);
function shortName(sp) {
  if (!sp) return '';
  const entry = rosterByKey.get(sp.politician_id) || rosterByKey.get(sp.name);
  if (entry?.short_name) return entry.short_name;
  const toks = String(sp.name || '').split(/\s+/).filter(Boolean);
  if (toks.length <= 2) return toks.join(' ');
  let i = 1;
  if (COMPOUND_FIRST.has(toks[0].toLowerCase()) && toks.length > 3) i = 2;  // "José María Figaredo …"
  const out = toks.slice(0, i);
  while (i < toks.length) { out.push(toks[i]); if (!PARTICLES.has(toks[i].toLowerCase())) break; i++; }
  return out.join(' ');
}
function partyFor(sp) {
  if (!sp) return '';
  return (rosterByKey.get(sp.politician_id) || rosterByKey.get(sp.name))?.party || '';
}
const partyChip = (party) => (party ? `<span class="party">${esc(party)}</span>` : '');

/* ── bootstrap ──────────────────────────────────────────────────────────── */
function dataBase() {
  const q = new URLSearchParams(location.search).get('data');
  let base = q ?? (window.LIVE_DATA_BASE || '');
  if (base && !base.endsWith('/')) base += '/';
  return base;
}

async function fetchJSON(url, opts = {}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${url}`), { status: r.status });
  return r.json();
}

async function boot() {
  bucketBase = dataBase();
  const sid = new URLSearchParams(location.search).get('s');
  // A second runner (a TV debate beside the Congress stream) publishes its own
  // pointer: ?c=tv → sessions/current-tv.json. The runner's own page sets it.
  const channel = (new URLSearchParams(location.search).get('c') || window.LIVE_CHANNEL || '')
    .toLowerCase().replace(/[^a-z0-9-]/g, '');
  // 1. Published buckets (static hosting / aton). The manifest is the only
  //    mutable object, so it is fetched with the cache bypassed.
  try {
    const key = sid ? `sessions/${encodeURIComponent(sid)}.json`
      : channel ? `sessions/current-${channel}.json` : 'sessions/current.json';
    bucketCfg = await fetchJSON(bucketBase + key, { cache: 'no-store' });
    mode = 'buckets';
  } catch {
    bucketCfg = null;
  }
  try {
    VOCAB = await fetchJSON(mode === 'buckets' ? bucketBase + 'vocabularies.json' : '/vocabularies');
  } catch {
    VOCAB = {}; // tags fall back to raw values rather than not rendering
  }
  if (mode === 'buckets') { await bootBuckets(); return setupAdmin(); }

  // 2. Local API (WebSocket).
  let debates = [];
  try { debates = await fetchJSON('/debates'); } catch { debates = []; }
  if (!debates.length) {
    showIdle();
    return setupAdmin();
  }
  session = debates[debates.length - 1];
  applySession();
  if (session.video_url) {
    player.hidden = false;
    player.src = session.video_url;
    player.load();
  }
  connect();
  setupAdmin();
}

/* The header's share button: the session as a whole. */
function renderSessionShare() {
  const url = liveShareUrl();
  const title = session?.title || 'el debate';
  const text = `${replayMode ? '▶️' : '🔴'} ${title}, verificado ${replayMode ? 'en diferido' : 'en directo'} en Facthem`;
  $('live-share').innerHTML = shareMenu(url, text, `${text} ${url}`, '<span>Compartir</span>');
  $('tb-share').innerHTML = shareMenu(url, text, `${text} ${url}`);
}

function applySession() {
  renderBreakdown();
  renderSessionShare();
  $('session-title').textContent = session.title || session.session_id;
  document.title = `${session.title || session.session_id} · Facthem directo`;
  rosterByKey = new Map();
  for (const r of session.roster || []) {
    if (r.politician_id) rosterByKey.set(r.politician_id, r);
    if (r.name) rosterByKey.set(r.name, r);
  }
  renderRail();
  renderStages(session.stages || {});
}

/* ── bucket mode ─────────────────────────────────────────────────────────
   Nothing here asks the server what is new. The page knows the wall clock
   and the bucket size, so it computes which immutable file to fetch next.
   Cold start: newest rollup (durable events so far) + the buckets after it. */
function closedBucket() {
  const bs = bucketCfg.bucket_seconds || 10;
  const grace = bucketCfg.grace_seconds ?? 2;
  return Math.floor((Date.now() / 1000 - grace) / bs) - 1;
}

/* No sitting being verified right now: nothing of the last session is shown
   (its claims are archived in the parliament DB), just where to find us.
   `?replay` (or `?s=<session>`) still opens the archive view of a session. */
const IDLE_FOLLOW =
  'síguenos en ' +
  '<a href="https://www.youtube.com/@facthem_es" target="_blank" rel="noopener">YouTube</a>, ' +
  '<a href="https://www.tiktok.com/@facthem_es" target="_blank" rel="noopener">TikTok</a> y ' +
  '<a href="https://x.com/facthem_es" target="_blank" rel="noopener">X</a>: ' +
  '<b>@facthem_es</b> y <b>@facthem_eu</b>.';
const IDLE_DONATE =
  '♥ Apóyanos: ' +
  '<a href="https://paypal.me/hcasero" class="donate-btn" target="_blank" rel="noopener">PayPal</a> ' +
  '<a href="https://ko-fi.com/hugocasero" class="donate-btn" target="_blank" rel="noopener">Ko-fi</a>';
const IDLE_HTML =
  '<p class="idle-late">¡Llegas tarde, Ana Pasteur!</p>' +
  'Ahora mismo no estamos verificando ningún pleno en directo.<br />' +
  'Vuelve otro día y ' + IDLE_FOLLOW +
  '<p class="idle-archive">Si buscas una sesión anterior, puedes verla en ' +
  '<a href="https://facthem.es/">facthem.es</a>.</p>' +
  '<p class="idle-donate">' + IDLE_DONATE + '</p>';
function showIdle() {
  sessionEnded = true;
  $('session-title').textContent = 'sin emisión';
  document.title = 'Facthem directo';
  $('onair').hidden = true;
  document.body.classList.add('idle');
  for (const sel of ['.live-stage', '#live-dist', '#weak-drawer', '#debug-current']) {
    const el = document.querySelector(sel);
    if (el) el.hidden = true;
  }
  // Grab the placeholder before emptying the feed: once removed from the
  // document it is no longer reachable by id.
  const empty = $('feed-empty');
  $('feed').replaceChildren(empty);
  empty.classList.add('idle');
  empty.innerHTML = IDLE_HTML;
  empty.hidden = false;
}

async function bootBuckets() {
  const replay = new URLSearchParams(location.search).has('replay') || new URLSearchParams(location.search).has('s');
  const forceDiferido = new URLSearchParams(location.search).has('diferido');
  if ((bucketCfg.status === 'ended' && !replay) || forceDiferido) {
    if (await bootReplay()) return;
    showIdle();
    return;
  }
  session = {
    session_id: bucketCfg.session_id,
    title: bucketCfg.title,
    roster: bucketCfg.roster || [],
    stages: bucketCfg.stages || {},
    youtube_id: bucketCfg.youtube_id,
    tv: bucketCfg.tv || null,
    hashtags: bucketCfg.hashtags || [],
  };
  applySession();
  delaySeconds = bucketCfg.delay_recommended ?? delaySeconds;
  // A TV channel is the viewer's own screen: the broadcast is already ahead of
  // the pipeline, so there is nothing to hold back — show verdicts as they come.
  if (session.tv) { delaySeconds = 0; setupTv(session.tv); }
  // A phone plays the stream where YouTube puts it — the live edge — and the
  // claims show as the pipeline emits them. No delay, no seeking the embed.
  if (mobileLive()) delaySeconds = 0;
  $('delay').value = delaySeconds;
  $('delay-val').textContent = delaySeconds;
  const ended = bucketCfg.status === 'ended';
  sessionEnded = ended;
  $('onair').hidden = ended;
  if (session.youtube_id) setupYouTube(session.youtube_id);

  // Cold start from the newest rollup we can find.
  const every = bucketCfg.rollup_every || 6;
  const first = bucketCfg.first_bucket ?? Math.floor(bucketCfg.wall0 / (bucketCfg.bucket_seconds || 10));
  let b = closedBucket();
  b -= ((b + 1) % every + every) % every;   // largest b ≤ closed with (b+1) % every == 0
  nextBucket = first;
  for (let tries = 0; tries < 6 && b >= first; tries++, b -= every) {
    try {
      const roll = await fetchJSON(`${bucketBase}roll/${b}.json`);
      for (const ev of roll.events || []) onEvent(ev);
      nextBucket = roll.upto_bucket + 1;
      break;
    } catch { /* not written (yet) — try the previous one */ }
  }
  if (ended) {
    // Archive view: everything is revealed, no polling.
    await pollBuckets(true);
    clock = pipelineTime + 1;
    flushPending();
    setTimeout(markSettled, 1500);
    return;
  }
  await pollBuckets(false);
  setTimeout(markSettled, 1500);
  setInterval(() => pollBuckets(false), 1000);
}

/* ── diferido: replaying a past session ─────────────────────────────────
   Nothing on air: the page replays the last debate as if it were live. The
   YouTube video is the clock (media t = video time − vod_offset); claims show
   when the video reaches them, sit in "Verificando" for as long as the
   verifier took (capped, see applyVerdict) and land their verdict. Any jump
   of the video — the viewer's own bar, a card's time — rebuilds the page at
   the new position without animation, so it always shows exactly what had
   been said and checked up to that moment.

   Which sessions and videos is set by hand: `python -m fact_them_be.live.replay
   set …` adds one to sessions/replay.json. With none chosen the page shows
   them in a grid (showReplayGrid); a card opens ?diferido=<session>. Testing a video before setting it:
   ?diferido=<session>&yt=<video id>&offset=<s>[&start=<s>]. On a set replay,
   ?offset= / ?start= override the pointer's values (to check an alignment). */
async function bootReplay() {
  const q = new URLSearchParams(location.search);
  const want = q.get('diferido');
  let ptr = null;
  if (want && q.get('yt')) {
    ptr = { status: 'replay', session_id: want, youtube_id: q.get('yt'), vod_offset: 0, start: 0,
            events: `replays/${encodeURIComponent(want)}.json` };
  } else {
    let pointer = null;
    try { pointer = await fetchJSON(`${bucketBase}sessions/replay.json`, { cache: 'no-store' }); } catch { pointer = null; }
    if (!pointer || pointer.status !== 'replay') return false;
    // The grid, newest first. A pointer of the first version is one session.
    const list = (pointer.sessions?.length ? pointer.sessions : [pointer]).filter((s) => s.youtube_id && s.events);
    if (!list.length) return false;
    ptr = want ? list.find((s) => s.session_id === want) : null;
    if (!ptr) { showReplayGrid(list); return true; }
    replayHasGrid = true;
    showPast(list.filter((s) => s.session_id !== want));
  }
  if (!ptr || !ptr.youtube_id || !ptr.events) return false;
  if (q.has('offset')) ptr.vod_offset = parseFloat(q.get('offset')) || 0;
  if (q.has('start')) ptr.start = parseFloat(q.get('start')) || 0;
  let data;
  try { data = await fetchJSON(bucketBase + ptr.events); } catch { return false; }

  replayMode = true;
  replayEvents = data.events || [];
  bucketCfg = { ...ptr, vod: true, status: 'ended', wall0: 0, delay_recommended: 0 };
  session = {
    session_id: ptr.session_id,
    title: data.title || ptr.title || ptr.session_id,
    roster: ptr.roster || [],
    stages: {},
    youtube_id: ptr.youtube_id,
    hashtags: ptr.hashtags || [],
  };
  applySession();
  document.body.classList.add('replay');
  $('session-title').textContent = session.title;   // the status above it says "Diferido"
  document.title = `${session.title} (diferido) · Facthem`;
  showDiferidoBadge();
  $('feed-empty').textContent = 'Las afirmaciones aparecerán a medida que se pronuncien en el vídeo.';
  showReplayBanner();
  sessionEnded = true;
  delaySeconds = 0;
  ytOffset = ptr.vod_offset || 0;
  pipelineTime = data.t_last || 0;
  setupYouTube(ptr.youtube_id);
  setTimeout(markSettled, 1500);
  // A sitting going live while someone watches the replay: say so.
  setInterval(checkLiveFromReplay, 60000);
  return true;
}

let replayHasGrid = false;   // the replay was picked from the grid: offer the way back

function showDiferidoBadge() {
  const badge = $('onair');
  badge.textContent = 'Diferido';
  badge.classList.add('diferido');
  badge.hidden = false;
}

/* The page's own URL with ?diferido=<session> (or without it, for the grid). */
function diferidoHref(sid) {
  const u = new URL(location.href);
  for (const k of ['diferido', 'yt', 'offset', 'start']) u.searchParams.delete(k);
  if (sid) u.searchParams.set('diferido', sid);
  return u.pathname + u.search;
}

function fmtDuration(sec) {
  const m = Math.round((sec || 0) / 60);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`;
}

/* "Debates anteriores" (mockup .past): one card per replayable debate —
   date, title, its verdict bar, the count — linking to ?diferido=<session>,
   so the choice can be shared and Back returns here. */
function pastCards(list) {
  return list.map((s) => {
    const cnt = {};
    for (const [res, n] of Object.entries(s.verdicts || {})) { const k = verdictKey(res); cnt[k] = (cnt[k] || 0) + n; }
    const total = Object.values(cnt).reduce((a, b) => a + b, 0) || s.claims || 0;
    const bar = VERDICTS.filter(([k]) => cnt[k]).map(([k, , long, , c]) =>
      `<span class="${k === 'SUBESTIMADO' ? 'hatch' : ''}" style="--c:${c};flex:${cnt[k]}" title="${esc(long)}: ${cnt[k]}"></span>`).join('');
    const when = [fmtDateEs(s.session_date), s.label].filter(Boolean).join(' · ');
    return `<a class="past-card" href="${esc(diferidoHref(s.session_id))}">`
      + (s.youtube_id ? `<span class="past-thumb" style="background-image:url(https://i.ytimg.com/vi/${encodeURIComponent(s.youtube_id)}/hqdefault.jpg)"><span class="past-play" aria-hidden="true">▶</span>${s.duration ? `<span class="past-dur">${fmtDuration(s.duration)}</span>` : ''}</span>` : '')
      + `<span class="muted">${esc(when)}</span><strong>${esc(s.title || s.session_id)}</strong>`
      + `<span class="mini-stack">${bar}</span><span class="muted">${total} afirmaciones · ver en diferido</span></a>`;
  }).join('');
}
function showPast(list) {
  if (!list.length) return;
  $('past-grid').innerHTML = pastCards(list);
  $('past').hidden = false;
}

/* Nothing on air and no session chosen: the note, and the debates to replay. */
function showReplayGrid(list) {
  sessionEnded = true;
  document.body.classList.add('replay-picker');
  $('session-title').textContent = 'Directos anteriores';
  document.title = 'Facthem directo · diferido';
  showDiferidoBadge();
  document.querySelector('.live-cols').hidden = true;
  const ban = $('replay-banner');
  ban.innerHTML =
    '<p class="rb-late">¡Llegas tarde, Ana Pasteur!</p>' +
    '<p class="rb-msg">Ahora mismo no estamos verificando nada en directo. ' +
    `Elige ${list.length > 1 ? 'un debate' : 'el último debate'} y míralo en diferido: ` +
    'las afirmaciones se verifican a medida que avanza el vídeo.</p>' +
    '<p class="rb-links">Para el próximo directo, ' + IDLE_FOLLOW + ' <span class="rb-donate">' + IDLE_DONATE + '</span></p>' +
    '<p class="rb-live" id="rb-live" hidden></p>';
  ban.hidden = false;
  closableBanner(ban);
  showPast(list);
  setInterval(checkLiveFromReplay, 60000);
}

function fmtDateEs(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return isNaN(d) ? iso : d.toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric' });
}

/* While a replay plays there is no "¡Llegas tarde!" note (that belongs to the
   picker grid): only the way back to the grid, in the session header, and —
   if a sitting goes live meanwhile — a one-line notice (checkLiveFromReplay). */
function showReplayBanner() {
  if (replayHasGrid && !document.querySelector('.live-back')) {
    document.querySelector('.live-head')?.insertAdjacentHTML('afterbegin',
      `<a class="live-back" href="${esc(diferidoHref(''))}">← Directos anteriores</a>`);
  }
  const el = $('replay-banner');
  el.innerHTML = '<p class="rb-live" id="rb-live" hidden></p>';
  el.hidden = true;   // shown only if the live notice fills it
}

/* The "¡Llegas tarde!" banner can be dismissed; it stays closed for the rest
   of the visit (sessionStorage), reloads included. */
const BANNER_KEY = 'facthem-live-banner-closed';
function closableBanner(el) {
  let closed = false;
  try { closed = sessionStorage.getItem(BANNER_KEY) === '1'; } catch { /* ignore */ }
  if (closed) { el.hidden = true; return; }
  if (el.querySelector('.rb-close')) return;
  el.insertAdjacentHTML('afterbegin', '<button type="button" class="rb-close" aria-label="Cerrar aviso">×</button>');
  el.querySelector('.rb-close').addEventListener('click', () => {
    el.hidden = true;
    try { sessionStorage.setItem(BANNER_KEY, '1'); } catch { /* ignore */ }
  });
}

async function checkLiveFromReplay() {
  let cfg = null;
  try { cfg = await fetchJSON(`${bucketBase}sessions/current.json`, { cache: 'no-store' }); } catch { return; }
  if (!cfg || cfg.status === 'ended' || cfg.listed === false) return;
  const el = $('rb-live');
  if (!el.hidden) return;
  el.innerHTML = `● Ahora estamos en directo: <a href="${esc(location.pathname)}">${esc(cfg.title || 'ver el directo')}</a>`;
  el.hidden = false;
  if (replayMode) $('replay-banner').hidden = false;
}

/* The video drives the clock. A position the passage of time cannot explain
   (a seek, a scrub, the first sample) rebuilds the page there. */
let replayLastCur = null;
let replayLastMs = 0;
let replayWasPlaying = false;
function tickReplay() {
  if (!yt || !ytReady) return;
  let cur, playing;
  try { cur = yt.getCurrentTime(); playing = yt.getPlayerState() === YT.PlayerState.PLAYING; } catch { return; }
  if (cur == null || isNaN(cur)) return;
  const nowMs = Date.now();
  const expected = replayLastCur == null ? null
    : replayLastCur + (replayWasPlaying ? (nowMs - replayLastMs) / 1000 : 0);
  replayLastCur = cur; replayLastMs = nowMs; replayWasPlaying = playing;
  const t = cur - ytOffset;
  pictureTime = t;
  if (expected == null || Math.abs(cur - expected) > 3) replayRebuild(t);
  else { clock = t; flushPending(); }
  updateFuture();
  tickPending();
  $('clock-emision').textContent = fmtTime(cur);
  $('clock-lag').textContent = 'diferido';
  $('clock-lag').hidden = false;
}

/* Empty the page and replay every event up to `t`, with motion off. */
function replayRebuild(t) {
  settled = false;
  document.body.classList.add('settling');
  claims.clear();
  heldVerdicts.clear();
  pending = [];
  for (const k of Object.keys(verdictCounts)) delete verdictCounts[k];
  for (const k of Object.keys(stats)) delete stats[k];
  speakerTimeline.length = 0;
  captionParts = [];
  $('caption').textContent = '';
  $('feed').querySelectorAll(':scope > .f-item').forEach((el) => el.remove());
  $('weak-list').replaceChildren();
  $('weak-drawer').hidden = true;
  $('weak-count').textContent = '0';
  clearNewAbove();
  $('feed-empty').hidden = false;
  clock = t;
  for (const ev of replayEvents) {
    // Old captions would only be overwritten: skip them.
    if (ev.type === 'transcript.final' && (ev.payload?.t_end ?? ev.t ?? 0) < t - 30) continue;
    onEvent(ev);
  }
  renderBreakdown();
  renderStats();
  rewindState();
  setTimeout(markSettled, 600);
}

let polling = false;
async function pollBuckets(drainAll) {
  if (polling) return;
  polling = true;
  try {
    const limit = drainAll ? closedBucket() + 1 : closedBucket();
    while (nextBucket <= limit) {
      let seg;
      try {
        seg = await fetchJSON(`${bucketBase}seg/${nextBucket}.json`);
      } catch (e) {
        // A missing bucket means the publisher is behind or down. Wait a
        // few polls for it, then step over it so one gap does not stall
        // the whole feed forever.
        bucketMisses++;
        if (bucketMisses < (drainAll ? 2 : 8)) return;
        bucketMisses = 0;
        nextBucket++;
        continue;
      }
      bucketMisses = 0;
      for (const ev of seg.events || []) onEvent(ev);
      nextBucket++;
    }
  } finally {
    polling = false;
  }
}

/* ── TV channel ───────────────────────────────────────────────────────────
   The runner publishes the channel's tokenised HLS master (`tv.hls`, Spain
   only, ~8 h). We play it in a <video> of its own — not #player, whose
   currentTime the bucket clock drives — at the live edge, where the pipeline
   also captures it. If it cannot play (abroad, expired token, no MSE) the box
   falls back to a pointer to the channel: second screen. */
const HLS_JS = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js';
const TV_HLS = /^https:\/\/atres-live\.atresmedia\.com\/[^\s"'<>]+\.m3u8$/;

// Off since 2026-11-13: the token only played from the IP that resolved it
// (aton), so every viewer got a broken player. The card is the default; turn
// this back on once the stream is served from our side or the token is open.
const TV_EMBED = false;

function setupTv(tv) {
  const wrap = document.querySelector('.player-wrap');
  if (!wrap || wrap.querySelector('.tv-video, .tv-card')) return;
  if (!TV_EMBED || !TV_HLS.test(tv.hls || '')) { setupSecondScreen(tv); return; }
  const video = document.createElement('video');
  video.className = 'tv-video';
  Object.assign(video, { controls: true, muted: true, autoplay: true, playsInline: true });
  wrap.appendChild(video);
  // A just-issued token answers errors for a few seconds (measured 2026-11-12:
  // the first load fails, the same URL plays a moment later), so retry before
  // giving up on the embed.
  const RETRIES = 5;
  let tries = 0, hls = null, done = false;
  const play = () => video.play().catch(() => {});  // muted autoplay; the controls cover the rest
  // hls.js wherever Media Source exists (Android, desktop): Android Chrome
  // claims native HLS but showed a broken player on 2026-11-13. Native only
  // where there is no MSE (iPhone Safari).
  const mse = !!(window.MediaSource || window.ManagedMediaSource);
  const native = !mse && video.canPlayType('application/vnd.apple.mpegurl') !== '';
  const fail = (why) => {
    if (done) return;
    if (hls) { hls.destroy(); hls = null; }
    if (++tries <= RETRIES) {
      console.warn(`tv: stream error (${why}), retry ${tries}/${RETRIES}`);
      setTimeout(load, 2000 * tries);
      return;
    }
    done = true;
    console.warn('tv: stream not playable here —', why);
    video.remove();
    setupSecondScreen(tv);
  };
  video.addEventListener('error', () => { if (native) fail('native HLS error'); });
  video.addEventListener('playing', () => { tries = 0; });
  function load() {
    if (native) {   // Safari, iOS, recent Chrome
      video.src = tv.hls;
      video.load();
      play();
      return;
    }
    if (!window.Hls || !Hls.isSupported()) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = tv.hls; video.load(); play(); return; }
      done = true; video.remove(); setupSecondScreen(tv); return;
    }
    hls = new Hls({ liveSyncDurationCount: 3 });
    hls.on(Hls.Events.ERROR, (_, d) => { if (d.fatal) fail(d.details); });
    hls.on(Hls.Events.MANIFEST_PARSED, play);
    hls.loadSource(tv.hls);
    hls.attachMedia(video);
  }
  if (native || window.Hls) { load(); return; }
  const tag = document.createElement('script');
  tag.src = HLS_JS;
  tag.onload = load;
  tag.onerror = () => { done = true; video.remove(); setupSecondScreen(tv); };
  document.head.appendChild(tag);
}

/* Second screen: the debate is on the viewer's TV or atresplayer. The player
   box becomes a pointer to the channel; the cards below follow the broadcast. */
function setupSecondScreen(tv) {
  const wrap = document.querySelector('.player-wrap');
  if (!wrap || wrap.querySelector('.tv-card')) return;
  const card = document.createElement('div');
  card.className = 'tv-card';
  const link = /^https:\/\/www\.atresplayer\.com\//.test(tv.watch_url || '') ? tv.watch_url : '';
  card.innerHTML =
    '<div class="tv-kicker">Segunda pantalla</div>' +
    '<div class="tv-title">Míralo en directo</div>' +
    '<div class="tv-note">y comprueba aquí las verificaciones.</div>' +
    (link ? '<a class="btn primary tv-link" target="_blank" rel="noopener">Abrir el directo</a>' : '');
  if (link) card.querySelector('.tv-link').href = link;
  wrap.appendChild(card);
}

/* ── YouTube embed ───────────────────────────────────────────────────────
   The IFrame API player replaces <video>. Our clock is pipeline media time;
   YouTube's currentTime is its own. The two are related by a constant we
   measure once (live: at first play, assuming the player starts near the
   live edge, which is also where aton started capturing) or take from the
   manifest (VOD tests: `vod_offset`). syncVideo() then seeks as needed. */
function setupYouTube(videoId) {
  $('yt-player').hidden = false;
  player.hidden = true;
  const create = () => {
    yt = new YT.Player('yt-player', {
      videoId,
      playerVars: { autoplay: 1, mute: 1, playsinline: 1, rel: 0, modestbranding: 1,
                    ...(replayMode && bucketCfg?.start ? { start: Math.floor(bucketCfg.start) } : {}) },
      events: {
        onReady: () => {
          ytReady = true;
          if (replayMode) {
            // Diferido: the video leads, the page follows (tickReplay).
          } else if (vodOffset() != null) {
            // VOD standing in for a live stream: the mapping is known up front.
            ytOffset = vodOffset();
            requestYtSeek(clock + ytOffset, 'vod.start');
          }
          try { yt.mute(); yt.playVideo(); } catch { /* ignore */ }
          // Muted autoplay is normally allowed; if it is not, ask for a click.
          setTimeout(() => {
            try { if (yt.getPlayerState() !== YT.PlayerState.PLAYING) showPlayPrompt(); } catch { /* ignore */ }
          }, 3000);
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING) {
            $('play-overlay').hidden = true;
            $('btn-play').textContent = 'Pausar';
            if (ytOffset == null) {
              if (vodOffset() != null) ytOffset = vodOffset();
              else ytOffset = yt.getCurrentTime() - pipelineNow();
            }
          } else if (e.data === YT.PlayerState.PAUSED) {
            $('btn-play').textContent = 'Reproducir';
          }
        },
      },
    });
  };
  if (window.YT && window.YT.Player) create();
  else {
    window.onYouTubeIframeAPIReady = create;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  }
}

/* A recording standing in for a live stream: the player-to-pipeline mapping is
   known up front (capture started `vod_offset` seconds into the video). Zero
   is a valid offset, so this is a null check, not a truthiness one. */
function vodOffset() {
  if (!bucketCfg) return null;
  if (bucketCfg.vod || bucketCfg.vod_offset) return bucketCfg.vod_offset || 0;
  return null;
}

function pipelineNow() {
  return Math.max(0, Date.now() / 1000 - (bucketCfg?.wall0 || 0));
}

/* A debate has a handful of participants: show them all, up front. A Congress
   session has ~350 possible speakers: the rail is built as people take the
   floor instead — most recent first, capped — so it stays a "who has spoken"
   strip rather than a directory. */
const RAIL_STATIC_MAX = 8;
const RAIL_DYNAMIC_MAX = 5;   // the person speaking plus the four before
let railKeys = [];   // dynamic mode: politician_ids in display order

function personHTML(r, sub) {
  return `<div class="person" data-key="${esc(r.politician_id)}" title="${esc(r.name)} · ${esc(sub)}">
        ${r.photo_url ? `<img src="${esc(r.photo_url)}" alt="" />` : ''}
        <span class="person-name">${esc(r.short_name || shortName({ name: r.name, politician_id: r.politician_id }))}</span>${partyChip(r.party)}
      </div>`;
}

/* Moderators (a TV debate's presenter) are in the roster so faces can tell
   them apart, but they are never shown — like the Congress presidency. */
const onRail = (r) => !r.presiding;

function railIsStatic() {
  return (session?.roster || []).filter(onRail).length <= RAIL_STATIC_MAX;
}

function renderRail() {
  if (!session) return;   // the diferido picker has no session (ResizeObserver fires anyway)
  const rail = $('rail');
  if (railIsStatic()) {
    rail.innerHTML = (session.roster || []).filter(onRail).map((r) => personHTML(r, 'en el plató')).join('');
    return;
  }
  const sig = railKeys.join('|');
  if (rail.dataset.keys === sig && rail.childElementCount) { fitRail(); return; }
  rail.dataset.keys = sig;
  flipChildren(rail, '.person', (el) => el.dataset.key, () => {
    rail.innerHTML = railKeys
      .map((k) => rosterByKey.get(k))
      .filter(Boolean)
      .map((r, i) => personHTML(r, i === 0 ? 'en el uso de la palabra' : 'ha intervenido'))
      .join('');
  });
  fitRail();
}
/* One line, always: the newest speakers are on the left, so drop chips from
   the right (the oldest) until the row fits. Re-run when the column resizes. */
function fitRail() {
  const rail = $('rail');
  if (railIsStatic()) return;
  let guard = 12;
  while (rail.scrollWidth > rail.clientWidth + 1 && rail.childElementCount > 1 && guard-- > 0) {
    rail.lastElementChild.remove();
  }
}
if (window.ResizeObserver) new ResizeObserver(() => { $('rail').dataset.keys = ''; renderRail(); }).observe(document.querySelector('.live-stage') || document.body);

function noteSpeakerInRail(sp) {
  if (railIsStatic() || !sp?.politician_id || !rosterByKey.has(sp.politician_id)) return;
  railKeys = [sp.politician_id, ...railKeys.filter((k) => k !== sp.politician_id)].slice(0, RAIL_DYNAMIC_MAX);
  renderRail();
}

function renderStages(stages) {
  const chips = [
    ['face', `identificación por rostro (${stages.face_backend || '—'})`],
    ['extraction', 'extracción de afirmaciones'],
    ['verification', 'verificación con fuentes'],
    ['cache', 'caché de veredictos'],
  ].map(([k, label]) => `<span class="chip ${stages[k] ? 'on' : 'off'}">${esc(label)}</span>`);
  if (stages.llm_model) chips.unshift(`<span class="chip model">${esc(stages.llm_model)}</span>`);
  $('stage-chips').innerHTML = chips.join('');
}

/* ── websocket ──────────────────────────────────────────────────────────── */
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/debates/${session.session_id}/stream`);
  ws.onmessage = (e) => onEvent(JSON.parse(e.data));
  setTimeout(markSettled, 1500);
  ws.onclose = () => setTimeout(connect, 2000);
}

function onEvent(ev) {
  // After a runner jump on a recording, events from before it (or stamped
  // far from the new head) are history of another part of the recording.
  // They are still shown — a reload must rebuild everything the session
  // produced — but they must not move the head, or the picture would be
  // dragged back to where the runner used to be.
  const beforeJump = bucketCfg?.seek_epoch && ev.epoch && ev.epoch < bucketCfg.seek_epoch - 0.5;
  const farFromHead = bucketCfg?.seek_seq && bucketCfg?.vod && ev.t && Math.abs(ev.t - pipelineNow()) > 300;
  if (!beforeJump && !farFromHead) pipelineTime = Math.max(pipelineTime, ev.t || 0);
  trace(ev);
  debugNote(ev);

  switch (ev.type) {
    case 'session.started':
      if (bucketCfg?.status === 'ended') return;  // archive replay of the rollup
      $('onair').hidden = false;
      sessionEnded = false;
      renderStages(ev.payload.stages || {});
      startPlayback();
      return;
    case 'session.stopped':
      $('onair').hidden = true;
      sessionEnded = true;
      Object.assign(stats, ev.payload.stats || {});
      renderStats();
      return;
    case 'verdict.ready':
      applyVerdict(ev); // never queued: land it the moment it exists
      return;
    case 'verdict.pending':
      markPending(ev.payload.claim_id);
      return;
    case 'cost.update':
      renderCost(ev.payload.cost);
      return;
    case 'stage.info':
      if ('extraction_active' in ev.payload) renderSwitch(ev.payload.extraction_active);
      return;
  }
  // Operator view only: a claim card exists from the moment the pipeline
  // finds it, dimmed with a countdown until the viewer clock reaches it —
  // so "what is being verified right now" is visible, and survives a
  // reload. The public page keeps queueing: a viewer must not see a claim
  // before the delayed picture reaches the words.
  if (window.LIVE_ADMIN && !replayMode && ev.type === 'claim.detected' && (ev.t || 0) > clock) {
    applyTimed(ev);
    updateFuture();
    return;
  }
  if ((ev.t || 0) <= clock) {
    // Already behind the viewer clock on arrival: the delay did not cover the
    // pipeline lag, so this shows after the viewer heard it. Count it and say
    // by how much, so the slider can be set from evidence rather than guessed.
    if (ev.type === 'claim.detected' && clock > 0) {
      const late = clock - (ev.payload.t_end ?? ev.t ?? 0);
      if (late > 0) {
        bump('late');
        console.warn(`[directo] claim shown ${late.toFixed(0)}s after the words (pipeline lag ${ev.lag ?? '?'}s, ` +
                     `delay ${delaySeconds}s) — raise the delay to ≥ ${Math.ceil((ev.lag ?? delaySeconds + late) + 5)}s`);
      }
    }
    applyTimed(ev);
  } else pending.push(ev);
}

function flushPending() {
  if (!pending.length) return;
  const ready = pending.filter((e) => (e.t || 0) <= clock);
  if (!ready.length) return;
  pending = pending.filter((e) => (e.t || 0) > clock);
  ready.sort((a, b) => a.seq - b.seq).forEach(applyTimed);
}

/* Counters are bumped here, on *reveal*, not on arrival: the pipeline runs a
   minute ahead of the viewer, and a count that disagreed with the cards on
   screen read as a broken UI.

   `claim.forming` / `claim.retracted` are deliberately not rendered. They are
   speculative guesses from half-finished sentences; most get retracted, and a
   card that appears and vanishes is worse than one that appears a few seconds
   later. They stay on the wire for the diagnostics panel only. */
function applyTimed(ev) {
  switch (ev.type) {
    case 'transcript.final': showCaption(ev.payload.text); bump('segments'); break;
    case 'speaker.assigned': {
      // Kept sorted by media time: a speaker placed at the presidency's
      // hand-over arrives after the event it precedes.
      const entry = { t: ev.t || 0, sp: ev.payload.speaker };
      let i = speakerTimeline.length;
      while (i > 0 && speakerTimeline[i - 1].t > entry.t) i--;
      speakerTimeline.splice(i, 0, entry);
      // Applied late (its moment already passed on this page): the timeline
      // has it for rewinds, but it must not replace whoever is shown now.
      const newest = speakerTimeline[speakerTimeline.length - 1];
      if (newest === entry || ev.payload.from !== 'handover') showSpeaker(ev.payload.speaker);
      break;
    }
    case 'window.result': if (ev.payload.is_final && !ev.payload.skipped) bump('windows'); break;
    case 'claim.detected': addClaim(ev); bump('claims'); break;
  }
}

/* ── now speaking + captions ────────────────────────────────────────────── */
let captionParts = [];
const captionWords = (t) =>
  esc(t).split(/\s+/).filter(Boolean).map((w, i) => `<span class="w" style="--i:${Math.min(i, 36)}">${w}</span>`).join(' ');
/* The box keeps the last few chunks across speakers. A change of speaker
   does not wipe it: a thin rule with the new speaker's name goes between
   their lines. Entries are strings (a transcript chunk) or {sep: label}. */
function renderCaption() {
  let last = -1;
  captionParts.forEach((p, i) => { if (typeof p === 'string') last = i; });
  let prev = -1;
  for (let i = last - 1; i >= 0; i--) if (typeof captionParts[i] === 'string') { prev = i; break; }
  $('caption').innerHTML = captionParts.map((p, i) => {
    if (typeof p !== 'string') return `<span class="cap-sep">${p.sep ? `<span>${esc(p.sep)}</span>` : ''}</span>`;
    // The newest chunk arrives word by word; the one before it settles.
    if (i === last) return `<b class="fresh">${captionWords(p)}</b>`;
    if (i === prev) return `<span class="cap-txt settling">${esc(p)}</span>`;
    return `<span class="cap-txt">${esc(p)}</span>`;
  }).join('');
}
function showCaption(text) {
  if (switchActive === false) return;
  captionParts = [...captionParts, text].slice(-6);
  while (captionParts.length && typeof captionParts[0] !== 'string') captionParts.shift();  // never open on a rule
  renderCaption();
}
function captionSpeakerChange(label) {
  if (switchActive === false || !captionParts.length) return;  // nothing above to separate from
  if (typeof captionParts[captionParts.length - 1] !== 'string') captionParts.pop();  // two changes in a row: keep the last
  captionParts.push({ sep: label || '' });
  renderCaption();
}

/* "Hablando": the person with the floor, as in the mockup (avatar, name,
   party, a level meter). How they were identified is for the operator. */
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
let shownSpeakerKey = null;
function showSpeaker(sp) {
  const now = $('now');
  if (!sp) {
    if (shownSpeakerKey !== null) {
      shownSpeakerKey = null;
      captionSpeakerChange('');
      now.classList.remove('speaking');
      now.innerHTML = `<span class="now-avatar now-avatar-none" aria-hidden="true"></span><div><span class="now-label">Hablando</span><strong class="now-name muted">—</strong></div>`;
      document.querySelectorAll('.person').forEach((el) => el.classList.remove('active'));
    }
    return;
  }
  const key = sp.politician_id || sp.name || 'unknown';
  const changed = key !== shownSpeakerKey;
  if (changed) { shownSpeakerKey = key; captionSpeakerChange(sp.name ? shortName(sp) : ''); }
  noteSpeakerInRail(sp);
  const photo = photoFor(sp);
  const party = partyFor(sp);
  const how = (SOURCE_LABEL[sp.source] || sp.source || '') + (sp.confidence ? ` · ${(sp.confidence * 100).toFixed(0)}%` : '');
  now.classList.add('speaking');
  now.innerHTML = `${photo ? `<img class="now-avatar" src="${esc(photo)}" alt="" width="40" height="40" />` : '<span class="now-avatar now-avatar-none" aria-hidden="true"></span>'}`
    + `<div><span class="now-label">Hablando</span><strong class="now-name" title="${esc(sp.name || '')}">${esc(sp.name ? shortName(sp) : 'Orador no identificado')}</strong>`
    + `${party ? ` <span class="muted now-party">· ${esc(party)}</span>` : ''}`
    + `${window.LIVE_ADMIN && $('debug-text').checked ? `<span class="now-src">${esc(how)}</span>` : ''}</div>`
    + '<span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i></span>';
  if (changed) pulseClass(now, 'swap', 900);
  document.querySelectorAll('.person').forEach((el) => el.classList.toggle('active', el.dataset.key === (sp.politician_id || '')));
  if (changed) pulseClass(document.querySelector('.person.active'), 'just', 900);
}

const foldKey = (s) => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

const foldedVocab = new Map(); // field → Map(foldedKey → label)
function lookup(field, value) {
  const vocab = VOCAB[field];
  if (!vocab) return null;
  if (!foldedVocab.has(field)) {
    foldedVocab.set(field, new Map(Object.entries(vocab).map(([k, v]) => [foldKey(k), v])));
  }
  return foldedVocab.get(field).get(foldKey(value)) ?? null;
}

function tag(field, value, { strong = false } = {}) {
  if (!value || foldKey(value) === 'no especificado') return '';
  const label = field ? lookup(field, value) : null;
  const known = !field || label !== null;
  const title = field === 'verificabilidad' && label ? ` title="${esc(label)}"` : '';
  const text = field === 'verificabilidad' ? value : (label ?? value);
  return `<span class="${known ? '' : 'off-vocab'}"${title}>${strong ? '<b>' : ''}${esc(text)}${strong ? '</b>' : ''}</span>`;
}

/* ── claim cards ─────────────────────────────────────────────────────────
   Structure and motion from fact_them_fr/mockup/live.js: a card grows in
   when the claim is detected, sits in "Verificando N s" with its actions
   row reserved, then the verdict stamps and the card flashes once; 650 ms
   later the row fills (unfold + share) without changing the card's height.
   Unverifiable claims show their verdict, hold, and leave for the drawer
   under the feed, which lights up as it takes them. */
function cardHTML(c, sp, t) {
  const photo = photoFor(sp);
  const tags = [tag('ambito_tematico', c.ambito_tematico), tag('ambito_geografico', c.ambito_geografico)].filter(Boolean).join(' · ');
  const party = partyFor(sp);
  return `
    <div class="f-top">
      <span class="f-verdict"><span class="vtag vtag-pending"><span class="spin" aria-hidden="true"></span><span class="pend-txt">Detectando</span></span>${tags ? `<span class="c-tags">${tags}</span>` : ''}</span>
      <button type="button" class="f-time" data-seek="${t}" title="Ir a este momento del debate">${fmtTime(replayMode ? t + (ytOffset || 0) : t)}</button>
    </div>
    <p class="f-claim">${esc(c.texto_normalizado || c.texto_original)}</p>
    <div class="f-who">${photo ? `<img src="${esc(photo)}" alt="" width="22" height="22" />` : ''}<span class="f-name${sp?.name ? '' : ' unknown'}" title="${esc(sp?.name || '')}">${esc(sp?.name ? shortName(sp) : 'Sin atribuir')}</span>${party ? ` <span class="muted">· ${esc(party)}</span>` : ''}</div>
    <div class="f-actions is-empty" aria-hidden="true"><span class="f-ph"></span><span class="f-ph f-ph-sm"></span></div>`;
}

/* Newest moment of the debate on top, whatever order the events arrive in
   (a reload replays history; a resumed runner replays it after its own). */
function insertByTime(list, el) {
  const before = [...list.querySelectorAll(':scope > .f-item')].find((c) => +c.dataset.t < +el.dataset.t);
  if (before) list.insertBefore(el, before); else list.appendChild(el);
}

function makeCard(payload, state) {
  const el = document.createElement('article');
  el.className = 'f-item';
  el.dataset.state = state;
  el.innerHTML = cardHTML(payload.claim, payload.speaker, payload.t_start ?? 0);
  el._claim = payload.claim;  // what the share text is built from
  el._speaker = payload.speaker;
  el.querySelector('.f-time').addEventListener('click', (e) => {
    if (replayMode) {
      const at = parseFloat(e.currentTarget.dataset.seek) - 3 + ytOffset;
      try { yt.playVideo(); } catch { /* ignore */ }
      requestYtSeek(at, 'card');
      return;
    }
    clock = Math.max(0, parseFloat(e.currentTarget.dataset.seek) - 3);
    if (yt && ytOffset != null) requestYtSeek(clock + ytOffset, 'card');
    else { videoSeekBy = clock; player.currentTime = clock; }
    adoptClock(clock);
  });
  const feed = $('feed');
  el.dataset.t = payload.t_end ?? payload.t_start ?? 0;
  el.dataset.flip = payload.claim_id || `x${Math.random()}`;
  insertByTime(feed, el);
  $('feed-empty').hidden = true;
  growIn(el);
  if (settled && el === feed.querySelector(':scope > .f-item')) followNewCard();
  return el;
}

/* ── Height-first entrance and exit (mockup growIn / growBox / leave) ──── */
function growIn(el) {
  if (!motion() || !el.animate) return;
  const h = el.getBoundingClientRect().height;
  if (!h) return;
  el.style.overflow = 'hidden';
  el.animate([
    { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px', opacity: 0, transform: 'translateY(6px)', easing: 'cubic-bezier(.25,.1,.25,1)' },
    { height: `${h}px`, opacity: 0, transform: 'translateY(6px)', offset: .55, easing: 'cubic-bezier(.2,.7,.2,1)' },
    { height: `${h}px`, opacity: 1, transform: 'none' }], { duration: 1000 })
    .finished.then(() => { el.style.overflow = ''; }, () => { el.style.overflow = ''; });
}
function growBox(el) {
  el.hidden = false;
  if (!motion() || !el.animate) return;
  const h = el.getBoundingClientRect().height;
  el.style.overflow = 'hidden';
  el.animate([{ height: '0px', opacity: 0 }, { height: `${h}px`, opacity: 0, offset: .6 }, { height: `${h}px`, opacity: 1 }],
    { duration: 600, easing: 'ease-out' })
    .finished.then(() => { el.style.overflow = ''; }, () => { el.style.overflow = ''; });
}
function leave(el) {
  if (!motion() || !el.animate) return Promise.resolve();
  const h = el.getBoundingClientRect().height;
  el.style.overflow = 'hidden';
  return el.animate([
    { height: `${h}px`, opacity: 1, transform: 'none' },
    { height: `${h}px`, opacity: 0, transform: 'translateY(10px) scale(.98)', offset: .4 },
    { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginBottom: '0px', borderWidth: '0px', opacity: 0, transform: 'translateY(10px) scale(.98)' }],
    { duration: 800, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'forwards' }).finished.catch(() => {});
}

/* ── "N nuevas" when the reader is scrolled away ───────────────────────────
   Phones: the feed is its own scroller under the fixed video; at the top it
   follows new cards, scrolled down a pill counts them. Desktop: the page
   scrolls; the pill shows when the top of the feed is out of view. */
let newAbove = 0;
function feedScroller() {
  const f = document.querySelector('.live-feed');
  if (!f) return null;
  const o = getComputedStyle(f).overflowY;
  return o === 'auto' || o === 'scroll' ? f : null;
}
function followNewCard() {
  const sc = feedScroller();
  if (sc) {
    if (sc.scrollTop > 60) noteNewAbove();
    else sc.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  } else if (window.scrollY > $('feed').getBoundingClientRect().top + window.scrollY - 80) noteNewAbove();
}
function noteNewAbove() {
  newAbove += 1;
  const b = $('feed-new');
  b.hidden = false;
  b.innerHTML = `↑ <b>${newAbove}</b> nueva${newAbove > 1 ? 's' : ''}`;
  pulseClass(b, 'pop', 300);
}
function clearNewAbove() { newAbove = 0; $('feed-new').hidden = true; }
$('feed-new').addEventListener('click', () => {
  clearNewAbove();
  const sc = feedScroller();
  if (sc) sc.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
  else document.querySelector('.live-feed')?.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth' });
});
document.querySelector('.live-feed')?.addEventListener('scroll', (e) => { if (e.currentTarget.scrollTop < 30 && newAbove) clearNewAbove(); }, { passive: true });
addEventListener('scroll', () => {
  if (!newAbove || feedScroller()) return;
  if ($('feed').getBoundingClientRect().top > 60) clearNewAbove();
}, { passive: true });

function addClaim(ev) {
  const { claim_id, claim } = ev.payload;
  // A claim nobody could be attributed to is never shown to viewers: without a
  // speaker it says nothing about anyone. (The operator page keeps it, to see
  // the attribution failing.) Its verdict, if it comes, finds no card and waits.
  if (!ev.payload.speaker?.name && !window.LIVE_ADMIN) return;
  const el = makeCard(ev.payload, 'pending');
  claims.set(claim_id, { el, claim, startedAt: Date.now(), t: ev.t ?? ev.payload.t_end ?? null });
  markPending(claim_id);

  // A verdict that arrived before the card was revealed (the viewer delay
  // covers the whole verification) is not landed now: the viewer would never
  // see the claim being checked. It lands when the viewer clock reaches the
  // moment the verifier actually answered — claim time plus its latency.
  const held = heldVerdicts.get(claim_id);
  if (held) { heldVerdicts.delete(claim_id); applyVerdict(held); }
}

function markPending(claimId) {
  const entry = claims.get(claimId);
  if (!entry) return;
  const txt = entry.el.querySelector('.pend-txt');
  if (txt) txt.textContent = 'Verificando 0 s';
}

/* A ticking counter on every in-flight verification. Verification takes tens of
   seconds; without this the UI is indistinguishable from one that has hung. */
function tickPending() {
  const now = Date.now();
  for (const entry of claims.values()) {
    const { el, startedAt, done } = entry;
    if (done) continue;
    if (entry.held && clock >= entry.verdictAt) { const h = entry.held; entry.held = null; applyVerdict(h); continue; }
    const txt = el.querySelector('.pend-txt');
    if (txt) {
      const secs = replayMode ? clock - (entry.t ?? clock) : (now - startedAt) / 1000;
      txt.textContent = `Verificando ${Math.max(0, Math.round(secs))} s`;
    }
  }
  renderStats();
}

const BAD = new Set(['FALSO', 'SOBREESTIMADO', 'SUBESTIMADO']);
const WEAK_HOLD_MS = 2200;   // an unverifiable verdict is shown this long before it leaves
const FILL_DELAY_MS = 650;   // the actions row fills after the stamp

function applyVerdict(ev) {
  const { claim_id, verdict, cache_hit, latency_seconds } = ev.payload;
  const entry = claims.get(claim_id);
  if (!entry) { heldVerdicts.set(claim_id, ev); return; }
  // A verdict ahead of the viewer clock (the delay covers the verification,
  // or the card was shown early on the admin page) is not landed yet: it
  // lands when the clock reaches the moment the verifier actually answered —
  // claim time plus its latency — so the claim is seen being checked.
  if (!entry.done) {
    const lat = Math.min(25, Math.max(3, ev.payload.latency_seconds ?? 6));
    const at = (entry.t ?? clock) + lat;
    if (clock < at) { entry.held = ev; entry.verdictAt = at; return; }
  }
  entry.held = null;
  entry.done = true;
  bump('verdicts');

  // NO_VERIFICABLE is a finding about the pipeline, not the world: the claim
  // was still made, so it is kept — in the drawer under the feed.
  const { el } = entry;
  const vk = verdictKey(verdict.resultado);
  const color = VKEY[vk][4];
  el.dataset.state = 'done';
  el.dataset.v = vk;
  el.style.setProperty('--c', color);
  if (BAD.has(vk)) el.dataset.bad = '';
  const pendingTag = el.querySelector('.vtag-pending');
  if (pendingTag) pendingTag.outerHTML = `<span class="vtag stamped" style="--c:${color}">${vtagInner(vk)}</span>`;
  const animate = motion();
  if (animate) el.classList.add('reveal');
  countVerdict(vk);
  if (feedFilter.size) el.classList.toggle('filtered', !feedFilter.has(vk));

  if (vk === 'NO_VERIFICABLE') {
    const park = () => {
      el.remove(); el.classList.remove('reveal');
      el.getAnimations().forEach((a) => a.cancel()); el.style.overflow = '';
      insertByTime($('weak-list'), el);
      const d = $('weak-drawer'); d.hidden = false;
      $('weak-count').textContent = $('weak-list').children.length;
      bumpEl($('weak-count'));
      pulseClass(d, 'received', 2000);
    };
    if (!animate) park();
    else setTimeout(async () => { await leave(el); park(); }, WEAK_HOLD_MS);
    return;
  }

  // After the stamp: one button that unfolds the full verification, in the
  // claim page's sections and wording, the confidence bar as the separator.
  const tierRank = (f) => ({ primaria: 0, primary: 0, academica: 1, academic: 1, secundaria: 2, secondary: 2, terciaria: 3, tertiary: 3 }[foldKey(f.tipo || '')] ?? 4);
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
  const srcs = (verdict.fuentes || []).filter((f) => f.url || f.nombre)
    .map((f, i) => [f, i]).sort((a, b) => tierRank(a[0]) - tierRank(b[0]) || a[1] - b[1]).map(([f]) => f);
  const txt = (x) => (typeof x === 'string' ? x : x?.descripcion || '');
  const errs = (verdict.errores || []).map(txt).filter(Boolean);
  const oms = (verdict.omisiones || []).map(txt).filter(Boolean);
  const conf = Math.round(100 * (verdict.confidence_score || 0));
  const list = (arr, c) => `<ul class="c-list" style="--b:${c}">${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const block = `
    <div class="f-detail" hidden>
      <div class="c-conf" style="--c:${color};--p:${conf}%" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${conf}" aria-label="Confianza de la verificación">
        <div class="c-conf-track"><span></span></div>
        <span class="c-conf-lbl">Confianza de la verificación <b>${conf}%</b></span>
      </div>
      ${verdict.afirmacion_correcta ? `<section class="c-sec"><h2>Lo que dicen los datos</h2><p>${esc(verdict.afirmacion_correcta)}</p></section>` : ''}
      ${errs.length ? `<section class="c-sec"><h2>Errores <span class="n">· ${errs.length}</span></h2>${list(errs, 'var(--v-falso)')}</section>` : ''}
      ${oms.length ? `<section class="c-sec"><h2>Contexto que falta <span class="n">· ${oms.length}</span></h2>${list(oms, 'var(--v-sobre)')}</section>` : ''}
      ${srcs.length ? `<section class="c-sec"><h2>Fuentes <span class="n">· ${srcs.length}</span></h2><ol class="c-sources">${srcs.map((f) => `<li>${f.url
        ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.nombre || host(f.url))}</a>` : `<span class="src-name">${esc(f.nombre)}</span>`}
        <span class="meta">${esc(f.url ? host(f.url) : '')}${tierRank(f) === 0 ? `${f.url ? ' · ' : ''}<span class="prim">fuente primaria</span>` : ''}</span>${f.dato_especifico ? `<span class="dato">${esc(f.dato_especifico)}</span>` : ''}</li>`).join('')}</ol></section>` : ''}
      ${window.LIVE_ADMIN && (latency_seconds != null || cache_hit) ? `<p class="f-foot">${latency_seconds != null ? `verificado en ${Math.round(latency_seconds)} s` : ''}${cache_hit ? ' · ⚡ caché' : ''}</p>` : ''}
    </div>`;
  const fill = () => {
    // Fill the row that was reserved while verifying: no height change.
    const row = el.querySelector('.f-actions');
    if (!row) return;
    row.classList.remove('is-empty'); row.removeAttribute('aria-hidden');
    row.innerHTML = `<button type="button" class="f-more" aria-expanded="false">Ver verificación completa</button>${shareButton(el, verdict)}`;
    row.classList.add('filled');
    row.insertAdjacentHTML('afterend', block);
  };
  if (!animate) fill(); else setTimeout(fill, FILL_DELAY_MS);
}

/* Unfold / fold the full verification with a height tween. */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.f-more'); if (!btn) return;
  const box = btn.closest('.f-item').querySelector('.f-detail');
  const open = box.hidden;
  btn.setAttribute('aria-expanded', String(open));
  btn.textContent = open ? 'Ocultar verificación' : 'Ver verificación completa';
  if (open) { growBox(box); return; }
  if (!motion() || !box.animate) { box.hidden = true; return; }
  const h = box.getBoundingClientRect().height;
  box.style.overflow = 'hidden';
  box.animate([{ height: `${h}px`, opacity: 1 }, { height: '0px', opacity: 0 }], { duration: 300, easing: 'ease-in' })
    .finished.then(() => { box.hidden = true; box.style.overflow = ''; });
});

const isMobile = () => !!(window.matchMedia && matchMedia('(max-width: 860px)').matches);

const mobileLive = () => isMobile() && !window.LIVE_ADMIN;

/* ── verdict breakdown (left column) ────────────────────────────────────── */
// Every verdict, "no verificable" included (it is counted, and its cards sit in the drawer).
const verdictCounts = {};

function countVerdict(resultado) {
  const k = verdictKey(resultado);
  verdictCounts[k] = (verdictCounts[k] || 0) + 1;
  renderBreakdown();
}

/* ── cost ───────────────────────────────────────────────────────────────── */
let lastCost = null;
function renderCost(cost) {
  if (!cost) return;
  lastCost = cost;
  // Session total across restarts: model + searches + audio. Older runners
  // send the model figure only; the rest defaults to zero.
  const usd = cost.total_usd ?? cost.usd ?? 0;
  const perClaim = claims.size ? usd / claims.size : 0;
  // A 10-minute demo costs cents, so cents is the unit that reads.
  const money = (v) => (v < 1 ? `${(v * 100).toFixed(2)}¢` : `$${v.toFixed(2)}`);
  $('cost-total').textContent = money(usd);
  const searches = Object.entries(cost.searches || {}).map(([p, n]) => `${p} ${n}`).join(', ');
  $('cost-detail').innerHTML = `
    <span>modelo ${money(cost.usd || 0)} · ${cost.calls} llamadas</span>
    ${cost.search_count ? `<span>búsquedas ${money(cost.search_usd || 0)} · ${cost.search_count} (${searches})</span>` : ''}
    ${cost.asr_seconds ? `<span>audio ${money(cost.asr_usd || 0)} · ${(cost.asr_seconds / 3600).toFixed(2)} h</span>` : ''}
    <span>${((cost.prompt_tokens || 0) / 1000).toFixed(1)}k tokens entrada</span>
    <span>${((cost.completion_tokens || 0) / 1000).toFixed(1)}k salida</span>
    ${cost.cached_tokens ? `<span>${((cost.cached_tokens || 0) / 1000).toFixed(1)}k en caché</span>` : ''}
    ${cost.runs > 1 ? `<span>${cost.runs} arranques</span>` : ''}
    ${claims.size ? `<span>${(perClaim * 100).toFixed(2)}¢ por afirmación</span>` : ''}
    ${(usd && pipelineTime) ? `<span>≈$${((usd / pipelineTime) * 3600).toFixed(2)}/hora de debate</span>` : ''}`;
}

/* One stacked bar, not five. At the counts a live debate produces (a dozen or
   two), five separate tracks are mostly empty rails; a single bar shows the
   mix at a glance and reads as a summary of the feed it sits above. */
/* The feed's header: one stacked bar whose segments resize as
   verdicts land, and its legend. Bar and legend are also the filter: a click
   shows only that verdict (several can be on); pending cards always show.
   Built once, then updated in place. */
const feedFilter = new Set();
function renderBreakdown() {
  const box = $('live-dist');
  if (!box.firstElementChild) {
    box.innerHTML = `<div class="stack stack-live" role="group" aria-label="Filtrar por veredicto">${VERDICTS.map(([k, , long, , c]) =>
        `<button type="button" class="${k === 'SUBESTIMADO' ? 'hatch' : ''}" data-k="${k}" style="--c:${c};flex:0" title="${esc(long)}" aria-label="${esc(long)}" aria-pressed="false"></button>`).join('')}</div>`
      + '<ul class="legend" id="live-legend"></ul>';
  }
  const total = VERDICTS.reduce((a, [k]) => a + (verdictCounts[k] || 0), 0);
  box.querySelectorAll('.stack-live [data-k]').forEach((el) => {
    const k = el.dataset.k;
    el.style.flex = String(verdictCounts[k] || 0);
    el.title = `${VKEY[k][2]}: ${verdictCounts[k] || 0}`;
    el.setAttribute('aria-pressed', String(feedFilter.has(k)));
  });
  box.classList.toggle('filtering', feedFilter.size > 0);
  $('live-legend').innerHTML = total
    ? VERDICTS.filter(([k]) => verdictCounts[k] || feedFilter.has(k)).map(([k, label, , , c]) =>
      `<li><button type="button" data-k="${k}" style="--c:${c}" aria-pressed="${feedFilter.has(k)}"><span class="dot"></span>${esc(label)} <span class="num">${verdictCounts[k] || 0}</span></button></li>`).join('')
    : '<li class="legend-wait">Esperando la primera verificación</li>';
}
function applyFeedFilter() {
  for (const el of document.querySelectorAll('#feed > .f-item, #weak-list > .f-item')) {
    el.classList.toggle('filtered', feedFilter.size > 0 && el.dataset.state === 'done' && !feedFilter.has(el.dataset.v));
  }
}
$('live-dist').addEventListener('click', (e) => {
  const b = e.target.closest('[data-k]'); if (!b) return;   // a second click on a verdict turns it off
  const k = b.dataset.k;
  if (feedFilter.has(k)) feedFilter.delete(k); else feedFilter.add(k);
  renderBreakdown();
  applyFeedFilter();
});

/* ── Share ──────────────────────────────────────────────────────────────────
   Same menu as the rest of Facthem (see fact_them_fr/js/app.js). A live claim
   has no permalink yet — the archive page is written after the session — so
   the link is the live page itself (the TV runner's ?c=, a replay's ?s=), and
   the text stands on its own. On X it is built like a tweet of the session
   thread (scripts/archive/generate_twitter_thread.py): the speaker's @handle,
   the party as a hashtag, topic / region hashtags plus the debate's own one
   (`--hashtag` on the runner), shortened step by step until it fits 280. */
const SHARE_ICON =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"/>' +
  '<circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/>' +
  '<line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';

const RESULTADO_EMOJIS = {
  CONFIRMADO: '✅',
  CONFIRMADO_CON_MATIZ: '⚠️',
  FALSO: '❌',
  DESCONTEXTUALIZADO: '🟠',
  IMPRECISO: '🔸',
  NO_VERIFICABLE: '❓',
  SOBREESTIMADO: '🟠',
  SUBESTIMADO: '🟠',
};

const LIVE_URL = 'https://facthem.es/live/';
const SHARE_VIA = 'facthem_ES';

/* The page as a reader should open it: the TV runner's channel, or the
   replayed session — never the admin token or debug flags. */
function liveShareUrl() {
  const q = new URLSearchParams(location.search);
  const p = new URLSearchParams();
  const channel = (q.get('c') || window.LIVE_CHANNEL || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (replayMode && session?.session_id) p.set('s', session.session_id);
  else if (channel) p.set('c', channel);
  const qs = p.toString();
  return LIVE_URL + (qs ? `?${qs}` : '');
}

/* Keys of vocabularies.yaml → ambito_tematico; one tag each, a tweet has little room. */
const TOPIC_HASHTAGS = {
  'economía': ['#Economía'],
  'industria_y_trabajo': ['#Empleo'],
  'sanidad': ['#Sanidad'],
  'educación': ['#Educación'],
  'igualdad': ['#Igualdad'],
  'interior': ['#Seguridad'],
  'vivienda': ['#Vivienda'],
  'inmigración': ['#Inmigración'],
  'medio_ambiente': ['#MedioAmbiente'],
  'defensa': ['#Defensa'],
  'relaciones_internacionales': ['#PolíticaExterior'],
  'justicia_y_corrupción': ['#Justicia'],
  'política_social': ['#PolíticaSocial'],
  'transporte': ['#Transporte'],
  'agricultura': ['#Agricultura'],
};
const REGION_SKIP = new Set(['', 'no especificado', 'no especificada', 'sin especificar', 'ue', 'unión europea', 'union europea']);
const REGION_STOPWORDS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'el']);
const HASHTAG_CHARS = /[^0-9A-Za-zÁÉÍÓÚÜÑáéíóúüñ_]/g;

function hashtagOf(words) {
  const token = String(words || '').replace(HASHTAG_CHARS, '');
  return token ? `#${token}` : '';
}
function regionHashtag(scope) {
  const raw = String(scope || '').replace(/\(.*?\)/g, '').trim();
  if (REGION_SKIP.has(raw.toLowerCase())) return '';
  const words = raw.split(/\s+/).filter((w) => w && !REGION_STOPWORDS.has(w.toLowerCase()));
  return hashtagOf(words.map((w) => w[0].toUpperCase() + w.slice(1)).join(''));
}
/* The debate's hashtags first (the one a reader follows), then topic, region. */
function shareHashtags(claim) {
  const topic = String(claim?.ambito_tematico || '').toLowerCase().replace(/\s+/g, '_');
  const tags = [
    ...(session?.hashtags || []),
    ...(TOPIC_HASHTAGS[topic] || []),
    regionHashtag(claim?.ambito_geografico),
  ].filter(Boolean);
  const seen = new Set();
  return tags.filter((t) => !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

/* X counts every link as 23 chars (t.co) and most emoji as 2; `via` adds
   " via @facthem_ES". Keep a margin so a tweet that "fits" never overflows. */
const TWEET_LIMIT = 280 - 8 - (` via @${SHARE_VIA}`).length;
const tweetLen = (s) => s.replace(/https?:\/\/\S+/g, 'u'.repeat(23)).length;

function shareParts(el, verdict) {
  const sp = el._speaker;
  const entry = sp ? rosterByKey.get(sp.politician_id) || rosterByKey.get(sp.name) : null;
  const short = sp?.name ? shortName(sp) : 'Un político';
  const party = entry?.party || '';
  const twitter = String(entry?.twitter || '').replace(/^@/, '');
  const claim = el._claim || {};
  const texto = String(claim.texto_normalizado || claim.texto_original
    || el.querySelector('.f-claim')?.textContent || '').trim();
  const key = String(verdict.resultado || '').toUpperCase();
  const emoji = RESULTADO_EMOJIS[key] ?? '🔍';
  const label = RESULTADO_LABELS[key] || verdict.resultado || 'Sin verificar';
  return { short, party, twitter, texto, emoji, label, tags: shareHashtags(claim) };
}

/* The line in front of the link: what the reader finds behind it. */
const liveCallout = () => (replayMode
  ? '▶️ Revívelo verificado en diferido 👉'
  : '🔴 Estamos verificando en directo 👉');

/* WhatsApp / Telegram: name, party, claim, verdict, hashtags — no @handle,
   it means nothing outside X. */
function shareText(el, verdict) {
  const p = shareParts(el, verdict);
  const texto = p.texto.length > 220 ? p.texto.slice(0, 220).trimEnd() + '…' : p.texto;
  const who = p.party ? `${p.short} (${p.party})` : p.short;
  return `🔍 ${who} ha afirmado: "${texto}"\n${p.emoji} ${p.label}` + (p.tags.length ? `\n${p.tags.join(' ')}` : '');
}

/* X: when the tweet does not fit, drop in this order — the topic / region
   hashtags (#Empleo #España, never the debate's), then the party with its
   brackets, then "ha afirmado" — and only then cut the claim. The speaker's
   @mention is never dropped: it is what puts the claim in front of their
   audience. Always first name + first surname ("Pedro Sánchez"). */
function tweetText(el, verdict, url) {
  const p = shareParts(el, verdict);
  const party = hashtagOf(p.party) || p.party;
  const who = `🔍 ${p.short}${p.twitter ? ` (@${p.twitter})` : ''}`;
  const pt = party ? ` (${party})` : '';
  const debate = new Set((session?.hashtags || []).map((t) => t.toLowerCase()));
  const own = p.tags.filter((t) => debate.has(t.toLowerCase()));
  const foot = (tags) => `"\n${p.emoji} ${p.label}\n` + (tags.length ? `${tags.join(' ')}\n` : '') + `${liveCallout()} ${url}`;
  const steps = [
    [`${who}${pt} ha afirmado: "`, p.tags],
    [`${who}${pt} ha afirmado: "`, own],
    [`${who} ha afirmado: "`, own],
    [`${who}: "`, own],
  ];
  for (const [head, tags] of steps) {
    const t = head + p.texto + foot(tags);
    if (tweetLen(t) <= TWEET_LIMIT) return t;
  }
  const [head, tags] = steps[steps.length - 1];
  const f = foot(tags);
  const room = TWEET_LIMIT - tweetLen(head) - tweetLen(f) - 1;
  return head + p.texto.slice(0, Math.max(0, room)).trimEnd() + '…' + f;
}

const shareMenu = (url, text, tweet, label = '') => {
  const enc = encodeURIComponent;
  return `<div class="share"><button type="button" class="share-btn${label ? ' has-label' : ''}" aria-haspopup="true" aria-expanded="false" aria-label="Compartir" data-url="${esc(url)}" data-text="${esc(text)}">${SHARE_ICON}${label}</button>`
    + '<div class="share-pop" role="menu" hidden>'
    + `<button type="button" role="menuitem" data-copy="${esc(url)}">Copiar enlace</button>`
    + `<a role="menuitem" href="https://twitter.com/intent/tweet?text=${enc(tweet)}${tweet.includes(url) ? '' : `&url=${enc(url)}`}&via=${SHARE_VIA}" target="_blank" rel="noopener">X</a>`
    + `<a role="menuitem" href="https://wa.me/?text=${enc(`${text} ${url}`)}" target="_blank" rel="noopener">WhatsApp</a>`
    + `<a role="menuitem" href="https://t.me/share/url?url=${enc(url)}&text=${enc(text)}" target="_blank" rel="noopener">Telegram</a>`
    + '</div></div>';
};

function shareButton(el, verdict) {
  const url = liveShareUrl();
  return shareMenu(url, `${shareText(el, verdict)}\n\n${liveCallout()}`, tweetText(el, verdict, url));
}

/* Phones and tablets: the system share sheet; elsewhere our menu, opening
   upwards when there is no room below (screen edge or the feed's scroller). */
const NATIVE_SHARE = !!navigator.share && !!window.matchMedia && matchMedia('(pointer: coarse)').matches;
const closeShares = (except) => document.querySelectorAll('.share-pop:not([hidden])').forEach((p) => {
  if (p === except) return;
  p.hidden = true; p.previousElementSibling.setAttribute('aria-expanded', 'false');
  p.closest('.f-item')?.classList.remove('menu-open');
});
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.share-btn');
  const copy = e.target.closest('[data-copy]');
  if (btn) {
    e.preventDefault(); e.stopPropagation();
    if (NATIVE_SHARE) { navigator.share({ title: 'Facthem', text: btn.dataset.text, url: btn.dataset.url }).catch(() => {}); return; }
    const pop = btn.nextElementSibling; closeShares(pop);
    pop.hidden = !pop.hidden; btn.setAttribute('aria-expanded', String(!pop.hidden));
    if (!pop.hidden) {
      pop.classList.remove('up');
      let limit = innerHeight, n = pop.parentElement;
      while (n && n !== document.body) {
        const o = getComputedStyle(n).overflowY;
        if (o === 'auto' || o === 'scroll') { limit = Math.min(limit, n.getBoundingClientRect().bottom); break; }
        n = n.parentElement;
      }
      if (pop.getBoundingClientRect().bottom > limit - 8) pop.classList.add('up');
    }
    btn.closest('.f-item')?.classList.toggle('menu-open', !pop.hidden);
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
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeShares(); });

/* ── debug: text processing ──────────────────────────────────────────────
   What each transcript window looked like when it was handed to the model,
   and what came back: claims, duplicates dropped, or why it was skipped
   (paused, moderator). Off by default and recorded only while the checkbox
   is on — it is a diagnostic for us, not a view for a reader. Arrival-timed,
   not reveal-timed: it shows the pipeline as it happens. */
const DEBUG_MAX = 80;
const dbgWindows = new Map();   // index → {el, ...}
let debugOn = false;
try { debugOn = localStorage.getItem('facthem-debug-text') === '1'; } catch { /* ignore */ }

let dbgLatest = null;   // index of the window shown in the "sent to the model" box
function debugNote(ev) {
  if (!debugOn) return;
  const p = ev.payload || {};
  if (ev.type === 'window.closed') {
    if (!p.is_final) return;  // speculative partials are noise here
    // The box above the claims: the newest window as handed to the model.
    dbgLatest = p.index;
    $('debug-current-meta').textContent = `último bloque transcrito · #${p.index} · ${fmtTime(p.t_start)}–${fmtTime(p.t_end)} · ${p.speaker?.name || 'sin orador'}`;
    $('debug-current-text').textContent = p.text || '';
    $('debug-current-result').className = 'result none';
    $('debug-current-result').textContent = '…';
    const el = document.createElement('div');
    el.className = 'dbg-win pending';
    el.innerHTML = `
      <div class="meta">#${p.index} · ${fmtTime(p.t_start)}–${fmtTime(p.t_end)} · ${esc(p.speaker?.name || 'sin orador')} · ${(p.text || '').length} caracteres</div>
      <div class="text">${esc(p.text || '')}</div>
      <div class="result none">…</div>`;
    const box = $('debug-windows');
    box.prepend(el);
    dbgWindows.set(p.index, { el });
    while (box.childElementCount > DEBUG_MAX) box.lastElementChild.remove();
    return;
  }
  if (ev.type === 'window.result') {
    if (!p.is_final) return;
    const entry = dbgWindows.get(p.index);
    if (!entry) return;
    const res = entry.el.querySelector('.result');
    entry.el.classList.remove('pending');
    if (p.index === dbgLatest) {
      const top = $('debug-current-result');
      top.className = p.skipped || !p.extracted ? 'result none' : 'result';
      top.textContent = p.skipped ? `no enviado al modelo: ${p.skipped}` : `enviado al modelo → ${p.extracted || 0} afirmación(es)${p.duplicates ? `, ${p.duplicates} repetida(s)` : ''}${p.latency_seconds != null ? ` · ${p.latency_seconds}s` : ''}`;
    }
    if (p.skipped) {
      entry.el.classList.add('skipped');
      res.className = 'result none';
      res.textContent = `no enviado al modelo: ${p.skipped}`;
      return;
    }
    const n = p.extracted || 0;
    const parts = [`${n} afirmación${n === 1 ? '' : 'es'} extraída${n === 1 ? '' : 's'}`];
    if (p.duplicates) parts.push(`${p.duplicates} repetida${p.duplicates === 1 ? '' : 's'} (descartada${p.duplicates === 1 ? '' : 's'})`);
    if (p.latency_seconds != null) parts.push(`${p.latency_seconds}s`);
    res.className = n ? 'result' : 'result none';
    res.innerHTML = esc(parts.join(' · ')) +
      ((p.claims || []).length ? `<ul>${p.claims.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '');
  }
}

/* One switch for everything that is for us and not for a reader: the box
   showing what goes to the model, the diagnostics panel (stages, stats,
   cost, text processing, event trace). */
function applyDebug() {
  // Operator controls only: a viewer of facthem.es/live/ sees the player, the
  // speaker, the rail, the captions and the cards. Nothing else, ever.
  if (!adminOn) debugOn = false;
  $('controls').hidden = !adminOn;
  $('debug-text').checked = debugOn;
  $('delay-row').hidden = !liveMode || !debugOn;
  $('now-how').hidden = !debugOn;  // how the speaker was attributed: diagnostics, not for a viewer
  $('debug-current').hidden = !debugOn;
  $('diagnostics').hidden = !debugOn;
  if (debugOn) $('diagnostics').open = true;
  if (debugOn && !dbgWindows.size) {
    $('debug-windows').innerHTML = '<p class="hint">Esperando el siguiente bloque…</p>';
  }
}
applyDebug();
$('debug-text').addEventListener('change', (e) => {
  debugOn = e.target.checked;
  try { localStorage.setItem('facthem-debug-text', debugOn ? '1' : '0'); } catch { /* ignore */ }
  applyDebug();
});

/* ── stats + trace ──────────────────────────────────────────────────────── */
/* Diagnostics only, so these say what they mean rather than naming the
   internals: a "segmento" is one caption fragment, a "ventana" is the pooled
   chunk actually sent to the model. Neither is a concept a viewer should meet. */
const STAT_LABEL = {
  segments: 'frases transcritas',
  windows: 'bloques enviados al modelo',
  claims: 'afirmaciones detectadas',
  inflight: 'verificando ahora',
  verdicts: 'veredictos emitidos',
  late: 'llegadas tarde',
  dropped: 'descartados',
};
function bump(k) { stats[k] = (stats[k] || 0) + 1; renderStats(); }
function renderStats() {
  // `inflight` is derived, not counted: it is how many cards are on screen
  // still waiting on a verdict, which is the visible face of the concurrency.
  stats.inflight = [...claims.values()].filter((c) => !c.done).length;
  $('stats').innerHTML = Object.entries(STAT_LABEL)
    .map(([k, label]) => `<div class="stat"><b>${stats[k] || 0}</b><small>${label}</small></div>`)
    .join('');
}

function trace(ev) {
  const box = $('trace');
  const detail =
    ev.payload?.text?.slice(0, 54) ||
    ev.payload?.claim?.texto_normalizado?.slice(0, 54) ||
    ev.payload?.verdict?.resultado ||
    ev.payload?.speaker?.name ||
    '';
  const line = document.createElement('div');
  const lag = ev.lag != null ? ` <span class="t">+${Math.round(ev.lag)}s</span>` : '';
  line.innerHTML = `<span class="t">${fmtTime(ev.t)}</span> <span class="k">${esc(ev.type)}</span> ${esc(detail)}${lag}`;
  box.prepend(line);
  while (box.childElementCount > 200) box.lastElementChild.remove();
}

/* ── the viewer clock ───────────────────────────────────────────────────── */
let wasAhead = false;
function tickClock() {
  if (replayMode) return tickReplay();
  const nowMs = Date.now();
  const dt = clockLastMs == null ? 0 : (nowMs - clockLastMs) / 1000;
  clockLastMs = nowMs;

  if (mode === 'buckets' && !sessionEnded) pipelineTime = Math.max(pipelineTime, pipelineNow());

  if (sessionEnded) {
    // The source has stopped, so `pipelineTime` is frozen. Keep advancing at
    // real time — clamping to a frozen target is what used to stall the clock
    // under a still-playing video.
    clock += dt;
  } else {
    const target = Math.max(0, pipelineTime - delaySeconds - scrubOffset);
    if (target - clock > 5) clock = target;      // late join / replayed history
    else clock = Math.min(target, clock + dt);   // real time, never ahead
  }

  flushPending();
  updateFuture();
  syncVideo();
  tickPending();
  if (aheadOfHead() !== wasAhead) { wasAhead = aheadOfHead(); rewindState(); }
  if (wasAhead) renderScrub();

  $('clock-emision').textContent = fmtTime(clock);
  const lag = Math.round(Math.max(0, pipelineTime - clock));
  $('clock-lag').textContent = sessionEnded ? 'emisión finalizada' : `verificación +${lag}s`;
  // The lag is an operator number; a viewer only needs to know when it ended.
  $('clock-lag').hidden = !window.LIVE_ADMIN && !sessionEnded;
}

/* Keep the picture on the viewer clock — but never by seeking *backwards*.
   A backward seek looked like the video was stuck looping over the same two
   seconds: whenever the clock stalled, every tick yanked the playhead back to
   it, the video played forward, and the next tick yanked it back again. If the
   picture gets ahead, hold it (pause) and let the clock walk up to it; that is
   invisible, where a backward jump is not. */
let videoSeekBy = null;   // currentTime we last set ourselves
function syncVideo() {
  if (replayMode) return;
  if (yt) return syncYouTube();
  if (!session?.video_url || !player.duration || player.seeking) return;
  const drift = clock - player.currentTime;

  if (drift > 3) {
    // Picture is behind the clock (buffering, a pause, a late join): jump up.
    videoSeekBy = Math.min(clock, player.duration - 0.1);
    player.currentTime = videoSeekBy;
    holding = false;
  } else if (drift < -0.75) {
    // Picture ran ahead: hold it rather than rewind.
    if (!player.paused) { player.pause(); holding = true; }
    return;
  } else if (holding) {
    holding = false;
  }

  if (player.paused && autoplayOk && !holding && clock > 0) player.play().catch(showPlayPrompt);
}

/* ── YouTube ↔ clock sync ────────────────────────────────────────────────
   Rules, learnt the hard way (a paused or buffering embed used to be seeked
   forward every 4 s in 5 s hops — "looping a fragment"):

   1. Never touch the player unless it is PLAYING. Paused, buffering or
      unstarted, there is nothing to sync and every seek only buys more
      buffering.
   2. An explicit seek (slider, claim card, Sincronizar, catch-up) is *one*
      request: wait until the player is playing near the target before
      judging drift again. A timer is not a state.
   3. A jump the passage of time cannot explain is the viewer scrubbing the
      player: follow it (clock ← picture).
   4. Picture behind the clock (late join, resumed after a pause): catch up
      with one seek. Picture ahead of the clock: follow it — never seek
      backwards on the viewer, that is the loop they see.

   Every decision is logged: console + `window.__syncLog` (last 200) + the
   diagnostics trace, so a misbehaving session can be read, not guessed. */
let ytLastCur = null;        // last position seen, in ANY player state
let ytLastMs = null;
let ytLastPlaying = false;   // whether the player was playing at that sample
let ytSeekTarget = null;     // player time we asked for, until the player gets there
let ytSeekFrom = null;       // where the player was when we asked
let ytSeekAt = 0;            // when we asked
const SEEK_SETTLE_MS = 12000; // give up waiting for a seek to land after this
window.__syncLog = [];
function syncLog(what, extra = {}) {
  const line = { t: new Date().toISOString().slice(11, 23), what, clock: +clock.toFixed(1),
                 pipeline: +pipelineTime.toFixed(1), delay: delaySeconds, ...extra };
  window.__syncLog.push(line);
  if (window.__syncLog.length > 200) window.__syncLog.shift();
  console.info('[directo/sync]', what, JSON.stringify(extra), `clock=${line.clock} pipeline=${line.pipeline} delay=${line.delay}`);
  const box = $('trace');
  if (box) {
    const el = document.createElement('div');
    el.innerHTML = `<span class="t">${fmtTime(clock)}</span> <span class="k">sync.${esc(what)}</span> ${esc(Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' '))}`;
    box.prepend(el);
    while (box.childElementCount > 200) box.lastElementChild.remove();
  }
}

function requestYtSeek(playerTime, why) {
  if (!yt || !ytReady || (mobileLive() && !replayMode)) return;
  const target = Math.max(0, playerTime);
  ytSeekTarget = target;
  ytSeekAt = Date.now();
  ytLastCur = null;
  let cur = null;
  try { cur = +yt.getCurrentTime().toFixed(1); } catch { /* ignore */ }
  ytSeekFrom = cur;
  syncLog('seek', { why, from: cur, to: +target.toFixed(1) });
  try { yt.seekTo(target, true); } catch { /* ignore */ }
}

function syncYouTube() {
  if (!ytReady || ytOffset == null) return;
  let cur, state;
  try { cur = yt.getCurrentTime(); state = yt.getPlayerState(); } catch { return; }
  const nowMs = Date.now();
  const playing = state === YT.PlayerState.PLAYING;
  pictureTime = cur - ytOffset;  // where the picture is, in pipeline media time

  // 2. An explicit seek in flight: wait for it to land (or give up). A
  //    position far from both ends of our seek is the viewer moving the
  //    picture somewhere else meanwhile — the viewer wins, and in test mode
  //    the runner must hear about it.
  if (ytSeekTarget != null) {
    const near = Math.abs(cur - ytSeekTarget) < 4 || (cur > ytSeekTarget && cur - ytSeekTarget < 30);
    const elsewhere = Math.abs(cur - ytSeekTarget) > 30 && (ytSeekFrom == null || Math.abs(cur - ytSeekFrom) > 30);
    if (playing && near) {
      syncLog('seek.landed', { at: +cur.toFixed(1), after_ms: nowMs - ytSeekAt });
      ytSeekTarget = null;
      ytLastCur = cur; ytLastMs = nowMs; ytLastPlaying = playing;
    } else if (elsewhere) {
      syncLog('seek.overridden', { wanted: +ytSeekTarget.toFixed(1), at: +cur.toFixed(1), state });
      ytSeekTarget = null;
      ytLastCur = cur; ytLastMs = nowMs; ytLastPlaying = playing;
      adoptClock(pictureTime);
      requestRunnerSeek(pictureTime);
      return;
    } else if (nowMs - ytSeekAt > SEEK_SETTLE_MS) {
      syncLog('seek.gave_up', { wanted: +ytSeekTarget.toFixed(1), at: +cur.toFixed(1), state });
      ytSeekTarget = null;
      ytLastCur = cur; ytLastMs = nowMs; ytLastPlaying = playing;
      if (playing) adoptClock(pictureTime);
    } else {
      return;
    }
  }

  // 3. Viewer scrubbed the player: a jump the passage of time cannot explain,
  //    in whatever state the player is (a real drag passes through BUFFERING;
  //    a paused player does not advance at all). Follow it.
  if (ytLastCur != null) {
    const expected = ytLastCur + (ytLastPlaying ? (nowMs - ytLastMs) / 1000 : 0);
    if (Math.abs(cur - expected) > 4) {
      syncLog('scrub.adopt', { from: +expected.toFixed(1), to: +cur.toFixed(1), state, ahead_of_head: +(pictureTime - pipelineTime).toFixed(1) });
      ytLastCur = cur; ytLastMs = nowMs; ytLastPlaying = playing;
      adoptClock(pictureTime);
      requestRunnerSeek(pictureTime);
      return;
    }
  }
  ytLastCur = cur; ytLastMs = nowMs; ytLastPlaying = playing;

  // Not playing: nothing else to sync.
  if (!playing) return;

  // 4. Drift.
  const want = clock + ytOffset;
  const drift = want - cur;
  if (drift > 4) requestYtSeek(want, `behind ${drift.toFixed(1)}s`);
  else if (drift < -4 && !aheadOfHead()) {
    syncLog('ahead.adopt', { drift: +drift.toFixed(1), at: +cur.toFixed(1) });
    adoptClock(pictureTime);
  }
}

/* Where the picture is in pipeline media time (YouTube) — may be past the
   head on a recording. `aheadOfHead()` is the state the page reports. */
let pictureTime = null;
function aheadOfHead() {
  return !sessionEnded && pictureTime != null && pictureTime > pipelineTime + 1;
}

function startPlayback() {
  if (!session?.video_url) return;
  // Muted autoplay is what browsers actually permit; one click unmutes.
  player.muted = true;
  player.play().then(() => { $('play-overlay').hidden = true; }).catch(showPlayPrompt);
}
function showPlayPrompt() {
  autoplayOk = false;
  $('play-overlay').hidden = false;
}

/* ── the fact-checking switch (admin) ────────────────────────────────────
   A plenary day is mostly roll-calls, votes and recesses. The switch stops
   claim extraction (and so verification) while the transcript keeps running.
   The state comes from the runner over `stage.info`; the button POSTs to the
   runner's /control on the data origin. Only on the runner's /admin page. */
/* ── live mode ────────────────────────────────────────────────────────────
   ON  (what every viewer gets): the runner follows the stream; the delay
       holds the picture back so verdicts have time to land; scrubbing only
       rewinds the page.
   OFF (testing, admin page only): no delay; a scrub on the bar restarts the
       runner there — capture, faces, verification — and the page sits at the
       head. */
function applyLiveMode(seekPicture = true) {
  $('live-toggle').checked = liveMode;
  $('delay-row').hidden = !liveMode || !debugOn;
  if (!liveMode) {
    if (savedDelay == null) savedDelay = delaySeconds;
    delaySeconds = 0;
  } else if (savedDelay != null) {
    delaySeconds = savedDelay;
    savedDelay = null;
  }
  $('delay').value = delaySeconds;
  $('delay-val').textContent = delaySeconds;
  scrubOffset = 0;
  if (mode === 'buckets' && !sessionEnded) clock = Math.max(0, pipelineTime - delaySeconds);
  syncLog('live.mode', { live: liveMode, delay: delaySeconds });
  renderScrub();
  renderAdminNote();
  rewindState();
  flushPending();
  if (seekPicture && yt && ytOffset != null) requestYtSeek(clock + ytOffset, liveMode ? 'live mode on' : 'live mode off');
}

function renderAdminNote() {
  // Only problems are worth a line here; the buttons say the normal state.
  if (!adminOn) return;
  const el = $('admin-note');
  el.textContent = (!liveMode && !canSeekRunner) ? 'este runner no admite saltos: reinícialo con el código actual' : '';
  el.hidden = !el.textContent;
}

let switchActive = null;
let runnerSeekPending = null;   // position we asked the runner to jump to
let runnerSeekTimer = null;

/* Testing on a recording: the runner follows the tester. A scrub on the
   player is sent to the runner, which restarts capture there and republishes
   the manifest; the page resyncs when it sees the new seek sequence. Live
   streams never seek — the runner follows the stream, viewers only rewind
   the page. */
function requestRunnerSeek(position) {
  if (liveMode || !adminOn || !canSeekRunner || mode !== 'buckets') return;
  clearTimeout(runnerSeekTimer);
  runnerSeekTimer = setTimeout(async () => {
    runnerSeekPending = position;
    renderScrub();
    syncLog('runner.seek.request', { to: +position.toFixed(1) });
    try {
      await fetchJSON(`${bucketBase}control`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seek: position, token: adminToken }),
      });
    } catch (e) {
      runnerSeekPending = null;
      syncLog('runner.seek.failed', { error: e.message });
      $('admin-note').textContent = `no se pudo saltar: ${e.message}`;
      $('admin-note').hidden = false;
    }
  }, 800);
}

/* The runner jumped (its manifest carries a new seek sequence): the pipeline
   now starts at the new position. Everything before it is another part of
   the recording — drop the queue, the speaker timeline and the clock, and
   put the viewer at the head so cards arrive as the pipeline produces them. */
let lastSeekSeq = 0;
function onRunnerSeek(cfg) {
  bucketCfg = cfg;
  lastSeekSeq = cfg.seek_seq || 0;
  pending = [];
  speakerTimeline.length = 0;
  pipelineTime = pipelineNow();
  clock = pipelineTime;
  scrubOffset = -delaySeconds;
  runnerSeekPending = null;
  syncLog('runner.seek.applied', { seq: lastSeekSeq, wall0: cfg.wall0, head: +pipelineTime.toFixed(1) });
  rewindState();
  renderScrub();
  if (yt && ytOffset != null) requestYtSeek(clock + ytOffset, 'runner seek');
}
async function pollManifest() {
  if (mode !== 'buckets' || !bucketCfg?.vod || sessionEnded) return;
  try {
    const cfg = await fetchJSON(`${bucketBase}sessions/current.json`, { cache: 'no-store' });
    if (cfg.session_id !== bucketCfg.session_id) return;
    if ((cfg.seek_seq || 0) !== lastSeekSeq) onRunnerSeek(cfg);
  } catch { /* transient */ }
}
setInterval(pollManifest, 3000);

const PAUSED_MESSAGE = 'La verificación está pausada temporalmente. Se reanudará cuando continúe el debate.';
function renderSwitch(active) {
  switchActive = active;
  // Everyone sees the pause, not just the operator: the transcript box
  // carries the notice (nothing else arrives while paused), and the pill
  // says "en pausa" instead of "en directo".
  const paused = active === false;
  const cap = $('caption');
  cap.classList.toggle('paused', paused);
  if (paused) { captionParts = []; cap.textContent = PAUSED_MESSAGE; }
  else if (cap.classList.contains('was-paused')) { cap.textContent = ''; }
  cap.classList.toggle('was-paused', paused);
  const pill = $('onair');
  pill.classList.toggle('paused', paused);
  pill.textContent = paused ? 'En pausa' : 'En directo';
  const btn = $('btn-switch');
  btn.textContent = active === false ? '▶ Activar verificación' : '⏸ Pausar verificación';
  btn.classList.toggle('on', active !== false);
}
async function setupAdmin() {
  // Only the admin page (the runner's /admin, localhost) sets LIVE_ADMIN; the
  // public page has neither the flag nor the markup. The token comes from
  // ?token= (or the older ?admin=), then the browser's storage, then a prompt.
  if (!window.LIVE_ADMIN) return;
  const q = new URLSearchParams(location.search);
  let token = q.get('token') || q.get('admin') || '';
  if (!token) { try { token = localStorage.getItem('facthem-admin-token') || ''; } catch { /* ignore */ } }
  if (!token) token = window.prompt('Token de administración (LIVE_ADMIN_TOKEN)') || '';
  const base = (mode === 'buckets' ? bucketBase : '') || '';
  let st;
  try {
    st = await fetchJSON(`${base}control?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
  } catch (e) {
    console.info('[directo] admin panel unavailable here:', e.message);
    try { localStorage.removeItem('facthem-admin-token'); } catch { /* ignore */ }
    $('session-title').textContent = 'admin: token rechazado o runner sin /control';
    return;
  }
  try { localStorage.setItem('facthem-admin-token', token); } catch { /* ignore */ }
  adminOn = true; adminToken = token;
  $('controls').hidden = false;
  $('btn-switch').hidden = false;
  lastSeekSeq = bucketCfg?.seek_seq || 0;
  $('live-toggle-wrap').hidden = false;
  $('live-toggle').addEventListener('change', (e) => {
    liveMode = e.target.checked;
    try { localStorage.setItem('facthem-live-mode', liveMode ? '1' : '0'); } catch { /* ignore */ }
    applyLiveMode();
  });
  canSeekRunner = !!st.can_seek;
  $('btn-simulate').hidden = false;
  $('btn-simulate').addEventListener('click', simulateClaim);
  renderSwitch(st.active);
  applyDebug();
  applyLiveMode(false);
  $('btn-switch').addEventListener('click', async () => {
    const want = switchActive === false;
    $('btn-switch').disabled = true;
    try {
      const st = await fetchJSON(`${base}control`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: want, token }),
      });
      renderSwitch(st.active);
      $('admin-note').textContent = '';
      $('admin-note').hidden = true;
    } catch (e) {
      $('admin-note').textContent = `error: ${e.message}`;
      $('admin-note').hidden = false;
    } finally {
      $('btn-switch').disabled = false;
    }
  });
}

/* ── admin: one synthetic claim, end to end ──────────────────────────────
   Plays the whole sequence the page animates — speaker change, caption,
   card arrival, verification in flight, verdict — without waiting for the
   pipeline. Fake data, admin page only; nothing is published. */
const SIM_CLAIMS = [
  ['El paro juvenil ha bajado del 40 % al 27 % desde 2018.', 'economía', 'CONFIRMADO_CON_MATIZ'],
  ['España es el país de la UE que más ha reducido la deuda pública.', 'economía', 'FALSO'],
  ['Hay 20 millones de afiliados a la Seguridad Social.', 'empleo', 'SOBREESTIMADO'],
  ['El gasto en sanidad supera el 7 % del PIB.', 'sanidad', 'CONFIRMADO'],
  ['La inflación cerró 2023 en el 3,1 %.', 'economía', 'CONFIRMADO'],
  ['Nunca antes se había subido tanto el salario mínimo.', 'empleo', 'IMPRECISO'],
  ['Las listas de espera han crecido un 50 % en dos años.', 'sanidad', 'NO_VERIFICABLE'],
];
let simN = 0;
function simulateClaim() {
  simN += 1;
  const roster = (session.roster || []).filter((r) => r.politician_id && onRail(r));
  const other = roster.filter((r) => r.politician_id !== shownSpeakerKey);
  const who = (other.length ? other : roster)[simN % Math.max(1, (other.length ? other : roster).length)];
  const sp = who
    ? { politician_id: who.politician_id, name: who.name, party: who.party, photo_url: who.photo_url, source: 'face_sticky', confidence: .91 }
    : { politician_id: null, name: null, source: 'stub' };
  showSpeaker(sp);
  const [text, ambito, resultado] = SIM_CLAIMS[simN % SIM_CLAIMS.length];
  showCaption('Señorías, los datos son claros y quiero recordarlos aquí:');
  setTimeout(() => showCaption(text), 700);
  const claim_id = `sim-${Date.now()}`;
  const t = clock;
  setTimeout(() => {
    addClaim({ t, payload: { claim_id, t_start: t, t_end: t, speaker: sp,
      claim: { texto_normalizado: text, ambito_tematico: ambito, ambito_geografico: 'España', periodo_temporal: '2023' } } });
    bump('claims');
  }, 1400);
  setTimeout(() => applyVerdict({ t, payload: { claim_id, latency_seconds: 3.2, cache_hit: false, verdict: {
    resultado,
    afirmacion_correcta: resultado === 'NO_VERIFICABLE' ? '' : 'Según la fuente oficial, la cifra correcta para el periodo citado difiere ligeramente de la enunciada.',
    errores: resultado === 'CONFIRMADO' ? [] : ['La cifra corresponde a otro periodo del que se cita.'],
    omisiones: ['No se menciona el cambio metodológico de 2021.'],
    confidence_score: .78,
    fuentes: [
      { url: 'https://www.ine.es/', nombre: 'INE — EPA', tipo: 'primaria', dato_especifico: 'Tasa de paro 4T 2023: 11,76 %' },
      { url: 'https://www.bde.es/', nombre: 'Banco de España', tipo: 'primaria', dato_especifico: 'Deuda pública 2023: 107,7 % del PIB' },
    ],
  } } }), 4600);
}

/* ── controls ───────────────────────────────────────────────────────────── */
$('play-overlay').addEventListener('click', () => {
  autoplayOk = true;
  if (yt) { try { yt.unMute(); yt.playVideo(); } catch { /* ignore */ } $('play-overlay').hidden = true; return; }
  player.muted = false;
  videoSeekBy = clock;
  player.currentTime = clock;
  player.play().then(() => { $('play-overlay').hidden = true; }).catch(() => {});
});
$('delay').addEventListener('change', (e) => {
  delaySeconds = Math.max(0, Math.round(+e.target.value || 0));
  e.target.value = delaySeconds;
  $('delay-val').textContent = delaySeconds;
  if (mode === 'buckets') {
    clock = Math.max(0, pipelineTime - delaySeconds - scrubOffset);
    syncLog('slider', { delay: delaySeconds, scrub: +scrubOffset.toFixed(1) });
    if (yt && ytOffset != null) requestYtSeek(clock + ytOffset, 'slider');
    flushPending();
  }
});

/* The viewer moved the picture (the player's own bar, a claim card, a
   keyboard seek): the clock follows the picture, and the delay is whatever
   distance that leaves to the pipeline. Nothing already on screen is taken
   back — cards persist — but everything not yet revealed up to the new
   position appears, and later events wait for the clock again. */
function adoptClock(t) {
  const before = clock;
  clock = Math.max(0, Math.min(t, sessionEnded ? t : pipelineTime));
  if (!sessionEnded) scrubOffset = pipelineTime - delaySeconds - clock;
  syncLog('clock.adopt', { from: +before.toFixed(1), to: +clock.toFixed(1), scrub: +scrubOffset.toFixed(1) });
  renderScrub();
  rewindState();
  flushPending();
}

/* The page is a log of the debate as the clock passed it. When the clock
   jumps, the "now speaking" panel, the captions and the cards must agree with
   the picture again: speaker from the timeline at the new clock, captions
   cleared, cards from later than the clock dimmed until it reaches them. */
const speakerTimeline = [];   // {t, sp}, in arrival order (t non-decreasing)
function rewindState() {
  captionParts = [];
  $('caption').textContent = '';
  // Past the verified head there is nothing newer to show: keep the last
  // known speaker rather than blanking the panel.
  if (!aheadOfHead()) {
    let last = null;
    for (const e of speakerTimeline) { if (e.t <= clock) last = e; else break; }
    if (last) showSpeaker(last.sp);
  }
  updateFuture();
}
function updateFuture() {
  for (const { el, t } of claims.values()) {
    if (t == null) continue;
    const future = t > clock + 0.5;
    el.classList.toggle('future', future);
    if (future) el.dataset.eta = `${Math.ceil(t - clock)} s`;
  }
}

function renderScrub() {
  const el = $('clock-scrub');
  if (!el) return;
  if (runnerSeekPending != null) {
    el.hidden = false;
    el.textContent = `saltando la verificación a ${fmtTime(runnerSeekPending)}…`;
    return;
  }
  if (aheadOfHead()) {
    el.hidden = false;
    const gap = fmtTime(pictureTime - pipelineTime);
    el.textContent = adminOn && bucketCfg?.vod && !canSeekRunner
      ? `imagen +${gap} por delante de lo verificado · el runner no sigue la barra (reinícialo)`
      : `imagen +${gap} por delante de lo verificado`;
    return;
  }
  const off = Math.round(scrubOffset);
  el.hidden = !liveMode || Math.abs(off) < 2;
  const effective = Math.max(0, Math.round(delaySeconds + off));
  el.textContent = `retardo efectivo ${effective} s · Sincronizar vuelve a ${delaySeconds} s`;
}
$('btn-play').addEventListener('click', () => {
  autoplayOk = true;
  $('play-overlay').hidden = true;
  if (yt) {
    try {
      yt.unMute();
      yt.getPlayerState() === YT.PlayerState.PLAYING ? yt.pauseVideo() : yt.playVideo();
    } catch { /* ignore */ }
    return;
  }
  player.muted = false;
  player.paused ? player.play().catch(showPlayPrompt) : player.pause();
});
player.addEventListener('play', () => ($('btn-play').textContent = 'Pausar'));
player.addEventListener('pause', () => ($('btn-play').textContent = 'Reproducir'));
$('btn-sync').addEventListener('click', () => {
  scrubOffset = 0;
  renderScrub();
  clock = Math.max(0, pipelineTime - delaySeconds);
  if (yt) {
    ytOffset = null;
    try { ytOffset = vodOffset() ?? (yt.getCurrentTime() - pipelineNow()); } catch { /* ignore */ }
    syncLog('resync', { offset: ytOffset });
    if (ytOffset != null) requestYtSeek(clock + ytOffset, 'resync');
  } else { videoSeekBy = clock; player.currentTime = clock; }
  flushPending();
});
player.addEventListener('seeked', () => {
  // A seek we did not make is the viewer scrubbing the <video>: follow it.
  if (videoSeekBy == null || Math.abs(player.currentTime - videoSeekBy) > 1) adoptClock(player.currentTime);
  else flushPending();
  videoSeekBy = null;
});

/* Phones: one header. The session title (and whether it is live or a
   replay) is mirrored into the site's top bar; the live header row is hidden. */
function syncTopbar() {
  const onair = $('onair');
  $('tb-live').textContent = $('session-title').textContent;
  $('tb-live').classList.toggle('off', onair.hidden || onair.classList.contains('diferido') || onair.classList.contains('paused'));
}
new MutationObserver(syncTopbar).observe($('session-title'), { childList: true, characterData: true, subtree: true });
new MutationObserver(syncTopbar).observe($('onair'), { attributes: true, childList: true });

setInterval(tickClock, 250);
renderStats();
renderBreakdown();
boot();
