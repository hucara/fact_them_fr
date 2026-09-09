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
  IMPRECISO: 'Impreciso',
  NO_VERIFICABLE: 'No verificable',
  SOBREESTIMADO: 'Sobreestimado',
  SUBESTIMADO: 'Subestimado',
};

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



/* ── helpers ────────────────────────────────────────────────────────────── */
const fmtTime = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
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
  // 1. Published buckets (static hosting / aton). The manifest is the only
  //    mutable object, so it is fetched with the cache bypassed.
  try {
    const key = sid ? `sessions/${encodeURIComponent(sid)}.json` : 'sessions/current.json';
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
    $('session-title').textContent = 'sin sesión activa';
    return;
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

function applySession() {
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

async function bootBuckets() {
  session = {
    session_id: bucketCfg.session_id,
    title: bucketCfg.title,
    roster: bucketCfg.roster || [],
    stages: bucketCfg.stages || {},
    youtube_id: bucketCfg.youtube_id,
  };
  applySession();
  delaySeconds = bucketCfg.delay_recommended ?? delaySeconds;
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
      playerVars: { autoplay: 1, mute: 1, playsinline: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          ytReady = true;
          if (vodOffset() != null) {
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

function railIsStatic() {
  return (session?.roster || []).length <= RAIL_STATIC_MAX;
}

function renderRail() {
  const rail = $('rail');
  if (railIsStatic()) {
    rail.innerHTML = (session.roster || []).map((r) => personHTML(r, 'en el plató')).join('');
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
if (window.ResizeObserver) new ResizeObserver(() => { $('rail').dataset.keys = ''; renderRail(); }).observe(document.querySelector('.col') || document.body);

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
  if (window.LIVE_ADMIN && ev.type === 'claim.detected' && (ev.t || 0) > clock) {
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
    case 'speaker.assigned': speakerTimeline.push({ t: ev.t || 0, sp: ev.payload.speaker }); showSpeaker(ev.payload.speaker); break;
    case 'window.result': if (ev.payload.is_final && !ev.payload.skipped) bump('windows'); break;
    case 'claim.detected': addClaim(ev); bump('claims'); break;
  }
}

/* ── now speaking + captions ────────────────────────────────────────────── */
let captionParts = [];
const captionWords = (t) =>
  esc(t).split(/\s+/).filter(Boolean).map((w, i) => `<span class="w" style="--i:${Math.min(i, 36)}">${w}</span>`).join(' ');
function showCaption(text) {
  if (switchActive === false) return;
  captionParts = [...captionParts, text].slice(-4);
  // The newest chunk arrives word by word; the one before it settles from
  // bright to muted; anything older is just text.
  const last = captionParts.length - 1;
  $('caption').innerHTML = captionParts
    .map((t, i) => {
      if (i === last) return `<b class="fresh">${captionWords(t)}</b>`;
      if (i === last - 1) return `<span class="settling">${esc(t)}</span>`;
      return esc(t);
    })
    .join(' ');
}

let shownSpeakerKey = null;
function showSpeaker(sp) {
  if (!sp) {
    // Nobody to show (the presiding officer has the floor): blank panel, the
    // transcript box starts over, the rail keeps the last real speakers.
    if (shownSpeakerKey !== null) {
      shownSpeakerKey = null;
      if (switchActive !== false) { captionParts = []; $('caption').textContent = ''; }
      $('now-name').textContent = '—';
      $('now-name').title = '';
      $('now-name').classList.remove('unknown');
      $('now-how').textContent = '';
      $('now-avatar').src = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
      $('now-avatar').classList.remove('live');
      document.querySelectorAll('.person').forEach((el) => el.classList.remove('active'));
    }
    return;
  }
  const key = sp.politician_id || sp.name || 'unknown';
  const changed = key !== shownSpeakerKey;
  if (changed) {
    // New speaker: the transcript box starts over, so what is on screen is
    // this person's words only.
    shownSpeakerKey = key;
    if (switchActive !== false) { captionParts = []; $('caption').textContent = ''; }
    pulseClass(document.querySelector('.now'), 'swap', 700);
  }
  noteSpeakerInRail(sp);
  $('now-name').innerHTML = `${esc(sp.name ? shortName(sp) : 'Orador no identificado')} ${partyChip(partyFor(sp))}`;
  $('now-name').title = sp.name || '';
  $('now-name').classList.toggle('unknown', !sp.name);
  const conf = sp.confidence ? ` · ${(sp.confidence * 100).toFixed(0)}%` : '';
  $('now-how').textContent = (SOURCE_LABEL[sp.source] || sp.source) + conf;
  const av = $('now-avatar');
  av.src = photoFor(sp) || 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  av.classList.toggle('live', String(sp.source || '').startsWith('face'));
  document.querySelectorAll('.person').forEach((el) =>
    el.classList.toggle('active', el.dataset.key === (sp.politician_id || ''))
  );
  if (changed) pulseClass(document.querySelector('.person.active'), 'just', 900);
}

/* ── claim cards ────────────────────────────────────────────────────────── */
/* Tag labels come from /vocabularies, i.e. from the same lists that are
   interpolated into the extractor's prompt. A value the model returned that
   isn't in the vocabulary is shown but flagged, so extractor drift is visible
   rather than silently rendered as if it were a valid category. */
/* Accent- and case-insensitive, because the model returns "economia" as often
   as "economía". That is a spelling difference, not a category the pipeline
   doesn't know — flagging it as off-vocabulary would cry wolf and make the
   real signal (a genuinely invented category) worthless. */
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

function cardHTML(c, sp, t) {
  const photo = photoFor(sp);
  const tags = [tag('ambito_tematico', c.ambito_tematico), tag('ambito_geografico', c.ambito_geografico)].join('');
  return `
    <div class="claim-header">
      ${photo ? `<img src="${esc(photo)}" alt="" />` : ''}
      <span class="politician-name ${sp?.name ? '' : 'unknown'}" title="${esc(sp?.name || '')}">${esc(sp?.name ? shortName(sp) : 'Sin atribuir')} ${partyChip(partyFor(sp))}</span>
      <button class="claim-at" data-seek="${t}" title="Ir a este momento del debate">
        <span class="clock-icon">◷</span>${fmtTime(t)}
      </button>
      <span class="resultado-badge resultado-forming">Detectando</span>
    </div>
    <p class="claim-text">${esc(c.texto_normalizado || c.texto_original)}</p>
    ${tags ? `<div class="claim-tags">${tags}</div>` : ''}
    <div class="verdict" hidden></div>`;
}

function makeCard(payload, state) {
  const el = document.createElement('article');
  el.className = 'claim-card';
  el.dataset.state = state;
  el.innerHTML = cardHTML(payload.claim, payload.speaker, payload.t_start ?? 0);
  el.querySelector('.claim-at').addEventListener('click', (e) => {
    clock = Math.max(0, parseFloat(e.target.dataset.seek) - 3);
    if (yt && ytOffset != null) requestYtSeek(clock + ytOffset, 'card');
    else { videoSeekBy = clock; player.currentTime = clock; }
    adoptClock(clock);
  });
  // Newest moment of the debate on top, whatever order the events arrive in
  // (a reload replays history; a resumed runner replays it after its own).
  const feed = $('feed');
  const t = payload.t_end ?? payload.t_start ?? 0;
  el.dataset.t = t;
  el.dataset.flip = payload.claim_id || `x${Math.random()}`;
  const before = [...feed.querySelectorAll('.claim-card')].find((c) => +c.dataset.t < t);
  if (before) feed.insertBefore(el, before); else feed.appendChild(el);
  growIn(el);
  $('feed-empty').hidden = true;
  if (settled && el === feed.querySelector('.claim-card') && feed.scrollTop > 60) noteNewAbove();
  return el;
}

/* A new card opens up from zero height to its own, so the cards around it
   are pushed aside continuously instead of jumping; the fade (CSS `enter`)
   runs over it. Collapsing is the same motion in reverse. */
const SHRINK = { duration: 1400, fill: 'forwards' };
const closedBox = { height: '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', marginBottom: '-0.75rem' };
/* Two phases in one animation, never overlapping: first the space opens (the
   card, still invisible, grows and pushes the others down), then the card
   fades in where the space is. One animation and no inline styles, so there
   is no state to clean up and nothing can be left half-shown. */
function growIn(el) {
  if (!motion() || !el.animate) return;
  const h = el.getBoundingClientRect().height;
  el.animate(
    [{ ...closedBox, opacity: 0, transform: 'translateY(6px)', easing: 'cubic-bezier(.25, .1, .25, 1)' },
     { height: `${h}px`, opacity: 0, transform: 'translateY(6px)', offset: .58, easing: 'cubic-bezier(.2, .7, .2, 1)' },
     { height: `${h}px`, opacity: 1, transform: 'none' }],
    { duration: 1050 });
}

/* A block that appears inside a card or above the list opens its space first
   and shows its content second, so nothing around it jumps. */
function growBox(el) {
  el.hidden = false;
  if (!motion() || !el.animate) return;
  const h = el.getBoundingClientRect().height;
  el.animate(
    [{ height: '0px', marginTop: '0px', opacity: 0, easing: 'cubic-bezier(.25, .1, .25, 1)' },
     { height: `${h}px`, opacity: 0, offset: .6, easing: 'ease-out' },
     { height: `${h}px`, opacity: 1 }],
    { duration: 600 });
}

/* A card that lands at the top while the reader is further down would go
   unseen: count it in a sticky pill that scrolls back up on click. */
let newAbove = 0;
function noteNewAbove() {
  newAbove += 1;
  const pill = $('feed-new');
  pill.querySelector('b').textContent = newAbove;
  pill.querySelector('.n').textContent = newAbove === 1 ? 'nueva afirmación' : 'nuevas afirmaciones';
  if (pill.hidden) pill.hidden = false; else bumpEl(pill.querySelector('b'));
}
$('feed-new').addEventListener('click', () => {
  newAbove = 0;
  $('feed-new').hidden = true;
  // Own tween rather than behavior:'smooth': it is honoured everywhere and
  // is not cancelled by the scroll anchoring a landing card triggers.
  const feed = $('feed');
  const from = feed.scrollTop;
  if (reducedMotion || from < 2) { feed.scrollTop = 0; return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / 380);
    feed.scrollTop = from * (1 - (1 - Math.pow(1 - k, 3)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
});
$('feed').addEventListener('scroll', () => {
  if ($('feed').scrollTop < 30 && newAbove) { newAbove = 0; $('feed-new').hidden = true; }
}, { passive: true });

function addClaim(ev) {
  const { claim_id, claim } = ev.payload;
  const el = makeCard(ev.payload, 'pending');
  claims.set(claim_id, { el, claim, startedAt: Date.now(), t: ev.t ?? ev.payload.t_end ?? null });
  markPending(claim_id);
  $('claim-count').textContent = claims.size;
  bumpEl($('claim-count'));

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
  const badge = entry.el.querySelector('.resultado-badge');
  badge.className = 'resultado-badge resultado-pending';
  badge.textContent = 'Verificando 0s';
}

/* A ticking counter on every in-flight verification. Verification takes tens of
   seconds; without this the UI is indistinguishable from one that has hung. */
function tickPending() {
  const now = Date.now();
  for (const entry of claims.values()) {
    const { el, startedAt, done } = entry;
    if (done) continue;
    if (entry.held && clock >= entry.verdictAt) { const h = entry.held; entry.held = null; applyVerdict(h); continue; }
    const badge = el.querySelector('.resultado-badge');
    if (badge?.classList.contains('resultado-pending')) {
      badge.textContent = `Verificando ${Math.round((now - startedAt) / 1000)}s`;
    }
  }
  renderStats();
}

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

  // NO_VERIFICABLE is never a finding about the world — only about the
  // pipeline — so it always goes to the drawer, never dropped: the claim was
  // still made, and hiding it would misrepresent the debate.
  //
  // This used to be gated on confidence, on the theory that a *confident*
  // NO_VERIFICABLE meant something substantive ("no official source exists").
  // The scores don't carry that distinction: a bare "no se pudo verificar"
  // with two sources came back at 0.55, while one with three sources and real
  // content scored 0.45. Since confidence can't separate the two, the verdict
  // type alone decides.
  const weak = verdict.resultado === 'NO_VERIFICABLE';
  entry.el.dataset.weak = weak ? '1' : '';
  bump('verdicts');

  const { el } = entry;
  const cls = resultadoToClass(verdict.resultado);
  el.dataset.state = 'done';
  // Unverifiable claims go to the folded drawer under the list: verdict
  // shown, a hold, a fade, and the drawer lights up as it takes the card.
  const toDrawer = weak;
  el.dataset.resultado = cls;

  const badge = el.querySelector('.resultado-badge');
  badge.className = `resultado-badge resultado-${cls}`;
  badge.textContent = RESULTADO_LABELS[verdict.resultado] || verdict.resultado;
  if (motion() && !toDrawer) el.classList.add('reveal');

  // Sources: tier, name, the specific figure it gives — one row each, the
  // tier badge a fixed width so the names line up.
  // Primary sources first, then academic, then the rest — in the order the
  // verifier gave them within each tier.
  const tierRank = (f) => ({ primaria: 0, academica: 1, secundaria: 2, terciaria: 3 }[foldKey(f.tipo || '')] ?? 4);
  const sources = (verdict.fuentes || [])
    .filter((f) => f.url)
    .map((f, i) => [f, i])
    .sort((a, b) => tierRank(a[0]) - tierRank(b[0]) || a[1] - b[1])
    .map(([f]) => f)
    .slice(0, 4)
    .map((f) => {
      const tier = f.tipo || '';
      const gloss = VOCAB.fuente_tipo?.[tier];
      return `<a class="src" href="${esc(f.url)}" target="_blank" rel="noopener">
        <span class="src-tier src-${esc(foldKey(tier || 'otra'))}"${gloss ? ` title="${esc(gloss)}"` : ''}>${esc(tier || 'fuente')}</span>
        <span class="src-body"><b>${esc(f.nombre || f.url)}</b>${f.dato_especifico ? `<small>${esc(f.dato_especifico)}</small>` : ''}</span>
      </a>`;
    })
    .join('');
  const notes = (verdict.errores || []).concat(verdict.omisiones || []).slice(0, 3);
  const conf = Math.round(100 * (verdict.confidence_score || 0));

  // Collapsed, a card answers one question: who said what, and was it true?
  // Expanded, three labelled blocks: the correct statement, the nuances, the
  // sources — and one footer line with confidence and timing.
  const headline = verdict.afirmacion_correcta || '';

  const box = el.querySelector('.verdict');
  box.innerHTML = `
    <div class="claim-actions">
      <button class="detail-toggle" aria-expanded="false">Ver verificación completa</button>
      ${shareButton(el, verdict)}
    </div>
    <div class="verdict-detail"><div class="vd-inner"><div class="vd-pad">
      ${headline ? `<section class="vd"><h4>Lo que dicen los datos</h4><p class="verdict-headline">${esc(headline)}</p></section>` : ''}
      ${notes.length ? `<section class="vd"><h4>Matices</h4><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : ''}
      ${sources ? `<section class="vd"><h4>Fuentes</h4><div class="sources">${sources}</div></section>` : ''}
      <div class="claim-foot">
        <span class="confidence"><span class="confidence-track"><span class="confidence-fill" style="width:${conf}%"></span></span>${conf}% confianza</span>
        ${latency_seconds != null ? `<span>verificado en ${Math.round(latency_seconds)} s</span>` : ''}
        ${cache_hit ? '<span>⚡ caché</span>' : ''}
      </div>
    </div></div></div>`;

  countVerdict(verdict.resultado);
  growBox(box);
  if (toDrawer) {
    if (!motion()) parkInDrawer(el);
    else setTimeout(() => relocateCard(el, () => parkInDrawer(el)), 2500);
  }
}

function parkInDrawer(el) {
  const drawer = $('weak-drawer');
  $('weak-list').appendChild(el);
  drawer.hidden = false;
  $('weak-count').textContent = $('weak-list').childElementCount;
  bumpEl($('weak-count'));
  pulseClass(drawer, 'received', 2200);
}

const isMobile = () => !!(window.matchMedia && matchMedia('(max-width: 760px)').matches);
const mobileLive = () => isMobile() && !window.LIVE_ADMIN;

/* Fade out in place, close the space, move (the callback), reopen. */
function relocateCard(el, move) {
  const h = el.getBoundingClientRect().height;
  el.style.overflow = 'hidden';
  const fold = el.animate(
    [{ opacity: 1, height: `${h}px`, easing: 'ease-out' },
     { opacity: 0, height: `${h}px`, offset: .42, easing: 'linear' },
     { opacity: 0, height: `${h}px`, offset: .55, easing: 'cubic-bezier(.4, 0, .2, 1)' },
     { opacity: 0, ...closedBox }],
    { duration: 1400, fill: 'forwards' });
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    fold.cancel();
    el.style.overflow = '';
    move();
    growIn(el);
  };
  fold.onfinish = finish;
  setTimeout(finish, 1550);
}

/* ── verdict breakdown (left column) ────────────────────────────────────── */
const VB_ORDER = [
  ['verdadero', 'Confirmado'],
  ['parcial', 'Con matiz'],
  ['enganoso', 'Sobre/subestimado'],
  ['falso', 'Falso'],
];   // unverifiable claims are counted on the drawer, not here
const verdictCounts = {};

function countVerdict(resultado) {
  const cls = resultadoToClass(resultado);
  verdictCounts[cls] = (verdictCounts[cls] || 0) + 1;
  renderBreakdown();
}

/* ── cost ───────────────────────────────────────────────────────────────── */
let lastCost = null;
function renderCost(cost) {
  if (!cost) return;
  lastCost = cost;
  const usd = cost.usd || 0;
  const perClaim = claims.size ? usd / claims.size : 0;
  // A 10-minute demo costs cents, so cents is the unit that reads.
  const money = usd < 1 ? `${(usd * 100).toFixed(2)}¢` : `$${usd.toFixed(2)}`;
  $('cost-total').textContent = money;
  $('cost-detail').innerHTML = `
    <span>${cost.calls} llamadas</span>
    <span>${((cost.prompt_tokens || 0) / 1000).toFixed(1)}k tokens entrada</span>
    <span>${((cost.completion_tokens || 0) / 1000).toFixed(1)}k salida</span>
    ${cost.cached_tokens ? `<span>${((cost.cached_tokens || 0) / 1000).toFixed(1)}k en caché</span>` : ''}
    ${claims.size ? `<span>${(perClaim * 100).toFixed(2)}¢ por afirmación</span>` : ''}
    ${(usd && pipelineTime) ? `<span>≈$${((usd / pipelineTime) * 3600).toFixed(2)}/hora de debate</span>` : ''}`;
}

/* One stacked bar, not five. At the counts a live debate produces (a dozen or
   two), five separate tracks are mostly empty rails; a single bar shows the
   mix at a glance and reads as a summary of the feed it sits above. */
function renderBreakdown() {
  const total = Object.values(verdictCounts).reduce((a, b) => a + b, 0);
  const bar = $('summary-bar');
  if (!total) { bar.hidden = true; return; }
  const firstShow = bar.hidden;

  // Built once, then updated in place: the segments' flex values tween and
  // a changed count bumps, instead of the whole bar being rebuilt.
  if (!bar.firstElementChild) {
    bar.innerHTML = `
    <div class="sb-track">
      ${VB_ORDER.map(([cls]) => `<span class="sb-seg sb-${cls} empty" data-cls="${cls}" style="flex:0"></span>`).join('')}
    </div>
    <div class="sb-legend">
      ${VB_ORDER.map(([cls, label]) => `<span class="sb-key" data-cls="${cls}" hidden><span class="dot sb-${cls}"></span>${label} <b>0</b></span>`).join('')}
    </div>`;
  }
  for (const [cls] of VB_ORDER) {
    const n = verdictCounts[cls] || 0;
    const seg = bar.querySelector(`.sb-seg[data-cls="${cls}"]`);
    seg.style.flex = String(n);
    seg.classList.toggle('empty', !n);
    const key = bar.querySelector(`.sb-key[data-cls="${cls}"]`);
    key.hidden = !n;
    const b = key.querySelector('b');
    if (b.textContent !== String(n)) { b.textContent = n; bumpEl(b); }
  }
  if (firstShow) growBox(bar);
}


/* ── Share ──────────────────────────────────────────────────────────────────
   Same menu as the rest of Facthem (see fact_them_fr/js/app.js). The one
   difference is what gets shared: a live claim has no permalink yet — the
   archive page is written after the session — so the shared text stands on its
   own (speaker, claim, verdict) and links to the site rather than to a claim
   page that would 404. */
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

const SHARE_URL = 'https://facthem.es';

function shareText(el, verdict) {
  const name = el.querySelector('.politician-name')?.textContent?.trim() || 'Un político';
  const claimText = el.querySelector('.claim-text')?.textContent?.trim() || '';
  const truncated = claimText.length > 200 ? claimText.slice(0, 200) + '…' : claimText;
  const key = String(verdict.resultado || '').toUpperCase();
  const emoji = RESULTADO_EMOJIS[key] ?? '🔍';
  const label = RESULTADO_LABELS[key] || verdict.resultado || 'Sin verificar';
  return `🔍 ${name} ha afirmado: "${truncated}"\n${emoji} ${label} | facthem.es`;
}

function shareButton(el, verdict) {
  const text = shareText(el, verdict);
  const full = text + '\n\n' + SHARE_URL;
  const u = encodeURIComponent(full);
  const url = encodeURIComponent(SHARE_URL);
  return `
    <span class="share-wrapper">
      <button class="share-btn" aria-label="Compartir afirmación">${SHARE_ICON}</button>
      <span class="share-menu" hidden>
        <a class="share-option" href="https://wa.me/?text=${u}" target="_blank" rel="noopener">WhatsApp</a>
        <a class="share-option" href="https://twitter.com/intent/tweet?text=${u}&via=facthem_ES"
           target="_blank" rel="noopener">X / Twitter</a>
        <a class="share-option" href="https://t.me/share/url?url=${url}&text=${encodeURIComponent(text)}"
           target="_blank" rel="noopener">Telegram</a>
      </span>
    </span>`;
}

/* One delegated listener for every card, present and future. */
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('.detail-toggle');
  if (toggle) {
    const panel = toggle.closest('.verdict').querySelector('.verdict-detail');
    const open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? 'Ocultar verificación' : 'Ver verificación completa';
    return;
  }

  const btn = e.target.closest('.share-btn');

  if (btn) {
    e.stopPropagation();
    const menu = btn.closest('.share-wrapper').querySelector('.share-menu');
    const wasHidden = menu.hidden;
    document.querySelectorAll('.share-menu').forEach((m) => { m.hidden = true; });
    menu.hidden = !wasHidden;
    return;
  }
  document.querySelectorAll('.share-menu').forEach((m) => { m.hidden = true; });
});

/* ── debug: text processing ──────────────────────────────────────────────
   What each transcript window looked like when it was handed to the model,
   and what came back: claims, duplicates dropped, or why it was skipped
   (paused, prefilter). Off by default and recorded only while the checkbox
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
  if (!yt || !ytReady || mobileLive()) return;
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
  pill.textContent = paused ? 'en pausa' : 'en directo';
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
  const roster = (session.roster || []).filter((r) => r.politician_id);
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

setInterval(tickClock, 250);
renderStats();
boot();
