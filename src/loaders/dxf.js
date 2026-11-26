// DXF reader (ASCII). Lines, polylines, arcs, circles, ellipses, splines, points,
// 3D faces, polyface meshes and block inserts (including dimension blocks).
// Returns plain arrays so it runs without three.js: { lines: {color: Float32Array},
// faces: {color: Float32Array}, points: Float32Array, skipped: {TYPE: n}, unitScale }.

const ACI = { 1: 0xff0000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff, 5: 0x0000ff, 6: 0xff00ff, 7: 0x1d232c, 8: 0x808080, 9: 0xc0c0c0, 250: 0x333333, 251: 0x505050, 252: 0x696969, 253: 0x828282, 254: 0xbebebe, 255: 0xffffff };
// $INSUNITS -> millimetres
const UNITS = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 14: 100 };

function tokenize(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i + 1 < lines.length; i += 2) out.push([parseInt(lines[i], 10), lines[i + 1].trim()]);
  return out;
}

// Groups the flat token list into entities: { type, codes: [[code, value], ...] }.
function entitiesOf(tokens, start, endName) {
  const list = [];
  let cur = null;
  let i = start;
  for (; i < tokens.length; i++) {
    const [c, v] = tokens[i];
    if (c === 0) {
      if (v === endName || v === 'ENDSEC' || v === 'EOF') break;
      cur = { type: v, codes: [] };
      list.push(cur);
    } else if (cur) cur.codes.push([c, v]);
  }
  return { list, end: i };
}

const num = (e, code, def = 0) => {
  const f = e.codes.find((x) => x[0] === code);
  return f ? parseFloat(f[1]) : def;
};
const str = (e, code, def = '') => {
  const f = e.codes.find((x) => x[0] === code);
  return f ? f[1] : def;
};
const all = (e, code) => e.codes.filter((x) => x[0] === code).map((x) => parseFloat(x[1]));

// Arbitrary axis algorithm: object coordinate system -> world.
function ocs(n) {
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const az = [n[0] / len, n[1] / len, n[2] / len];
  if (Math.abs(az[0] - 0) < 1e-12 && Math.abs(az[1]) < 1e-12 && az[2] > 0) return null; // identity
  const w = Math.abs(az[0]) < 1 / 64 && Math.abs(az[1]) < 1 / 64 ? [0, 1, 0] : [0, 0, 1];
  let ax = [w[1] * az[2] - w[2] * az[1], w[2] * az[0] - w[0] * az[2], w[0] * az[1] - w[1] * az[0]];
  const l = Math.hypot(...ax);
  ax = ax.map((v) => v / l);
  const ay = [az[1] * ax[2] - az[2] * ax[1], az[2] * ax[0] - az[0] * ax[2], az[0] * ax[1] - az[1] * ax[0]];
  return (p) => [0, 1, 2].map((k) => p[0] * ax[k] + p[1] * ay[k] + p[2] * az[k]);
}

const extrusion = (e) => ocs([num(e, 210, 0), num(e, 220, 0), num(e, 230, 1)]);

// Affine transform helpers (3x4 row-major [r00 r01 r02 tx; ...]).
const IDENT = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
function apply(m, p) {
  return [m[0] * p[0] + m[1] * p[1] + m[2] * p[2] + m[3], m[4] * p[0] + m[5] * p[1] + m[6] * p[2] + m[7], m[8] * p[0] + m[9] * p[1] + m[10] * p[2] + m[11]];
}
function compose(a, b) {
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + (c === 3 ? a[r * 4 + 3] : 0);
    }
  }
  return o;
}

function arcPoints(cx, cy, r, a0, a1, z = 0) {
  while (a1 <= a0) a1 += Math.PI * 2;
  const n = Math.max(4, Math.ceil(((a1 - a0) / (Math.PI * 2)) * 72));
  const pts = [];
  for (let k = 0; k <= n; k++) {
    const a = a0 + ((a1 - a0) * k) / n;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
  }
  return pts;
}

