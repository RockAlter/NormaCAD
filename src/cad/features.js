// Feature catalogue: defaults, form fields and short summaries. Shared by the UI only.

export const CREATE = ['box', 'cylinder', 'sphere', 'cone', 'torus', '-', 'extrude', 'revolve'];
export const MODIFY = ['hole', 'fillet', 'chamfer', 'shell', '-', 'mirror', 'linearPattern', 'polarPattern', 'cutPlane', 'transform'];

// Features whose result is a tool body (they can be repeated by a pattern).
export const TOOL_FEATURES = new Set(['box', 'cylinder', 'sphere', 'cone', 'torus', 'extrude', 'revolve', 'hole']);
// Features that only work on exact (B-Rep) bodies.
export const EXACT_ONLY = new Set(['fillet', 'chamfer', 'shell']);

const OPS = [['add', 'op.add'], ['cut', 'op.cut'], ['intersect', 'op.intersect']];
const AXES = [['X', 'X'], ['Y', 'Y'], ['Z', 'Z']];
const PLANES = [['XY', 'XY'], ['XZ', 'XZ'], ['YZ', 'YZ']];

// Field kinds: num, vec3, select, check, edges, faces, point, sketch, source
export const FIELDS = {
  import: [['op', 'select', OPS]],
  box: [['op', 'select', OPS], ['pos', 'vec3'], ['w', 'num'], ['d', 'num'], ['h', 'num']],
  cylinder: [['op', 'select', OPS], ['pos', 'vec3'], ['axis', 'select', AXES], ['r', 'num'], ['h', 'num']],
  sphere: [['op', 'select', OPS], ['pos', 'vec3'], ['r', 'num']],
  cone: [['op', 'select', OPS], ['pos', 'vec3'], ['axis', 'select', AXES], ['r1', 'num'], ['r2', 'num'], ['h', 'num']],
  torus: [['op', 'select', OPS], ['pos', 'vec3'], ['axis', 'select', AXES], ['R', 'num'], ['r', 'num']],
  extrude: [['op', 'select', OPS], ['sketch', 'sketch'], ['distance', 'num'], ['reverse', 'check'], ['symmetric', 'check'], ['through', 'check']],
  revolve: [['op', 'select', OPS], ['sketch', 'sketch'], ['axis', 'select', [['U', 'p.axisU'], ['V', 'p.axisV']]], ['angle', 'num']],
  hole: [['p', 'point'], ['diameter', 'num'], ['depth', 'num'], ['through', 'check'], ['cbDiameter', 'num'], ['cbDepth', 'num']],
  fillet: [['edges', 'edges'], ['radius', 'num']],
  chamfer: [['edges', 'edges'], ['distance', 'num']],
  shell: [['faces', 'faces'], ['thickness', 'num']],
  mirror: [['plane', 'select', PLANES], ['origin', 'vec3'], ['keep', 'check']],
  linearPattern: [['of', 'source'], ['direction', 'select', AXES], ['spacing', 'num'], ['count', 'num']],
  polarPattern: [['of', 'source'], ['axis', 'select', AXES], ['origin', 'vec3'], ['count', 'num'], ['angle', 'num']],
  cutPlane: [['plane', 'select', PLANES], ['offset', 'num'], ['keep', 'select', [['positive', 'p.keepPos'], ['negative', 'p.keepNeg']]]],
  transform: [['translate', 'vec3'], ['rotAxis', 'select', AXES], ['rotAngle', 'num'], ['rotOrigin', 'vec3'], ['scale', 'num']],
};

