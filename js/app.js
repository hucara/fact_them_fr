import { supabase } from './supabase-client.js';

// ─── Label maps ───────────────────────────────────────────────────────────────
const TEMATICO_LABELS = {
  defensa:                    'Defensa',
  'economía':                 'Economía',
  educacion:                  'Educación',
  igualdad:                   'Igualdad',
  industria_y_trabajo:        'Industria y Trabajo',
  'inmigración':              'Inmigración',
  interior:                   'Interior',
  justicia_y_corrupcion:      'Justicia y Corrupción',
  medio_ambiente:             'Medio Ambiente',
  otros:                      'Otros',
  politica_social:            'Política Social',
  relaciones_internacionales: 'Relaciones Internacionales',
  sanidad:                    'Sanidad',
  vivienda:                   'Vivienda',
};

const RESULTADO_LABELS = {
  CONFIRMADO:                'Confirmado',
  CONFIRMADO_CON_MATIZ:      'Con matiz',
  DESCONTEXTUALIZADO:        'Descontextualizado',
  FALSO:                     'Falso',
  IMPRECISO:                 'Impreciso',
  NO_VERIFICABLE:            'No verificable',
  SOBREESTIMADO:             'Sobreestimado',
  SUBESTIMADO:               'Subestimado',
};

// ─── State ────────────────────────────────────────────────────────────────────
let allClaims  = [];
let claimsById = {};

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  setupTabs();
  setupHeroCTAs();
  setupFilters();
  setupModal();
  await loadSessions();
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

  const [{ data, error }, { count: claimCount }, { data: claimSessions }] = await Promise.all([
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

  const statsEl = document.getElementById('header-stats');
  if (statsEl) {
    statsEl.innerHTML =
      `<strong>${sessions.length}</strong> sesiones · <strong>${(claimCount ?? 0).toLocaleString('es-ES')}</strong> afirmaciones`;
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

  allClaims  = data ?? [];
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
  const tematico  = document.getElementById('filter-tematico').value;
  const resultado = document.getElementById('filter-resultado').value;
  const politico  = document.getElementById('filter-politico').value;
  const search    = document.getElementById('search-claim').value.trim().toLowerCase();

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
    claim.ambito_tematico   ? `<span class="tag tag-tematico">${escHtml(snakeToLabel(claim.ambito_tematico))}</span>`   : '',
    claim.ambito_geografico ? `<span class="tag tag-geo">${escHtml(snakeToLabel(claim.ambito_geografico))}</span>` : '',
  ].filter(Boolean).join('');

  return `
    <article class="claim-card" data-resultado="${resultadoClass}">
      <header class="claim-header">
        <div class="claim-meta-top">
          ${pol
            ? `<span class="politician-name">${escHtml(pol.nombre_completo)}</span>
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

      ${v ? `<button class="claim-toggle" data-id="${claim.id}">Ver más →</button>` : ''}
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

  const v   = claim.verification?.[0] ?? null;
  const pol = claim.politician;

  const resultadoClass = v ? resultadoToClass(v.resultado) : 'nv';
  const resultadoLabel = v ? formatResultado(v.resultado) : 'Sin verificar';
  const score = v && v.confidence_score != null ? Math.round(v.confidence_score * 100) : null;

  const tags = [
    claim.ambito_tematico   ? `<span class="tag tag-tematico">${escHtml(snakeToLabel(claim.ambito_tematico))}</span>`   : '',
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
          ? `<span class="politician-name" style="font-size:1.05rem">${escHtml(pol.nombre_completo)}</span>
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
    const tipoKey   = (s.tipo ?? '').toLowerCase().replace(/[^a-z]/g, '') || 'otra';
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
    'CONFIRMADO':               'verdadero',
    'CONFIRMADO_CON_MATIZ':     'parcial',
    'DESCONTEXTUALIZADO':       'enganoso',
    'IMPRECISO':                'nv',
    'FALSO':                    'falso',
    'NO_VERIFICABLE':           'nv',
    'SOBREESTIMADO':            'enganoso',
    'SUBESTIMADO':              'enganoso',
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
  const grid   = document.getElementById('dashboard-grid');
  const loader = document.getElementById('dashboard-loading');

  const { data: claims, error } = await supabase
    .from('claim')
    .select(`
      id, ambito_tematico, session_id,
      politician:politician_id (nombre_completo, partido),
      verification (resultado),
      session:session_id (fecha)
    `);

  if (error) {
    loader.innerHTML = `<p class="error">Error al cargar estadísticas: ${error.message}</p>`;
    return;
  }

  loader.style.display = 'none';
  grid.classList.remove('hidden');

  if (!claims || claims.length === 0) {
    grid.innerHTML = '<p class="empty">No hay datos suficientes para estadísticas.</p>';
    return;
  }

  renderDashboard(claims);
}

function renderDashboard(claims) {
  const grid = document.getElementById('dashboard-grid');

  let totalVerificados = 0, totalFalsos = 0, totalConfirmados = 0;
  const partidoCounts = {}, partidoFalsoCounts = {};
  const politicoCounts = {}, politicoFalsoCounts = {};
  const partidoNvCounts = {}, politicoNvCounts = {};
  const partidoMatizCounts = {}, politicoMatizCounts = {};
  const partidoSobreCounts = {}, politicoSobreCounts = {};
  const partidoSubestCounts = {}, politicoSubestCounts = {};
  const partidoImprecisoCounts = {}, politicoImprecisoCounts = {};
  const politicoDescontCounts = {}, partidoDescontCounts = {};
  const politicoTemas = {}; // { nombre_completo → Set<ambito_tematico> }
  // { "polName|sessionId" → { count, polName, partido, fecha } }
  const plenaConfirmadoCounts = {}, plenaFalsoCounts = {};
  const temaCounts = {}, temaFalsoCounts = {};
  const temaPartidoCounts = {};  // { tema → { partido → count } }
  const politicoPartido = {};    // { nombre_completo → partido }

  claims.forEach(c => {
    const tema = c.ambito_tematico;
    const pol  = c.politician;
    const v    = c.verification?.[0];

    if (tema) temaCounts[tema] = (temaCounts[tema] || 0) + 1;

    let isFalso = false, isConfirmado = false, isNv = false, isMatiz = false, isSobre = false, isSubest = false, isImpreciso = false, isDescont = false;
    if (v?.resultado) {
      totalVerificados++;
      const res = v.resultado.toUpperCase();
      if (res === 'FALSO' || res === 'ENGAÑOSO')        { isFalso = true; totalFalsos++; }
      if (res === 'NO_VERIFICABLE')                      { isNv = true; }
      if (res === 'CONFIRMADO_CON_MATIZ')                { isMatiz = true; }
      if (res === 'CONFIRMADO')                          { isConfirmado = true; totalConfirmados++; }
      if (res === 'SOBREESTIMADO')                       { isSobre = true; }
      if (res === 'SUBESTIMADO')                         { isSubest = true; }
      if (res === 'IMPRECISO')                           { isImpreciso = true; }
      if (res === 'DESCONTEXTUALIZADO')                  { isDescont = true; }
      if (isFalso && tema) temaFalsoCounts[tema] = (temaFalsoCounts[tema] || 0) + 1;
    }

    if (pol) {
      const pName   = pol.partido || 'Desconocido';
      const polName = pol.nombre_completo || 'Desconocido';
      politicoPartido[polName] = pName;

      partidoCounts[pName]    = (partidoCounts[pName]    || 0) + 1;
      politicoCounts[polName] = (politicoCounts[polName] || 0) + 1;

      if (isFalso)   { partidoFalsoCounts[pName]    = (partidoFalsoCounts[pName]    || 0) + 1; politicoFalsoCounts[polName]  = (politicoFalsoCounts[polName]  || 0) + 1; }
      if (isNv)      { partidoNvCounts[pName]        = (partidoNvCounts[pName]        || 0) + 1; politicoNvCounts[polName]     = (politicoNvCounts[polName]     || 0) + 1; }
      if (isMatiz)   { partidoMatizCounts[pName]     = (partidoMatizCounts[pName]     || 0) + 1; politicoMatizCounts[polName]  = (politicoMatizCounts[polName]  || 0) + 1; }
      if (isSobre)   { partidoSobreCounts[pName]     = (partidoSobreCounts[pName]     || 0) + 1; politicoSobreCounts[polName]  = (politicoSobreCounts[polName]  || 0) + 1; }
      if (isSubest)    { partidoSubestCounts[pName]    = (partidoSubestCounts[pName]    || 0) + 1; politicoSubestCounts[polName]   = (politicoSubestCounts[polName]   || 0) + 1; }
      if (isImpreciso) { partidoImprecisoCounts[pName] = (partidoImprecisoCounts[pName] || 0) + 1; politicoImprecisoCounts[polName] = (politicoImprecisoCounts[polName] || 0) + 1; }
      if (isDescont)   { politicoDescontCounts[polName] = (politicoDescontCounts[polName] || 0) + 1; partidoDescontCounts[pName] = (partidoDescontCounts[pName] || 0) + 1; }

      if (tema) {
        if (!politicoTemas[polName]) politicoTemas[polName] = new Set();
        politicoTemas[polName].add(tema);
      }

      if (c.session_id) {
        const key = `${polName}|${c.session_id}`;
        const fecha = c.session?.fecha ?? null;
        if (isConfirmado) {
          if (!plenaConfirmadoCounts[key]) plenaConfirmadoCounts[key] = { count: 0, polName, partido: pName, fecha };
          plenaConfirmadoCounts[key].count++;
        }
        if (isFalso) {
          if (!plenaFalsoCounts[key]) plenaFalsoCounts[key] = { count: 0, polName, partido: pName, fecha };
          plenaFalsoCounts[key].count++;
        }
      }

      if (tema) {
        if (!temaPartidoCounts[tema]) temaPartidoCounts[tema] = {};
        temaPartidoCounts[tema][pName] = (temaPartidoCounts[tema][pName] || 0) + 1;
      }
    }
  });

  const topPartido          = getTop(partidoCounts);
  const topPartidoFalso     = getTop(partidoFalsoCounts);
  const topPolitico         = getTop(politicoCounts);
  const topPoliticoFalso    = getTop(politicoFalsoCounts);
  const topTema             = getTop(temaCounts);
  const topPartidoNv        = getTop(partidoNvCounts);
  const topPoliticoNv       = getTop(politicoNvCounts);
  const topPartidoMatiz     = getTop(partidoMatizCounts);
  const topPoliticoMatiz    = getTop(politicoMatizCounts);
  const topPartidoSobre     = getTop(partidoSobreCounts);
  const topPoliticoSobre    = getTop(politicoSobreCounts);
  const topPartidoSubest    = getTop(partidoSubestCounts);
  const topPoliticoSubest   = getTop(politicoSubestCounts);
  const topPartidoImpreciso  = getTop(partidoImprecisoCounts);
  const topPoliticoImpreciso = getTop(politicoImprecisoCounts);
  const topPoliticoDescont   = getTop(politicoDescontCounts);
  const topPartidoDescont    = getTop(partidoDescontCounts);
  const topTemaFalso        = getTop(temaFalsoCounts);

  // El Cuñado Nacional — politician with widest thematic breadth
  const topCunado = Object.entries(politicoTemas)
    .reduce((best, [polName, temas]) => temas.size > best.val ? { key: polName, val: temas.size } : best, { key: '-', val: 0 });

  // La Madre de todos los Bulos — theme with highest false-claim rate (min 5 claims)
  const topTemaFalsoRate = Object.entries(temaCounts)
    .filter(([, cnt]) => cnt >= 5)
    .map(([tema, cnt]) => ({ tema, rate: (temaFalsoCounts[tema] || 0) / cnt }))
    .reduce((best, cur) => cur.rate > best.rate ? cur : best, { tema: '-', rate: 0 });

  const getTopPleno = (obj) => {
    let best = null;
    for (const entry of Object.values(obj)) {
      if (!best || entry.count > best.count ||
          (entry.count === best.count && entry.fecha > best.fecha)) {
        best = entry;
      }
    }
    return best ?? { polName: '-', partido: '-', fecha: null, count: 0 };
  };
  const comboBreakerPleno = getTopPleno(plenaConfirmadoCounts);
  const bocachanclaPleno  = getTopPleno(plenaFalsoCounts);

  const porcFalsos      = totalVerificados > 0 ? Math.round((totalFalsos      / totalVerificados) * 100) : 0;
  const porcConfirmados = totalVerificados > 0 ? Math.round((totalConfirmados / totalVerificados) * 100) : 0;

  // All themes by volume with their dominant party
  const topTemas = Object.entries(temaCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([tema]) => ({
      tema:    TEMATICO_LABELS[tema] ?? snakeToLabel(tema),
      partido: temaPartidoCounts[tema] ? getTop(temaPartidoCounts[tema]).key : '—',
    }));

  // All parties sorted by claim count
  const claimsPorPartido = Object.entries(partidoCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([partido, count]) => ({ tema: partido, partido: count.toString() }));

  // Politician name with party lookup
  const pol = (name) => name === '-' ? '-'
    : `${name}${politicoPartido[name] ? ` · ${politicoPartido[name]}` : ''}`;

  grid.innerHTML = `
    ${statCard('Partido con más claims',          topPartido.key,                    `${topPartido.val} claims totales`,        false, 'El partido que más afirmaciones ha realizado en total.')}
    ${statCard('Partido con más falsos',          topPartidoFalso.key,               `${topPartidoFalso.val} falsos/engañosos`, true,  'El partido con más afirmaciones verificadas como falsas o engañosas.')}
    ${statCard('Político con más claims',         pol(topPolitico.key),              `${topPolitico.val} claims totales`,       false, 'El diputado que más afirmaciones ha realizado en total.')}
    ${statCard('Político con más falsos',         pol(topPoliticoFalso.key),         `${topPoliticoFalso.val} falsos/engañosos`,true,  'El diputado con más afirmaciones verificadas como falsas o engañosas.')}
    ${statCard('Temática más frecuente',          topTema.key === '-' ? '-' : (TEMATICO_LABELS[topTema.key] ?? snakeToLabel(topTema.key)), `${topTema.val} menciones`, false, 'El ámbito sobre el que más afirmaciones se han hecho.')}
    ${statCard('Tasa de falsedad',                `${porcFalsos}%`,                  `${totalFalsos} de ${totalVerificados} verificados`,   true,  'Porcentaje de afirmaciones verificadas como falsas o engañosas.')}
    ${statCard('Tasa de veracidad',               `${porcConfirmados}%`,             `${totalConfirmados} de ${totalVerificados} verificados`, false, 'Porcentaje de afirmaciones verificadas como completamente ciertas.')}
    ${statCard('El Maestro del Escaqueo',         pol(topPoliticoNv.key),            `${topPoliticoNv.val} afirmaciones no verificables`,   false, 'El político que más afirmaciones hace que no pueden verificarse por falta de datos concretos.')}
    ${statCard('Partido más escurridizo',         topPartidoNv.key,                  `${topPartidoNv.val} afirmaciones no verificables`,    false, 'El partido que más afirmaciones hace que no pueden verificarse.')}
    ${statCard('El Gran Matizador',               pol(topPoliticoMatiz.key),         `${topPoliticoMatiz.val} confirmados con matiz`,        false, 'El político que más veces dice algo cierto… pero con algún pero importante.')}
    ${statCard('Partido del "sí, pero..."',       topPartidoMatiz.key,               `${topPartidoMatiz.val} confirmados con matiz`,         false, 'El partido que más verdades a medias acumula.')}
    ${statCard('El Exagerador Mayor',             pol(topPoliticoSobre.key),         `${topPoliticoSobre.val} cifras sobreestimadas`,        true,  'El político que más veces ha inflado cifras reales para que suenen más impactantes.')}
    ${statCard('Partido de las Cifras Infladas',  topPartidoSobre.key,               `${topPartidoSobre.val} sobreestimaciones`,             true,  'El partido que más veces ha sobreestimado datos que en realidad son menores.')}
    ${statCard('El Minimizador',                  pol(topPoliticoSubest.key),        `${topPoliticoSubest.val} cifras subestimadas`,          true,  'El político que más veces ha reducido cifras reales para que suenen menos graves.')}
    ${statCard('Partido de las Cifras Maquilladas', topPartidoSubest.key,            `${topPartidoSubest.val} subestimaciones`,               true,  'El partido que más veces ha minimizado datos reales.')}
    ${statCard('El Maestro del Bla Bla',           pol(topPoliticoImpreciso.key),     `${topPoliticoImpreciso.val} afirmaciones imprecisas`,  false, 'El político que más veces ha soltado una afirmación tan vaga que no hay manera de verificarla.')}
    ${statCard('Partido de las Verdades de Perogrullo', topPartidoImpreciso.key,     `${topPartidoImpreciso.val} imprecisiones`,             false, 'El partido que más veces ha dicho algo tan ambiguo que ni ellos mismos saben si es cierto.')}
    ${statCard('El Sacador de Contexto',          pol(topPoliticoDescont.key),       `${topPoliticoDescont.val} descontextualizaciones`,     true,  'El político que más veces ha usado datos reales arrancándolos de su contexto para cambiar su significado.')}
    ${statCard('Combo Breaker',                   comboBreakerPleno.polName === '-' ? '-' : `${comboBreakerPleno.polName} · ${comboBreakerPleno.partido}`, comboBreakerPleno.fecha ? `${comboBreakerPleno.count} confirmados en el pleno del ${new Date(comboBreakerPleno.fecha).toLocaleDateString('es-ES')}` : '-', false, 'El político que más afirmaciones confirmadas acumuló en un solo pleno.')}
    ${statCard('Bocachancla',                     bocachanclaPleno.polName === '-' ? '-' : `${bocachanclaPleno.polName} · ${bocachanclaPleno.partido}`,    bocachanclaPleno.fecha  ? `${bocachanclaPleno.count} falsedades en el pleno del ${new Date(bocachanclaPleno.fecha).toLocaleDateString('es-ES')}`  : '-', true,  'El político que más afirmaciones falsas encadenó en un solo pleno.')}
    ${statCard('Temática más conflictiva',        topTemaFalso.key === '-' ? '-' : (TEMATICO_LABELS[topTemaFalso.key] ?? snakeToLabel(topTemaFalso.key)), `${topTemaFalso.val} afirmaciones falsas`, true, 'El ámbito temático donde más afirmaciones falsas se han detectado.')}
    ${statCard('El Cuñado Nacional',            pol(topCunado.key),                                                                                     `${topCunado.val} temáticas distintas`,                                  false, 'El diputado que opina sobre absolutamente todo, como el cuñado en Navidad.')}
    ${statCard('La Madre de todos los Bulos',   topTemaFalsoRate.tema === '-' ? '-' : (TEMATICO_LABELS[topTemaFalsoRate.tema] ?? snakeToLabel(topTemaFalsoRate.tema)), `${Math.round(topTemaFalsoRate.rate * 100)}% de falsedades`, true,  'El ámbito temático donde los políticos mienten con más descaro en proporción.')}
    ${statCard('El Partido del Bulo Selectivo', topPartidoDescont.key,                                                                                  `${topPartidoDescont.val} descontextualizaciones`,                       true,  'El partido que más veces usa datos reales arrancados de su contexto para cambiar su significado.')}
    ${statCardList('Partido dominante por temática', topTemas, 'Qué partido protagoniza más el debate en cada ámbito temático.')}
    ${statCardList('Afirmaciones por partido', claimsPorPartido, 'Total de afirmaciones registradas por cada partido político.')}
  `;
}

function getTop(obj) {
  let maxKey = '-', maxVal = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (v > maxVal) { maxVal = v; maxKey = k; }
  }
  return { key: maxKey, val: maxVal };
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
