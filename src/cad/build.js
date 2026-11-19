// Feature-history evaluation on top of replicad / OpenCascade.
// Runs inside the kernel worker (and in Node for tests). No DOM, no three.js.
//
// A part is an ordered list of features. Each feature takes the shape produced so far and
// returns a new one. References to faces and edges are stored as 3D points and re-resolved
// on every rebuild, so they survive upstream parameter changes as long as the geometry
// does not move too far.

let R = null;
export function setKernel(replicad) { R = replicad; }

const DEG = Math.PI / 180;

function kerr(key, vars) {
  return Object.assign(new Error(key), { i18n: key, vars });
}

// ---- planes -----------------------------------------------------------------------------------

const STD_PLANES = {
  XY: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
  XZ: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] },
};

export function planeDef(p) {
  if (!p) return STD_PLANES.XY;
  if (typeof p === 'string') return STD_PLANES[p] || STD_PLANES.XY;
  return p;
}

function makePlane(def, offset = 0) {
  const d = planeDef(def);
  const n = d.normal;
  const o = [d.origin[0] + n[0] * offset, d.origin[1] + n[1] * offset, d.origin[2] + n[2] * offset];
  return new R.Plane(o, d.xDir, d.normal);
}

// ---- sketches -----------------------------------------------------------------------------------

