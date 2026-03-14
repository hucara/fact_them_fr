import { supabase } from './supabase-client.js';

// ─── Label maps ───────────────────────────────────────────────────────────────
const TEMATICO_LABELS = {
  defensa: 'Defensa',
  'economía': 'Economía',
  educacion: 'Educación',
  igualdad: 'Igualdad',
  industria_y_trabajo: 'Industria y Trabajo',
  'inmigración': 'Inmigración',
  interior: 'Interior',
  justicia_y_corrupcion: 'Justicia y Corrupción',
  medio_ambiente: 'Medio Ambiente',
  otros: 'Otros',
  politica_social: 'Política Social',
  relaciones_internacionales: 'Relaciones Internacionales',
  sanidad: 'Sanidad',
  vivienda: 'Vivienda',
};

const RESULTADO_LABELS = {
  CONFIRMADO: 'Confirmado',
  CONFIRMADO_CON_MATIZ: 'Con matiz',
  DESCONTEXTUALIZADO: 'Descontextualizado',
  FALSO: 'Falso',
  IMPRECISO: 'Impreciso',
  NO_VERIFICABLE: 'No verificable',
  SOBREESTIMADO: 'Sobreestimado',
  SUBESTIMADO: 'Subestimado',
};

// ─── State ────────────────────────────────────────────────────────────────────
let allClaims = [];
let claimsById = {};

// ─── Búsqueda state ───────────────────────────────────────────────────────────
let allPoliticians = [];
let searchLoaded = false;
let activeSearchIndex = -1;
let searchClaimsCache = {};
let claimCount = 0;

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  setupTabs();
  setupHeroCTAs();
  setupFilters();
  setupModal();
  setupShare();
  await Promise.all([loadSessions(), handleClaimDeepLink()]);
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab-button').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view-container').forEach(v => v.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'view-estadisticas' && !window.statsLoaded) {
        loadGlobalDashboard();
      }
      if (tab.dataset.tab === 'view-busqueda' && !searchLoaded) {
        loadPoliticians();
      }
    });
  });
}

// ─── Hero CTAs ────────────────────────────────────────────────────────────────
function setupHeroCTAs() {
  document.querySelectorAll('.hero-cta[data-cta]').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.cta;
      const tabBtn = document.querySelector(`.tab-button[data-tab="view-${target}"]`);
      if (tabBtn) tabBtn.click();
    });
  });
}

// ─── Session selector + content filters ───────────────────────────────────────
function setupFilters() {
  document.getElementById('filter-session').addEventListener('change', e => {
    if (e.target.value) loadSession(e.target.value);
  });

  document.querySelectorAll('#filters select:not(#filter-session)').forEach(sel => {
    sel.addEventListener('change', applyFilters);
  });

  document.getElementById('search-claim').addEventListener('input', applyFilters);
}

// ─── Sessions ─────────────────────────────────────────────────────────────────
async function loadSessions() {
  const sel = document.getElementById('filter-session');
  sel.disabled = true;

  const [{ data, error }, { count: headerCount }, { data: claimSessions }] = await Promise.all([
    supabase.from('session').select('id, legislatura, tipo, numero, fecha, organo, status').order('fecha', { ascending: false }),
    supabase.from('claim').select('id', { count: 'exact', head: true }),
    supabase.from('claim').select('session_id, verification!inner(id)'),
  ]);

  sel.disabled = false;

  if (error || !data?.length) {
    sel.innerHTML = '<option value="">Sin sesiones disponibles</option>';
    return;
  }

  const sessionIdsWithClaims = new Set((claimSessions ?? []).map(c => c.session_id));
  const sessions = data.filter(s => sessionIdsWithClaims.has(s.id));

  claimCount = headerCount ?? 0;

  const statsEl = document.getElementById('header-stats');
  if (statsEl) {
    statsEl.innerHTML =
      `<strong>${sessions.length}</strong> sesiones · <strong>${claimCount.toLocaleString('es-ES')}</strong> afirmaciones`;
  }

  if (!sessions.length) {
    sel.innerHTML = '<option value="">Sin sesiones disponibles</option>';
    return;
  }

  sel.innerHTML = '<option value="">Seleccionar sesión…</option>' +
    sessions.map(s => {
      const fecha = s.fecha
        ? new Date(s.fecha).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
        : '—';
      const organ = s.organo ? ` · ${s.organo}` : '';
      return `<option value="${s.id}">${fecha}${organ}</option>`;
    }).join('');

  // Pre-select and load the latest session automatically
  sel.value = sessions[0].id;
  loadSession(sessions[0].id);
}

// ─── Claims for a session ─────────────────────────────────────────────────────
async function loadSession(sessionId) {
  const container = document.getElementById('claims-container');
  container.innerHTML = '<p class="loading">Cargando afirmaciones…</p>';

  const { data, error } = await supabase
    .from('claim')
    .select(`
      id, texto_normalizado, texto_original, entidad, metrica,
      valor_afirmado, periodo_temporal, ambito_geografico, ambito_tematico,
      fuente_citada, verificabilidad, centralidad, relevancia, tipo_claim,
      politician:politician_id (nombre_completo, partido, grupo_parlamentario),
      verification (
        resultado, confidence_score, afirmacion_correcta,
        omisiones, errores, fuentes, potencial_engano,
        recomendacion_redaccion, razonamiento_llm
      )
    `)
    .eq('session_id', sessionId)
    .order('id');

  if (error) {
    container.innerHTML = `<p class="error">Error al cargar afirmaciones: ${error.message}</p>`;
    return;
  }

  allClaims = data ?? [];
  claimsById = Object.fromEntries(allClaims.map(c => [c.id, c]));

  ['filter-resultado', 'filter-tematico', 'filter-politico'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.selectedIndex = 0;
  });
  populateFilters(allClaims);
  renderClaims(allClaims);
}

