import { collection, query, where, orderBy, limit, getDocs, Timestamp } from 'firebase/firestore';
import { db } from './firebase.js';
import { ROOMS, VARS } from './config.js';
import { describe, median, fmt, slopePerHour, outOfRange, esc, fmtDateTime } from './stats.js';
import { timeChart, setSeries } from './charts.js';

const HOUR = 3_600_000;
const PERIODS = [
  { id: '1h', label: 'Última hora', ms: HOUR },
  { id: '6h', label: 'Últimas 6 horas', ms: 6 * HOUR },
  { id: '24h', label: 'Últimas 24 horas', ms: 24 * HOUR },
  { id: '7d', label: 'Últimos 7 dias', ms: 7 * 24 * HOUR },
  { id: '30d', label: 'Últimos 30 dias', ms: 30 * 24 * HOUR },
];
const RAW_MAX_MS = 6 * HOUR; // acima disso usa os resumos por ciclo (stats)
const RAW_LIMIT = 5000;
const STATS_LIMIT = 5000;

const VAR_KEYS = ['temperature', 'humidity'];

// ---------------------------------------------------------------------
//  Carga dos dados de uma sala
// ---------------------------------------------------------------------
async function loadRoom(roomId, since, raw) {
  const col = collection(db, 'rooms', roomId, raw ? 'readings' : 'stats');
  const field = raw ? 'timestamp' : 'periodStart';
  const snap = await getDocs(query(col, where(field, '>=', Timestamp.fromMillis(since)), orderBy(field), limit(raw ? RAW_LIMIT : STATS_LIMIT)));
  return snap.docs.map((d) => {
    const x = d.data();
    if (raw) return { ts: x.timestamp.toMillis(), temperature: x.temperature, humidity: x.humidity };
    return { ts: x.periodStart.toMillis(), end: x.periodEnd.toMillis(), count: x.count, out: x.readingsOutOfRange ?? 0, temperature: x.temperature, humidity: x.humidity };
  });
}

async function loadDaily(roomId) {
  const snap = await getDocs(query(collection(db, 'rooms', roomId, 'daily'), orderBy('date', 'desc'), limit(14)));
  return snap.docs.map((d) => d.data()).reverse();
}

// ---------------------------------------------------------------------
//  Indicadores
// ---------------------------------------------------------------------
function summarizeRaw(rows, v, lim) {
  const values = rows.map((r) => r[v]).filter((x) => typeof x === 'number');
  const d = describe(values);
  const out = values.filter((x) => outOfRange(x, lim)).length;
  return { ...d, out, pct: values.length ? (100 * out) / values.length : null, slope: slopePerHour(rows.map((r) => ({ x: r.ts, y: r[v] }))), exact: true };
}

// A partir dos resumos por ciclo: media e desvio exatos (soma e soma dos quadrados); mediana aproximada.
function summarizeStats(rows, v) {
  const parts = rows.map((r) => r[v]).filter(Boolean);
  const n = parts.reduce((s, p) => s + p.count, 0);
  if (!n) return { count: 0, mean: null, median: null, stdDev: null, min: null, max: null, out: 0, pct: null, slope: null, exact: false };
  const sum = parts.reduce((s, p) => s + p.sum, 0);
  const sq = parts.reduce((s, p) => s + p.sumSquares, 0);
  const variance = n > 1 ? (sq - (sum * sum) / n) / (n - 1) : 0;
  const out = parts.reduce((s, p) => s + (p.belowMin ?? 0) + (p.aboveMax ?? 0), 0);
  return {
    count: n,
    mean: sum / n,
    median: median(parts.map((p) => p.median)),
    stdDev: Math.sqrt(Math.max(variance, 0)),
    min: Math.min(...parts.map((p) => p.min)),
    max: Math.max(...parts.map((p) => p.max)),
    out,
    pct: (100 * out) / n,
    slope: slopePerHour(rows.map((r) => ({ x: r.ts, y: r[v].mean }))),
    exact: false,
  };
}

