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
  CONFIRMADO_CON_MATIZ: 'Confirmado con matiz',
  'CONFIRMADO CON MATIZ': 'Confirmado con matiz',
  DESCONTEXTUALIZADO: 'Descontextualizado',
  FALSO: 'Falso',
  IMPRECISO: 'Impreciso',
  NO_VERIFICABLE: 'No verificable',
  SOBREESTIMADO: 'Sobreestimado',
  SUBESTIMADO: 'Subestimado',
};

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

// Colores exactos del CSS para la imagen generada (keyed by resultadoToClass output)
const IMG_COLORS = {
  verdadero: { color: '#3da966', bgAlpha: 'rgba(61,169,102,.07)',   border: 'rgba(61,169,102,.4)'   },
  falso:     { color: '#c43e5e', bgAlpha: 'rgba(196,62,94,.08)',    border: 'rgba(196,62,94,.4)'    },
  enganoso:  { color: '#b07825', bgAlpha: 'rgba(176,120,37,.07)',   border: 'rgba(176,120,37,.4)'   },
  parcial:   { color: '#3890bc', bgAlpha: 'rgba(56,144,188,.07)',   border: 'rgba(56,144,188,.4)'   },
  nv:        { color: '#8a7880', bgAlpha: 'rgba(255,255,255,.02)',  border: 'rgba(92,74,82,.35)'    },
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

// ─── State ────────────────────────────────────────────────────────────────────
let allClaims = [];
let claimsById = {};
let currentSessionIds = [];

// ─── Filter state ─────────────────────────────────────────────────────────────
const filterState = { resultado: [], tematico: [], politico: [] };
let sessionCalendar = null;
let msResultado = null, msTematico = null, msPolitico = null;

// ─── Búsqueda state ───────────────────────────────────────────────────────────
let allPoliticians = [];
let searchLoaded = false;
let politiciansLoadPromise = null;
let politicianAutocompleteReady = false;
let activeSearchIndex = -1;
let searchClaimsCache = {};
let currentSearchClaims = [];
let currentPoliticianSlug = '';

// ─── Búsqueda filter state ────────────────────────────────────────────────────
const searchFilterState = { resultado: [], tematico: [] };
let msSearchResultado = null, msSearchTematico = null;
let claimCount = 0;
let headerStatsBase = '';

const TAB_TO_SLUG = {
  'view-sesiones': 'sesiones',
  'view-busqueda': 'parlamentarios',
  'view-estadisticas': 'estadisticas',
};

const SLUG_TO_TAB = {
  sesiones: 'view-sesiones',
  sessions: 'view-sesiones',
  parlamentarios: 'view-busqueda',
  parlamentaries: 'view-busqueda',
  representantes: 'view-busqueda',
  busqueda: 'view-busqueda',
  estadisticas: 'view-estadisticas',
  statistics: 'view-estadisticas',
};

// ─── Boot ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', boot);

async function boot() {
  setupTabs();
  applyUrlTab(true);
  setupHeroCTAs();
  setupFilters();
  setupFiltersToggle();
  setupSearchFilters();
  setupModal();
  setupShare();
  await Promise.all([loadSessions(), handleClaimDeepLink(), handlePoliticianDeepLink()]);
}

function applyUrlTab(initial = false) {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('tab');
  const tabId = SLUG_TO_TAB[slug] || (params.get('politician') ? 'view-busqueda' : 'view-sesiones');
  activateTab(tabId, false);
  if (initial) {
    history.replaceState({ tab: tabId, politician: params.get('politician') }, '', window.location.href);
  }
}

function updateAppUrl(tabId, { politicianSlug = currentPoliticianSlug, replace = false } = {}) {
  const params = new URLSearchParams(window.location.search);
  params.delete('claim');
  params.set('tab', TAB_TO_SLUG[tabId] || TAB_TO_SLUG['view-sesiones']);

  if (tabId === 'view-busqueda' && politicianSlug) {
    params.set('politician', politicianSlug);
  } else {
    params.delete('politician');
  }

  const query = params.toString();
  const nextUrl = `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`;
  const nextState = { tab: tabId, politician: params.get('politician') };
  const method = replace ? 'replaceState' : 'pushState';
  history[method](nextState, '', nextUrl);
}

async function handlePoliticianDeepLink() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('politician');
  if (!slug) {
    if (document.getElementById('view-busqueda')?.classList.contains('active') && currentPoliticianSlug) {
      resetPoliticianSearchView();
    }
    return;
  }
  activateTab('view-busqueda', false);
  await loadPoliticians();
  const match = allPoliticians.find(p =>
    slugifyPolitician(formatNombre(p.nombre_completo), p.partido || '') === slug);
  if (match) {
    selectPolitician(match.id, formatNombre(match.nombre_completo), { updateUrl: false, scrollToResults: true });
    if (params.get('tab') !== TAB_TO_SLUG['view-busqueda']) {
      updateAppUrl('view-busqueda', { politicianSlug: slug, replace: true });
    }
  }
}

function setupFiltersToggle() {
  const btn = document.getElementById('btn-filters-toggle');
  const panel = document.getElementById('filters');
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    const open = panel.classList.toggle('is-open');
    btn.setAttribute('aria-expanded', String(open));
  });
}

// ─── Búsqueda filters ────────────────────────────────────────────────────────
function setupSearchFilters() {
  msSearchResultado = new MultiSelect(
    document.getElementById('ms-search-resultado'), [],
    vals => { searchFilterState.resultado = vals; applySearchFilters(); }
  );
  msSearchTematico = new MultiSelect(
    document.getElementById('ms-search-tematico'), [],
    vals => { searchFilterState.tematico = vals; applySearchFilters(); }
  );
  document.getElementById('search-busqueda-claim')
    .addEventListener('input', applySearchFilters);
}

function populateSearchFilters(claims) {
  const tematicos = [...new Set(claims.map(c => c.ambito_tematico).filter(Boolean))].sort();
  const resultados = [...new Set(
    claims.flatMap(c => c.verification?.map(v => v.resultado) ?? []).filter(Boolean)
  )].sort();
  msSearchTematico.setOptions(tematicos.map(t => ({ value: t, label: TEMATICO_LABELS[t] ?? t })));
  msSearchResultado.setOptions(resultados.map(r => ({ value: r, label: RESULTADO_LABELS[r] ?? r })));
}

