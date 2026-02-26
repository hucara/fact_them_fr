import { supabase } from './supabase-client.js';

// ─── State ────────────────────────────────────────────────────────────────────
let allClaims = [];

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  setupTabs();
  await loadSessions();
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function setupTabs() {
  const tabs = document.querySelectorAll('.tab-button');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view-container').forEach(v => {
        v.classList.remove('active');
        v.style.display = 'none';
      });
      tab.classList.add('active');
      const viewId = tab.dataset.tab;
      const viewEl = document.getElementById(viewId);
      viewEl.classList.add('active');
      viewEl.style.display = viewEl.classList.contains('dashboard-view') ? 'block' : 'flex';

      if (viewId === 'view-estadisticas' && !window.statsLoaded) {
        loadGlobalDashboard();
      }
    });
  });
}

// ─── Sessions ─────────────────────────────────────────────────────────────────
async function loadSessions() {
  const sidebar = document.getElementById('session-list');
  sidebar.innerHTML = '<p class="loading">Cargando sesiones…</p>';

  const { data, error } = await supabase
    .from('session')
    .select('id, legislatura, tipo, numero, fecha, organo, status')
    .order('fecha', { ascending: false });

  if (error) {
    console.error('[loadSessions] error:', error);
    sidebar.innerHTML = `<p class="error">Error al cargar sesiones: ${error.message}</p>`;
    return;
  }

  console.log('[loadSessions] rows:', data?.length, data);

  if (!data || !data.length) {
    sidebar.innerHTML = '<p class="empty">No hay sesiones disponibles.</p>';
    return;
  }

  sidebar.innerHTML = data.map(s => sessionCard(s)).join('');

  sidebar.querySelectorAll('.session-card').forEach(card => {
    card.addEventListener('click', () => {
      sidebar.querySelectorAll('.session-card').forEach(c => c.classList.remove('active'));
      card.classList.add('active');
      loadSession(card.dataset.id);
    });
  });
}

function sessionCard(s) {
  const fecha = s.fecha
    ? new Date(s.fecha).toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
    : '—';
  const statusBadge = s.status === 'completed'
    ? '<span class="session-status completed">Verificado</span>'
    : s.status
      ? `<span class="session-status">${s.status}</span>`
      : '';
  return `
    <div class="session-card" data-id="${s.id}">
      <div class="session-card-top">
        <span class="session-date">${fecha}</span>
        ${statusBadge}
      </div>
      <span class="session-organ">${s.organo ?? '—'}</span>
      <span class="session-meta">${s.tipo ?? ''} · Nº ${s.numero ?? '?'} · ${s.legislatura ?? ''}</span>
    </div>`;
}

// ─── Claims for a session ─────────────────────────────────────────────────────
async function loadSession(sessionId) {
  const main = document.getElementById('claims-container');
  const header = document.getElementById('session-header');
  const filtersEl = document.getElementById('filters');

  main.innerHTML = '<p class="loading">Cargando afirmaciones…</p>';
  filtersEl.classList.add('hidden');

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
    console.error('[loadSession] error:', error);
    main.innerHTML = `<p class="error">Error al cargar afirmaciones: ${error.message}</p>`;
    return;
  }

  console.log('[loadSession] claims:', data?.length, data);

  allClaims = data ?? [];
  header.textContent = `${allClaims.length} afirmación${allClaims.length !== 1 ? 'es' : ''} encontrada${allClaims.length !== 1 ? 's' : ''}`;

  populateFilters(allClaims);
  filtersEl.classList.remove('hidden');
  renderClaims(allClaims);
}