function insights(rooms) {
  const lines = [];
  for (const r of rooms) {
    for (const v of VAR_KEYS) {
      const s = r.sum[v];
      if (!s.count) continue;
      const { label, unit } = VARS[v];
      if (s.pct > 0) lines.push(`${r.name}: ${label.toLowerCase()} fora da faixa em ${fmt(s.pct, 1)}% das leituras (${s.out} de ${s.count}).`);
      else lines.push(`${r.name}: ${label.toLowerCase()} dentro da faixa durante todo o período.`);
      if (s.slope != null && Math.abs(s.slope) >= 0.05) {
        lines.push(`${r.name}: tendência de ${s.slope > 0 ? 'alta' : 'queda'} da ${label.toLowerCase()} (${fmt(s.slope, 2)} ${unit}/h).`);
      }
      const spread = r.limits[v].max - r.limits[v].min;
      if (s.stdDev != null && s.stdDev > spread / 4) lines.push(`${r.name}: variação elevada da ${label.toLowerCase()} (desvio ${fmt(s.stdDev, 2)} ${unit}).`);
    }
  }
  if (rooms.length === 2) {
    for (const v of VAR_KEYS) {
      const [a, b] = rooms;
      if (a.sum[v].mean != null && b.sum[v].mean != null) {
        const diff = a.sum[v].mean - b.sum[v].mean;
        if (Math.abs(diff) >= 0.1) {
          lines.push(`Em média, ${diff > 0 ? a.name : b.name} tem ${VARS[v].label.toLowerCase()} ${fmt(Math.abs(diff), 1)} ${VARS[v].unit} maior que ${diff > 0 ? b.name : a.name}.`);
        }
      }
    }
  }
  return lines;
}

function occurrences(rooms, raw) {
  const rows = [];
  for (const r of rooms) {
    for (const x of r.rows) {
      if (raw) {
        for (const v of VAR_KEYS) {
          const dir = outOfRange(x[v], r.limits[v]);
          if (dir) rows.push({ ts: x.ts, room: r.name, text: `${VARS[v].label} ${dir === 'low' ? 'abaixo do mínimo' : 'acima do máximo'}: ${fmt(x[v], 1, VARS[v].unit)}` });
        }
      } else if (x.out > 0) {
        rows.push({ ts: x.ts, room: r.name, text: `${x.out} leitura(s) fora da faixa no ciclo (${x.count} no total)` });
      }
    }
  }
  return rows.sort((a, b) => b.ts - a.ts).slice(0, 30);
}

// ---------------------------------------------------------------------
//  Tela
// ---------------------------------------------------------------------
function statsTable(rooms) {
  const rowsHtml = rooms.flatMap((r) => VAR_KEYS.map((v) => {
    const s = r.sum[v];
    const { unit } = VARS[v];
    return `<tr>
      <th scope="row">${esc(r.name)}</th><td>${VARS[v].label}</td>
      <td>${fmt(s.mean, 2, unit)}</td><td>${fmt(s.median, 2, unit)}${s.exact ? '' : '*'}</td><td>${fmt(s.stdDev, 2, unit)}</td>
      <td>${fmt(s.min, 1, unit)}</td><td>${fmt(s.max, 1, unit)}</td>
      <td class="${s.out ? 'bad-text' : ''}">${s.count ? `${s.out} (${fmt(s.pct, 1)}%)` : '—'}</td>
      <td>${s.slope == null ? '—' : `${s.slope > 0 ? '+' : ''}${fmt(s.slope, 2)} ${unit}/h`}</td>
      <td>${s.count}</td></tr>`;
  })).join('');
  return `<div class="table-wrap"><table>
    <thead><tr><th>Sala</th><th>Variável</th><th>Média</th><th>Mediana</th><th>Desvio</th><th>Mín</th><th>Máx</th><th>Fora da faixa</th><th>Tendência</th><th>Leituras</th></tr></thead>
    <tbody>${rowsHtml}</tbody></table></div>`;
}

function dailyTable(daily) {
  const days = [...new Set(Object.values(daily).flatMap((d) => d.map((x) => x.date)))].sort().reverse();
  if (!days.length) return '<p class="muted">Sem acumulados diários ainda.</p>';
  const cell = (room, day) => {
    const d = daily[room.id].find((x) => x.date === day);
    if (!d) return '<td colspan="2" class="muted">—</td>';
    const bad = (d.temperature.belowMin ?? 0) + (d.temperature.aboveMax ?? 0) + (d.humidity.belowMin ?? 0) + (d.humidity.aboveMax ?? 0);
    return `<td>${fmt(d.temperature.mean, 1, '°C')} ± ${fmt(d.temperature.stdDev, 1)} · ${fmt(d.humidity.mean, 1, '%')} ± ${fmt(d.humidity.stdDev, 1)}</td><td class="${bad ? 'bad-text' : ''}">${bad}</td>`;
  };
  return `<div class="table-wrap"><table>
    <thead><tr><th rowspan="2">Dia</th>${ROOMS.map((r) => `<th colspan="2">${esc(r.name)}</th>`).join('')}</tr>
    <tr>${ROOMS.map(() => '<th>Média ± desvio (T · U)</th><th>Fora</th>').join('')}</tr></thead>
    <tbody>${days.map((day) => `<tr><th scope="row">${day.split('-').reverse().join('/')}</th>${ROOMS.map((r) => cell(r, day)).join('')}</tr>`).join('')}</tbody></table></div>`;
}

