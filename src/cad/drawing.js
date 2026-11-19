// 2D technical drawing sheet (like FreeCAD's TechDraw): third-angle views, overall
// dimensions and a title block, exported as SVG, DXF or printed to PDF.

export const SHEETS = { A4: [297, 210], A3: [420, 297], A2: [594, 420] };
const SCALES = [10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500];
const MARGIN = 10;
const TITLE_H = 36;
const FONT = '"Segoe UI","Yu Gothic UI","Microsoft YaHei UI",Arial,sans-serif';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f2 = (v) => +v.toFixed(2);
export const scaleLabel = (s) => (s >= 1 ? `${s}:1` : `1:${Math.round(1 / s)}`);

// Places the views on the sheet. Everything is in sheet millimetres.
export function layout(views, size) {
  const [W, H] = SHEETS[size];
  const { front, top, right } = views;
  const gap = 24; // room for dimensions between views
  const availW = W - 2 * MARGIN - 3 * gap;
  const availH = H - 2 * MARGIN - TITLE_H - 3 * gap;
  // Keep the right-hand column free for the isometric view as well.
  const needW = front.box[2] + right.box[2];
  const needH = front.box[3] + top.box[3];
  const scale = SCALES.find((s) => needW * s <= availW && needH * s <= availH) ?? SCALES[SCALES.length - 1];

  const x0 = MARGIN + gap;
  const fw = front.box[2] * scale, fh = front.box[3] * scale, th = top.box[3] * scale, rw = right.box[2] * scale;
  const free = H - 2 * MARGIN - TITLE_H - fh - th;
  const yTop = MARGIN + Math.max(6, free / 3);
  const yFront = yTop + th + Math.max(gap, free / 3);
  const xRight = x0 + fw + gap;

  const place = (v, x, y, s) => ({ ...v, x, y, s, w: v.box[2] * s, h: v.box[3] * s });
  const out = {
    W, H, scale,
    front: place(front, x0, yFront, scale),
    top: place(top, x0, yTop, scale),
    right: place(right, xRight, yFront, scale),
  };
  // Isometric: top-right quadrant, shrunk if necessary.
  const iso = views.iso;
  const isoX = xRight, isoW = W - MARGIN - 6 - isoX, isoH = yFront - gap - MARGIN - 4;
  const isoS = Math.min(scale, isoW / iso.box[2], isoH / iso.box[3]);
  out.iso = place(iso, isoX + (isoW - iso.box[2] * isoS) / 2, MARGIN + 4 + (isoH - iso.box[3] * isoS) / 2, isoS);
  out.rw = rw;
  return out;
}

function viewGroup(v) {
  const tx = f2(v.x - v.box[0] * v.s), ty = f2(v.y - v.box[1] * v.s);
  const sw = (mm) => f2(mm / v.s * 1000) / 1000;
  const hidden = v.hidden.map((d) => `<path d="${d}"/>`).join('');
  const visible = v.visible.map((d) => `<path d="${d}"/>`).join('');
  return `<g transform="translate(${tx} ${ty}) scale(${v.s})" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<g stroke="#8a8f98" stroke-width="${sw(0.13)}" stroke-dasharray="${sw(1.5)} ${sw(0.9)}">${hidden}</g>` +
    `<g stroke="#111" stroke-width="${sw(0.35)}">${visible}</g></g>`;
}

function arrow(x, y, angle) {
  const a = (angle * Math.PI) / 180, l = 2.4, w = 0.5;
  const px = Math.cos(a), py = Math.sin(a);
  const pts = [[x, y], [x - l * px - w * py, y - l * py + w * px], [x - l * px + w * py, y - l * py - w * px]];
  return `<polygon fill="#111" points="${pts.map((p) => p.map(f2).join(',')).join(' ')}"/>`;
}

function hDim(x1, x2, yFrom, y, value) {
  const mid = (x1 + x2) / 2;
  return `<path d="M${f2(x1)} ${f2(yFrom)}V${f2(y + 1)}M${f2(x2)} ${f2(yFrom)}V${f2(y + 1)}M${f2(x1)} ${f2(y)}H${f2(x2)}"/>` +
    arrow(x1, y, 180) + arrow(x2, y, 0) +
    `<text x="${f2(mid)}" y="${f2(y - 1)}" text-anchor="middle" stroke="none" fill="#111">${value}</text>`;
}

function vDim(y1, y2, xFrom, x, value) {
  const mid = (y1 + y2) / 2;
  return `<path d="M${f2(xFrom)} ${f2(y1)}H${f2(x - 1)}M${f2(xFrom)} ${f2(y2)}H${f2(x - 1)}M${f2(x)} ${f2(y1)}V${f2(y2)}"/>` +
    arrow(x, y1, 270) + arrow(x, y2, 90) +
    `<text transform="translate(${f2(x - 1)} ${f2(mid)}) rotate(-90)" text-anchor="middle" stroke="none" fill="#111">${value}</text>`;
}

