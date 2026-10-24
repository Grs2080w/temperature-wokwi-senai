import { ref, query, limitToLast, onChildAdded } from 'firebase/database';
import { doc, onSnapshot } from 'firebase/firestore';
import { rtdb, db } from './firebase.js';
import { ROOMS, VARS, DEFAULT_LIMITS, LIVE_WINDOW, OFFLINE_AFTER_MS } from './config.js';
import { describe, fmt, outOfRange, esc, fmtDateTime, fmtTime } from './stats.js';
import { timeChart, setSeries } from './charts.js';

const todayId = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' }); // AAAA-MM-DD

// ---------------------------------------------------------------------
//  Store: assina RTDB (leituras) e Firestore (limites + resumos do Flask)
// ---------------------------------------------------------------------
export function createLiveStore() {
  const state = {
    rooms: Object.fromEntries(
      ROOMS.map((r) => [r.id, { ...r, limits: DEFAULT_LIMITS, readings: [], summary: null, daily: null }]),
    ),
  };
  const listeners = new Set();
  const unsubs = [];
  let queued = false;
  const notify = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      listeners.forEach((fn) => fn(state));
    });
  };

  for (const { id } of ROOMS) {
    const room = state.rooms[id];

    unsubs.push(onSnapshot(doc(db, 'rooms', id), (s) => {
      const d = s.data();
      if (d?.limits?.temperature && d?.limits?.humidity) room.limits = d.limits;
      if (d?.name) room.name = d.name;
      notify();
    }, (e) => console.error('rooms', e)));

    unsubs.push(onSnapshot(doc(db, 'rooms', id, 'summary', 'latest'), (s) => {
      room.summary = s.data() ?? null;
      notify();
    }, () => {}));

    // acompanha a data do dia: refaz a assinatura se virar a meia-noite
    let dailyUnsub = null;
    let dailyFor = null;
    const watchDaily = () => {
      const day = todayId();
      if (day === dailyFor) return;
      dailyUnsub?.();
      dailyFor = day;
      dailyUnsub = onSnapshot(doc(db, 'rooms', id, 'daily', day), (s) => {
        room.daily = s.data() ?? null;
        notify();
      }, () => {});
    };
    watchDaily();
    const dailyTimer = setInterval(watchDaily, 60_000);
    unsubs.push(() => { dailyUnsub?.(); clearInterval(dailyTimer); });

    const q = query(ref(rtdb, `readings/${id}`), limitToLast(LIVE_WINDOW));
    unsubs.push(onChildAdded(q, (snap) => {
      const v = snap.val();
      if (typeof v?.timestamp !== 'number') return;
      const r = { key: snap.key, t: v.temperature, h: v.humidity, ts: v.timestamp };
      room.readings.push(r);
      room.readings.sort((a, b) => a.ts - b.ts || (a.key < b.key ? -1 : 1));
      if (room.readings.length > LIVE_WINDOW) room.readings.splice(0, room.readings.length - LIVE_WINDOW);
      notify();
    }, (e) => console.error('readings', e)));
  }

  // reavalia "sem dados" mesmo sem evento novo
  const tick = setInterval(notify, 5_000);
  unsubs.push(() => clearInterval(tick));

  return {
    state,
    subscribe(fn) {
      listeners.add(fn);
      fn(state);
      return () => listeners.delete(fn);
    },
    stop() {
      unsubs.forEach((u) => u());
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------
//  Situacao de cada sala
// ---------------------------------------------------------------------
export function roomStatus(room, now = Date.now()) {
  const last = room.readings[room.readings.length - 1];
  if (!last) return { kind: 'nodata', issues: [], last: null };
  if (now - last.ts > OFFLINE_AFTER_MS) return { kind: 'offline', issues: [], last };
  const issues = [];
  const t = outOfRange(last.t, room.limits.temperature);
  const h = outOfRange(last.h, room.limits.humidity);
  if (t) issues.push({ v: 'temperature', dir: t, value: last.t, limit: room.limits.temperature });
  if (h) issues.push({ v: 'humidity', dir: h, value: last.h, limit: room.limits.humidity });
  return { kind: issues.length ? 'alert' : 'ok', issues, last };
}

const describeIssue = (i) =>
  `${VARS[i.v].label} ${i.dir === 'low' ? 'abaixo do mínimo' : 'acima do máximo'} (${fmt(i.value, 1, VARS[i.v].unit)}; faixa ${fmt(i.limit.min, 0)}–${fmt(i.limit.max, 0)} ${VARS[i.v].unit})`;

export function renderAlertBar(el, state) {
  const lines = [];
  for (const room of Object.values(state.rooms)) {
    const st = roomStatus(room);
    if (st.kind === 'alert') st.issues.forEach((i) => lines.push(`<strong>${esc(room.name)}:</strong> ${esc(describeIssue(i))}`));
    else if (st.kind === 'offline') lines.push(`<strong>${esc(room.name)}:</strong> sem leituras novas desde ${esc(fmtTime(st.last.ts))}`);
  }
  el.hidden = !lines.length;
  el.innerHTML = lines.length ? `<span class="alert-icon">⚠</span><div>${lines.join('<br>')}</div>` : '';
}

// ---------------------------------------------------------------------
//  Aba "Tempo real"
// ---------------------------------------------------------------------
const STATUS_LABEL = { ok: 'Normal', alert: 'Alerta', offline: 'Sem dados', nodata: 'Aguardando' };

function statBlock(title, s, v) {
  const { digits, unit } = VARS[v];
  if (!s || !s.count) return `<div class="stat"><h4>${title}</h4><p class="muted">sem dados</p></div>`;
  return `<div class="stat"><h4>${title} <span class="muted">(${s.count})</span></h4>
    <dl><div><dt>Média</dt><dd>${fmt(s.mean, digits, unit)}</dd></div>
    <div><dt>Mediana</dt><dd>${fmt(s.median, digits, unit)}</dd></div>
    <div><dt>Desvio</dt><dd>${fmt(s.stdDev, 2, unit)}</dd></div></dl></div>`;
}

function roomCard(room) {
  const st = roomStatus(room);
  const lim = room.limits;
  const last = st.last;
  const bad = (v) => st.issues.some((i) => i.v === v);
  const live = (key) => describe(room.readings.map((r) => r[key]));
  const sum = (v) => (room.summary?.[v] ? { ...room.summary[v], count: room.summary.count } : null);
  const day = (v) => (room.daily?.[v] ? { ...room.daily[v], median: null } : null);

  const metric = (v, key) => `
    <div class="metric${bad(v) ? ' bad' : ''}">
      <span class="metric-label">${VARS[v].label}</span>
      <span class="metric-value">${last ? fmt(last[key], 1) : '—'}<small>${VARS[v].unit}</small></span>
      <span class="metric-range">faixa ${fmt(lim[v].min, 0)}–${fmt(lim[v].max, 0)} ${VARS[v].unit}</span>
    </div>`;

  const daily = (v) => {
    const d = day(v);
    return d
      ? `<div class="stat"><h4>Hoje <span class="muted">(${d.count})</span></h4>
          <dl><div><dt>Média</dt><dd>${fmt(d.mean, 1, VARS[v].unit)}</dd></div>
          <div><dt>Desvio</dt><dd>${fmt(d.stdDev, 2, VARS[v].unit)}</dd></div>
          <div><dt>Fora</dt><dd>${(d.belowMin ?? 0) + (d.aboveMax ?? 0)}</dd></div></dl></div>`
      : `<div class="stat"><h4>Hoje</h4><p class="muted">sem dados</p></div>`;
  };

  return `
    <article class="card room ${st.kind}">
      <header>
        <h2>${esc(room.name)}</h2>
        <span class="badge ${st.kind}">${STATUS_LABEL[st.kind]}</span>
      </header>
      <div class="metrics">${metric('temperature', 't')}${metric('humidity', 'h')}</div>
      <p class="muted small">${last ? `Última leitura: ${fmtDateTime(last.ts)}` : 'Nenhuma leitura recebida ainda'}</p>
      ${st.issues.map((i) => `<p class="issue">⚠ ${esc(describeIssue(i))}</p>`).join('')}
      ${st.kind === 'offline' ? '<p class="issue">⚠ Sensor sem enviar dados. Verifique o dispositivo.</p>' : ''}
      <details open>
        <summary>Indicadores estatísticos</summary>
        ${['temperature', 'humidity'].map((v) => `
          <h3>${VARS[v].label}</h3>
          <div class="stats">
            ${statBlock('Ao vivo', live(v === 'temperature' ? 't' : 'h'), v)}
            ${statBlock('Último ciclo', sum(v), v)}
            ${daily(v)}
          </div>`).join('')}
      </details>
    </article>`;
}

export function mountLive(view, { store }) {
  view.innerHTML = `
    <div id="cards" class="grid-2"></div>
    <section class="card"><h2>Temperatura — comparação das salas</h2><div class="chart"><canvas id="c-temp"></canvas></div></section>
    <section class="card"><h2>Umidade — comparação das salas</h2><div class="chart"><canvas id="c-hum"></canvas></div></section>
    <p class="muted small">Gráficos mostram as últimas ${LIVE_WINDOW} leituras; linhas tracejadas = limites de cada sala.
      Indicadores "Ao vivo" são calculados sobre essa janela; "Último ciclo" e "Hoje" vêm do processamento do servidor.</p>`;
  const cards = view.querySelector('#cards');
  const tChart = timeChart(view.querySelector('#c-temp'), { unit: '°C' });
  const hChart = timeChart(view.querySelector('#c-hum'), { unit: '%' });

  const render = (state) => {
    const rooms = Object.values(state.rooms);
    cards.innerHTML = rooms.map(roomCard).join('');
    const series = (key, v) => rooms.map((r) => ({
      name: r.name,
      color: r.color,
      limit: r.limits[v],
      points: r.readings.map((x) => ({ x: x.ts, y: x[key] })),
    }));
    setSeries(tChart, series('t', 'temperature'));
    setSeries(hChart, series('h', 'humidity'));
  };
  const unsub = store.subscribe(render);
  return () => {
    unsub();
    tChart.destroy();
    hChart.destroy();
  };
}