// Points along a polyline segment with a bulge (arc) between p and q.
function bulgeSegment(p, q, bulge) {
  if (!bulge) return [q];
  const ang = 4 * Math.atan(bulge);
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return [q];
  const r = chord / (2 * Math.sin(ang / 2));
  const mx = (p[0] + q[0]) / 2, my = (p[1] + q[1]) / 2;
  const h = r * Math.cos(ang / 2);
  const cx = mx - (dy / chord) * h, cy = my + (dx / chord) * h;
  const a0 = Math.atan2(p[1] - cy, p[0] - cx);
  const n = Math.max(2, Math.ceil((Math.abs(ang) / (Math.PI * 2)) * 72));
  const out = [];
  for (let k = 1; k <= n; k++) {
    const a = a0 + (ang * k) / n;
    out.push([cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a), p[2]]);
  }
  out[out.length - 1] = q;
  return out;
}

function nurbs(degree, knots, ctrl, weights, samples = 96) {
  const n = ctrl.length - 1;
  if (n < degree || knots.length !== ctrl.length + degree + 1) return ctrl;
  const lo = knots[degree], hi = knots[n + 1];
  const out = [];
  for (let s = 0; s <= samples; s++) {
    const u = Math.min(lo + ((hi - lo) * s) / samples, hi - 1e-12);
    let k = degree;
    while (k < n && u >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= degree; j++) {
      const w = weights[k - degree + j] ?? 1;
      const c = ctrl[k - degree + j];
      d.push([c[0] * w, c[1] * w, c[2] * w, w]);
    }
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den ? (u - knots[i]) / den : 0;
        for (let q = 0; q < 4; q++) d[j][q] = (1 - a) * d[j - 1][q] + a * d[j][q];
      }
    }
    const p = d[degree];
    out.push([p[0] / p[3], p[1] / p[3], p[2] / p[3]]);
  }
  return out;
}