export function mountHistory(view, { store }) {
  view.innerHTML = `
    <section class="card toolbar">
      <label>Período
        <select id="period">${PERIODS.map((p) => `<option value="${p.id}"${p.id === '6h' ? ' selected' : ''}>${p.label}</option>`).join('')}</select>
      </label>
      <button class="btn primary" id="reload">Atualizar</button>
      <span id="status" class="muted small" aria-live="polite"></span>
    </section>
    <div id="out"></div>`;
  const out = view.querySelector('#out');
  const status = view.querySelector('#status');
  const periodEl = view.querySelector('#period');
  let charts = [];
  let seq = 0;

  const destroyCharts = () => { charts.forEach((c) => c.destroy()); charts = []; };

  async function load() {
    const my = ++seq;
    const period = PERIODS.find((p) => p.id === periodEl.value);
    const raw = period.ms <= RAW_MAX_MS;
    const since = Date.now() - period.ms;
    status.textContent = 'Carregando…';
    destroyCharts();
    try {
      const [data, dailyArr] = await Promise.all([
        Promise.all(ROOMS.map((r) => loadRoom(r.id, since, raw))),
        Promise.all(ROOMS.map((r) => loadDaily(r.id))),
      ]);
      if (my !== seq) return;
      const rooms = ROOMS.map((r, i) => {
        const live = store.state.rooms[r.id];
        const rows = data[i];
        return { ...r, name: live.name, limits: live.limits, rows, sum: Object.fromEntries(VAR_KEYS.map((v) => [v, raw ? summarizeRaw(rows, v, live.limits[v]) : summarizeStats(rows, v)])) };
      });
      const daily = Object.fromEntries(ROOMS.map((r, i) => [r.id, dailyArr[i]]));
      const total = rooms.reduce((s, r) => s + r.rows.length, 0);
      status.textContent = total ? `${raw ? 'Leituras brutas' : 'Resumos por ciclo (média de cada ciclo)'} · atualizado ${fmtDateTime(Date.now())}` : '';

      const tips = insights(rooms);
      const occ = occurrences(rooms, raw);
      out.innerHTML = total === 0
        ? '<section class="card"><p class="muted">Nenhum dado neste período. Confira se o Wokwi está rodando e se o cron do Flask está ativo.</p></section>'
        : `
        <section class="card"><h2>Temperatura</h2><div class="chart"><canvas id="h-temp"></canvas></div></section>
        <section class="card"><h2>Umidade</h2><div class="chart"><canvas id="h-hum"></canvas></div></section>
        <section class="card"><h2>Indicadores do período</h2>${statsTable(rooms)}
          ${raw ? '' : '<p class="muted small">* Mediana aproximada (mediana das medianas dos ciclos). Média e desvio são exatos.</p>'}</section>
        <section class="card"><h2>Análise</h2>${tips.length ? `<ul class="insights">${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="muted">Sem observações.</p>'}</section>
        <section class="card"><h2>Ocorrências fora da faixa</h2>${occ.length
          ? `<div class="table-wrap"><table><thead><tr><th>Quando</th><th>Sala</th><th>Ocorrência</th></tr></thead><tbody>${occ.map((o) => `<tr><td>${fmtDateTime(o.ts)}</td><td>${esc(o.room)}</td><td>${esc(o.text)}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted">Nenhuma ocorrência no período. ✔</p>'}</section>
        <section class="card"><h2>Acumulado por dia (últimos 14 dias)</h2>${dailyTable(daily)}</section>`;

      if (total) {
        const long = period.ms > 24 * HOUR;
        const make = (id, v, unit) => {
          const c = timeChart(out.querySelector(id), { unit, long });
          setSeries(c, rooms.map((r) => ({
            name: r.name,
            color: r.color,
            limit: r.limits[v],
            points: r.rows.map((x) => ({ x: x.ts, y: raw ? x[v] : x[v].mean })),
          })));
          charts.push(c);
        };
        make('#h-temp', 'temperature', '°C');
        make('#h-hum', 'humidity', '%');
      }
    } catch (e) {
      if (my !== seq) return;
      console.error(e);
      status.textContent = '';
      out.innerHTML = `<section class="card"><p class="error">Erro ao carregar o histórico: ${esc(e.message)}</p></section>`;
    }
  }

  view.querySelector('#reload').addEventListener('click', load);
  periodEl.addEventListener('change', load);
  load();
  return () => { seq++; destroyCharts(); };
}