// ─── Filters ──────────────────────────────────────────────────────────────────
function populateFilters(claims) {
  const tematicos = [...new Set(claims.map(c => c.ambito_tematico).filter(Boolean))].sort();
  const resultados = [...new Set(
    claims.flatMap(c => c.verification?.map(v => v.resultado) ?? []).filter(Boolean)
  )].sort();
  const politicos = [...new Map(
    claims.filter(c => c.politician?.nombre_completo)
      .map(c => [c.politician.nombre_completo, c.politician])
  ).values()].sort((a, b) =>
    (a.nombre_completo ?? '').localeCompare(b.nombre_completo ?? '')
  );

  setSelectOptions('filter-tematico',
    tematicos.map(t => ({ value: t, label: TEMATICO_LABELS[t] ?? snakeToLabel(t) })),
    'Temática'
  );
  setSelectOptions('filter-resultado',
    resultados.map(r => ({ value: r, label: RESULTADO_LABELS[r] ?? snakeToLabel(r) })),
    'Resultado'
  );
  setSelectOptions('filter-politico',
    politicos.map(p => ({ value: p.nombre_completo, label: p.nombre_completo })),
    'Político'
  );
}

function setSelectOptions(id, items, placeholder) {
  const sel = document.getElementById(id);
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    items.map(item => {
      const value = typeof item === 'string' ? item : item.value;
      const label = typeof item === 'string' ? item : item.label;
      return `<option value="${value}">${label}</option>`;
    }).join('');
}