// ─── Filters ──────────────────────────────────────────────────────────────────
function populateFilters(claims) {
  const tematicos = [...new Set(claims.map(c => c.ambito_tematico).filter(Boolean))].sort();
  const resultados = [...new Set(
    claims.flatMap(c => c.verification?.map(v => v.resultado) ?? []).filter(Boolean)
  )].sort();
  const politicos = [...new Map(
    claims.filter(c => c.politician)
      .map(c => [c.politician.nombre_completo, c.politician])
  ).values()].sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo));

  setSelectOptions('filter-tematico', tematicos, 'Todos los temas');
  setSelectOptions('filter-resultado', resultados, 'Todos los resultados');
  setSelectOptions('filter-politico',
    politicos.map(p => ({ value: p.nombre_completo, label: p.nombre_completo })),
    'Todos los políticos'
  );

  document.getElementById('filters').querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', applyFilters);
  });
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

  const filtered = allClaims.filter(c => {
    if (tematico && c.ambito_tematico !== tematico) return false;
    if (politico && c.politician?.nombre_completo !== politico) return false;
    if (resultado) {
      const hasResult = c.verification?.some(v => v.resultado === resultado);
      if (!hasResult) return false;
    }
    return true;
  });

  document.getElementById('session-header').textContent =
    `${filtered.length} afirmación${filtered.length !== 1 ? 'es' : ''} (filtrado${filtered.length !== 1 ? 's' : ''})`;
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
    btn.addEventListener('click', () => {
      const detail = btn.closest('.claim-card').querySelector('.claim-detail');
      const open = detail.classList.toggle('open');
      btn.textContent = open ? '▲ Ver menos' : '▼ Ver más';
    });
  });
}

function claimCard(claim) {
  const v = claim.verification?.[0] ?? null;
  const pol = claim.politician;

  const resultadoClass = v ? resultadoToClass(v.resultado) : 'nv';
  const resultadoLabel = v ? formatResultado(v.resultado) : 'Sin verificar';
  const score = v && v.confidence_score != null ? Math.round(v.confidence_score * 100) : null;

  // Only show human-readable geo/topic tags — hide technical tipo_claim values
  const tags = [
    claim.ambito_tematico   ? `<span class="tag tag-tematico">${escHtml(capitalize(claim.ambito_tematico))}</span>`   : '',
    claim.ambito_geografico ? `<span class="tag tag-geo">${escHtml(capitalize(claim.ambito_geografico))}</span>` : '',
  ].filter(Boolean).join('');

  return `
    <article class="claim-card" data-resultado="${resultadoClass}">
      <header class="claim-header">
        <div class="claim-meta-top">
          ${pol
            ? `<span class="politician-name">${escHtml(pol.nombre_completo)}</span>
               ${pol.partido ? `<span class="partido-badge">${escHtml(pol.partido)}</span>` : ''}
               ${pol.grupo_parlamentario ? `<span class="grupo-badge">${escHtml(pol.grupo_parlamentario)}</span>` : ''}`
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

      ${v ? `
        <div class="claim-detail">
          <dl>
            ${isValidValue(v.errores) ? `
              <div class="detail-row detail-errores">
                <dt>Error detectado</dt>
                <dd>${escHtml(capitalize(v.errores))}</dd>
              </div>` : ''}
            ${bulletRow('omisiones', 'Omisiones', v.omisiones)}
            ${bulletRow('fuentes', 'Fuentes', v.fuentes)}
            ${detailRow('Potencial de engaño', v.potencial_engano)}
            ${detailRow('Recomendación de redacción', v.recomendacion_redaccion)}
            ${isValidValue(v.razonamiento_llm) ? detailRow('Razonamiento del modelo', v.razonamiento_llm) : ''}
          </dl>
        </div>
        <button class="claim-toggle">▼ Ver más</button>
      ` : ''}
    </article>`;
}

function isValidValue(v) {
  return v && v !== 'N/A' && v !== '-' && v !== 'n/a';
}