function applySearchFilters() {
  const search = norm(document.getElementById('search-busqueda-claim').value.trim());
  const filtered = currentSearchClaims.filter(c => {
    if (searchFilterState.tematico.length && !searchFilterState.tematico.includes(c.ambito_tematico)) return false;
    if (searchFilterState.resultado.length) {
      const claimResults = c.verification?.map(v => v.resultado) ?? [];
      if (!searchFilterState.resultado.some(r => claimResults.includes(r))) return false;
    }
    if (search) {
      const haystack = norm([c.texto_normalizado, c.texto_original].filter(Boolean).join(' '));
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
  renderSearchResults(filtered, document.getElementById('politician-search-input').value);
}

function resetSearchFilters() {
  searchFilterState.resultado = [];
  searchFilterState.tematico = [];
  document.getElementById('search-busqueda-claim').value = '';
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────
function activateTab(tabId, pushToHistory = true) {
  document.querySelectorAll('.tab-button').forEach(t =>
    t.classList.toggle('active', t.dataset.tab === tabId));
  document.querySelectorAll('.view-container').forEach(v =>
    v.classList.toggle('active', v.id === tabId));
  if (tabId === 'view-estadisticas' && !window.statsLoaded) loadGlobalDashboard();
  if (tabId === 'view-busqueda' && !searchLoaded) loadPoliticians();
  if (pushToHistory) {
    updateAppUrl(tabId);
  }
}

function setupTabs() {
  document.querySelectorAll('.tab-button').forEach(tab => {
    tab.addEventListener('click', () => {
      const current = document.querySelector('.tab-button.active')?.dataset.tab;
      if (tab.dataset.tab === current) return;
      activateTab(tab.dataset.tab, true);
    });
  });
  window.addEventListener('popstate', e => {
    applyUrlTab();
    handlePoliticianDeepLink();
  });
}

// ─── Hero CTAs ────────────────────────────────────────────────────────────────
function setupHeroCTAs() {
  document.querySelectorAll('.hero-cta[data-cta]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const target = btn.dataset.cta;
      const tabBtn = document.querySelector(`.tab-button[data-tab="view-${target}"]`);
      if (tabBtn) tabBtn.click();
      document.getElementById('app-header')?.scrollIntoView({ behavior: 'smooth' });
    });
  });
}

// ─── MultiSelect component ────────────────────────────────────────────────────
class MultiSelect {
  constructor(container, options, onChange) {
    this.container = container;
    this.allOptions = options;
    this.selected = new Set();
    this.onChange = onChange;
    this.query = '';
    this.isOpen = false;
    this._outsideHandler = null;
    this._keyHandler = null;
    this.mount();
  }

  mount() {
    this.container.innerHTML = `
      <div class="ms-trigger" tabindex="0" role="combobox" aria-expanded="false" aria-haspopup="listbox">
        <div class="ms-chips"><input class="ms-input" type="text" autocomplete="off" spellcheck="false" /></div>
        <button class="ms-clear-all" type="button" hidden aria-label="Limpiar selección">✕</button>
        <svg class="ms-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="ms-dropdown" hidden role="listbox">
        <ul class="ms-list"></ul>
      </div>`;
    this.triggerEl  = this.container.querySelector('.ms-trigger');
    this.chipsEl    = this.container.querySelector('.ms-chips');
    this.inputEl    = this.container.querySelector('.ms-input');
    this.clearAllBtn = this.container.querySelector('.ms-clear-all');
    this.dropdownEl = this.container.querySelector('.ms-dropdown');
    this.listEl     = this.container.querySelector('.ms-list');

    this.inputEl.placeholder = '';

    this.triggerEl.addEventListener('mousedown', (e) => {
      if (e.target === this.clearAllBtn || e.target.closest('.ms-chip button')) return;
      e.preventDefault();
      this.isOpen ? this.close() : this.open();
    });
    this.inputEl.addEventListener('input', () => {
      this.query = this.inputEl.value;
      this.renderList();
    });
    this.clearAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.clearAll();
    });
    this.renderChips();
  }

  setOptions(options) {
    this.allOptions = options;
    this.selected.clear();
    this.query = '';
    this.inputEl.value = '';
    this.renderChips();
    if (this.isOpen) this.renderList();
  }

  renderChips() {
    this.chipsEl.querySelectorAll('.ms-chip, .ms-placeholder').forEach(el => el.remove());
    if (this.selected.size === 0) {
      const pl = document.createElement('span');
      pl.className = 'ms-placeholder';
      pl.textContent = this.container.dataset.placeholder ?? '';
      this.chipsEl.insertBefore(pl, this.inputEl);
    } else {
      this.selected.forEach(val => {
        const opt = this.allOptions.find(o => o.value === val);
        const label = opt ? opt.label : val;
        const chip = document.createElement('span');
        chip.className = 'ms-chip';
        chip.innerHTML = `${escHtml(label)} <button type="button" aria-label="Quitar ${escHtml(label)}">✕</button>`;
        chip.querySelector('button').addEventListener('click', (e) => {
          e.stopPropagation();
          this.deselect(val);
        });
        this.chipsEl.insertBefore(chip, this.inputEl);
      });
    }
    this.clearAllBtn.hidden = this.selected.size === 0;
    this.triggerEl.setAttribute('aria-expanded', String(this.isOpen));
  }

  renderList() {
    const q = norm(this.query);
    const filtered = q
      ? this.allOptions.filter(o => norm(o.label).includes(q))
      : this.allOptions;
    if (!filtered.length) {
      this.listEl.innerHTML = '<li class="ms-empty">Sin resultados</li>';
      return;
    }
    this.listEl.innerHTML = filtered.map(opt => {
      const sel = this.selected.has(opt.value);
      let labelHtml = escHtml(opt.label);
      if (q) {
        const idx = norm(opt.label).indexOf(q);
        if (idx >= 0) {
          labelHtml = escHtml(opt.label.slice(0, idx))
            + '<mark>' + escHtml(opt.label.slice(idx, idx + q.length)) + '</mark>'
            + escHtml(opt.label.slice(idx + q.length));
        }
      }
      return `<li class="ms-option" role="option" aria-selected="${sel}" data-value="${escHtml(opt.value)}">
        <span class="ms-check">✓</span> ${labelHtml}</li>`;
    }).join('');
    this.listEl.querySelectorAll('.ms-option').forEach(li => {
      li.addEventListener('mousedown', (e) => {
        e.preventDefault();
        this.toggleOption(li.dataset.value);
      });
    });
  }

  toggleOption(value) {
    this.selected.has(value) ? this.selected.delete(value) : this.selected.add(value);
    this.renderChips();
    this.renderList();
    this.onChange(Array.from(this.selected));
  }

  deselect(value) {
    this.selected.delete(value);
    this.renderChips();
    if (this.isOpen) this.renderList();
    this.onChange(Array.from(this.selected));
  }

  clearAll() {
    this.selected.clear();
    this.renderChips();
    if (this.isOpen) this.renderList();
    this.onChange([]);
  }

  open() {
    this.isOpen = true;
    this.dropdownEl.hidden = false;
    this.triggerEl.setAttribute('aria-expanded', 'true');
    this.renderList();
    this.inputEl.focus();
    this._outsideHandler = (e) => { if (!this.container.contains(e.target)) this.close(); };
    this._keyHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('mousedown', this._outsideHandler);
    document.addEventListener('keydown', this._keyHandler);
  }

  close() {
    this.isOpen = false;
    this.dropdownEl.hidden = true;
    this.triggerEl.setAttribute('aria-expanded', 'false');
    this.query = '';
    this.inputEl.value = '';
    document.removeEventListener('mousedown', this._outsideHandler);
    document.removeEventListener('keydown', this._keyHandler);
  }
}