function applyFilters() {
  const tematico = document.getElementById('filter-tematico').value;
  const resultado = document.getElementById('filter-resultado').value;
  const politico = document.getElementById('filter-politico').value;
  const search = document.getElementById('search-claim').value.trim().toLowerCase();

  const filtered = allClaims.filter(c => {
    if (tematico && c.ambito_tematico !== tematico) return false;
    if (politico && c.politician?.nombre_completo !== politico) return false;
    if (resultado) {
      const hasResult = c.verification?.some(v => v.resultado === resultado);
      if (!hasResult) return false;
    }
    if (search) {
      const haystack = [c.texto_normalizado, c.texto_original]
        .filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  renderClaims(filtered);
}

// ─── Render claims ────────────────────────────────────────────────────────────
function renderClaims(claims) {
  const container = document.getElementById('claims-container');

  if (!claims.length) {
    container.innerHTML = '<p class="empty">No hay afirmaciones que coincidan con los filtros.</p>';
    return;
  }

  container.innerHTML = claims.map(c => claimCard(c)).join('');

  container.querySelectorAll('.claim-toggle').forEach(btn => {
    btn.addEventListener('click', () => openModal(claimsById[btn.dataset.id]));
  });
}

function claimCard(claim) {
  const v = claim.verification?.[0] ?? null;
  const pol = claim.politician;

  const resultadoClass = v ? resultadoToClass(v.resultado) : 'nv';
  const resultadoLabel = v ? formatResultado(v.resultado) : 'Sin verificar';
  const score = v && v.confidence_score != null ? Math.round(v.confidence_score * 100) : null;

  const tags = [
    claim.ambito_tematico ? `<span class="tag tag-tematico">${escHtml(snakeToLabel(claim.ambito_tematico))}</span>` : '',
    claim.ambito_geografico ? `<span class="tag tag-geo">${escHtml(snakeToLabel(claim.ambito_geografico))}</span>` : '',
  ].filter(Boolean).join('');

  return `
    <article class="claim-card" data-resultado="${resultadoClass}">
      <header class="claim-header">
        <div class="claim-meta-top">
          ${pol
      ? `<span class="politician-name">${escHtml(formatNombre(pol.nombre_completo))}</span>
               ${pol.partido ? `<span class="partido-badge">${escHtml(pol.partido)}</span>` : ''}`
      : '<span class="politician-name unknown">Político desconocido</span>'}
        </div>
        <span class="resultado-badge resultado-${resultadoClass}">${resultadoLabel}</span>
      </header>

      <blockquote class="claim-text" title="${escHtml(claim.texto_original)}">
        ${escHtml(capitalize(claim.texto_normalizado))}
      </blockquote>

      ${score !== null ? `
        <div class="confidence-bar" title="Confianza del modelo: ${score}%">
          <div class="confidence-track">
            <div class="confidence-fill confidence-${resultadoClass}" style="width:${score}%"></div>
          </div>
          <span class="confidence-label">${score}% confianza</span>
        </div>` : ''}

      ${tags ? `<div class="claim-tags">${tags}</div>` : ''}

      <div class="claim-actions">
        ${v ? `<button class="claim-toggle" data-id="${claim.id}">Ver más →</button>` : ''}
        <div class="share-wrapper">
          <button class="share-btn" aria-label="Compartir afirmación">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
              <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
            </svg>
          </button>
          <div class="share-menu" hidden>${buildShareMenu(claim)}</div>
        </div>
      </div>
    </article>`;
}

// ─── Modal ────────────────────────────────────────────────────────────────────
function setupModal() {
  const overlay = document.getElementById('modal-overlay');
  const closeBtn = document.getElementById('modal-close');

  closeBtn.addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

function openModal(claim) {
  if (!claim) return;

  const v = claim.verification?.[0] ?? null;
  const pol = claim.politician;

  const resultadoClass = v ? resultadoToClass(v.resultado) : 'nv';
  const resultadoLabel = v ? formatResultado(v.resultado) : 'Sin verificar';
  const score = v && v.confidence_score != null ? Math.round(v.confidence_score * 100) : null;

  const tags = [
    claim.ambito_tematico ? `<span class="tag tag-tematico">${escHtml(snakeToLabel(claim.ambito_tematico))}</span>` : '',
    claim.ambito_geografico ? `<span class="tag tag-geo">${escHtml(snakeToLabel(claim.ambito_geografico))}</span>` : '',
  ].filter(Boolean).join('');

  const details = v
    ? [renderErrores(v.errores), renderOmisiones(v.omisiones), renderFuentes(v.fuentes)]
      .filter(Boolean).join('')
    : '';

  const card = document.getElementById('modal-card');
  card.dataset.resultado = resultadoClass;

  document.getElementById('modal-content').innerHTML = `
    <header class="claim-header" style="margin-bottom:1.25rem">
      <div class="claim-meta-top">
        ${pol
      ? `<span class="politician-name" style="font-size:1.05rem">${escHtml(formatNombre(pol.nombre_completo))}</span>
             ${pol.partido ? `<span class="partido-badge">${escHtml(pol.partido)}</span>` : ''}`
      : '<span class="politician-name unknown">Político desconocido</span>'}
      </div>
      <span class="resultado-badge resultado-${resultadoClass}">${resultadoLabel}</span>
    </header>

    <blockquote class="claim-text modal-claim-text" title="${escHtml(claim.texto_original)}">
      ${escHtml(capitalize(claim.texto_normalizado))}
    </blockquote>

    ${score !== null ? `
      <div class="confidence-bar" style="margin-bottom:1rem" title="Confianza del modelo: ${score}%">
        <div class="confidence-track" style="width:160px">
          <div class="confidence-fill confidence-${resultadoClass}" style="width:${score}%"></div>
        </div>
        <span class="confidence-label">${score}% confianza</span>
      </div>` : ''}

    ${tags ? `<div class="claim-tags" style="margin-bottom:1.25rem">${tags}</div>` : ''}

    ${details ? `<dl class="modal-detail-list">${details}</dl>` : ''}

    <div class="modal-share">
      <div class="share-wrapper">
        <button class="share-btn share-btn--labeled" aria-label="Compartir afirmación">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>
          </svg>
          Compartir
        </button>
        <div class="share-menu" hidden>${buildShareMenu(claim)}</div>
      </div>
    </div>
  `;

  const overlay = document.getElementById('modal-overlay');
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  document.getElementById('modal-close').focus();
}

function closeModal() {
  document.getElementById('modal-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

// ─── Share ────────────────────────────────────────────────────────────────────
function buildShareUrl(claimId) {
  return `https://facthem.es/?claim=${claimId}`;
}

function formatNombre(str) {
  const parts = String(str ?? '').split(',');
  return parts.length === 2 ? `${parts[1].trim()} ${parts[0].trim()}` : String(str ?? '');
}

function buildShareText(claim) {
  const pol = claim.politician;
  const v = claim.verification?.[0] ?? null;
  const resultado = v ? formatResultado(v.resultado) : 'Sin verificar';
  const nombre = pol ? formatNombre(pol.nombre_completo) : 'Un político';
  const partido = pol?.partido ? ` (${pol.partido})` : '';
  const texto = String(claim.texto_normalizado ?? '').trim();
  const truncated = texto.length > 120 ? texto.slice(0, 120) + '…' : texto;
  return `${nombre}${partido} afirmó: "${truncated}"\n${resultado} | Facthem.es`;
}

function buildShareMenu(claim) {
  const shareUrl = buildShareUrl(claim.id);
  const shareText = buildShareText(claim);
  const encodedUrl = encodeURIComponent(shareUrl);
  const encodedText = encodeURIComponent(shareText);
  const encodedWa = encodeURIComponent(shareText + '\n' + shareUrl);

  return `
    <a class="share-option" href="https://wa.me/?text=${encodedWa}" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347zM12 0C5.373 0 0 5.373 0 12c0 2.127.557 4.123 1.532 5.856L0 24l6.335-1.652A11.954 11.954 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/></svg>
      WhatsApp
    </a>
    <a class="share-option" href="https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}&via=facthem_ES" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      X / Twitter
    </a>
    <a class="share-option" href="https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
      Facebook
    </a>
    <a class="share-option" href="https://t.me/share/url?url=${encodedUrl}&text=${encodedText}" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
      Telegram
    </a>
    <button class="share-option share-copy-btn" data-url="${escHtml(shareUrl)}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      <span>Copiar enlace</span>
    </button>`;
}

function setupShare() {
  document.addEventListener('click', e => {
    const shareBtn = e.target.closest('.share-btn');
    const copyBtn = e.target.closest('.share-copy-btn');

    if (shareBtn) {
      e.stopPropagation();
      const menu = shareBtn.closest('.share-wrapper').querySelector('.share-menu');
      const isHidden = menu.hidden;
      document.querySelectorAll('.share-menu').forEach(m => { m.hidden = true; });
      menu.hidden = !isHidden;
      return;
    }

    if (copyBtn) {
      e.stopPropagation();
      handleShareCopy(copyBtn, copyBtn.dataset.url);
      return;
    }

    document.querySelectorAll('.share-menu').forEach(m => { m.hidden = true; });
  });
}

async function handleShareCopy(btn, url) {
  try {
    await navigator.clipboard.writeText(url);
    const span = btn.querySelector('span');
    if (span) {
      span.textContent = '¡Copiado!';
      setTimeout(() => { span.textContent = 'Copiar enlace'; }, 2000);
    }
  } catch { /* clipboard not available */ }
}

function updateOGTags(claim) {
  const pol = claim.politician;
  const v = claim.verification?.[0] ?? null;
  const nombre = pol ? formatNombre(pol.nombre_completo) : 'Un político';
  const resultado = v ? formatResultado(v.resultado) : 'Sin verificar';
  const texto = String(claim.texto_normalizado ?? '').trim();
  const desc = texto.length > 160 ? texto.slice(0, 160) + '…' : texto;
  const title = `${nombre} — ${resultado} | Facthem`;

  document.title = title;
  setMeta('name', 'description', desc);
  setMeta('property', 'og:title', title);
  setMeta('property', 'og:description', desc);
  setMeta('property', 'og:url', `https://facthem.es/?claim=${claim.id}`);
  setMeta('name', 'twitter:title', title);
  setMeta('name', 'twitter:description', desc);
}

function setMeta(attr, value, content) {
  const el = document.querySelector(`meta[${attr}="${value}"]`);
  if (el) el.setAttribute('content', content);
}

async function handleClaimDeepLink() {
  const claimId = new URLSearchParams(window.location.search).get('claim');
  if (!claimId) return;

  const { data, error } = await supabase
    .from('claim')
    .select(`
      id, texto_normalizado, texto_original, entidad, metrica,
      valor_afirmado, periodo_temporal, ambito_geografico, ambito_tematico,
      fuente_citada, verificabilidad, centralidad, relevancia, tipo_claim,
      politician:politician_id (nombre_completo, partido, grupo_parlamentario),
      verification (
        resultado, confidence_score, afirmacion_correcta,
        omisiones, errores, fuentes, potencial_engano,
        recomendacion_redaccion, razonamiento_llm
      )
    `)
    .eq('id', claimId)
    .single();

  if (!error && data) {
    updateOGTags(data);
    openModal(data);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isValidValue(v) {
  return v && v !== 'N/A' && v !== '-' && v !== 'n/a';
}

function capitalize(str) {
  const s = String(str ?? '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function snakeToLabel(str) {
  return capitalize(String(str ?? '').replace(/_/g, ' '));
}

function toListItems(text) {
  return text
    .split(/\n|;/)
    .map(s => s.replace(/^[\s\-•*\d.]+/, '').trim())
    .filter(Boolean);
}

function renderErrores(raw) {
  if (!isValidValue(raw)) return '';
  let items = [];
  try {
    const parsed = JSON.parse(raw);
    items = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [String(parsed)];
  } catch {
    items = [raw.trim()].filter(Boolean);
  }
  if (!items.length) return '';
  return `<div class="detail-row detail-errores">
    <dt>Error detectado</dt>
    <dd>${items.map(i => `<em>${escHtml(capitalize(i))}</em>`).join('<br><br>')}</dd>
  </div>`;
}

function renderOmisiones(raw) {
  if (!isValidValue(raw)) return '';
  let items = [];
  try { items = JSON.parse(raw); } catch { items = toListItems(raw); }
  if (!Array.isArray(items) || !items.length) return '';
  return `<div class="detail-row">
    <dt>Omisiones</dt>
    <dd><ul class="detail-list omisiones">
      ${items.map(i => `<li>${escHtml(capitalize(String(i)))}</li>`).join('')}
    </ul></dd>
  </div>`;
}

const FUENTE_TIPO_ORDER = { 'Primaria': 0, 'Académica': 1, 'Secundaria': 2, 'Terciaria': 3 };

function renderFuentes(raw) {
  if (!isValidValue(raw)) return '';
  let items = [];
  try { items = JSON.parse(raw); } catch {
    const plain = toListItems(raw);
    if (!plain.length) return '';
    return `<div class="detail-row">
      <dt>Fuentes</dt>
      <dd><ul class="detail-list fuentes">${plain.map(i => `<li>${escHtml(i)}</li>`).join('')}</ul></dd>
    </div>`;
  }
  if (!Array.isArray(items) || !items.length) return '';

  const sorted = [...items].sort((a, b) =>
    (FUENTE_TIPO_ORDER[a.tipo] ?? 9) - (FUENTE_TIPO_ORDER[b.tipo] ?? 9)
  );

  const bullets = sorted.map(s => {
    const isPrimary = s.tipo === 'Primaria';
    const tipoKey = (s.tipo ?? '').toLowerCase().replace(/[^a-z]/g, '') || 'otra';
    const name = escHtml(s.nombre ?? 'Fuente');
    const link = s.url
      ? `<a class="source-link" href="${escHtml(s.url)}" target="_blank" rel="noopener">${name}</a>`
      : `<span>${name}</span>`;
    const tipoBadge = s.tipo
      ? `<span class="source-tipo source-tipo--${tipoKey}">${escHtml(s.tipo)}</span>`
      : '';
    const dato = s.dato_especifico
      ? `<span class="source-dato">${escHtml(s.dato_especifico)}</span>`
      : '';
    return `<li class="fuente-item${isPrimary ? ' fuente-item--primary' : ''}">${tipoBadge}${link}${dato}</li>`;
  }).join('');

  return `<div class="detail-row">
    <dt>Fuentes</dt>
    <dd><ul class="detail-list fuentes">${bullets}</ul></dd>
  </div>`;
}

function resultadoToClass(resultado) {
  if (!resultado) return 'nv';
  const map = {
    'CONFIRMADO': 'verdadero',
    'CONFIRMADO_CON_MATIZ': 'parcial',
    'DESCONTEXTUALIZADO': 'enganoso',
    'IMPRECISO': 'nv',
    'FALSO': 'falso',
    'NO_VERIFICABLE': 'nv',
    'SOBREESTIMADO': 'enganoso',
    'SUBESTIMADO': 'enganoso',
  };
  return map[resultado.toUpperCase()] ?? 'nv';
}

function formatResultado(resultado) {
  if (!resultado) return 'Sin verificar';
  return RESULTADO_LABELS[resultado.toUpperCase()] ?? snakeToLabel(resultado);
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
async function loadGlobalDashboard() {
  window.statsLoaded = true;
  const grid = document.getElementById('dashboard-grid');
  const loader = document.getElementById('dashboard-loading');

  const { data, error } = await supabase
    .from('dashboard_stats')
    .select('stats')
    .eq('id', 1)
    .single();

  if (error || !data?.stats) {
    loader.innerHTML = `<p class="error">Error al cargar estadísticas: ${error?.message ?? 'sin datos'}</p>`;
    return;
  }

  loader.style.display = 'none';
  grid.classList.remove('hidden');

  const stats = typeof data.stats === 'string' ? JSON.parse(data.stats) : data.stats;
  renderDashboard(stats);
}

function renderDashboard(s) {
  const grid = document.getElementById('dashboard-grid');

  const total = s.total_claims || 0;
  const totalFalsos = s.total_falsos || 0;
  const totalConfirm = s.total_confirmados || 0;
  const porcFalsos = total > 0 ? Math.round((totalFalsos / total) * 100) : 0;
  const porcConfirmados = total > 0 ? Math.round((totalConfirm / total) * 100) : 0;

  const d = (field) => s[field] || {};
  const polLabel = (f) => {
    const o = d(f);
    return o.name ? `${formatNombre(o.name)}${o.partido ? ` · ${o.partido}` : ''}` : '-';
  };

  const cb = s.combo_breaker || {};
  const bc = s.bocachancla || {};
  const cbLabel = cb.politico ? `${formatNombre(cb.politico)} · ${cb.partido}` : '-';
  const bcLabel = bc.politico ? `${formatNombre(bc.politico)} · ${bc.partido}` : '-';
  const cbSub = cb.fecha ? `${cb.count} confirmados en el pleno del ${new Date(cb.fecha).toLocaleDateString('es-ES')}` : '-';
  const bcSub = bc.fecha ? `${bc.count} falsedades en el pleno del ${new Date(bc.fecha).toLocaleDateString('es-ES')}` : '-';

  const temaLabel = (f) => {
    const name = d(f).name;
    return name ? (TEMATICO_LABELS[name] ?? snakeToLabel(name)) : '-';
  };

  const tfrRate = s.top_tema_falso_rate || {};
  const tfrLabel = tfrRate.name ? (TEMATICO_LABELS[tfrRate.name] ?? snakeToLabel(tfrRate.name)) : '-';

  const topTemas = (s.temas_por_volumen || []).map(t => ({
    tema: TEMATICO_LABELS[t.tema] ?? snakeToLabel(t.tema),
    dominante: t.partido_dominante || '—',
    especializado: t.partido_especializado || '—',
  }));

  const claimsPorPartido = (s.claims_por_partido || []).map(p => ({
    tema: p.partido,
    partido: p.count.toString(),
  }));

  grid.innerHTML = `
    ${statCard('Partido con más claims', d('top_partido_claims').name || '-', `${d('top_partido_claims').count || 0} claims totales`, false, 'El partido que más afirmaciones ha realizado en total.')}
    ${statCard('Partido con más falsos', d('top_partido_falso').name || '-', `${d('top_partido_falso').count || 0} falsos/engañosos`, true, 'El partido con más afirmaciones verificadas como falsas o engañosas.')}
    ${statCard('Político con más claims', polLabel('top_politico_claims'), `${d('top_politico_claims').count || 0} claims totales`, false, 'El diputado que más afirmaciones ha realizado en total.')}
    ${statCard('Político con más falsos', polLabel('top_politico_falso'), `${d('top_politico_falso').count || 0} falsos/engañosos`, true, 'El diputado con más afirmaciones verificadas como falsas o engañosas.')}
    ${statCard('Temática más frecuente', temaLabel('top_tema'), `${d('top_tema').count || 0} menciones`, false, 'El ámbito sobre el que más afirmaciones se han hecho.')}
    ${statCard('Tasa de falsedad', `${porcFalsos}%`, `${totalFalsos} de ${total} afirmaciones`, true, 'Porcentaje de afirmaciones verificadas como falsas o engañosas.')}
    ${statCard('Tasa de veracidad', `${porcConfirmados}%`, `${totalConfirm} de ${total} afirmaciones`, false, 'Porcentaje de afirmaciones verificadas como completamente ciertas.')}
    ${statCard('El Maestro del Escaqueo', polLabel('top_politico_nv'), `${d('top_politico_nv').count || 0} afirmaciones no verificables`, false, 'El político que más afirmaciones hace que no pueden verificarse por falta de datos concretos.')}
    ${statCard('Partido más escurridizo', d('top_partido_nv').name || '-', `${d('top_partido_nv').count || 0} afirmaciones no verificables`, false, 'El partido que más afirmaciones hace que no pueden verificarse.')}
    ${statCard('El Gran Matizador', polLabel('top_politico_matiz'), `${d('top_politico_matiz').count || 0} confirmados con matiz`, false, 'El político que más veces dice algo cierto… pero con algún pero importante.')}
    ${statCard('Partido del "sí, pero..."', d('top_partido_matiz').name || '-', `${d('top_partido_matiz').count || 0} confirmados con matiz`, false, 'El partido que más verdades a medias acumula.')}
    ${statCard('El Exagerador Mayor', polLabel('top_politico_sobre'), `${d('top_politico_sobre').count || 0} cifras sobreestimadas`, true, 'El político que más veces ha inflado cifras reales para que suenen más impactantes.')}
    ${statCard('Partido de las Cifras Infladas', d('top_partido_sobre').name || '-', `${d('top_partido_sobre').count || 0} sobreestimaciones`, true, 'El partido que más veces ha sobreestimado datos que en realidad son menores.')}
    ${statCard('El Minimizador', polLabel('top_politico_subest'), `${d('top_politico_subest').count || 0} cifras subestimadas`, true, 'El político que más veces ha reducido cifras reales para que suenen menos graves.')}
    ${statCard('Partido de las Cifras Maquilladas', d('top_partido_subest').name || '-', `${d('top_partido_subest').count || 0} subestimaciones`, true, 'El partido que más veces ha minimizado datos reales.')}
    ${statCard('El Maestro del Bla Bla', polLabel('top_politico_impreciso'), `${d('top_politico_impreciso').count || 0} afirmaciones imprecisas`, false, 'El político que más veces ha soltado una afirmación tan vaga que no hay manera de verificarla.')}
    ${statCard('Partido de las Verdades de Perogrullo', d('top_partido_impreciso').name || '-', `${d('top_partido_impreciso').count || 0} imprecisiones`, false, 'El partido que más veces ha dicho algo tan ambiguo que ni ellos mismos saben si es cierto.')}
    ${statCard('El Sacador de Contexto', polLabel('top_politico_descont'), `${d('top_politico_descont').count || 0} descontextualizaciones`, true, 'El político que más veces ha usado datos reales arrancándolos de su contexto para cambiar su significado.')}
    ${statCard('Combo Breaker', cbLabel, cbSub, false, 'El político que más afirmaciones confirmadas acumuló en un solo pleno.')}
    ${statCard('Bocachancla', bcLabel, bcSub, true, 'El político que más afirmaciones falsas encadenó en un solo pleno.')}
    ${statCard('Temática más conflictiva', temaLabel('top_tema_falso'), `${d('top_tema_falso').count || 0} afirmaciones falsas`, true, 'El ámbito temático donde más afirmaciones falsas se han detectado.')}
    ${statCard('El Cuñado Nacional', polLabel('top_politico_cunado'), `${d('top_politico_cunado').count || 0} temáticas distintas`, false, 'El diputado que opina sobre absolutamente todo, como el cuñado en Navidad.')}
    ${statCard('La Madre de todos los Bulos', tfrLabel, `${Math.round((tfrRate.rate || 0) * 100)}% de falsedades`, true, 'El ámbito temático donde los políticos mienten con más descaro en proporción.')}
    ${statCard('El Partido del Bulo Selectivo', d('top_partido_descont').name || '-', `${d('top_partido_descont').count || 0} descontextualizaciones`, true, 'El partido que más veces usa datos reales arrancados de su contexto para cambiar su significado.')}
    ${statCardListTemas('Partidos por temática', topTemas)}
    ${statCardList('Afirmaciones por partido', claimsPorPartido, 'Total de afirmaciones registradas por cada partido político.')}
  `;
}

function statCard(title, value, subtitle, isFalsoSubtitle = false, description = '') {
  const subClass = isFalsoSubtitle ? 'stat-subtitle falso-subtitle' : 'stat-subtitle';
  return `
    <div class="stat-card">
      <div class="stat-title">${title}</div>
      <div class="stat-value">${value}</div>
      <div class="${subClass}">${subtitle}</div>
      ${description ? `<div class="stat-desc">${description}</div>` : ''}
    </div>`;
}

function statCardList(title, rows, description = '') {
  const items = rows.map(r =>
    `<div class="stat-list-row">
      <span class="stat-list-tema">${escHtml(r.tema)}</span>
      <span class="stat-list-partido">${escHtml(r.partido)}</span>
    </div>`
  ).join('');
  return `
    <div class="stat-card stat-card--list">
      <div class="stat-title">${title}</div>
      <div class="stat-list">${items}</div>
      ${description ? `<div class="stat-desc">${description}</div>` : ''}
    </div>`;
}

function statCardListTemas(title, rows) {
  const header = `<div class="stat-list-row stat-list-row--header">
    <span class="stat-list-tema"></span>
    <span class="stat-list-partido stat-list-col-label">Dominante</span>
    <span class="stat-list-partido stat-list-col-label">Más enfocado</span>
  </div>`;
  const items = rows.map(r =>
    `<div class="stat-list-row">
      <span class="stat-list-tema">${escHtml(r.tema)}</span>
      <span class="stat-list-partido">${escHtml(r.dominante)}</span>
      <span class="stat-list-partido">${escHtml(r.especializado)}</span>
    </div>`
  ).join('');
  return `
    <div class="stat-card stat-card--list stat-card--temas">
      <div class="stat-title">${title}</div>
      <div class="stat-list stat-list--table">${header}${items}</div>
      <div class="stat-desc">
        Muestra la relación principal entre los partidos y los diferentes temas de debate. Dominante: más afirmaciones en ese tema. Más enfocado: el que más lo prioriza respecto a su actividad total.
      </div>
    </div>`;
}

// ─── Búsqueda tab ─────────────────────────────────────────────────────────────
async function loadPoliticians() {
  searchLoaded = true;
  const input = document.getElementById('politician-search-input');
  input.placeholder = 'Cargando políticos…';
  input.disabled = true;

  const { data, error } = await supabase
    .from('politician')
    .select('id, nombre_completo, partido')
    .order('nombre_completo');

  input.disabled = false;
  input.placeholder = 'Escribe el nombre de un político…';

  if (error || !data?.length) {
    input.placeholder = 'Error al cargar políticos. Recarga la página.';
    return;
  }

  allPoliticians = data;
  setupPoliticianAutocomplete();
}

function setupPoliticianAutocomplete() {
  const input = document.getElementById('politician-search-input');
  const clearBtn = document.getElementById('search-clear-btn');
  const combobox = document.getElementById('politician-combobox');

  input.addEventListener('input', onSearchInput);
  input.addEventListener('keydown', onSearchKeydown);
  input.addEventListener('focus', onSearchFocus);
  clearBtn.addEventListener('click', clearSearch);

  document.addEventListener('click', e => {
    if (!combobox.contains(e.target)) closeSuggestions();
  });
}

function onSearchInput(e) {
  const query = e.target.value.trim();
  const clearBtn = document.getElementById('search-clear-btn');
  clearBtn.hidden = query.length === 0;
  activeSearchIndex = -1;

  if (query.length < 2) { closeSuggestions(); return; }

  const norm = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const tokens = norm.split(/\s+/).filter(Boolean);
  const matches = allPoliticians
    .filter(p => {
      const normName = p.nombre_completo.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      return tokens.every(t => normName.includes(t));
    })
    .slice(0, 8);

  renderSuggestions(matches, query);
}

function onSearchFocus() {
  const input = document.getElementById('politician-search-input');
  if (input.value.trim().length >= 2) onSearchInput({ target: input });
}

function onSearchKeydown(e) {
  const list = document.getElementById('politician-suggestions');
  const items = [...list.querySelectorAll('.suggestion-item')];

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    activeSearchIndex = Math.min(activeSearchIndex + 1, items.length - 1);
    updateActiveItem(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    activeSearchIndex = Math.max(activeSearchIndex - 1, -1);
    updateActiveItem(items);
  } else if (e.key === 'Enter') {
    if (activeSearchIndex >= 0 && items[activeSearchIndex]) {
      items[activeSearchIndex].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    }
  } else if (e.key === 'Escape') {
    closeSuggestions();
  }
}

function updateActiveItem(items) {
  const input = document.getElementById('politician-search-input');
  items.forEach((item, i) => {
    const active = i === activeSearchIndex;
    item.classList.toggle('suggestion-item--active', active);
    item.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  input.setAttribute('aria-activedescendant',
    activeSearchIndex >= 0 ? (items[activeSearchIndex]?.id ?? '') : '');
}

function renderSuggestions(matches, query) {
  const list = document.getElementById('politician-suggestions');
  const input = document.getElementById('politician-search-input');

  if (!matches.length) { closeSuggestions(); return; }

  list.innerHTML = matches.map((p, i) => {
    const formattedName = formatNombre(p.nombre_completo);
    const highlighted = highlightMatch(escHtml(formattedName), query);
    const partido = p.partido
      ? `<span class="suggestion-partido">${escHtml(p.partido)}</span>`
      : '';
    return `<li class="suggestion-item" role="option" id="suggestion-${i}" aria-selected="false"
      data-id="${p.id}" data-name="${escHtml(formattedName)}">${highlighted}${partido}</li>`;
  }).join('');

  list.querySelectorAll('.suggestion-item').forEach(item => {
    item.addEventListener('mousedown', e => {
      e.preventDefault();
      selectPolitician(item.dataset.id, item.dataset.name);
    });
  });

  list.hidden = false;
  input.setAttribute('aria-expanded', 'true');
}

function highlightMatch(escapedText, rawQuery) {
  const norm = rawQuery.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const normText = escapedText.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const idx = normText.indexOf(norm);
  if (idx === -1) return escapedText;
  return (
    escapedText.slice(0, idx) +
    `<mark class="suggestion-mark">${escapedText.slice(idx, idx + rawQuery.length)}</mark>` +
    escapedText.slice(idx + rawQuery.length)
  );
}

function closeSuggestions() {
  const list = document.getElementById('politician-suggestions');
  const input = document.getElementById('politician-search-input');
  list.hidden = true;
  list.innerHTML = '';
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
  activeSearchIndex = -1;
}

function clearSearch() {
  const input = document.getElementById('politician-search-input');
  const clearBtn = document.getElementById('search-clear-btn');
  const area = document.getElementById('search-results-area');
  input.value = '';
  clearBtn.hidden = true;
  closeSuggestions();
  area.innerHTML = `<div class="search-welcome">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
    <p>Busca un político para ver todas sus afirmaciones verificadas.</p>
  </div>`;
  input.focus();
}

async function selectPolitician(politicianId, politicianName) {
  const input = document.getElementById('politician-search-input');
  const area = document.getElementById('search-results-area');

  input.value = politicianName;
  closeSuggestions();
  document.getElementById('search-clear-btn').hidden = false;

  if (searchClaimsCache[politicianId]) {
    renderSearchResults(searchClaimsCache[politicianId], politicianName);
    return;
  }

  area.innerHTML = '<p class="loading">Cargando afirmaciones…</p>';

  const { data, error } = await supabase
    .from('claim')
    .select(`
      id, texto_normalizado, texto_original, ambito_tematico, ambito_geografico,
      politician:politician_id (nombre_completo, partido, grupo_parlamentario),
      verification (resultado, confidence_score, errores, omisiones, fuentes),
      session:session_id (id, fecha, organo, legislatura, tipo, numero)
    `)
    .eq('politician_id', politicianId)
    .not('verification', 'is', null)
    .order('session_id', { ascending: false });

  if (error) {
    area.innerHTML = `<p class="error">Error al cargar afirmaciones: ${escHtml(error.message)}</p>`;
    return;
  }

  const claims = data ?? [];
  searchClaimsCache[politicianId] = claims;
  renderSearchResults(claims, politicianName);
}

function renderSearchResults(claims, politicianName) {
  const area = document.getElementById('search-results-area');

  if (!claims.length) {
    area.innerHTML = `<p class="empty">No se encontraron afirmaciones verificadas para <strong>${escHtml(politicianName)}</strong>.</p>`;
    return;
  }

  const grouped = new Map();
  for (const claim of claims) {
    const key = claim.session?.id ?? 'unknown';
    if (!grouped.has(key)) grouped.set(key, { session: claim.session, claims: [] });
    grouped.get(key).claims.push(claim);
  }

  const total = claims.length;
  const falsos = claims.filter(c => c.verification?.[0]?.resultado === 'FALSO').length;
  const pct = total > 0 ? Math.round((falsos / total) * 100) : 0;
  const countBadge = `<div class="search-count-badge">
    <span><strong>${total}</strong> afirmaci${total === 1 ? 'ón' : 'ones'}</span>
    <span class="badge-sep">·</span>
    <span><strong>${falsos}</strong> falsa${falsos === 1 ? '' : 's'}</span>
    <span class="badge-sep">·</span>
    <span><strong>${pct}%</strong> falsas</span>
  </div>`;

  const groupsHtml = [...grouped.values()].map(({ session, claims: sessionClaims }) => {
    const fecha = session?.fecha
      ? new Date(session.fecha).toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' })
      : 'Sesión desconocida';
    const organ = session?.organo ? ` · ${escHtml(session.organo)}` : '';
    return `<section class="search-session-group">
      <h3 class="search-session-header">
        <span class="search-session-date">${escHtml(fecha)}</span>
        <span class="search-session-organ">${organ}</span>
      </h3>
      <div class="search-claims-grid">${sessionClaims.map(c => claimCard(c)).join('')}</div>
    </section>`;
  }).join('');

  area.innerHTML = countBadge + groupsHtml;

  const byId = Object.fromEntries(claims.map(c => [c.id, c]));
  area.querySelectorAll('.claim-toggle').forEach(btn => {
    btn.addEventListener('click', () => openModal(byId[btn.dataset.id]));
  });
}