// Reasonable starting values, scaled to the part (size = bounding-box diagonal or 100).
export function defaults(type, ctx) {
  // An empty part starts at a comfortable working size (boxes of ~50 mm).
  const s = niceStep(ctx.hasBody ? ctx.size || 100 : 500);
  const c = ctx.center || [0, 0, 0];
  const empty = !ctx.hasBody;
  switch (type) {
    case 'box': return { op: 'add', pos: empty ? [0, 0, 0] : c.slice(), w: s * 5, d: s * 5, h: s * 5 };
    case 'cylinder': return { op: empty ? 'add' : 'cut', pos: empty ? [0, 0, 0] : [c[0], c[1], ctx.min[2] - s], axis: 'Z', r: s * 2, h: empty ? s * 5 : (ctx.max[2] - ctx.min[2]) + 2 * s };
    case 'sphere': return { op: 'add', pos: empty ? [0, 0, 0] : c.slice(), r: s * 3 };
    case 'cone': return { op: 'add', pos: empty ? [0, 0, 0] : c.slice(), axis: 'Z', r1: s * 3, r2: s, h: s * 5 };
    case 'torus': return { op: 'add', pos: empty ? [0, 0, 0] : c.slice(), axis: 'Z', R: s * 4, r: s };
    case 'extrude': return { op: empty ? 'add' : 'cut', distance: s * 2, reverse: !empty, symmetric: false, through: false, sketch: { plane: 'XY', offset: empty ? 0 : round(ctx.max[2], s / 10), shapes: [] } };
    case 'revolve': return { op: 'add', axis: 'V', angle: 360, sketch: { plane: 'XZ', offset: 0, shapes: [] } };
    case 'hole': return { p: null, normal: null, diameter: s, depth: s * 2, through: true, cbDiameter: 0, cbDepth: 0 };
    case 'fillet': return { edges: [], radius: s / 2 };
    case 'chamfer': return { edges: [], distance: s / 2 };
    case 'shell': return { faces: [], thickness: s / 5 };
    case 'mirror': return { plane: 'YZ', origin: [0, 0, 0], keep: true };
    case 'linearPattern': return { of: ctx.lastTool, direction: 'X', spacing: s * 2, count: 3 };
    case 'polarPattern': return { of: ctx.lastTool, axis: 'Z', origin: [0, 0, 0], count: 6, angle: 360 };
    case 'cutPlane': return { plane: 'XY', offset: round(c[2], s / 10), keep: 'negative' };
    case 'transform': return { translate: [0, 0, 0], rotAxis: 'Z', rotAngle: 0, rotOrigin: [0, 0, 0], scale: 1 };
    default: return {};
  }
}

export function niceStep(size) {
  const raw = size / 50;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
}

function round(v, step) {
  return Math.round(v / step) * step;
}

// The transform dialog edits flat fields; the engine wants nested ones.
export function toEngine(f) {
  if (f.type !== 'transform') return f;
  const out = { type: 'transform', translate: f.translate, scale: f.scale };
  if (f.rotAngle) out.rotate = { angle: f.rotAngle, axis: f.rotAxis, origin: f.rotOrigin };
  if (f.suppressed) out.suppressed = true;
  return out;
}

const n = (v) => (Number.isFinite(v) ? +v.toFixed(3) : v);

// One-line description for the feature tree, e.g. "Pad 20 mm".
export function summary(f, t) {
  const name = t('f.' + f.type);
  switch (f.type) {
    case 'import': return `${name}: ${f.name || ''}`;
    case 'box': return `${opName(f, t)} ${name} ${n(f.w)}×${n(f.d)}×${n(f.h)}`;
    case 'cylinder': return `${opName(f, t)} ${name} Ø${n(f.r * 2)}×${n(f.h)}`;
    case 'sphere': return `${opName(f, t)} ${name} Ø${n(f.r * 2)}`;
    case 'cone': return `${opName(f, t)} ${name} Ø${n(f.r1 * 2)}/Ø${n(f.r2 * 2)}×${n(f.h)}`;
    case 'torus': return `${opName(f, t)} ${name} Ø${n(f.R * 2)}`;
    case 'extrude': return `${t(f.op === 'cut' ? 'f.pocket' : f.op === 'intersect' ? 'f.extrudeX' : 'f.pad')} ${f.through ? t('p.through') : n(f.distance) + ' mm'}`;
    case 'revolve': return `${t(f.op === 'cut' ? 'f.groove' : 'f.revolve')} ${n(f.angle)}°`;
    case 'hole': return `${name} Ø${n(f.diameter)} ${f.through ? t('p.through') : n(f.depth) + ' mm'}`;
    case 'fillet': return `${name} R${n(f.radius)} ×${(f.edges || []).length}`;
    case 'chamfer': return `${name} ${n(f.distance)} ×${(f.edges || []).length}`;
    case 'shell': return `${name} ${n(f.thickness)} mm`;
    case 'mirror': return `${name} ${f.plane}`;
    case 'linearPattern': return `${name} ×${f.count}`;
    case 'polarPattern': return `${name} ×${f.count}`;
    case 'cutPlane': return `${name} ${f.plane} ${n(f.offset)}`;
    case 'transform': return name;
    default: return name;
  }
}

function opName(f, t) {
  return f.op === 'cut' ? '−' : f.op === 'intersect' ? '∩' : '+';
}