function capitalize(str) {
  const s = String(str ?? '').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function toListItems(text) {
  return text
    .split(/\n|;/)
    .map(s => s.replace(/^[\s\-•*\d.]+/, '').trim())
    .filter(Boolean);
}

function bulletRow(type, label, value) {
  if (!isValidValue(value)) return '';
  const items = toListItems(value);
  if (items.length <= 1) {
    return `<div class="detail-row">
      <dt>${label}</dt>
      <dd>${escHtml(capitalize(value.trim()))}</dd>
    </div>`;
  }
  return `<div class="detail-row">
    <dt>${label}</dt>
    <dd><ul class="detail-list ${type}">${items.map(i => `<li>${escHtml(capitalize(i))}</li>`).join('')}</ul></dd>
  </div>`;
}

function detailRow(label, value) {
  if (!isValidValue(value)) return '';
  return `
    <div class="detail-row">
      <dt>${label}</dt>
      <dd>${escHtml(capitalize(String(value)))}</dd>
    </div>`;
}

function resultadoToClass(resultado) {
  if (!resultado) return 'nv';
  const map = {
    'VERDADERO': 'verdadero',
    'FALSO': 'falso',
    'ENGAÑOSO': 'enganoso',
    'PARCIALMENTE_VERDADERO': 'parcial',
    'NO_VERIFICABLE': 'nv',
  };
  return map[resultado.toUpperCase()] ?? 'nv';
}

function formatResultado(resultado) {
  if (!resultado) return 'Sin verificar';
  const map = {
    'VERDADERO': 'Verdadero',
    'FALSO': 'Falso',
    'ENGAÑOSO': 'Engañoso',
    'PARCIALMENTE_VERDADERO': 'Parcialmente verdadero',
    'NO_VERIFICABLE': 'No verificable',
  };
  return map[resultado.toUpperCase()] ?? resultado;
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

  const { data: claims, error } = await supabase
    .from('claim')
    .select(`
      id, ambito_tematico,
      politician:politician_id (nombre_completo, partido),
      verification (resultado)
    `);

  if (error) {
    console.error('[loadGlobalDashboard] error:', error);
    loader.innerHTML = `<p class="error">Error al cargar estadísticas: ${error.message}</p>`;
    return;
  }

  console.log('[loadGlobalDashboard] claims:', claims?.length);

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

  let totalVerificados = 0;
  let totalFalsos = 0;

  const partidoCounts = {};
  const partidoFalsoCounts = {};
  const politicoCounts = {};
  const politicoFalsoCounts = {};
  const temaCounts = {};

  claims.forEach(c => {
    const tema = c.ambito_tematico;
    const pol = c.politician;
    const v = c.verification?.[0];

    if (tema) temaCounts[tema] = (temaCounts[tema] || 0) + 1;

    let isFalso = false;
    if (v && v.resultado) {
      totalVerificados++;
      const res = v.resultado.toUpperCase();
      if (res === 'FALSO' || res === 'ENGAÑOSO') {
        isFalso = true;
        totalFalsos++;
      }
    }

    if (pol) {
      const pName = pol.partido || 'Desconocido';
      const polName = pol.nombre_completo || 'Desconocido';
      partidoCounts[pName] = (partidoCounts[pName] || 0) + 1;
      politicoCounts[polName] = (politicoCounts[polName] || 0) + 1;
      if (isFalso) {
        partidoFalsoCounts[pName] = (partidoFalsoCounts[pName] || 0) + 1;
        politicoFalsoCounts[polName] = (politicoFalsoCounts[polName] || 0) + 1;
      }
    }
  });

  const topPartido       = getTop(partidoCounts);
  const topPartidoFalso  = getTop(partidoFalsoCounts);
  const topPolitico      = getTop(politicoCounts);
  const topPoliticoFalso = getTop(politicoFalsoCounts);
  const topTema          = getTop(temaCounts);
  const porcFalsos       = totalVerificados > 0
    ? Math.round((totalFalsos / totalVerificados) * 100) : 0;

  grid.innerHTML = `
    ${statCard('Partido con más claims',  topPartido.key,       `${topPartido.val} claims totales`)}
    ${statCard('Partido con más falsos',  topPartidoFalso.key,  `${topPartidoFalso.val} falsos/engañosos`, true)}
    ${statCard('Político con más claims', topPolitico.key,      `${topPolitico.val} claims totales`)}
    ${statCard('Político con más falsos', topPoliticoFalso.key, `${topPoliticoFalso.val} falsos/engañosos`, true)}
    ${statCard('Temática más frecuente',  topTema.key,          `${topTema.val} menciones`)}
    ${statCard('Tasa de falsedad',        `${porcFalsos}%`,     `${totalFalsos} de ${totalVerificados} verificados`, true)}
  `;
}

function getTop(obj) {
  let maxKey = 'N/A', maxVal = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (v > maxVal) { maxVal = v; maxKey = k; }
  }
  return { key: maxKey, val: maxVal };
}

function statCard(title, value, subtitle, isFalsoSubtitle = false) {
  const subClass = isFalsoSubtitle ? 'stat-subtitle falso-subtitle' : 'stat-subtitle';
  return `
    <div class="stat-card">
      <div class="stat-title">${title}</div>
      <div class="stat-value">${value}</div>
      <div class="${subClass}">${subtitle}</div>
    </div>`;
}
