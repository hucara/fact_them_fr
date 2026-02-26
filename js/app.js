import { supabase } from './supabase-client.js';

// ─── State ────────────────────────────────────────────────────────────────────
let allClaims = [];       // raw data for the active session
let activeSession = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  await loadSessions();
}

// ─── Sessions ─────────────────────────────────────────────────────────────────
async function loadSessions() {
  const sidebar = document.getElementById('session-list');
  sidebar.innerHTML = '<p class="loading">Cargando sesiones…</p>';

  const { data, error } = await supabase
    .from('session')
    .select('id, legislatura, tipo, numero, fecha, organo, status')
    .eq('status', 'completed')
    .order('fecha', { ascending: false });

  if (error) {
    sidebar.innerHTML = `<p class="error">Error al cargar sesiones: ${error.message}</p>`;
    return;
  }

  if (!data.length) {
    sidebar.innerHTML = '<p class="empty">No hay sesiones procesadas.</p>';
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
  const fecha = new Date(s.fecha).toLocaleDateString('es-ES', {
    day: '2-digit', month: 'short', year: 'numeric'
  });
  return `
    <div class="session-card" data-id="${s.id}">
      <span class="session-date">${fecha}</span>
      <span class="session-organ">${s.organo}</span>
      <span class="session-meta">${s.tipo} · Nº ${s.numero} · ${s.legislatura}</span>
    </div>`;
}

// ─── Claims for a session ─────────────────────────────────────────────────────
async function loadSession(sessionId) {
  activeSession = sessionId;
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
    main.innerHTML = `<p class="error">Error al cargar afirmaciones: ${error.message}</p>`;
    return;
  }

  allClaims = data;
  header.textContent = `${data.length} afirmación${data.length !== 1 ? 'es' : ''} encontrada${data.length !== 1 ? 's' : ''}`;

  populateFilters(data);
  filtersEl.classList.remove('hidden');
  renderClaims(data);
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
    if (tematico  && c.ambito_tematico !== tematico) return false;
    if (politico  && c.politician?.nombre_completo !== politico) return false;
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
      btn.textContent = open ? 'Ver menos' : 'Ver más';
    });
  });
}

function claimCard(claim) {
  const v = claim.verification?.[0] ?? null;
  const pol = claim.politician;

  const resultadoClass = v ? resultadoToClass(v.resultado) : 'nv';
  const resultadoLabel = v ? v.resultado : 'SIN VERIFICAR';
  const score = v ? Math.round(v.confidence_score * 100) : null;

  return `
    <article class="claim-card" data-resultado="${resultadoClass}">
      <header class="claim-header">
        <div class="claim-meta-top">
          ${pol ? `
            <span class="politician-name">${pol.nombre_completo}</span>
            <span class="partido-badge">${pol.partido}</span>
            <span class="grupo-badge">${pol.grupo_parlamentario}</span>
          ` : '<span class="politician-name unknown">Político desconocido</span>'}
        </div>
        <span class="resultado-badge resultado-${resultadoClass}">${resultadoLabel}</span>
      </header>

      <blockquote class="claim-text" title="${escHtml(claim.texto_original)}">
        ${escHtml(claim.texto_normalizado)}
      </blockquote>

      ${score !== null ? `
        <div class="confidence-bar" title="Confianza: ${score}%">
          <div class="confidence-fill" style="width:${score}%"></div>
          <span class="confidence-label">${score}% confianza</span>
        </div>` : ''}

      <div class="claim-tags">
        <span class="tag">${escHtml(claim.ambito_tematico)}</span>
        <span class="tag">${escHtml(claim.ambito_geografico)}</span>
        <span class="tag tag-tipo">${escHtml(claim.tipo_claim)}</span>
      </div>

      ${v ? `
        <div class="claim-detail">
          ${detailRow('Afirmación correcta', v.afirmacion_correcta)}
          ${detailRow('Errores detectados', v.errores)}
          ${detailRow('Omisiones', v.omisiones)}
          ${detailRow('Potencial de engaño', v.potencial_engano)}
          ${detailRow('Fuentes', v.fuentes)}
          ${detailRow('Recomendación de redacción', v.recomendacion_redaccion)}
          ${v.razonamiento_llm ? detailRow('Razonamiento', v.razonamiento_llm) : ''}
        </div>
        <button class="claim-toggle">Ver más</button>
      ` : ''}
    </article>`;
}

function detailRow(label, value) {
  if (!value || value === 'N/A' || value === '-') return '';
  return `
    <div class="detail-row">
      <dt>${label}</dt>
      <dd>${escHtml(value)}</dd>
    </div>`;
}

function resultadoToClass(resultado) {
  const map = {
    'VERDADERO': 'verdadero',
    'FALSO': 'falso',
    'ENGAÑOSO': 'enganoso',
    'PARCIALMENTE_VERDADERO': 'parcial',
    'NO_VERIFICABLE': 'nv',
  };
  return map[resultado?.toUpperCase()] ?? 'nv';
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