// ─── SessionCalendar component ────────────────────────────────────────────────
class SessionCalendar {
  constructor(onSelect) {
    this.onSelect = onSelect;
    this.sessions = [];
    this.sessionsByDate = new Map();
    this.selectedId = null;
    this.viewYear = new Date().getFullYear();
    this.viewMonth = new Date().getMonth();
    this.isOpen = false;
    this._outsideHandler = null;
    this._keyHandler = null;

    const wrap = document.getElementById('session-calendar-wrap');
    wrap.innerHTML = `
      <button class="session-cal-trigger" id="session-cal-trigger" type="button"
              aria-haspopup="true" aria-expanded="false" aria-controls="session-cal-popup">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
          <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
        </svg>
        <span id="session-cal-label">Cargando sesiones…</span>
        <svg class="cal-trigger-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="cal-popup" id="session-cal-popup" hidden role="dialog" aria-label="Seleccionar sesión">
        <div class="cal-header">
          <button class="cal-nav" id="cal-prev" type="button" aria-label="Mes anterior">‹</button>
          <span class="cal-month-label" id="cal-month-label"></span>
          <button class="cal-nav" id="cal-next" type="button" aria-label="Mes siguiente">›</button>
        </div>
        <div class="cal-weekdays">
          <span>Lu</span><span>Ma</span><span>Mi</span><span>Ju</span><span>Vi</span><span>Sá</span><span>Do</span>
        </div>
        <div class="cal-grid" id="cal-grid" role="grid"></div>
        <div class="cal-session-list" id="cal-session-list" hidden></div>
      </div>`;

    this.triggerEl    = document.getElementById('session-cal-trigger');
    this.labelEl      = document.getElementById('session-cal-label');
    this.popupEl      = document.getElementById('session-cal-popup');
    this.gridEl       = document.getElementById('cal-grid');
    this.monthLabelEl = document.getElementById('cal-month-label');
    this.sessionListEl = document.getElementById('cal-session-list');

    this.triggerEl.addEventListener('click', () => this.toggle());
    document.getElementById('cal-prev').addEventListener('click', () => this.prevMonth());
    document.getElementById('cal-next').addEventListener('click', () => this.nextMonth());
  }

  setSessions(sessions) {
    this.sessions = sessions;
    this.sessionsByDate = new Map();
    sessions.forEach(s => {
      if (!s.fecha) return;
      const key = s.fecha.slice(0, 10);
      if (!this.sessionsByDate.has(key)) this.sessionsByDate.set(key, []);
      this.sessionsByDate.get(key).push(s);
    });
  }

  // silent=true: updates visual state only, does not fire onSelect callback
  selectSession(id, silent = true) {
    const session = this.sessions.find(s => s.id === id);
    if (!session) return;
    this.selectedId = id;
    if (session.fecha) {
      const d = new Date(session.fecha + 'T00:00:00');
      this.viewYear = d.getFullYear();
      this.viewMonth = d.getMonth();
    }
    this.updateLabel(session);
    if (this.isOpen) this.render();
    if (!silent) this.onSelect([id]);
  }

  updateLabel(sessionOrSessions) {
    if (!sessionOrSessions) { this.labelEl.textContent = 'Seleccionar sesión…'; return; }
    const sessions = Array.isArray(sessionOrSessions) ? sessionOrSessions : [sessionOrSessions];
    if (!sessions.length) { this.labelEl.textContent = 'Seleccionar sesión…'; return; }
    const s = sessions[0];
    const fecha = s.fecha
      ? new Date(s.fecha + 'T00:00:00').toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' })
      : '—';
    const suffix = sessions.length > 1
      ? ` · ${sessions.length} sesiones`
      : (s.organo ? ' · ' + s.organo : '');
    this.labelEl.textContent = fecha + suffix;
  }

  render() {
    const months = ['enero','febrero','marzo','abril','mayo','junio',
                    'julio','agosto','septiembre','octubre','noviembre','diciembre'];
    this.monthLabelEl.textContent = `${months[this.viewMonth]} ${this.viewYear}`;
    this.renderGrid();
  }

  renderGrid() {
    const { viewYear: y, viewMonth: m } = this;
    const firstDow = new Date(y, m, 1).getDay();
    const offset = firstDow === 0 ? 6 : firstDow - 1; // Mon-based
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

    let selDateStr = null;
    if (this.selectedId) {
      const sel = this.sessions.find(s => s.id === this.selectedId);
      if (sel?.fecha) selDateStr = sel.fecha.slice(0, 10);
    }

    const months = ['enero','febrero','marzo','abril','mayo','junio',
                    'julio','agosto','septiembre','octubre','noviembre','diciembre'];
    let html = '<span class="cal-day-empty"></span>'.repeat(offset);
    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const hasSess = this.sessionsByDate.has(dateStr);
      const isSel   = dateStr === selDateStr;
      const isToday = dateStr === todayStr;
      let cls = 'cal-day';
      if (hasSess) cls += ' cal-day--has-session';
      if (isSel)   cls += ' cal-day--selected';
      if (isToday) cls += ' cal-day--today';
      html += hasSess
        ? `<button class="${cls}" type="button" data-date="${dateStr}" aria-label="${d} de ${months[m]}">${d}</button>`
        : `<span class="${cls}">${d}</span>`;
    }
    this.gridEl.innerHTML = html;
    this.gridEl.querySelectorAll('.cal-day--has-session').forEach(btn => {
      btn.addEventListener('click', () => this.handleDayClick(btn.dataset.date));
    });
  }

  handleDayClick(dateStr) {
    const sessions = this.sessionsByDate.get(dateStr) ?? [];
    if (!sessions.length) return;
    const ids = sessions.map(s => s.id);
    this.selectedId = ids[0];
    this.updateLabel(sessions);
    this.renderGrid();
    this.sessionListEl.hidden = true;
    this.close();
    this.onSelect(ids);
  }

  prevMonth() {
    if (--this.viewMonth < 0) { this.viewMonth = 11; this.viewYear--; }
    this.render();
  }

  nextMonth() {
    if (++this.viewMonth > 11) { this.viewMonth = 0; this.viewYear++; }
    this.render();
  }

  toggle() { this.isOpen ? this.close() : this.open(); }

  open() {
    this.isOpen = true;
    this.popupEl.hidden = false;
    this.triggerEl.setAttribute('aria-expanded', 'true');
    this.render();
    this._outsideHandler = (e) => {
      if (!document.getElementById('session-calendar-wrap').contains(e.target)) this.close();
    };
    this._keyHandler = (e) => { if (e.key === 'Escape') this.close(); };
    document.addEventListener('mousedown', this._outsideHandler);
    document.addEventListener('keydown', this._keyHandler);
  }

  close() {
    this.isOpen = false;
    this.popupEl.hidden = true;
    this.triggerEl.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', this._outsideHandler);
    document.removeEventListener('keydown', this._keyHandler);
  }
}

// ─── Session selector + content filters ───────────────────────────────────────
function setupFilters() {
  sessionCalendar = new SessionCalendar(ids => loadSession(ids));

  msResultado = new MultiSelect(
    document.getElementById('ms-resultado'), [],
    vals => { filterState.resultado = vals; applyFilters(); }
  );
  msTematico = new MultiSelect(
    document.getElementById('ms-tematico'), [],
    vals => { filterState.tematico = vals; applyFilters(); }
  );
  msPolitico = new MultiSelect(
    document.getElementById('ms-politico'), [],
    vals => { filterState.politico = vals; applyFilters(); }
  );

  document.getElementById('search-claim').addEventListener('input', applyFilters);

  document.getElementById('btn-clear-filters')?.addEventListener('click', clearAllFilters);
}