function shapeDrawing(s) {
  switch (s.type) {
    case 'rect': {
      const w = Math.abs(s.w), h = Math.abs(s.h);
      if (!(w > 0 && h > 0)) throw kerr('k.badSize');
      const r = Math.min(Math.max(0, s.r || 0), w / 2 - 1e-6, h / 2 - 1e-6);
      let d = r > 0 ? R.drawRoundedRectangle(w, h, r) : R.drawRectangle(w, h);
      if (s.angle) d = d.rotate(s.angle);
      return d.translate(s.cx || 0, s.cy || 0);
    }
    case 'circle':
      if (!(s.r > 0)) throw kerr('k.badSize');
      return R.drawCircle(s.r).translate(s.cx || 0, s.cy || 0);
    case 'polygon': {
      const n = Math.round(s.n || 6);
      if (!(s.r > 0) || n < 3) throw kerr('k.badSize');
      let d = R.drawPolysides(s.r, n);
      if (s.angle) d = d.rotate(s.angle);
      return d.translate(s.cx || 0, s.cy || 0);
    }
    case 'slot': {
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len = Math.hypot(dx, dy);
      if (!(s.r > 0)) throw kerr('k.badSize');
      if (len < 1e-9) return R.drawCircle(s.r).translate(s.x1, s.y1);
      return R.drawRoundedRectangle(len + 2 * s.r, 2 * s.r, s.r - 1e-6)
        .rotate((Math.atan2(dy, dx) * 180) / Math.PI)
        .translate((s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2);
    }
    case 'polyline': {
      const pts = (s.pts || []).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
      if (pts.length < 3) throw kerr('k.polyline');
      let pen = R.draw(pts[0]);
      for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
      return pen.close();
    }
    default:
      throw kerr('k.unknownShape', { type: s.type });
  }
}

// Shapes marked as holes are cut from the union of the others.
function sketchDrawing(sketch) {
  const shapes = sketch?.shapes || [];
  if (!shapes.length) throw kerr('k.emptySketch');
  let solid = null;
  const holes = [];
  for (const s of shapes) {
    const d = shapeDrawing(s);
    if (s.hole) holes.push(d);
    else solid = solid ? solid.fuse(d) : d;
  }
  if (!solid) throw kerr('k.onlyHoles');
  for (const h of holes) solid = solid.cut(h);
  return solid;
}

// ---- reference resolution -----------------------------------------------------------------------

// Finds the element a stored point refers to.
// 1. An element passing (almost) through the point: the geometry has not moved.
// 2. Otherwise, after an upstream change, the clearly nearest element of the same type and
//    direction, within a quarter of the part size. "Clearly" = less than half as far as the
//    runner-up, so an ambiguous match fails instead of picking the wrong element.
function nearest(list, ref, diag) {
  const v = R.makeVertex(ref.p);
  const scored = [];
  for (const el of list) {
    if (ref.type && el.geomType !== ref.type) continue;
    if (ref.dir && !sameDirection(el, ref.dir)) continue;
    scored.push([R.measureDistanceBetween(v, el), el]);
  }
  v.delete?.();
  scored.sort((a, b) => a[0] - b[0]);
  if (!scored.length) return null;
  const [d1, best] = scored[0];
  if (d1 <= Math.max(0.05, diag * 0.002)) return best;
  const d2 = scored.length > 1 ? scored[1][0] : Infinity;
  if (d1 <= diag * 0.25 && d1 < d2 * 0.5) return best;
  return null;
}

// Straight edges: direction of the line. Planar faces: normal.
function directionOf(el) {
  try {
    if (el.geomType === 'LINE') return vec(el.tangentAt(0.5));
    if (el.geomType === 'PLANE') return vec(el.normalAt());
  } catch { /* ignore */ }
  return null;
}

function sameDirection(el, dir) {
  const d = directionOf(el);
  if (!d) return true;
  const dot = d[0] * dir[0] + d[1] * dir[1] + d[2] * dir[2];
  return Math.abs(dot) > 0.99;
}

function diagonal(shape) {
  const [a, b] = shape.boundingBox.bounds;
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function resolveRefs(list, refs, diag, lostKey, needKey) {
  const out = [];
  for (const r of refs || []) {
    const el = nearest(list, r, diag);
    if (!el) throw kerr(lostKey);
    if (!out.includes(el)) out.push(el);
  }
  if (!out.length) throw kerr(needKey);
  return out;
}

const resolveEdges = (shape, refs) => resolveRefs(shape.edges, refs, diagonal(shape), 'k.lostEdge', 'k.needEdges');
const resolveFaces = (shape, refs) => resolveRefs(shape.faces, refs, diagonal(shape), 'k.lostFace', 'k.needFaces');

// ---- tools -----------------------------------------------------------------------------------

const AXES = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };
function axisVec(a) {
  if (Array.isArray(a)) return a;
  return AXES[a] || AXES.Z;
}

function primitiveTool(f) {
  const p = f.pos || [0, 0, 0];
  switch (f.type) {
    case 'box': {
      if (!(f.w > 0 && f.d > 0 && f.h > 0)) throw kerr('k.badSize');
      return R.makeBox(p, [p[0] + f.w, p[1] + f.d, p[2] + f.h]);
    }
    case 'cylinder':
      if (!(f.r > 0 && f.h > 0)) throw kerr('k.badSize');
      return R.makeCylinder(f.r, f.h, p, axisVec(f.axis));
    case 'sphere':
      if (!(f.r > 0)) throw kerr('k.badSize');
      return R.makeSphere(f.r).translate(p);
    case 'cone': {
      if (!(f.r1 >= 0 && f.r2 >= 0 && f.r1 + f.r2 > 0 && f.h > 0)) throw kerr('k.badSize');
      // Revolve the half profile around the local Z axis, then orient it.
      const prof = R.draw([0, 0]).hLineTo(f.r1).lineTo([f.r2, f.h]).hLineTo(0).close();
      let s = prof.sketchOnPlane('XZ').revolve([0, 0, 1]);
      s = orientZ(s, axisVec(f.axis));
      return s.translate(p);
    }
    case 'torus': {
      if (!(f.R > 0 && f.r > 0 && f.r < f.R)) throw kerr('k.badSize');
      let s = R.drawCircle(f.r).translate(f.R, 0).sketchOnPlane('XZ').revolve([0, 0, 1]);
      s = orientZ(s, axisVec(f.axis));
      return s.translate(p);
    }
    default:
      return null;
  }
}

// Rotate a shape built along +Z so that +Z points along `dir`.
function orientZ(shape, dir) {
  const [x, y, z] = dir;
  const len = Math.hypot(x, y, z) || 1;
  const nz = z / len;
  if (nz > 1 - 1e-9) return shape;
  if (nz < -1 + 1e-9) return shape.rotate(180, [0, 0, 0], [1, 0, 0]);
  const axis = [-y / len, x / len, 0]; // Z × dir
  return shape.rotate(Math.acos(nz) / DEG, [0, 0, 0], axis);
}

function sketchTool(f, current) {
  const drawing = sketchDrawing(f.sketch);
  const def = planeDef(f.sketch.plane);
  const off = f.sketch.offset || 0;
  if (f.type === 'revolve') {
    const plane = makePlane(def, off);
    const axisLocal = f.axis === 'V' ? plane.yDir : plane.xDir;
    const axis = [axisLocal.x, axisLocal.y, axisLocal.z];
    const origin = [plane.origin.x, plane.origin.y, plane.origin.z];
    const ang = Math.max(0.1, Math.min(360, f.angle ?? 360));
    return drawing.sketchOnPlane(plane).revolve(axis, { origin, angle: ang });
  }
  // extrude
  let dist = f.distance;
  let start = off;
  if (f.through && current) {
    const [a, b] = current.boundingBox.bounds;
    dist = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * 2 + 1;
    start = off - dist / 2;
  } else {
    if (!(Math.abs(dist) > 0)) throw kerr('k.badSize');
    if (f.reverse) dist = -dist;
    if (f.symmetric) { start = off - dist / 2; }
  }
  if (dist < 0) { start += dist; dist = -dist; }
  return drawing.sketchOnPlane(makePlane(def, start)).extrude(dist);
}

// Loft from a one-shape sketch to a second profile further along the sketch normal.
function loftTool(f) {
  const shapes = f.sketch?.shapes || [];
  if (!shapes.length) throw kerr('k.emptySketch');
  if (shapes.length > 1 || shapes[0].hole) throw kerr('k.oneProfile');
  if (!f.distance) throw kerr('k.badSize');
  const def = planeDef(f.sketch.plane);
  const off = f.sketch.offset || 0;
  const end = shapeDrawing({ type: f.endType, cx: f.endU || 0, cy: f.endV || 0, w: f.endW, h: f.endH, r: f.endR, n: f.endN });
  const a = shapeDrawing(shapes[0]).sketchOnPlane(makePlane(def, off));
  const b = end.sketchOnPlane(makePlane(def, off + f.distance));
  return a.loftWith(b, { ruled: !!f.ruled });
}

// Sweep a circle or rectangle along a helix or a 3D polyline.
function sweepTool(f) {
  if (!(f.pw > 0) || (f.profile === 'rect' && !(f.ph > 0))) throw kerr('k.badSize');
  let spine;
  if (f.path === 'polyline') {
    const pts = parsePoints3(f.pts);
    if (pts.length < 2) throw kerr('k.pathPoints');
    const edges = [];
    for (let i = 0; i + 1 < pts.length; i++) edges.push(R.makeLine(pts[i], pts[i + 1]));
    spine = R.assembleWire(edges);
  } else {
    if (!(f.pitch > 0 && f.height > 0 && f.helixR > 0)) throw kerr('k.badSize');
    spine = R.makeHelix(f.pitch, f.height, f.helixR, f.pos || [0, 0, 0], axisVec(f.axis), !!f.lefthand);
  }
  const drawing = f.profile === 'rect' ? R.drawRectangle(f.pw, f.ph) : R.drawCircle(f.pw / 2);
  const profile = drawing.sketchOnPlane(new R.Plane(spine.startPoint, null, spine.tangentAt(0)));
  return R.genericSweep(profile.wire, spine, f.path === 'polyline' ? { transitionMode: 'right' } : { frenet: true });
}

export function parsePoints3(text) {
  return String(text || '').split(/[;\n]+/)
    .map((p) => p.split(',').map((v) => parseFloat(v)))
    .filter((p) => p.length === 3 && p.every(Number.isFinite));
}

// Spur gear with involute flanks, built like FreeCAD's involute gear generator.
function gearTool(f) {
  const z = Math.round(f.teeth), m = f.module;
  if (z < 6 || !(m > 0) || !(f.thickness > 0)) throw kerr('k.gear');
  const alpha = ((f.pressure ?? 20) * Math.PI) / 180;
  const rp = (m * z) / 2, rb = rp * Math.cos(alpha), ra = rp + m, rf = Math.max(rp - 1.25 * m, m * 0.5);
  if (f.bore > 0 && f.bore / 2 >= rf) throw kerr('k.gear');
  const inv = (r) => { const c = Math.acos(Math.min(1, rb / r)); return Math.tan(c) - c; };
  const half = Math.PI / (2 * z) + inv(rp);
  const pts = [];
  const polar = (r, a) => [r * Math.cos(a), r * Math.sin(a)];
  const start = Math.max(rb, rf);
  for (let i = 0; i < z; i++) {
    const c = (2 * Math.PI * i) / z;
    const flank = [];
    for (let k = 0; k <= 6; k++) flank.push(start + ((ra - start) * k) / 6);
    if (rf < start) pts.push(polar(rf, c - half));
    for (const r of flank) pts.push(polar(r, c - half + inv(r)));
    for (const r of flank.slice().reverse()) pts.push(polar(r, c + half - inv(r)));
    if (rf < start) pts.push(polar(rf, c + half));
  }
  let pen = R.draw(pts[0]);
  for (let i = 1; i < pts.length; i++) pen = pen.lineTo(pts[i]);
  let shape = pen.close().sketchOnPlane('XY').extrude(f.thickness);
  if (f.bore > 0) shape = shape.cut(R.makeCylinder(f.bore / 2, f.thickness + 2, [0, 0, -1]));
  return orientZ(shape, axisVec(f.axis)).translate(f.pos || [0, 0, 0]);
}

function holeTool(f, current) {
  const n = f.normal || [0, 0, 1];
  const len = Math.hypot(n[0], n[1], n[2]) || 1;
  const into = [-n[0] / len, -n[1] / len, -n[2] / len];
  if (!(f.diameter > 0)) throw kerr('k.badSize');
  let depth = f.depth;
  if (f.through) {
    const [a, b] = current.boundingBox.bounds;
    depth = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * 2 + 1;
  }
  if (!(depth > 0)) throw kerr('k.badSize');
  // Start slightly above the face so the cut is clean.
  const lift = 0.01;
  const p = [f.p[0] - into[0] * lift, f.p[1] - into[1] * lift, f.p[2] - into[2] * lift];
  let tool = R.makeCylinder(f.diameter / 2, depth + lift, p, into);
  if (f.cbDiameter > f.diameter && f.cbDepth > 0) {
    tool = tool.fuse(R.makeCylinder(f.cbDiameter / 2, f.cbDepth + lift, p, into));
  }
  return tool;
}

// Exact bodies are OpenCascade shapes; mesh bodies are Manifold MeshShapes. When the two
// meet, the exact one is tessellated so the boolean can run on meshes.
export const isMesh = (s) => !!s && s instanceof R.MeshShape;

function tessellation(shape) {
  const [a, b] = shape.boundingBox.bounds;
  const diag = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
  return { tolerance: Math.max(diag * 0.0005, 0.005), angularTolerance: 0.2 };
}

function asMesh(shape) {
  return isMesh(shape) ? shape : shape.meshShape(tessellation(shape));
}

function applyOp(current, tool, op) {
  if (!current) {
    if (op === 'cut' || op === 'intersect') throw kerr('k.nothingToCut');
    return tool;
  }
  if (isMesh(current) || isMesh(tool)) {
    current = asMesh(current);
    tool = asMesh(tool);
  }
  let out;
  if (op === 'cut') out = current.cut(tool);
  else if (op === 'intersect') out = current.intersect(tool);
  else out = current.fuse(tool);
  if (isMesh(out) && out.isEmpty) throw kerr('k.cutAll');
  return out;
}

function needExact(current) {
  if (!current) throw kerr('k.noBody');
  if (isMesh(current)) throw kerr('k.needExact');
}

function transformTool(tool, t) {
  let s = tool.clone();
  if (t.rotate) s = s.rotate(t.rotate.angle, t.rotate.origin, t.rotate.axis);
  if (t.translate) s = s.translate(t.translate);
  return s;
}

// ---- evaluation -----------------------------------------------------------------------------------

// sources: Map(id -> replicad shape) for imported bases.
// Returns { shape, tools, status[] } where status[i] = null | error.
export function evaluate(features, sources, cache = null) {
  const status = [];
  const tools = []; // tool shape per feature (for patterns)
  let current = null;
  let start = 0;

  // Reuse the cached state for an unchanged prefix of the history.
  if (cache && cache.keys) {
    while (start < features.length && start < cache.keys.length && cache.keys[start] === JSON.stringify(features[start])) start++;
    if (start > 0) {
      current = cache.shapes[start - 1];
      for (let i = 0; i < start; i++) { status.push(cache.status[i]); tools.push(cache.tools[i]); }
    }
  }
  const keys = features.map((f) => JSON.stringify(f));
  const shapes = cache ? cache.shapes.slice(0, start) : [];

  for (let i = start; i < features.length; i++) {
    const f = features[i];
    let tool = null;
    try {
      if (f.suppressed) {
        status.push(null);
      } else {
        current = applyFeature(f, current, sources, tools, features);
        tool = tools[i] ?? null;
        status.push(null);
      }
    } catch (err) {
      status.push(err);
    }
    if (tools.length <= i) tools.push(tool);
    shapes.push(current);
  }
  return { shape: current, status, cache: { keys, shapes, tools, status } };
}

function applyFeature(f, current, sources, tools, features) {
  const idx = tools.length;
  switch (f.type) {
    case 'import': {
      const src = sources.get(f.source);
      if (!src) throw kerr('k.noSource');
      tools[idx] = src;
      return applyOp(current, src.clone(), current ? f.op || 'add' : 'add');
    }
    case 'box':
    case 'cylinder':
    case 'sphere':
    case 'cone':
    case 'torus': {
      const tool = primitiveTool(f);
      tools[idx] = tool;
      return applyOp(current, tool.clone(), f.op || 'add');
    }
    case 'extrude':
    case 'revolve': {
      const tool = sketchTool(f, current);
      tools[idx] = tool;
      return applyOp(current, tool.clone(), f.op || 'add');
    }
    case 'loft':
    case 'sweep':
    case 'gear': {
      const tool = f.type === 'loft' ? loftTool(f) : f.type === 'sweep' ? sweepTool(f) : gearTool(f);
      tools[idx] = tool;
      return applyOp(current, tool.clone(), f.op || 'add');
    }
    case 'draft': {
      needExact(current);
      if (!f.angle) throw kerr('k.badSize');
      const faces = resolveFaces(current, f.faces);
      return current.draft(f.angle, (ff) => ff.inList(faces), makePlane(f.plane, f.offset || 0));
    }
    case 'hole': {
      if (!current) throw kerr('k.nothingToCut');
      const tool = holeTool(f, current);
      tools[idx] = tool;
      return applyOp(current, tool.clone(), 'cut');
    }
    case 'fillet': {
      needExact(current);
      if (!(f.radius > 0)) throw kerr('k.badSize');
      const edges = resolveEdges(current, f.edges);
      return current.fillet(f.radius, (e) => e.inList(edges));
    }
    case 'chamfer': {
      needExact(current);
      if (!(f.distance > 0)) throw kerr('k.badSize');
      const edges = resolveEdges(current, f.edges);
      return current.chamfer(f.distance, (e) => e.inList(edges));
    }
    case 'shell': {
      needExact(current);
      if (!(Math.abs(f.thickness) > 0)) throw kerr('k.badSize');
      const faces = resolveFaces(current, f.faces);
      return current.shell(f.thickness, (ff) => ff.inList(faces));
    }
    case 'mirror': {
      if (!current) throw kerr('k.noBody');
      const def = planeDef(f.plane);
      const mirrored = current.clone().mirror(def.normal, f.origin || def.origin);
      return f.keep === false ? mirrored : applyOp(current, mirrored, 'add');
    }
    case 'linearPattern':
    case 'polarPattern': {
      if (!current) throw kerr('k.noBody');
      const src = f.of;
      const tool = tools[src];
      if (src == null || src >= idx || !tool) throw kerr('k.patternSource');
      const srcF = features[src];
      const op = sourceOp(srcF.type === 'hole' ? 'hole' : srcF.op);
      const n = Math.round(f.count || 0);
      if (n < 2) throw kerr('k.badCount');
      let shape = current;
      if (f.type === 'linearPattern') {
        // Optional second direction makes a rectangular grid.
        const unit = (a) => { const d = axisVec(a); const l = Math.hypot(d[0], d[1], d[2]) || 1; return [d[0] / l, d[1] / l, d[2] / l]; };
        const d1 = unit(f.direction), d2 = unit(f.direction2 || 'Y');
        const n2 = Math.max(1, Math.round(f.count2 || 1));
        for (let j = 0; j < n2; j++) {
          for (let k = 0; k < n; k++) {
            if (!j && !k) continue;
            const a = (f.spacing || 0) * k, b = (f.spacing2 || 0) * j;
            shape = applyOp(shape, transformTool(tool, { translate: [0, 1, 2].map((c) => d1[c] * a + d2[c] * b) }), op);
          }
        }
        return shape;
      }
      for (let k = 1; k < n; k++) {
        let t;
        {
          const total = f.angle ?? 360;
          const step = Math.abs(total) >= 360 ? total / n : total / (n - 1);
          t = transformTool(tool, { rotate: { angle: step * k, origin: f.origin || [0, 0, 0], axis: axisVec(f.axis) } });
        }
        shape = applyOp(shape, t, op);
      }
      return shape;
    }
    case 'cutPlane': {
      if (!current) throw kerr('k.noBody');
      const plane = makePlane(f.plane, f.offset || 0);
      const keep = f.keep === 'negative' ? 'negative' : 'positive';
      if (isMesh(current)) {
        // Keep one side by intersecting with a large box on that side of the plane.
        const [a, b] = current.boundingBox.bounds;
        const size = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * 4 + 10;
        const n = [plane.zDir.x, plane.zDir.y, plane.zDir.z];
        const o = [plane.origin.x, plane.origin.y, plane.origin.z];
        const sign = keep === 'positive' ? 1 : -1;
        const half = R.makeBaseBox(size, size, size / 2);
        const centre = [o[0] + n[0] * sign * size / 4, o[1] + n[1] * sign * size / 4, o[2] + n[2] * sign * size / 4];
        const box = orientZ(half.translate(0, 0, -size / 4), n).translate(centre);
        return applyOp(current, box, 'intersect');
      }
      const kept = current.cutPlane(plane, 0, keep);
      if (!kept) throw kerr('k.cutAll');
      return kept;
    }
    case 'transform': {
      if (!current) throw kerr('k.noBody');
      let s = current;
      if (f.scale && f.scale !== 1) {
        if (!(f.scale > 0)) throw kerr('k.badSize');
        s = s.scale(f.scale, f.center || [0, 0, 0]);
      }
      if (f.rotate && f.rotate.angle) s = s.rotate(f.rotate.angle, f.rotate.origin || [0, 0, 0], axisVec(f.rotate.axis));
      if (f.translate && f.translate.some((v) => v)) s = s.translate(f.translate);
      return s;
    }
    default:
      throw kerr('k.unknownFeature', { type: f.type });
  }
}

// The pattern repeats the source feature's own boolean.
function sourceOp(op) {
  return op === 'cut' || op === 'hole' ? 'cut' : op === 'intersect' ? 'intersect' : 'add';
}

// ---- output -----------------------------------------------------------------------------------

function vec(v) { return [v.x, v.y, v.z]; }

// Render data plus the per-face / per-edge info the UI needs for picking and properties.
export function describe(shape) {
  if (isMesh(shape)) return describeMesh(shape);
  const [a, b] = shape.boundingBox.bounds;
  const diag = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
  const opts = { tolerance: Math.max(diag * 0.0004, 0.002), angularTolerance: 0.25 };
  const mesh = shape.mesh(opts);
  const edges = shape.meshEdges(opts);
  const shapeFaces = shape.faces;
  const shapeEdges = shape.edges;
  // Groups carry OpenCascade hash codes; turn them into indices into faces / edges.
  const faceIndex = new Map(shapeFaces.map((f, i) => [f.hashCode, i]));
  const edgeIndex = new Map(shapeEdges.map((e, i) => [e.hashCode, i]));
  const faceGroups = mesh.faceGroups.map((g) => ({ start: g.start, count: g.count, face: faceIndex.get(g.faceId) ?? -1 }));
  const edgeGroups = edges.edgeGroups.map((g) => ({ start: g.start, count: g.count, edge: edgeIndex.get(g.edgeId) ?? -1 }));
  const faces = shapeFaces.map((f) => {
    let area = 0;
    try { area = R.measureArea(f); } catch { /* degenerate */ }
    let normal = null;
    const type = f.geomType;
    if (type === 'PLANE') {
      try { normal = vec(f.normalAt()); } catch { /* ignore */ }
    }
    let radius = null;
    if (type === 'CYLINDRE') {
      try {
        const e = f.edges.find((x) => x.geomType === 'CIRCLE');
        if (e) radius = edgeRadius(e);
      } catch { /* ignore */ }
    }
    return { type, area, normal, dir: normal, radius };
  });
  const edgeInfo = shapeEdges.map((e) => {
    let length = 0, mid = null, radius = null;
    try { length = e.length; mid = vec(e.pointAt(0.5)); } catch { /* ignore */ }
    const type = e.geomType;
    if (type === 'CIRCLE') {
      try { radius = edgeRadius(e); } catch { /* ignore */ }
    }
    return { type, length, mid, radius, dir: directionOf(e) };
  });
  let volume = null, area = null, com = null;
  try {
    const vp = R.measureShapeVolumeProperties(shape);
    volume = vp.volume ?? R.measureVolume(shape);
    com = vp.centerOfMass;
  } catch { /* shells have no volume */ }
  try { area = R.measureArea(shape); } catch { /* ignore */ }
  return {
    vertices: Float32Array.from(mesh.vertices),
    normals: Float32Array.from(mesh.normals),
    triangles: Uint32Array.from(mesh.triangles),
    faceGroups,
    lines: Float32Array.from(edges.lines),
    edgeGroups,
    faces,
    edges: edgeInfo,
    props: { volume, area, com, bbox: [a, b], solids: shape.solids?.length ?? 1 },
  };
}

// Mesh bodies have no CAD faces or edges: one face group, normals and outline computed
// by the viewer.
function describeMesh(shape) {
  const m = shape.mesh();
  const [a, b] = shape.boundingBox.bounds;
  const np = m.numProp || 3;
  let vertices;
  if (m.vertices && m.vertices.length) vertices = Float32Array.from(m.vertices);
  else {
    const vp = m.vertProperties;
    vertices = new Float32Array((vp.length / np) * 3);
    for (let i = 0, j = 0; i < vp.length; i += np, j += 3) { vertices[j] = vp[i]; vertices[j + 1] = vp[i + 1]; vertices[j + 2] = vp[i + 2]; }
  }
  const triangles = Uint32Array.from(m.triangles || m.triVerts);
  return {
    mesh: true,
    vertices,
    normals: new Float32Array(0),
    triangles,
    faceGroups: [{ start: 0, count: triangles.length, face: 0 }],
    lines: new Float32Array(0),
    edgeGroups: [],
    faces: [{ type: 'MESH', area: shape.surfaceArea(), normal: null }],
    edges: [],
    props: { volume: shape.volume(), area: shape.surfaceArea(), com: null, bbox: [a, b], solids: 1 },
  };
}

// Radius of a circular edge, from three points on the arc.
function edgeRadius(e) {
  return circumradius(vec(e.pointAt(0)), vec(e.pointAt(0.5)), vec(e.pointAt(e.isClosed ? 0.25 : 1)));
}

// Hidden-line views for a 2D drawing. Paths are SVG path strings in model units.
export function drawingViews(shape) {
  const flat = (d) => d.toSVGPaths().flat(Infinity);
  const view = (camera) => {
    const p = R.drawProjection(shape, camera);
    const [x, y, w, h] = p.visible.toSVGViewBox(0).split(/\s+/).map(Number);
    return { visible: flat(p.visible), hidden: flat(p.hidden), box: [x, y, w, h] };
  };
  const iso = new R.ProjectionCamera([1, -1, 0.8], [-1, 1, -0.8], [1, 1, 0]);
  return { front: view('front'), top: view('top'), right: view('right'), iso: view(iso) };
}

function circumradius(a, b, c) {
  const ab = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const bc = Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2]);
  const ca = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
  const s = (ab + bc + ca) / 2;
  const area = Math.sqrt(Math.max(0, s * (s - ab) * (s - bc) * (s - ca)));
  return area > 1e-12 ? (ab * bc * ca) / (4 * area) : null;
}
