/** Shared canvas line-chart + results-table helpers for the browser benchmarks. */
export interface Point {
  threads: number;
  rowsPerSec: number;
}

export function addRow(
  tbody: HTMLElement,
  threads: number,
  rowsPerSec: number,
): void {
  const tr = document.createElement('tr');
  tr.innerHTML = `<td>${threads}</td><td>${(rowsPerSec / 1000).toFixed(0)}k</td>`;
  tbody.appendChild(tr);
}

export function drawChart(
  canvas: HTMLCanvasElement,
  points: Point[],
  title: string,
): void {
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const m = {l: 80, r: 24, t: 48, b: 56};
  const iw = W - m.l - m.r;
  const ih = H - m.t - m.b;
  const xMax = Math.max(...points.map(p => p.threads));
  const yMax = Math.max(...points.map(p => p.rowsPerSec), 1) * 1.1;
  const x = (t: number) => m.l + (t / xMax) * iw;
  const y = (v: number) => m.t + ih - (v / yMax) * ih;

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, W, H);
  ctx.font = '15px sans-serif';
  ctx.fillStyle = '#111';
  ctx.textAlign = 'center';
  ctx.fillText(title, W / 2, 24);

  ctx.font = '12px sans-serif';
  for (let i = 0; i <= 5; i++) {
    const v = (yMax / 5) * i;
    const yy = y(v);
    ctx.strokeStyle = '#eee';
    ctx.beginPath();
    ctx.moveTo(m.l, yy);
    ctx.lineTo(m.l + iw, yy);
    ctx.stroke();
    ctx.fillStyle = '#555';
    ctx.textAlign = 'right';
    ctx.fillText(`${(v / 1000).toFixed(0)}k`, m.l - 8, yy + 4);
  }

  ctx.strokeStyle = '#999';
  ctx.beginPath();
  ctx.moveTo(m.l, m.t);
  ctx.lineTo(m.l, m.t + ih);
  ctx.lineTo(m.l + iw, m.t + ih);
  ctx.stroke();

  ctx.fillStyle = '#333';
  ctx.textAlign = 'center';
  ctx.fillText('threads', m.l + iw / 2, H - 14);
  points.forEach(p =>
    ctx.fillText(String(p.threads), x(p.threads), m.t + ih + 20),
  );

  ctx.strokeStyle = '#2563eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(p.threads);
    const py = y(p.rowsPerSec);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.stroke();

  ctx.fillStyle = '#2563eb';
  points.forEach(p => {
    const px = x(p.threads);
    const py = y(p.rowsPerSec);
    ctx.beginPath();
    ctx.arc(px, py, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillText(`${(p.rowsPerSec / 1000).toFixed(0)}k`, px, py - 9);
  });
}