// ─── Sessions ─────────────────────────────────────────────────────────────────
async function loadSessions() {
  const [{ data, error }, { count: headerCount }] = await Promise.all([
    supabase.from('session').select('id, legislatura, tipo, numero, fecha, organo, status').order('fecha', { ascending: false }),
    supabase.from('claim').select('id', { count: 'exact', head: true }),
  ]);

  if (error || !data?.length) {
    const lbl = document.getElementById('session-cal-label');
    if (lbl) lbl.textContent = 'Sin sesiones disponibles';
    return;
  }

  const sessions = data.filter(s => s.status === 'verified' && s.fecha);

  claimCount = headerCount ?? 0;

  const statsEl = document.getElementById('header-stats');
  if (statsEl) {
    headerStatsBase = `<strong>${sessions.length}</strong> sesiones · <strong>${claimCount.toLocaleString('es-ES')}</strong> afirmaciones`;
    statsEl.innerHTML = headerStatsBase;
  }

  if (!sessions.length) {
    const lbl = document.getElementById('session-cal-label');
    if (lbl) lbl.textContent = 'Sin sesiones disponibles';
    return;
  }

  sessionCalendar.setSessions(sessions);
  // Visually select the latest session, then load it
  sessionCalendar.selectSession(sessions[0].id, /* silent */ true);
  loadSession([sessions[0].id]);
}

async function loadClaimById(id) {
  const SELECT = `id, session_id, texto_normalizado, texto_original, entidad, metrica,
    valor_afirmado, periodo_temporal, ambito_geografico, ambito_tematico,
    fuente_citada, verificabilidad, centralidad, relevancia, tipo_claim,
    politician:politician_id (nombre_completo, partido, grupo_parlamentario),
    verification (resultado, confidence_score, afirmacion_correcta,
      omisiones, errores, fuentes, potencial_engano,
      recomendacion_redaccion, razonamiento_llm)`;
  const { data } = await supabase.from('claim').select(SELECT).eq('id', id).single();
  return data;
}

// ─── Claims for a session ─────────────────────────────────────────────────────
async function loadSession(sessionIds) {
  const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds];
  currentSessionIds = ids;

  const container = document.getElementById('claims-container');
  container.innerHTML = '<p class="loading">Cargando afirmaciones…</p>';

  const { data, error } = await supabase
    .from('claim')
    .select(`
      id, session_id, texto_normalizado, texto_original, entidad, metrica,
      valor_afirmado, periodo_temporal, ambito_geografico, ambito_tematico,
      fuente_citada, verificabilidad, centralidad, relevancia, tipo_claim,
      politician:politician_id (nombre_completo, partido, grupo_parlamentario),
      verification (
        resultado, confidence_score, afirmacion_correcta,
        omisiones, errores, fuentes, potencial_engano,
        recomendacion_redaccion, razonamiento_llm
      )
    `)
    .in('session_id', ids)
    .order('session_id')
    .order('id');

  if (error) {
    container.innerHTML = `<p class="error">Error al cargar afirmaciones: ${error.message}</p>`;
    return;
  }

  allClaims = data ?? [];
  const prevById = claimsById;
  claimsById = Object.fromEntries(allClaims.map(c => [c.id, c]));
  // Preserve any pre-loaded claims not in this session (e.g. deeplink)
  for (const [id, claim] of Object.entries(prevById)) {
    if (!claimsById[id]) claimsById[id] = claim;
  }

  // Reset filter state
  filterState.resultado = [];
  filterState.tematico  = [];
  filterState.politico  = [];
  populateFilters(allClaims);
  renderClaims(allClaims);
  updateClaimsCount(allClaims.length, allClaims.length);
  updateFilterPills();
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

  msTematico?.setOptions(tematicos.map(t => ({ value: t, label: TEMATICO_LABELS[t] ?? snakeToLabel(t) })));
  msResultado?.setOptions(resultados.map(r => ({ value: r, label: RESULTADO_LABELS[r] ?? snakeToLabel(r) })));
  msPolitico?.setOptions(politicos.map(p => ({ value: p.nombre_completo, label: p.nombre_completo })));
}

function applyFilters() {
  const search = norm(document.getElementById('search-claim').value.trim());

  const filtered = allClaims.filter(c => {
    if (filterState.tematico.length && !filterState.tematico.includes(c.ambito_tematico)) return false;
    if (filterState.politico.length && !filterState.politico.includes(c.politician?.nombre_completo)) return false;
    if (filterState.resultado.length) {
      const claimResults = c.verification?.map(v => v.resultado) ?? [];
      if (!filterState.resultado.some(r => claimResults.includes(r))) return false;
    }
    if (search) {
      const haystack = norm([c.texto_normalizado, c.texto_original].filter(Boolean).join(' '));
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  renderClaims(filtered);
  updateClaimsCount(filtered.length, allClaims.length);
  updateFilterPills();
}

function updateClaimsCount(shown, total) {
  const el = document.getElementById('claims-count');
  if (el) el.hidden = true;

  const statsEl = document.getElementById('header-stats');
  if (!statsEl || !headerStatsBase) return;
  if (!total) { statsEl.innerHTML = headerStatsBase; return; }

  const pleno = shown === total
    ? `<strong>${total.toLocaleString('es-ES')}</strong> en este pleno`
    : `<strong>${shown.toLocaleString('es-ES')}</strong>/<strong>${total.toLocaleString('es-ES')}</strong> en este pleno`;

  statsEl.innerHTML = `${headerStatsBase} · ${pleno}`;
}

function updateFilterPills() {
  const pillsEl = document.getElementById('filter-pills');
  const clearBtn = document.getElementById('btn-clear-filters');
  if (!pillsEl) return;

  const pills = [];
  filterState.resultado.forEach(v =>
    pills.push({ label: RESULTADO_LABELS[v] ?? v, remove: () => msResultado.deselect(v) }));
  filterState.tematico.forEach(v =>
    pills.push({ label: TEMATICO_LABELS[v] ?? snakeToLabel(v), remove: () => msTematico.deselect(v) }));
  filterState.politico.forEach(v =>
    pills.push({ label: v, remove: () => msPolitico.deselect(v) }));

  const searchVal = document.getElementById('search-claim').value.trim();
  if (searchVal) pills.push({
    label: `"${searchVal}"`,
    remove: () => { document.getElementById('search-claim').value = ''; applyFilters(); },
  });

  pillsEl.hidden = pills.length === 0;
  if (clearBtn) clearBtn.hidden = pills.length === 0;

  const badge = document.getElementById('filters-badge');
  if (badge) {
    badge.hidden = pills.length === 0;
    badge.textContent = pills.length || '';
  }

  pillsEl.innerHTML = pills.map((p, i) =>
    `<button class="filter-pill" data-pill="${i}">${escHtml(p.label)} <span aria-hidden="true">✕</span></button>`
  ).join('');
  pillsEl.querySelectorAll('.filter-pill').forEach((btn, i) => {
    btn.addEventListener('click', () => pills[i].remove());
  });
}

function clearAllFilters() {
  msResultado?.clearAll();
  msTematico?.clearAll();
  msPolitico?.clearAll();
  document.getElementById('search-claim').value = '';
  filterState.resultado = [];
  filterState.tematico  = [];
  filterState.politico  = [];
  applyFilters();
}

// ─── Render claims ────────────────────────────────────────────────────────────
const DAY_SESSION_LABELS = ['Pleno Mañana', 'Pleno Tarde'];
function sessionDayLabel(index) {
  return DAY_SESSION_LABELS[index] ?? `Pleno ${index + 1}`;
}

const CLAIMS_PAGE_SIZE = 30;
let lazyObserver = null;
let pendingClaims = [];   // flat ordered list yet to render
let pendingGroups = null; // for multi-session: [{dividerHtml, claims[]}]

function bindClaimToggle(_container) {
  // claim-toggle is now an <a> link — no JS binding needed
}

function appendNextBatch(container) {
  const sentinel = container.querySelector('.claims-sentinel');
  const insert = html => {
    if (sentinel) sentinel.insertAdjacentHTML('beforebegin', html);
    else container.insertAdjacentHTML('beforeend', html);
  };

  if (pendingGroups) {
    let added = 0;
    while (added < CLAIMS_PAGE_SIZE && pendingGroups.length) {
      const g = pendingGroups[0];
      if (g.dividerHtml) { insert(g.dividerHtml); g.dividerHtml = null; }
      const take = Math.min(CLAIMS_PAGE_SIZE - added, g.claims.length);
      insert(g.claims.splice(0, take).map(c => claimCard(c)).join(''));
      added += take;
      if (!g.claims.length) pendingGroups.shift();
    }
  } else {
    insert(pendingClaims.splice(0, CLAIMS_PAGE_SIZE).map(c => claimCard(c)).join(''));
  }
  bindClaimToggle(container);
  updateSentinel(container);
}

function updateSentinel(container) {
  const remaining = pendingGroups
    ? pendingGroups.reduce((n, g) => n + g.claims.length, 0)
    : pendingClaims.length;

  let sentinel = container.querySelector('.claims-sentinel');
  if (remaining === 0) {
    if (sentinel) sentinel.remove();
    if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
    return;
  }
  if (!sentinel) {
    sentinel = document.createElement('div');
    sentinel.className = 'claims-sentinel';
    sentinel.style.cssText = 'height:1px;margin-top:1rem;';
    container.appendChild(sentinel);
  }
  if (!lazyObserver) {
    lazyObserver = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting) appendNextBatch(container);
    }, { rootMargin: '200px' });
    lazyObserver.observe(sentinel);
  }
}