function titleBlock(L, info, labels) {
  const w = 170, x = L.W - MARGIN - w, y = L.H - MARGIN - TITLE_H;
  const c1 = x + 100, c2 = x + 135, r1 = y + 14, r2 = y + 25;
  const cell = (cx, cy, label, value, size = 3.2) =>
    `<text x="${cx + 1.5}" y="${cy + 3}" font-size="1.9" fill="#555">${esc(label)}</text>` +
    `<text x="${cx + 1.5}" y="${cy + 8.4}" font-size="${size}" fill="#111">${esc(value)}</text>`;
  return `<g font-family='${FONT}'>` +
    `<rect x="${x}" y="${y}" width="${w}" height="${TITLE_H}" fill="#fff" stroke="#111" stroke-width="0.35"/>` +
    `<path d="M${x} ${r1}H${x + w}M${x} ${r2}H${x + w}M${c1} ${r1}V${y + TITLE_H}M${c2} ${r1}V${y + TITLE_H}" stroke="#111" stroke-width="0.2" fill="none"/>` +
    `<text x="${x + 3}" y="${y + 6}" font-size="1.9" fill="#555">${esc(labels.title)}</text>` +
    `<text x="${x + 3}" y="${y + 11.6}" font-size="5" font-weight="600" fill="#111">${esc(info.name)}</text>` +
    cell(x, r1, labels.scale, scaleLabel(L.scale)) + cell(c1, r1, labels.sheet, info.size) + cell(c2, r1, labels.units, 'mm') +
    cell(x, r2, labels.mass, info.mass || '–') + cell(c1, r2, labels.date, info.date) + cell(c2, r2, labels.projection, labels.third, 2.6) +
    `</g>`;
}

export function buildSheet(views, info, labels) {
  const L = layout(views, info.size);
  const { W, H, front: F, top: T, right: Rt, iso: I } = L;
  const dim = (v) => +(v).toFixed(2);
  const dims = `<g font-family='${FONT}' font-size="3" stroke="#111" stroke-width="0.13" fill="none">` +
    hDim(F.x, F.x + F.w, F.y + F.h + 1, F.y + F.h + 9, dim(F.box[2])) +
    vDim(F.y, F.y + F.h, F.x - 1, F.x - 9, dim(F.box[3])) +
    vDim(T.y, T.y + T.h, T.x - 1, T.x - 9, dim(T.box[3])) +
    `</g>`;
  const border = `<rect x="${MARGIN}" y="${MARGIN}" width="${W - 2 * MARGIN}" height="${H - 2 * MARGIN}" fill="none" stroke="#111" stroke-width="0.5"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#fff"/>${border}` +
    viewGroup(T) + viewGroup(F) + viewGroup(Rt) + viewGroup(I) + dims + titleBlock(L, info, labels) + `</svg>`;
}

// ---- DXF (views at true size; hidden lines on their own layer) ----------------------------------

const NS = 'http://www.w3.org/2000/svg';

// Flattens an SVG path string into polylines. Straight segments stay exact.
export function flatten(d) {
  const tokens = d.match(/[MLHVCSQTAZmlhvcsqtaz]|-?\d*\.?\d+(?:[eE][-+]?\d+)?/g) || [];
  const counts = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
  const lines = [];
  let cur = [0, 0], start = [0, 0], line = null, i = 0, cmd = null;
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) cmd = tokens[i++];
    const C = cmd.toUpperCase();
    const a = tokens.slice(i, i + counts[C]).map(Number);
    i += counts[C];
    if (C === 'M') { cur = a; start = a; line = [a]; lines.push(line); cmd = 'L'; }
    else if (C === 'L') { cur = a; line.push(a); }
    else if (C === 'H') { cur = [a[0], cur[1]]; line.push(cur); }
    else if (C === 'V') { cur = [cur[0], a[0]]; line.push(cur); }
    else if (C === 'Z') { line.push(start); cur = start; }
    else {
      const p = document.createElementNS(NS, 'path');
      p.setAttribute('d', `M${cur[0]} ${cur[1]}${C}${a.join(' ')}`);
      const len = p.getTotalLength();
      const n = Math.max(8, Math.min(64, Math.ceil(len)));
      for (let k = 1; k <= n; k++) { const q = p.getPointAtLength((len * k) / n); line.push([q.x, q.y]); }
      cur = a.slice(-2);
    }
  }
  return lines;
}

export function buildDXF(views) {
  const gap = Math.max(views.front.box[2], views.front.box[3], views.top.box[3]) * 0.3 + 10;
  const place = {
    front: [0, 0],
    top: [0, views.front.box[3] / 2 + views.top.box[3] / 2 + gap],
    right: [views.front.box[2] / 2 + views.right.box[2] / 2 + gap, 0],
  };
  const out = ['0', 'SECTION', '2', 'TABLES', '0', 'TABLE', '2', 'LAYER', '70', '2',
    '0', 'LAYER', '2', 'VISIBLE', '70', '0', '62', '7', '6', 'CONTINUOUS',
    '0', 'LAYER', '2', 'HIDDEN', '70', '0', '62', '8', '6', 'CONTINUOUS',
    '0', 'ENDTAB', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  let count = 0;
  const emit = (layer, a, b) => {
    out.push('0', 'LINE', '8', layer, '10', a[0].toFixed(4), '20', a[1].toFixed(4), '30', '0', '11', b[0].toFixed(4), '21', b[1].toFixed(4), '31', '0');
    count++;
  };
  for (const [name, [ox, oy]] of Object.entries(place)) {
    const v = views[name];
    const cx = v.box[0] + v.box[2] / 2, cy = v.box[1] + v.box[3] / 2;
    // SVG y points down, DXF y points up.
    const map = (p) => [p[0] - cx + ox, -(p[1] - cy) + oy];
    for (const [layer, paths] of [['VISIBLE', v.visible], ['HIDDEN', v.hidden]]) {
      for (const d of paths) {
        for (const l of flatten(d)) for (let i = 0; i + 1 < l.length; i++) emit(layer, map(l[i]), map(l[i + 1]));
      }
    }
  }
  out.push('0', 'ENDSEC', '0', 'EOF');
  return { text: out.join('\r\n') + '\r\n', count };
}