export function parseDXF(text) {
  const tokens = tokenize(text);
  const layers = new Map();
  const blocks = new Map();
  let entities = [];
  let unitScale = 1;
  for (let i = 0; i < tokens.length; i++) {
    const [c, v] = tokens[i];
    if (c !== 0 || v !== 'SECTION') continue;
    const name = tokens[i + 1]?.[1];
    if (name === 'HEADER') {
      for (let j = i + 2; j < tokens.length && !(tokens[j][0] === 0 && tokens[j][1] === 'ENDSEC'); j++) {
        if (tokens[j][0] === 9 && tokens[j][1] === '$INSUNITS') unitScale = UNITS[parseInt(tokens[j + 1][1], 10)] || 1;
      }
    } else if (name === 'TABLES') {
      const { list } = entitiesOf(tokens, i + 2, 'ENDSEC');
      for (const e of list) if (e.type === 'LAYER') layers.set(str(e, 2), { color: Math.abs(num(e, 62, 7)), off: num(e, 62, 7) < 0 || (num(e, 70, 0) & 1) });
    } else if (name === 'BLOCKS') {
      const { list } = entitiesOf(tokens, i + 2, 'ENDSEC');
      let cur = null;
      for (const e of list) {
        if (e.type === 'BLOCK') { cur = { name: str(e, 2), base: [num(e, 10), num(e, 20), num(e, 30)], ents: [] }; blocks.set(cur.name, cur); }
        else if (e.type === 'ENDBLK') cur = null;
        else if (cur) cur.ents.push(e);
      }
    } else if (name === 'ENTITIES') {
      entities = entitiesOf(tokens, i + 2, 'ENDSEC').list;
    }
  }

  const lines = new Map(); // color -> number[]
  const faces = new Map();
  const points = [];
  const skipped = {};
  const colorOf = (e, inherited) => {
    let ci = num(e, 62, 256);
    const layer = layers.get(str(e, 8, '0'));
    if (ci === 256) ci = layer ? layer.color : 7;
    if (ci === 0) ci = inherited ?? 7;
    return ACI[ci] ?? ACI[7];
  };
  const push = (map, color, arr) => {
    if (!map.has(color)) map.set(color, []);
    map.get(color).push(...arr);
  };
  const polyline = (m, color, pts, closed) => {
    const w = pts.map((p) => apply(m, p));
    const out = [];
    for (let k = 0; k + 1 < w.length; k++) out.push(...w[k], ...w[k + 1]);
    if (closed && w.length > 2) out.push(...w[w.length - 1], ...w[0]);
    push(lines, color, out);
  };
  const face = (m, color, quad) => {
    const w = quad.map((p) => apply(m, p));
    const out = [...w[0], ...w[1], ...w[2]];
    if (w[3] && Math.hypot(w[3][0] - w[2][0], w[3][1] - w[2][1], w[3][2] - w[2][2]) > 1e-12) out.push(...w[0], ...w[2], ...w[3]);
    push(faces, color, out);
  };

  // Entity list -> geometry. POLYLINE spans several entities (VERTEX ... SEQEND).
  const walk = (list, m, inheritedColor, depth) => {
    if (depth > 16) return;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const layer = layers.get(str(e, 8, '0'));
      if (layer && layer.off) continue;
      const color = colorOf(e, inheritedColor);
      const o = extrusion(e);
      const toW = (p) => (o ? o(p) : p);
      switch (e.type) {
        case 'LINE':
          polyline(m, color, [[num(e, 10), num(e, 20), num(e, 30)], [num(e, 11), num(e, 21), num(e, 31)]], false);
          break;
        case 'POINT':
          points.push(...apply(m, [num(e, 10), num(e, 20), num(e, 30)]));
          break;
        case 'CIRCLE':
        case 'ARC': {
          const a0 = e.type === 'ARC' ? (num(e, 50) * Math.PI) / 180 : 0;
          const a1 = e.type === 'ARC' ? (num(e, 51) * Math.PI) / 180 : Math.PI * 2;
          polyline(m, color, arcPoints(num(e, 10), num(e, 20), num(e, 40), a0, a1, num(e, 30)).map(toW), false);
          break;
        }
        case 'ELLIPSE': {
          const c = [num(e, 10), num(e, 20), num(e, 30)], ma = [num(e, 11), num(e, 21), num(e, 31)], ratio = num(e, 40, 1);
          const n = [num(e, 210, 0), num(e, 220, 0), num(e, 230, 1)];
          const mi = [n[1] * ma[2] - n[2] * ma[1], n[2] * ma[0] - n[0] * ma[2], n[0] * ma[1] - n[1] * ma[0]].map((v) => v * ratio);
          let t0 = num(e, 41, 0), t1 = num(e, 42, Math.PI * 2);
          while (t1 <= t0) t1 += Math.PI * 2;
          const pts = [];
          for (let k = 0; k <= 96; k++) {
            const t = t0 + ((t1 - t0) * k) / 96;
            pts.push([0, 1, 2].map((q) => c[q] + ma[q] * Math.cos(t) + mi[q] * Math.sin(t)));
          }
          polyline(m, color, pts, false);
          break;
        }
        case 'LWPOLYLINE': {
          const xs = all(e, 10), ys = all(e, 20), z = num(e, 38, 0);
          const bulges = [];
          let vi = -1;
          for (const [c] of e.codes) {
            if (c === 10) { vi++; bulges[vi] = 0; }
          }
          vi = -1;
          for (const [c, v] of e.codes) {
            if (c === 10) vi++;
            else if (c === 42 && vi >= 0) bulges[vi] = parseFloat(v);
          }
          const closed = (num(e, 70, 0) & 1) === 1;
          const vs = xs.map((x, k) => [x, ys[k], z]);
          const pts = [vs[0]];
          const count = closed ? vs.length : vs.length - 1;
          for (let k = 0; k < count; k++) pts.push(...bulgeSegment(vs[k], vs[(k + 1) % vs.length], bulges[k]));
          if (vs.length) polyline(m, color, pts.map(toW), false);
          break;
        }
        case 'POLYLINE': {
          const flags = num(e, 70, 0);
          const verts = [];
          let j = i + 1;
          for (; j < list.length && list[j].type === 'VERTEX'; j++) verts.push(list[j]);
          if (list[j]?.type === 'SEQEND') i = j; else i = j - 1;
          if (flags & 64) {
            // Polyface mesh: position vertices, then face records with 1-based indices.
            const pos = verts.filter((v) => num(v, 70, 0) & 64).map((v) => [num(v, 10), num(v, 20), num(v, 30)]);
            for (const v of verts) {
              const f = num(v, 70, 0);
              if ((f & 128) && !(f & 64)) {
                const ids = [71, 72, 73, 74].map((c) => Math.abs(num(v, c, 0))).filter(Boolean);
                if (ids.length >= 3) face(m, color, ids.map((k) => pos[k - 1]).filter(Boolean));
              }
            }
          } else if (flags & 16) {
            const M = num(e, 71, 0), N = num(e, 72, 0);
            const pos = verts.map((v) => [num(v, 10), num(v, 20), num(v, 30)]);
            for (let a = 0; a + 1 < M; a++) for (let b = 0; b + 1 < N; b++) {
              face(m, color, [pos[a * N + b], pos[(a + 1) * N + b], pos[(a + 1) * N + b + 1], pos[a * N + b + 1]]);
            }
          } else {
            const is3d = (flags & 8) !== 0;
            const vs = verts.map((v) => [num(v, 10), num(v, 20), is3d ? num(v, 30) : num(e, 30, 0)]);
            const bul = verts.map((v) => num(v, 42, 0));
            const closed = (flags & 1) === 1;
            const pts = [vs[0]];
            const count = closed ? vs.length : vs.length - 1;
            for (let k = 0; k < count; k++) pts.push(...(is3d ? [vs[(k + 1) % vs.length]] : bulgeSegment(vs[k], vs[(k + 1) % vs.length], bul[k])));
            if (vs.length) polyline(m, color, is3d ? pts : pts.map(toW), false);
          }
          break;
        }
        case 'SPLINE': {
          const deg = num(e, 71, 3);
          const knots = all(e, 40);
          const ctrl = all(e, 10).map((x, k) => [x, all(e, 20)[k], all(e, 30)[k] || 0]);
          const weights = all(e, 41);
          const fit = all(e, 11).map((x, k) => [x, all(e, 21)[k], all(e, 31)[k] || 0]);
          const pts = ctrl.length > deg ? nurbs(deg, knots, ctrl, weights) : fit;
          if (pts.length > 1) polyline(m, color, pts, (num(e, 70, 0) & 1) === 1 && ctrl.length <= deg);
          break;
        }
        case '3DFACE':
          face(m, color, [[num(e, 10), num(e, 20), num(e, 30)], [num(e, 11), num(e, 21), num(e, 31)], [num(e, 12), num(e, 22), num(e, 32)], [num(e, 13), num(e, 23), num(e, 33)]]);
          break;
        case 'SOLID':
        case 'TRACE':
          face(m, color, [[num(e, 10), num(e, 20), num(e, 30)], [num(e, 11), num(e, 21), num(e, 31)], [num(e, 13), num(e, 23), num(e, 33)], [num(e, 12), num(e, 22), num(e, 32)]].map(toW));
          break;
        case 'INSERT':
        case 'DIMENSION': {
          const block = blocks.get(str(e, 2));
          if (!block) break;
          if (e.type === 'DIMENSION') { walk(block.ents, m, color, depth + 1); break; }
          const sx = num(e, 41, 1), sy = num(e, 42, 1), sz = num(e, 43, 1), rot = (num(e, 50, 0) * Math.PI) / 180;
          const cols = Math.max(1, num(e, 70, 1)), rows = Math.max(1, num(e, 71, 1)), dc = num(e, 44, 0), dr = num(e, 45, 0);
          const c = Math.cos(rot), s = Math.sin(rot);
          for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
            const ins = [num(e, 10) + (c * dc * k - s * dr * r), num(e, 20) + (s * dc * k + c * dr * r), num(e, 30)];
            // world <- OCS(insert) <- rotate/scale <- shift by -base
            let local = [c * sx, -s * sy, 0, 0, s * sx, c * sy, 0, 0, 0, 0, sz, 0];
            local = compose(local, [1, 0, 0, -block.base[0], 0, 1, 0, -block.base[1], 0, 0, 1, -block.base[2]]);
            local = compose([1, 0, 0, ins[0], 0, 1, 0, ins[1], 0, 0, 1, ins[2]], local);
            if (o) {
              const ex = o([1, 0, 0]), ey = o([0, 1, 0]), ez = o([0, 0, 1]);
              local = compose([ex[0], ey[0], ez[0], 0, ex[1], ey[1], ez[1], 0, ex[2], ey[2], ez[2], 0], local);
            }
            walk(block.ents, compose(m, local), color, depth + 1);
          }
          break;
        }
        case 'VERTEX':
        case 'SEQEND':
        case 'ATTRIB':
        case 'ATTDEF':
          break;
        default:
          skipped[e.type] = (skipped[e.type] || 0) + 1;
      }
    }
  };
  walk(entities, IDENT, undefined, 0);

  const scale = (arr) => Float32Array.from(arr, (v) => v * unitScale);
  return {
    lines: new Map([...lines].map(([c, a]) => [c, scale(a)])),
    faces: new Map([...faces].map(([c, a]) => [c, scale(a)])),
    points: scale(points),
    skipped,
    unitScale,
    entityCount: entities.length,
  };
}
