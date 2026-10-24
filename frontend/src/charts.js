import { Chart, LineController, LineElement, PointElement, LinearScale, Tooltip, Legend, Filler } from 'chart.js';
import { fmtTime, fmtDateTime } from './stats.js';

Chart.register(LineController, LineElement, PointElement, LinearScale, Tooltip, Legend, Filler);

// Grafico de linhas com eixo X em milissegundos (sem adaptador de datas).
export function timeChart(canvas, { unit, long = false } = {}) {
  const fmtTick = long ? fmtDateTime : fmtTime;
  return new Chart(canvas, {
    type: 'line',
    data: { datasets: [] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, filter: (i) => !i.text.startsWith('_') } },
        tooltip: {
          callbacks: {
            title: (items) => fmtDateTime(items[0].parsed.x),
            label: (c) => `${c.dataset.label}: ${c.parsed.y.toFixed(1).replace('.', ',')} ${unit}`,
          },
          filter: (item) => !item.dataset.label.startsWith('_'),
        },
      },
      scales: {
        x: { type: 'linear', ticks: { maxTicksLimit: 6, callback: (v) => fmtTick(v) }, grid: { display: false } },
        y: { title: { display: true, text: unit }, grace: '10%' },
      },
    },
  });
}

// Linhas de dados + limites (tracejadas, mesma cor) por sala.
export function setSeries(chart, rooms) {
  const sets = [];
  for (const r of rooms) {
    sets.push({
      label: r.name,
      data: r.points,
      borderColor: r.color,
      backgroundColor: r.color,
      borderWidth: 2,
      pointRadius: r.points.length > 80 ? 0 : 2,
      tension: 0.25,
    });
    if (r.limit && r.points.length) {
      const x0 = r.points[0].x;
      const x1 = r.points[r.points.length - 1].x;
      for (const [k, v] of [['min', r.limit.min], ['max', r.limit.max]]) {
        sets.push({
          label: `_${r.name} ${k}`,
          data: [{ x: x0, y: v }, { x: x1, y: v }],
          borderColor: r.color + '88',
          borderDash: [6, 4],
          borderWidth: 1,
          pointRadius: 0,
          fill: false,
        });
      }
    }
  }
  chart.data.datasets = sets;
  chart.update('none');
}
