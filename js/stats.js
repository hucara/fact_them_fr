/* Estadísticas: the old site's dashboard (renderDashboard in the old
   js/app.js), card for card: same titles, wording and data, restyled.

   renderStats(stats) is pure (string in, HTML out). The build runs it under
   Node to prerender estadisticas.html (content without JS); in the browser this
   file only renders if that did not happen, and animates the cards in. */
(function (root) {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;' };
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ESC[c]);

  function renderStats(s) {
    const TEMATICO_LABELS = {
      defensa: 'Defensa', 'economía': 'Economía', educacion: 'Educación', 'educación': 'Educación', igualdad: 'Igualdad',
      industria_y_trabajo: 'Industria y Trabajo', 'inmigración': 'Inmigración', interior: 'Interior',
      justicia_y_corrupcion: 'Justicia y Corrupción', 'justicia_y_corrupción': 'Justicia y Corrupción', medio_ambiente: 'Medio Ambiente',
      otros: 'Otros', politica_social: 'Política Social', 'política_social': 'Política Social',
      relaciones_internacionales: 'Relaciones Internacionales', sanidad: 'Sanidad', vivienda: 'Vivienda', transporte: 'Transporte', agricultura: 'Agricultura',
    };
    const snakeToLabel = x => String(x || '').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
    const formatNumberES = n => new Intl.NumberFormat('es-ES', { useGrouping: 'always' }).format(n);
    const formatNombre = str => { const p = String(str ?? '').split(','); return p.length === 2 ? `${p[1].trim()} ${p[0].trim()}` : String(str ?? ''); };

    // ── Card templates (same parameters as the current site's helpers) ─────
    const desc = d => d ? `<p class="sc-desc">${d}</p>` : '';
    const sub = (t, bad) => `<p class="sc-sub${bad ? ' bad' : ''}">${esc(t)}</p>`;
    const statCard = (title, value, subtitle, isFalso = false, description = '') =>
      `<article class="sc"><h3 class="sc-title">${title}</h3><p class="sc-value">${esc(value)}</p>${sub(subtitle, isFalso)}${desc(description)}</article>`;
    const statCardDual = (title, volLabel, volSub, tasaLabel, tasaCount, tasaTotal, tasaRate, isFalso, tasaKeyword, description = '') =>
      `<article class="sc sc-dual"><h3 class="sc-title">${title}</h3><div class="sc-cols">
        <div><span class="sc-k">Por volumen</span><p class="sc-value">${esc(volLabel)}</p>${sub(volSub, isFalso)}</div>
        <div><span class="sc-k">Por tasa</span><p class="sc-value">${esc(tasaLabel)}</p>${sub(`${Math.round(tasaRate * 100)}% de ${tasaKeyword} · ${formatNumberES(tasaCount)} de ${formatNumberES(tasaTotal)} afirmaciones`, isFalso)}</div>
      </div>${desc(description)}</article>`;
    const statCardMatraca = (title, volLabel, volSub, tasaLabel, tasaSub, description = '') =>
      `<article class="sc sc-dual"><h3 class="sc-title">${title}</h3><div class="sc-cols">
        <div><span class="sc-k">Por volumen</span><p class="sc-value">${esc(volLabel)}</p>${sub(volSub)}</div>
        <div><span class="sc-k">Por tasa</span><p class="sc-value">${esc(tasaLabel)}</p>${sub(tasaSub)}</div>
      </div>${desc(description)}</article>`;
    const statCardBreakdown = (title, value, subtitle, rows, description = '') =>
      `<article class="sc"><h3 class="sc-title">${title}</h3><p class="sc-value sc-big">${esc(value)}</p>${sub(subtitle, true)}
        <ul class="sc-rows">${rows.map(r => `<li><span>${esc(r.label)}</span><span class="n">${formatNumberES(r.count)}</span><span class="p">${r.pct}%</span></li>`).join('')}</ul>${desc(description)}</article>`;
    const statCardTimeline = (title, value, subtitle, rows, isFalso = false, description = '') =>
      `<article class="sc"><h3 class="sc-title">${title}</h3><p class="sc-value">${esc(value)}</p>${sub(subtitle, isFalso)}
        ${rows.length ? `<div class="sc-events">${rows.map(r => `<div><span class="sc-k">${esc(r.label)}</span><p class="sc-value sc-sm">${esc(r.value)}</p>${sub(r.sub, isFalso)}</div>`).join('')}</div>` : ''}${desc(description)}</article>`;
    const statCardList = (title, rows, description = '') =>
      `<article class="sc sc-list"><h3 class="sc-title">${title}</h3><ul class="sc-table">${rows.map(r => `<li><span>${esc(r.tema)}</span><span class="n">${esc(r.partido)}</span></li>`).join('')}</ul>${desc(description)}</article>`;
    const statCardListTemas = (title, rows) =>
      `<article class="sc sc-list sc-wide"><h3 class="sc-title">${title}</h3><ul class="sc-table sc-table-3">
        <li class="hd"><span></span><span>Dominante</span><span>Más enfocado</span></li>
        ${rows.map(r => `<li><span>${esc(r.tema)}</span><span>${esc(r.dominante)}</span><span>${esc(r.especializado)}</span></li>`).join('')}</ul>
        ${desc('Muestra la relación principal entre los partidos y los diferentes temas de debate. Dominante: más afirmaciones en ese tema. Más enfocado: el que más lo prioriza respecto a su actividad total.')}</article>`;

    // ── Same derivations as renderDashboard ────────────────────────────────
    const total = s.total_claims || 0;
    const totalFalsos = s.total_falsos || 0, totalSobre = s.total_sobreestimados || 0, totalSubest = s.total_subestimados || 0;
    const totalIncorrectos = s.total_incorrectos || (totalFalsos + totalSobre + totalSubest);
    const totalConfirm = s.total_confirmados || 0;
    const pct = (rate, count, denom = total) => typeof rate === 'number' ? Math.round(rate * 100) : denom > 0 ? Math.round(count / denom * 100) : 0;
    const porcIncorrectos = pct(s.incorrecto_rate_global, totalIncorrectos), porcFalsos = pct(s.falso_rate_global, totalFalsos);
    const porcSobre = pct(s.sobreestimado_rate_global, totalSobre), porcSubest = pct(s.subestimado_rate_global, totalSubest);
    const porcConfirmados = pct(s.confirmado_rate_global, totalConfirm);
    const d = f => s[f] || {};
    const pick = (...fs) => fs.map(d).find(o => Object.keys(o).length) || {};
    const polLabelObj = o => o.name ? `${formatNombre(o.name)}${o.partido ? ` · ${o.partido}` : ''}` : '-';
    const polLabel = f => polLabelObj(d(f));
    const formatDate = f => new Date(`${f}T00:00:00`).toLocaleDateString('es-ES');
    const eventLabel = e => e?.politico ? `${formatNombre(e.politico)}${e.partido ? ` · ${e.partido}` : ''}` : '-';
    const eventSub = (e, noun) => e?.fecha ? `${formatNumberES(e.count || 0)} ${noun} en el pleno del ${formatDate(e.fecha)}` : '-';
    const eventRow = (label, e, noun) => e?.politico ? { label, value: eventLabel(e), sub: eventSub(e, noun) } : null;
    const cb = s.combo_breaker || {}, bc = s.bocachancla || {};
    const comboRows = [eventRow('Último mes', s.combo_breaker_last_month, 'confirmados')].filter(Boolean);
    const bocaRows = [eventRow('Último mes', s.bocachancla_last_month, 'falsedades')].filter(Boolean);
    const temaLabel = f => { const n = d(f).name; return n ? (TEMATICO_LABELS[n] ?? snakeToLabel(n)) : '-'; };
    // 'Último mes' (computed by the site build, build_claims.stats_last_month)
    const m = f => s[f + '_last_month'];
    const monthRow = (o, value, subText) => o ? [{ label: 'Último mes', value, sub: subText }] : [];
    const temaOf = o => o?.name ? (TEMATICO_LABELS[o.name] ?? snakeToLabel(o.name)) : '-';
    const mPartido = m('top_partido_claims'), mPol = m('top_politico_claims'), mTema = m('top_tema'), mTemaF = m('top_tema_falso'),
      mConf = s.confirmado_last_month, mTfr = m('top_tema_falso_rate'), mCun = m('top_politico_cunado');
    const tfr = s.top_tema_falso_rate || {};
    const tfrLabel = tfr.name ? (TEMATICO_LABELS[tfr.name] ?? snakeToLabel(tfr.name)) : '-';
    const topTemas = (s.temas_por_volumen || []).map(t => ({ tema: TEMATICO_LABELS[t.tema] ?? snakeToLabel(t.tema), dominante: t.partido_dominante || '—', especializado: t.partido_especializado || '—' }));
    const claimsPorPartido = (s.claims_por_partido || []).filter(p => p.count >= 40).map(p => ({ tema: p.partido, partido: formatNumberES(p.count) }));
    const topInexactoVol = pick('top_politico_inexacto_volumen', 'top_politico_impreciso_volumen');
    const topInexactoTasa = pick('top_politico_inexacto_tasa', 'top_politico_impreciso_tasa');
    const topPartidoInexacto = pick('top_partido_inexacto', 'top_partido_impreciso');
    const partidoInexactoCard = topPartidoInexacto.name ? statCard('Partido que más exagera o minimiza', topPartidoInexacto.name, `${formatNumberES(topPartidoInexacto.count || 0)} cifras sobre o subestimadas`, false, 'El partido con más afirmaciones sobreestimadas o subestimadas.') : '';
    const partidoDualCard = (title, volField, volNoun, tasaField, isFalso, description) => {
      const vol = d(volField), tasa = d(tasaField), volSub = `${formatNumberES(vol.count || 0)} ${volNoun}`;
      return tasa.name ? statCardDual(title, vol.name || '-', volSub, tasa.name, tasa.count || 0, tasa.total || 0, tasa.rate || 0, isFalso, 'sus afirmaciones', description)
        : statCard(title, vol.name || '-', volSub, isFalso, description);
    };
    const temaName = n => n ? (TEMATICO_LABELS[n] ?? snakeToLabel(n)) : '-';
    const mv = d('top_politico_matraca_volumen'), mt = d('top_politico_matraca_tasa');
    const matracaCard = (mv.name || mt.name) ? statCardMatraca('El de la Matraca',
      polLabelObj(mv), mv.name ? `${formatNumberES(mv.count || 0)} afirmaciones sobre ${temaName(mv.tema)}` : '-',
      polLabelObj(mt), mt.name ? `${Math.round((mt.rate || 0) * 100)}% sobre ${temaName(mt.tema)} · ${formatNumberES(mt.count || 0)} de ${formatNumberES(mt.total || 0)} afirmaciones` : '-',
      'El político más obsesionado con un solo tema.') : '';

    const dual = (title, f, noun, isFalso, kw, description) => statCardDual(title,
      polLabel(f + '_volumen'), `${formatNumberES(d(f + '_volumen').count || 0)} ${noun}`,
      polLabel(f + '_tasa'), d(f + '_tasa').count || 0, d(f + '_tasa').total || 0, d(f + '_tasa').rate || 0, isFalso, kw, description);

    return `
    <header class="page-head">
      <h1>Estadísticas globales</h1>
      <p class="muted">${formatNumberES(total)} afirmaciones verificadas en ${s.total_sessions} sesiones · XV Legislatura</p>
    </header>
    <div class="sgrid">
      ${statCardTimeline('Partido con más afirmaciones', d('top_partido_claims').name || '-', `${formatNumberES(d('top_partido_claims').count || 0)} afirmaciones en total`, monthRow(mPartido, mPartido?.name, `${formatNumberES(mPartido?.count || 0)} afirmaciones`), false, 'El partido que más afirmaciones ha realizado en total.')}
      ${statCardTimeline('Político con más afirmaciones', polLabel('top_politico_claims'), `${formatNumberES(d('top_politico_claims').count || 0)} afirmaciones en total`, monthRow(mPol, polLabelObj(mPol || {}), `${formatNumberES(mPol?.count || 0)} afirmaciones`), false, 'El diputado que más afirmaciones ha realizado en total.')}
      ${statCardTimeline('Temática más frecuente', temaLabel('top_tema'), `${formatNumberES(d('top_tema').count || 0)} menciones`, monthRow(mTema, temaOf(mTema), `${formatNumberES(mTema?.count || 0)} menciones`), false, 'El ámbito sobre el que más afirmaciones se han hecho.')}
      ${dual('Político con más falsos', 'top_politico_falso', 'falsos/engañosos', true, 'falsedad', 'El diputado con más afirmaciones verificadas como falsas o engañosas.')}
      ${partidoDualCard('Partido con más falsos', 'top_partido_falso', 'falsos/engañosos', 'top_partido_falso_tasa', true, 'El partido con más afirmaciones verificadas como falsas o engañosas.')}
      ${statCardBreakdown('Tasa de falsedad', `${porcIncorrectos}%`, `${formatNumberES(totalIncorrectos)} de ${formatNumberES(total)} afirmaciones incorrectas`, [
        { label: 'Falsos', count: totalFalsos, pct: porcFalsos }, { label: 'Sobreestimados', count: totalSobre, pct: porcSobre }, { label: 'Subestimados', count: totalSubest, pct: porcSubest },
      ], 'Combina afirmaciones falsas, sobreestimadas y subestimadas sobre el total de afirmaciones.')}
      ${statCardTimeline('Temática más conflictiva', temaLabel('top_tema_falso'), `${formatNumberES(d('top_tema_falso').count || 0)} afirmaciones falsas`, monthRow(mTemaF, temaOf(mTemaF), `${formatNumberES(mTemaF?.count || 0)} afirmaciones falsas`), true, 'El ámbito temático donde más afirmaciones falsas se han detectado.')}
      ${dual('El Maestro del Escaqueo', 'top_politico_nv', 'afirmaciones no verificables', false, 'no verificables', 'El político que más afirmaciones hace que no pueden verificarse por falta de datos concretos.')}
      ${statCardTimeline('Tasa de veracidad', `${porcConfirmados}%`, `${formatNumberES(totalConfirm)} de ${formatNumberES(total)} afirmaciones`, monthRow(mConf, `${Math.round((mConf?.rate || 0) * 100)}%`, `${formatNumberES(mConf?.count || 0)} de ${formatNumberES(mConf?.total || 0)} afirmaciones`), false, 'Porcentaje de afirmaciones verificadas como completamente ciertas.')}
      ${partidoDualCard('Partido más confirmado', 'top_partido_confirmado', 'confirmadas', 'top_partido_confirmado_tasa', false, 'El partido con más afirmaciones verificadas como completamente ciertas.')}
      ${partidoDualCard('Partido más escurridizo', 'top_partido_nv', 'afirmaciones no verificables', 'top_partido_nv_tasa', false, 'El partido que más afirmaciones hace que no pueden verificarse.')}
      ${statCardTimeline('La Madre de todos los Bulos', tfrLabel, `${Math.round((tfr.rate || 0) * 100)}% de falsedades`, monthRow(mTfr, temaOf(mTfr), `${Math.round((mTfr?.rate || 0) * 100)}% de falsedades`), true, 'El ámbito temático donde los políticos mienten con más descaro en proporción.')}
      ${dual('El Gran Matizador', 'top_politico_matiz', 'confirmados con matiz', false, 'confirmados con matiz', 'El político que más veces dice algo cierto… pero con algún pero importante.')}
      ${partidoDualCard('Partido del "sí, pero..."', 'top_partido_matiz', 'confirmados con matiz', 'top_partido_matiz_tasa', false, 'El partido que más verdades a medias acumula.')}
      ${statCardTimeline('Combo Breaker', eventLabel(cb), eventSub(cb, 'confirmados'), comboRows, false, 'El político que más afirmaciones confirmadas acumuló en un solo pleno.')}
      ${statCardTimeline('Bocachancla', eventLabel(bc), eventSub(bc, 'falsedades'), bocaRows, true, 'El político que más afirmaciones falsas encadenó en un solo pleno.')}
      ${dual('El Exagerador Mayor', 'top_politico_sobre', 'cifras sobreestimadas', true, 'sobreestimación', 'El político que más veces ha inflado cifras reales para que suenen más impactantes.')}
      ${partidoDualCard('Partido de las Cifras Infladas', 'top_partido_sobre', 'sobreestimaciones', 'top_partido_sobre_tasa', true, 'El partido que más veces ha sobreestimado datos que en realidad son menores.')}
      ${partidoDualCard('Partido de las Cifras Maquilladas', 'top_partido_subest', 'subestimaciones', 'top_partido_subest_tasa', true, 'El partido que más veces ha minimizado datos reales.')}
      ${statCardTimeline('El Cuñado Nacional', polLabel('top_politico_cunado'), `${formatNumberES(d('top_politico_cunado').count || 0)} temáticas · ${Math.round((d('top_politico_cunado').rate || 0) * 100)}% del total`, monthRow(mCun, polLabelObj(mCun || {}), `${formatNumberES(mCun?.count || 0)} temáticas · ${Math.round((mCun?.rate || 0) * 100)}% del total`), false, 'El diputado que opina sobre absolutamente todo, como el cuñado en Navidad.')}
      ${dual('El Minimizador', 'top_politico_subest', 'cifras subestimadas', true, 'subestimación', 'El político que más veces ha reducido cifras reales para que suenen menos graves.')}
      ${partidoInexactoCard}
      ${matracaCard}
      ${statCardDual('El Maestro del Bla Bla', polLabelObj(topInexactoVol), `${formatNumberES(topInexactoVol.count || 0)} cifras sobre o subestimadas`,
        polLabelObj(topInexactoTasa), topInexactoTasa.count || 0, topInexactoTasa.total || 0, topInexactoTasa.rate || 0, false, 'sobre o subestimación', 'El político con más afirmaciones sobreestimadas o subestimadas: cifras que no son las reales.')}
      ${dual('El Trilero', 'top_politico_descont', 'afirmaciones muy engañosas', true, 'potencial de engaño alto', 'El político con más afirmaciones que, según la verificación, tienen un potencial de engaño alto (aunque el dato sea real).')}
      ${statCardListTemas('Partidos por temática', topTemas)}
      ${statCardList('Afirmaciones por partido', claimsPorPartido, 'Total de afirmaciones registradas por cada partido político.')}
    </div>`;
  }

  if (typeof module !== 'undefined' && module.exports) { module.exports = { renderStats }; return; }

  const el = root.document.getElementById('stats');
  if (!el) return;
  if (!el.querySelector('.sgrid')) {
    const data = root.document.getElementById('stats-data');
    if (data) el.innerHTML = renderStats(JSON.parse(data.textContent));
  }
  // Cards rise in as they scroll into view.
  if (!root.matchMedia('(prefers-reduced-motion: reduce)').matches && 'IntersectionObserver' in root) {
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -40px 0px' });
    el.querySelectorAll('.sc').forEach((c, i) => { c.style.setProperty('--i', i % 3); io.observe(c); });
  } else {
    el.querySelectorAll('.sc').forEach(c => c.classList.add('in'));
  }
})(typeof window !== 'undefined' ? window : globalThis);