function renderClaims(claims) {
  const container = document.getElementById('claims-container');

  // Tear down previous lazy loader
  if (lazyObserver) { lazyObserver.disconnect(); lazyObserver = null; }
  pendingClaims = [];
  pendingGroups = null;

  if (!claims.length) {
    container.innerHTML = '<p class="empty">No hay afirmaciones que coincidan con los filtros.</p>';
    return;
  }

  container.innerHTML = '';

  if (currentSessionIds.length > 1) {
    const sessionsMap = new Map((sessionCalendar?.sessions ?? []).map(s => [s.id, s]));
    const orderedIds = currentSessionIds
      .map(id => sessionsMap.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.numero ?? 0) - (b.numero ?? 0))
      .map(s => s.id);

    const grouped = new Map();
    for (const c of claims) {
      if (!grouped.has(c.session_id)) grouped.set(c.session_id, []);
      grouped.get(c.session_id).push(c);
    }

    pendingGroups = orderedIds
      .filter(sid => grouped.has(sid))
      .map((sid, i) => ({
        dividerHtml: `<div class="session-divider" role="separator"><span>${escHtml(sessionDayLabel(i))}</span></div>`,
        claims: grouped.get(sid),
      }));
  } else {
    pendingClaims = [...claims];
  }

  appendNextBatch(container);
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
    <article class="claim-card" data-resultado="${resultadoClass}"${pol?.grupo_parlamentario === 'Cargo de Gobierno' ? ' data-gobierno' : ''}>
      <header class="claim-header">
        <div class="claim-meta-top">
          ${pol
      ? `<span class="politician-name">${escHtml(formatNombre(pol.nombre_completo))}${pol.partido ? `<span class="politician-partido">· ${escHtml(pol.partido)}</span>` : ''}</span>`
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
        ${v ? `<a class="claim-toggle" href="/claim/${slugifyClaim(claim.texto_normalizado, claim.id)}.html">Ver más →</a>` : ''}
        <div class="share-wrapper">
          <button class="share-btn" data-claim-id="${claim.id}" aria-label="Compartir afirmación">
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
      ? `<span class="politician-name" style="font-size:1.05rem">${escHtml(formatNombre(pol.nombre_completo))}${pol.grupo_parlamentario === 'Cargo de Gobierno' ? `<span class="politician-gobierno" title="Cargo de Gobierno">🏛️</span>` : ''}${pol.partido ? `<span class="politician-partido">· ${escHtml(pol.partido)}</span>` : ''}</span>`
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
        <button class="share-btn share-btn--labeled" data-claim-id="${claim.id}" aria-label="Compartir afirmación">
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
function slugifyPolitician(name, partido = '') {
  let s = `${name} ${partido}`.trim().toLowerCase();
  for (const [src, dst] of [['á','a'],['é','e'],['í','i'],['ó','o'],['ú','u'],['ñ','n'],['ç','c'],['ü','u']]) {
    s = s.replaceAll(src, dst);
  }
  s = s.replace(/[^a-z0-9\s-]/g, '');
  return s.split(/\s+/).join('-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'desconocido';
}

function slugifyClaim(text, claimId) {
  const shortId = String(claimId).split('-')[0];
  let s = String(text ?? '').trim().toLowerCase();
  for (const [src, dst] of [['á','a'],['é','e'],['í','i'],['ó','o'],['ú','u'],['ñ','n'],['ç','c'],['ü','u']]) {
    s = s.replaceAll(src, dst);
  }
  s = s.replace(/[^a-z0-9\s-]/g, '');
  const slug = s.split(/\s+/).slice(0, 8).join('-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug ? `${slug}-${shortId}` : shortId;
}

function buildShareUrl(claim) {
  const slug = slugifyClaim(claim.texto_normalizado, claim.id);
  return `https://facthem.es/claim/${slug}.html`;
}

function formatNombre(str) {
  const parts = String(str ?? '').split(',');
  return parts.length === 2 ? `${parts[1].trim()} ${parts[0].trim()}` : String(str ?? '');
}

function buildShareText(claim) {
  const pol = claim.politician;
  const v = claim.verification?.[0] ?? null;
  const resultadoKey = v?.resultado?.toUpperCase() ?? null;
  const resultadoLabel = v ? formatResultado(v.resultado) : 'Sin verificar';
  const emoji = resultadoKey ? (RESULTADO_EMOJIS[resultadoKey] ?? '🔍') : '🔍';
  const nombre = pol ? formatNombre(pol.nombre_completo) : 'Un político';
  const partido = pol?.partido ? ` (${pol.partido})` : '';
  const texto = String(claim.texto_normalizado ?? '').trim();
  const truncated = texto.length > 200 ? texto.slice(0, 200) + '…' : texto;
  return `🔍 ${nombre}${partido} ha afirmado: "${truncated}"\n${emoji} ${resultadoLabel} | facthem.es`;
}

function buildShareTextPlain(claim) {
  return buildShareText(claim);
}

function buildShareMenu(claim) {
  const shareUrl = buildShareUrl(claim);
  const shareText = buildShareTextPlain(claim);
  const fullText = shareText + '\n\n' + shareUrl;
  const encodedUrl = encodeURIComponent(shareUrl);
  const encodedFullText = encodeURIComponent(fullText);
  const encodedWa = encodeURIComponent(fullText);

  return `
    <a class="share-option" href="https://wa.me/?text=${encodedWa}" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347zM12 0C5.373 0 0 5.373 0 12c0 2.127.557 4.123 1.532 5.856L0 24l6.335-1.652A11.954 11.954 0 0 0 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z"/></svg>
      WhatsApp
    </a>
    <a class="share-option" href="https://twitter.com/intent/tweet?text=${encodedFullText}&via=facthem_ES" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.73-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
      X / Twitter
    </a>
    <a class="share-option" href="https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
      Facebook
    </a>
    <a class="share-option" href="https://t.me/share/url?url=${encodedUrl}&text=${encodeURIComponent(shareText + '\n')}" target="_blank" rel="noopener">
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
    const imgBtn = e.target.closest('.share-img-btn');

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

    if (imgBtn) {
      e.stopPropagation();
      const claim = claimsById[imgBtn.dataset.claimId];
      if (claim) handleShareImage(imgBtn, claim);
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
  setMeta('property', 'og:url', buildShareUrl(claim));
  setMeta('name', 'twitter:title', title);
  setMeta('name', 'twitter:description', desc);
}

function setMeta(attr, value, content) {
  const el = document.querySelector(`meta[${attr}="${value}"]`);
  if (el) el.setAttribute('content', content);
}

// ─── Share image (Canvas) ──────────────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const word of words) {
    const test = cur ? `${cur} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && cur) {
      lines.push(cur);
      if (lines.length >= maxLines) {
        lines[lines.length - 1] = lines[lines.length - 1].replace(/[,.]?$/, '…');
        return lines;
      }
      cur = word;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

async function generateShareImage(claim) {
  const canvas = document.createElement('canvas');
  const W = 1200, H = 630;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const pol = claim.politician;
  const v = claim.verification?.[0] ?? null;
  const clsKey = v ? resultadoToClass(v.resultado) : 'nv';
  const c = IMG_COLORS[clsKey] ?? IMG_COLORS.nv;
  const resultadoLabel = v ? formatResultado(v.resultado) : 'Sin verificar';
  const nombre = pol ? formatNombre(pol.nombre_completo) : 'Un político';
  const partido = pol?.partido ?? '';
  const texto = capitalize(String(claim.texto_normalizado ?? '').trim());
  const score = v?.confidence_score != null ? Math.round(v.confidence_score * 100) : null;
  const font = "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif";

  // Outer background
  ctx.fillStyle = '#0d0d0d';
  ctx.fillRect(0, 0, W, H);

  // Card rect
  const cx = 40, cy = 40, cw = W - 80, ch = H - 80, cr = 12;
  // Card gradient background
  const grad = ctx.createLinearGradient(cx, cy, cx, cy + ch * 0.35);
  grad.addColorStop(0, c.bgAlpha);
  grad.addColorStop(1, '#141414');
  ctx.fillStyle = grad;
  roundRect(ctx, cx, cy, cw, ch, cr);
  ctx.fill();
  // Card border
  ctx.strokeStyle = '#2a2424';
  ctx.lineWidth = 1.5;
  roundRect(ctx, cx, cy, cw, ch, cr);
  ctx.stroke();
  // Card border-top (verdict color, 6px)
  ctx.fillStyle = c.color;
  ctx.beginPath();
  ctx.moveTo(cx + cr, cy);
  ctx.lineTo(cx + cw - cr, cy);
  ctx.quadraticCurveTo(cx + cw, cy, cx + cw, cy + cr);
  ctx.lineTo(cx + cw, cy + 6);
  ctx.lineTo(cx, cy + 6);
  ctx.lineTo(cx, cy + cr);
  ctx.quadraticCurveTo(cx, cy, cx + cr, cy);
  ctx.closePath();
  ctx.fill();

  // ── Content padding
  const px = cx + 52, maxW = cw - 104;
  let y = cy + 74;

  // ── Header row: politician name + partido badge | resultado badge
  ctx.font = `700 34px ${font}`;
  ctx.fillStyle = '#e4e0e0';
  ctx.fillText(nombre, px, y);
  const nombreW = ctx.measureText(nombre).width;

  if (partido) {
    const bFont = `500 22px ${font}`;
    ctx.font = bFont;
    const bPad = 14, bH = 34, bR = 4;
    const bW = ctx.measureText(partido).width + bPad * 2;
    const bx = px + nombreW + 16, by = y - 26;
    ctx.fillStyle = 'rgba(255,255,255,.05)';
    roundRect(ctx, bx, by, bW, bH, bR); ctx.fill();
    ctx.strokeStyle = '#2a2424'; ctx.lineWidth = 1;
    roundRect(ctx, bx, by, bW, bH, bR); ctx.stroke();
    ctx.fillStyle = '#9a8e8e';
    ctx.fillText(partido, bx + bPad, by + 23);
  }

  // Resultado badge (right-aligned)
  const badgeLabel = resultadoLabel.toUpperCase();
  const badgeFont = `800 20px ${font}`;
  ctx.font = badgeFont;
  ctx.letterSpacing = '0.08em';
  const dotR = 6, dotGap = 10, badgePad = 18, badgeH = 38, badgeR = 3;
  const labelW = ctx.measureText(badgeLabel).width;
  const badgeW = dotR * 2 + dotGap + labelW + badgePad * 2;
  const bx2 = cx + cw - 52 - badgeW, by2 = y - 28;
  ctx.fillStyle = c.bgAlpha;
  roundRect(ctx, bx2, by2, badgeW, badgeH, badgeR); ctx.fill();
  ctx.strokeStyle = c.border; ctx.lineWidth = 1;
  roundRect(ctx, bx2, by2, badgeW, badgeH, badgeR); ctx.stroke();
  ctx.fillStyle = c.color;
  // dot
  ctx.beginPath();
  ctx.arc(bx2 + badgePad + dotR, by2 + badgeH / 2, dotR, 0, Math.PI * 2);
  ctx.fill();
  // label
  ctx.fillText(badgeLabel, bx2 + badgePad + dotR * 2 + dotGap, by2 + 26);
  ctx.letterSpacing = '0px';

  y += 52;

  // ── Decorative quote mark
  ctx.font = `900 180px Georgia, 'Times New Roman', serif`;
  ctx.fillStyle = 'rgba(200,96,122,0.30)';
  ctx.fillText('\u201C', px - 8, y + 100);

  // ── Claim text (italic)
  ctx.font = `italic 400 28px ${font}`;
  ctx.fillStyle = '#e4e0e0';
  const textIndent = px + 52;
  const textMaxW = maxW - 52;
  const textLines = wrapText(ctx, texto, textMaxW, 4);
  textLines.forEach((line, i) => { ctx.fillText(line, textIndent, y + i * 46); });
  y += textLines.length * 46 + 24;

  // ── Confidence bar
  if (score !== null) {
    const trackW = 220, trackH = 6, trackR = 99;
    ctx.fillStyle = '#2a2424';
    roundRect(ctx, px, y, trackW, trackH, trackR); ctx.fill();
    ctx.fillStyle = c.color;
    roundRect(ctx, px, y, Math.round(trackW * score / 100), trackH, trackR); ctx.fill();
    ctx.font = `500 20px ${font}`;
    ctx.fillStyle = '#9a8e8e';
    ctx.fillText(`${score}% confianza`, px + trackW + 14, y + trackH + 5);
    y += 30;
  }

  // ── Footer
  const footerY = cy + ch - 40;
  // "Facthem" in gradient (matching .hero-title)
  const fFont = `900 40px ${font}`;
  ctx.font = fFont;
  const fW = ctx.measureText('Facthem').width;
  const fGrad = ctx.createLinearGradient(px, footerY - 30, px + fW, footerY);
  fGrad.addColorStop(0, '#f0b8c4');
  fGrad.addColorStop(1, '#c8607a');
  ctx.fillStyle = fGrad;
  ctx.fillText('Facthem', px, footerY);
  // "verificador parlamentario" small
  ctx.font = `400 18px ${font}`;
  ctx.fillStyle = '#9a8e8e';
  ctx.fillText('verificador parlamentario', px + fW + 14, footerY - 2);
  // "facthem.es" right
  ctx.font = `500 20px ${font}`;
  ctx.fillStyle = '#9a8e8e';
  const fesW = ctx.measureText('facthem.es').width;
  ctx.fillText('facthem.es', cx + cw - 52 - fesW, footerY);

  return new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
}

async function handleShareImage(btn, claim) {
  const span = btn.querySelector('span');
  const originalText = span?.textContent ?? '';
  if (span) span.textContent = 'Generando…';
  try {
    const blob = await generateShareImage(claim);
    const file = new File([blob], 'facthem-claim.png', { type: 'image/png' });
    const shareUrl = buildShareUrl(claim);
    const shareText = buildShareText(claim);
    if (navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], text: shareText, url: shareUrl });
    } else {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'facthem-claim.png';
      a.click();
      URL.revokeObjectURL(url);
    }
  } catch (err) {
    if (err?.name !== 'AbortError') console.error('Share image failed:', err);
  } finally {
    if (span) span.textContent = originalText || 'Compartir imagen';
  }
}

async function handleClaimDeepLink() {
  const claimId = new URLSearchParams(window.location.search).get('claim');
  if (!claimId) return;

  const { data, error } = await supabase
    .from('claim')
    .select('id, texto_normalizado')
    .eq('id', claimId)
    .single();

  if (!error && data) {
    const slug = slugifyClaim(data.texto_normalizado, data.id);
    window.location.replace(`/claim/${slug}.html`);
  } else {
    console.warn('[deeplink] claim not found or fetch failed', claimId, error?.message);
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
  const key = String(resultado).toUpperCase().replaceAll(' ', '_');
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
  return map[key] ?? 'nv';
}

function formatResultado(resultado) {
  if (!resultado) return 'Sin verificar';
  const key = String(resultado).toUpperCase().replaceAll(' ', '_');
  return RESULTADO_LABELS[key] ?? snakeToLabel(resultado);
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

  const claimsPorPartido = (s.claims_por_partido || [])
    .filter(p => p.count >= 40)
    .map(p => ({
      tema: p.partido,
      partido: p.count.toString(),
    }));

  grid.innerHTML = `
    ${statCard('Partido con más claims', d('top_partido_claims').name || '-', `${d('top_partido_claims').count || 0} claims totales`, false, 'El partido que más afirmaciones ha realizado en total.')}
    ${statCard('Político con más claims', polLabel('top_politico_claims'), `${d('top_politico_claims').count || 0} claims totales`, false, 'El diputado que más afirmaciones ha realizado en total.')}
    ${statCard('Temática más frecuente', temaLabel('top_tema'), `${d('top_tema').count || 0} menciones`, false, 'El ámbito sobre el que más afirmaciones se han hecho.')}
    ${statCardDual('Político con más falsos',
        polLabel('top_politico_falso_volumen'), `${d('top_politico_falso_volumen').count || 0} falsos/engañosos`,
        polLabel('top_politico_falso_tasa'), d('top_politico_falso_tasa').count || 0, d('top_politico_falso_tasa').total || 0, d('top_politico_falso_tasa').rate || 0,
        true, 'falsedad', 'El diputado con más afirmaciones verificadas como falsas o engañosas.')}
    ${statCard('Partido con más falsos', d('top_partido_falso').name || '-', `${d('top_partido_falso').count || 0} falsos/engañosos`, true, 'El partido con más afirmaciones verificadas como falsas o engañosas.')}
    ${statCard('Tasa de falsedad', `${porcFalsos}%`, `${totalFalsos} de ${total} afirmaciones`, true, 'Porcentaje de afirmaciones verificadas como falsas o engañosas.')}
    ${statCard('Temática más conflictiva', temaLabel('top_tema_falso'), `${d('top_tema_falso').count || 0} afirmaciones falsas`, true, 'El ámbito temático donde más afirmaciones falsas se han detectado.')}
    ${statCardDual('El Maestro del Escaqueo',
        polLabel('top_politico_nv_volumen'), `${d('top_politico_nv_volumen').count || 0} afirmaciones no verificables`,
        polLabel('top_politico_nv_tasa'), d('top_politico_nv_tasa').count || 0, d('top_politico_nv_tasa').total || 0, d('top_politico_nv_tasa').rate || 0,
        false, 'no verificables', 'El político que más afirmaciones hace que no pueden verificarse por falta de datos concretos.')}
    ${statCard('Tasa de veracidad', `${porcConfirmados}%`, `${totalConfirm} de ${total} afirmaciones`, false, 'Porcentaje de afirmaciones verificadas como completamente ciertas.')}
    ${statCard('Partido más escurridizo', d('top_partido_nv').name || '-', `${d('top_partido_nv').count || 0} afirmaciones no verificables`, false, 'El partido que más afirmaciones hace que no pueden verificarse.')}
    ${statCard('La Madre de todos los Bulos', tfrLabel, `${Math.round((tfrRate.rate || 0) * 100)}% de falsedades`, true, 'El ámbito temático donde los políticos mienten con más descaro en proporción.')}
    ${statCardDual('El Gran Matizador',
        polLabel('top_politico_matiz_volumen'), `${d('top_politico_matiz_volumen').count || 0} confirmados con matiz`,
        polLabel('top_politico_matiz_tasa'), d('top_politico_matiz_tasa').count || 0, d('top_politico_matiz_tasa').total || 0, d('top_politico_matiz_tasa').rate || 0,
        false, 'confirmados con matiz', 'El político que más veces dice algo cierto… pero con algún pero importante.')}
    ${statCard('Partido del "sí, pero..."', d('top_partido_matiz').name || '-', `${d('top_partido_matiz').count || 0} confirmados con matiz`, false, 'El partido que más verdades a medias acumula.')}
    ${statCard('Combo Breaker', cbLabel, cbSub, false, 'El político que más afirmaciones confirmadas acumuló en un solo pleno.')}
    ${statCard('Bocachancla', bcLabel, bcSub, true, 'El político que más afirmaciones falsas encadenó en un solo pleno.')}
    ${statCardDual('El Exagerador Mayor',
        polLabel('top_politico_sobre_volumen'), `${d('top_politico_sobre_volumen').count || 0} cifras sobreestimadas`,
        polLabel('top_politico_sobre_tasa'), d('top_politico_sobre_tasa').count || 0, d('top_politico_sobre_tasa').total || 0, d('top_politico_sobre_tasa').rate || 0,
        true, 'sobreestimación', 'El político que más veces ha inflado cifras reales para que suenen más impactantes.')}
    ${statCard('Partido de las Cifras Infladas', d('top_partido_sobre').name || '-', `${d('top_partido_sobre').count || 0} sobreestimaciones`, true, 'El partido que más veces ha sobreestimado datos que en realidad son menores.')}
    ${statCard('Partido de las Cifras Maquilladas', d('top_partido_subest').name || '-', `${d('top_partido_subest').count || 0} subestimaciones`, true, 'El partido que más veces ha minimizado datos reales.')}
    ${statCard('El Cuñado Nacional', polLabel('top_politico_cunado'), `${d('top_politico_cunado').count || 0} temáticas · ${Math.round((d('top_politico_cunado').rate || 0) * 100)}% del total`, false, 'El diputado que opina sobre absolutamente todo, como el cuñado en Navidad.')}
    ${statCardDual('El Minimizador',
        polLabel('top_politico_subest_volumen'), `${d('top_politico_subest_volumen').count || 0} cifras subestimadas`,
        polLabel('top_politico_subest_tasa'), d('top_politico_subest_tasa').count || 0, d('top_politico_subest_tasa').total || 0, d('top_politico_subest_tasa').rate || 0,
        true, 'subestimación', 'El político que más veces ha reducido cifras reales para que suenen menos graves.')}
    ${statCard('Partido de las Verdades de Perogrullo', d('top_partido_impreciso').name || '-', `${d('top_partido_impreciso').count || 0} imprecisiones`, false, 'El partido que más veces ha dicho algo tan ambiguo que ni ellos mismos saben si es cierto.')}
    ${statCard('El Partido del Bulo Selectivo', d('top_partido_descont').name || '-', `${d('top_partido_descont').count || 0} descontextualizaciones`, true, 'El partido que más veces usa datos reales arrancados de su contexto para cambiar su significado.')}
    ${statCardDual('El Maestro del Bla Bla',
        polLabel('top_politico_impreciso_volumen'), `${d('top_politico_impreciso_volumen').count || 0} afirmaciones imprecisas`,
        polLabel('top_politico_impreciso_tasa'), d('top_politico_impreciso_tasa').count || 0, d('top_politico_impreciso_tasa').total || 0, d('top_politico_impreciso_tasa').rate || 0,
        false, 'imprecisión', 'El político que más veces ha soltado una afirmación tan vaga que no hay manera de verificarla.')}
    ${statCardDual('El Sacador de Contexto',
        polLabel('top_politico_descont_volumen'), `${d('top_politico_descont_volumen').count || 0} descontextualizaciones`,
        polLabel('top_politico_descont_tasa'), d('top_politico_descont_tasa').count || 0, d('top_politico_descont_tasa').total || 0, d('top_politico_descont_tasa').rate || 0,
        true, 'descontextualización', 'El político que más veces ha usado datos reales arrancándolos de su contexto para cambiar su significado.')}
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

function statCardDual(title, volLabel, volSub, tasaLabel, tasaCount, tasaTotal, tasaRate, isFalso, tasaKeyword, description = '') {
  const subClass = isFalso ? 'stat-subtitle falso-subtitle' : 'stat-subtitle';
  const tasaSub = `${Math.round(tasaRate * 100)}% de ${tasaKeyword} · ${tasaCount} de ${tasaTotal} afirmaciones`;
  return `
    <div class="stat-card stat-card--dual">
      <div class="stat-title">${title}</div>
      <div class="stat-dual">
        <div class="stat-dual-col">
          <div class="stat-dual-label">Por volumen</div>
          <div class="stat-value">${volLabel}</div>
          <div class="${subClass}">${volSub}</div>
        </div>
        <div class="stat-dual-col">
          <div class="stat-dual-label">Por tasa</div>
          <div class="stat-value">${tasaLabel}</div>
          <div class="${subClass}">${tasaSub}</div>
        </div>
      </div>
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
  if (allPoliticians.length) return allPoliticians;
  if (politiciansLoadPromise) return politiciansLoadPromise;

  politiciansLoadPromise = loadPoliticiansOnce();
  return politiciansLoadPromise;
}

async function loadPoliticiansOnce() {
  searchLoaded = true;
  const input = document.getElementById('politician-search-input');
  input.placeholder = 'Cargando políticos…';
  input.disabled = true;

  const { data, error } = await supabase
    .from('politician')
    .select('id, nombre_completo, partido, grupo_parlamentario')
    .order('nombre_completo');

  input.disabled = false;
  input.placeholder = 'Escribe el nombre de un político…';

  if (error || !data?.length) {
    input.placeholder = 'Error al cargar políticos. Recarga la página.';
    politiciansLoadPromise = null;
    return [];
  }

  allPoliticians = data;
  if (!politicianAutocompleteReady) {
    setupPoliticianAutocomplete();
    politicianAutocompleteReady = true;
  }
  return allPoliticians;
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
      ? `<span class="suggestion-partido">· ${escHtml(p.partido)}</span>`
      : '';
    const gobierno = p.grupo_parlamentario === 'Cargo de Gobierno' ? '  🏛️' : '';
    return `<li class="suggestion-item" role="option" id="suggestion-${i}" aria-selected="false"
      data-id="${p.id}" data-name="${escHtml(formattedName)}">${highlighted}${partido}${gobierno}</li>`;
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
  resetPoliticianSearchView({ focus: true });
  updateAppUrl('view-busqueda', { politicianSlug: '' });
}

function resetPoliticianSearchView({ focus = false } = {}) {
  const input = document.getElementById('politician-search-input');
  const clearBtn = document.getElementById('search-clear-btn');
  const area = document.getElementById('search-results-area');
  input.value = '';
  clearBtn.hidden = true;
  closeSuggestions();
  document.getElementById('search-filters').hidden = true;
  resetSearchFilters();
  currentSearchClaims = [];
  currentPoliticianSlug = '';
  area.innerHTML = `<div class="search-welcome">
    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
      <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
    </svg>
    <p>Busca un político para ver todas sus afirmaciones verificadas.</p>
  </div>`;
  if (focus) input.focus();
}

async function selectPolitician(politicianId, politicianName, { updateUrl = true, scrollToResults = false } = {}) {
  const input = document.getElementById('politician-search-input');
  const area = document.getElementById('search-results-area');
  const politician = allPoliticians.find(p => String(p.id) === String(politicianId));
  const polPartido = politician?.partido || '';
  currentPoliticianSlug = slugifyPolitician(politicianName, polPartido);

  input.value = politicianName;
  closeSuggestions();
  document.getElementById('search-clear-btn').hidden = false;
  if (updateUrl) {
    updateAppUrl('view-busqueda', { politicianSlug: currentPoliticianSlug });
  }

  if (searchClaimsCache[politicianId]) {
    currentSearchClaims = searchClaimsCache[politicianId];
    resetSearchFilters();
    document.getElementById('search-filters').hidden = false;
    populateSearchFilters(currentSearchClaims);
    renderSearchResults(currentSearchClaims, politicianName);
    if (scrollToResults) scrollToPoliticianResults();
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
  currentSearchClaims = claims;
  resetSearchFilters();
  document.getElementById('search-filters').hidden = false;
  populateSearchFilters(claims);
  renderSearchResults(claims, politicianName);
  if (scrollToResults) scrollToPoliticianResults();
}

function scrollToPoliticianResults() {
  requestAnimationFrame(() => {
    const target = document.querySelector('#view-busqueda .search-input-area');
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
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
}
