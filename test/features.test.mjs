// Feature-history engine test: node test/features.test.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import opencascade from 'replicad-opencascadejs';
import * as R from 'replicad';
import { setKernel, evaluate, describe, drawingViews } from '../src/cad/build.js';
import { evalExpr, paramValues, applyExprs } from '../src/cad/expr.js';

const require = createRequire(import.meta.url);
R.setOC(await opencascade({ wasmBinary: readFileSync(require.resolve('replicad-opencascadejs/wasm')) }));
setKernel(R);

let failed = 0;
const near = (a, b, tol) => Math.abs(a - b) <= tol;
function check(name, cond, extra = '') {
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : ''));
  if (!cond) failed++;
}
function run(features, cache) {
  const res = evaluate(features, new Map(), cache);
  const errs = res.status.map((e, i) => (e ? `#${i} ${e.i18n || e.message} ${JSON.stringify(e.vars || '')}` : null)).filter(Boolean);
  return { ...res, errs };
}

// 1. Pad a sketch with a hole in it, then pocket, fillet, hole, pattern.
const plate = {
  type: 'extrude', op: 'add', distance: 10,
  sketch: { plane: 'XY', offset: 0, shapes: [
    { type: 'rect', cx: 0, cy: 0, w: 100, h: 60, r: 0 },
    { type: 'circle', cx: 0, cy: 0, r: 8, hole: true },
  ] },
};
let r = run([plate]);
check('pad with sketch hole', !r.errs.length && near(R.measureVolume(r.shape), 60000 - Math.PI * 64 * 10, 0.5), r.errs.join(';'));

const pocket = { type: 'extrude', op: 'cut', distance: 4, reverse: true, sketch: { plane: 'XY', offset: 10, shapes: [{ type: 'rect', cx: 30, cy: 0, w: 20, h: 20 }] } };
r = run([plate, pocket]);
const v2 = 60000 - Math.PI * 640 - 20 * 20 * 4;
check('pocket from top face downwards', !r.errs.length && near(R.measureVolume(r.shape), v2, 0.5), (r.errs.join(';') || R.measureVolume(r.shape).toFixed(1)));

// Fillet one vertical corner edge, referenced by a point on it.
const fillet = { type: 'fillet', radius: 5, edges: [{ p: [50, 30, 5], type: 'LINE', dir: [0, 0, 1] }] };
r = run([plate, pocket, fillet]);
const v3 = v2 - 25 * (1 - Math.PI / 4) * 10;
check('fillet by point reference', !r.errs.length && near(R.measureVolume(r.shape), v3, 0.5), r.errs.join(';') || R.measureVolume(r.shape).toFixed(1));

// Hole from the top face, then a linear pattern of it.
const hole = { type: 'hole', p: [-35, -20, 10], normal: [0, 0, 1], diameter: 6, depth: 0, through: true };
const pattern = { type: 'linearPattern', of: 3, direction: [0, 1, 0], spacing: 20, count: 3 };
r = run([plate, pocket, fillet, hole, pattern]);
const v5 = v3 - 3 * Math.PI * 9 * 10;
check('hole + linear pattern', !r.errs.length && near(R.measureVolume(r.shape), v5, 0.5), r.errs.join(';') || R.measureVolume(r.shape).toFixed(1));

// Cache: changing only the last feature must reuse the earlier shapes.
const t0 = performance.now();
const r2 = run([plate, pocket, fillet, hole, { ...pattern, count: 2 }], r.cache);
check('incremental rebuild', !r2.errs.length && near(R.measureVolume(r2.shape), v3 - 2 * Math.PI * 90, 0.5), `${Math.round(performance.now() - t0)} ms`);

// Upstream change: make the plate longer; the fillet reference must still resolve.
const longer = { ...plate, sketch: { ...plate.sketch, shapes: [{ ...plate.sketch.shapes[0], w: 110 }, plate.sketch.shapes[1]] } };
const r3 = run([longer, pocket, fillet], null);
check('fillet survives upstream resize', !r3.errs.length, r3.errs.join(';'));

// 2. Primitives and booleans
r = run([
  { type: 'box', op: 'add', pos: [0, 0, 0], w: 20, d: 20, h: 20 },
  { type: 'cylinder', op: 'cut', pos: [10, 10, -1], r: 5, h: 30, axis: 'Z' },
  { type: 'sphere', op: 'add', pos: [10, 10, 25], r: 4 },
]);
check('primitives + booleans', !r.errs.length && near(R.measureVolume(r.shape), 8000 - Math.PI * 25 * 20 + (4 / 3) * Math.PI * 64, 0.5), r.errs.join(';') || R.measureVolume(r.shape).toFixed(1));

r = run([{ type: 'cone', op: 'add', pos: [0, 0, 0], r1: 10, r2: 5, h: 12, axis: 'X' }]);
const coneV = (Math.PI * 12 / 3) * (100 + 50 + 25);
const bb = r.shape?.boundingBox.bounds;
check('cone along X', !r.errs.length && near(R.measureVolume(r.shape), coneV, 0.5) && near(bb[1][0], 12, 1e-6), r.errs.join(';'));

r = run([{ type: 'torus', op: 'add', pos: [0, 0, 0], R: 20, r: 3, axis: 'Z' }]);
check('torus', !r.errs.length && near(R.measureVolume(r.shape), 2 * Math.PI * Math.PI * 20 * 9, 0.5), r.errs.join(';'));

// 3. Revolve, shell, mirror, polar pattern, cut by plane, transform
r = run([{ type: 'revolve', op: 'add', axis: 'V', angle: 360, sketch: { plane: 'XZ', shapes: [{ type: 'rect', cx: 15, cy: 10, w: 10, h: 20 }] } }]);
check('revolve ring', !r.errs.length && near(R.measureVolume(r.shape), Math.PI * (400 - 100) * 20, 0.5), r.errs.join(';') || R.measureVolume(r.shape).toFixed(1));

r = run([
  { type: 'box', op: 'add', pos: [0, 0, 0], w: 40, d: 40, h: 20 },
  { type: 'shell', thickness: 2, faces: [{ p: [20, 20, 20] }] },
]);
check('shell open top', !r.errs.length && near(R.measureVolume(r.shape), 32000 - 36 * 36 * 18, 0.5), r.errs.join(';') || R.measureVolume(r.shape).toFixed(1));

r = run([
  { type: 'box', op: 'add', pos: [5, 0, 0], w: 10, d: 10, h: 10 },
  { type: 'mirror', plane: 'YZ' },
]);
check('mirror', !r.errs.length && near(R.measureVolume(r.shape), 2000, 0.5), r.errs.join(';'));

r = run([
  { type: 'cylinder', op: 'add', pos: [0, 0, 0], r: 30, h: 5, axis: 'Z' },
  { type: 'cylinder', op: 'cut', pos: [20, 0, -1], r: 3, h: 10, axis: 'Z' },
  { type: 'polarPattern', of: 1, axis: 'Z', origin: [0, 0, 0], count: 6, angle: 360 },
]);
check('polar pattern of cut', !r.errs.length && near(R.measureVolume(r.shape), Math.PI * 900 * 5 - 6 * Math.PI * 9 * 5, 0.5), r.errs.join(';') || R.measureVolume(r.shape).toFixed(1));

r = run([
  { type: 'box', op: 'add', pos: [0, 0, 0], w: 10, d: 10, h: 10 },
  { type: 'cutPlane', plane: 'XY', offset: 4, keep: 'negative' },
  { type: 'transform', translate: [100, 0, 0], rotate: { angle: 90, axis: 'Z', origin: [0, 0, 0] } },
]);
const tb = r.shape?.boundingBox.bounds;
check('cut by plane + transform', !r.errs.length && near(R.measureVolume(r.shape), 400, 0.5) && near(tb[0][0], 90, 1e-6), r.errs.join(';') || JSON.stringify(tb));

// 4. Errors are reported per feature and do not stop later features.
r = run([
  { type: 'box', op: 'add', pos: [0, 0, 0], w: 10, d: 10, h: 10 },
  { type: 'fillet', radius: 50, edges: [{ p: [10, 10, 5] }] },
  { type: 'box', op: 'add', pos: [10, 0, 0], w: 10, d: 10, h: 10 },
]);
check('failed feature is isolated', r.status[1] && !r.status[2] && near(R.measureVolume(r.shape), 2000, 0.5));

// 5. describe(): face groups line up with faces, edges carry radius.
r = run([plate]);
const d = describe(r.shape);
const tri = d.triangles.length / 3;
const covered = d.faceGroups.reduce((s, g) => s + g.count, 0) / 3;
check('describe faces', d.faces.length === r.shape.faces.length && covered === tri && d.faceGroups.every((g) => g.face >= 0 && g.face < d.faces.length) && d.edgeGroups.every((g) => g.edge >= 0), `${d.faces.length} faces, ${tri} tris`);
const circle = d.edges.find((e) => e.type === 'CIRCLE');
check('circle edge radius', circle && near(circle.radius, 8, 1e-6), circle ? circle.radius : 'none');
check('volume props', near(d.props.volume, 60000 - Math.PI * 640, 0.5) && d.props.com && near(d.props.com[2], 5, 1e-6));

// 6. Loft, sweep, gear, draft, grid pattern, drawing views, formulas
r = run([{ type: 'loft', op: 'add', distance: 30, endType: 'rect', endW: 20, endH: 20, sketch: { plane: 'XY', shapes: [{ type: 'rect', cx: 0, cy: 0, w: 40, h: 40 }] } }]);
check('loft frustum', !r.errs.length && near(R.measureVolume(r.shape), (30 / 3) * (1600 + 400 + 800), 1), r.errs.join(';') || R.measureVolume(r.shape).toFixed(1));

r = run([{ type: 'sweep', op: 'add', profile: 'circle', pw: 4, path: 'helix', pitch: 10, height: 40, helixR: 20, pos: [0, 0, 0], axis: 'Z' }]);
check('helix sweep (spring)', !r.errs.length && near(R.measureVolume(r.shape), Math.PI * 4 * Math.hypot(2 * Math.PI * 20, 10) * 4, 10), r.errs.join(';') || R.measureVolume(r.shape).toFixed(1));

r = run([{ type: 'sweep', op: 'add', profile: 'rect', pw: 10, ph: 6, path: 'polyline', pts: '0,0,0; 0,0,50; 40,0,50' }]);
check('polyline sweep', !r.errs.length && R.measureVolume(r.shape) > 4500, r.errs.join(';') || R.measureVolume(r.shape).toFixed(1));

r = run([{ type: 'gear', op: 'add', pos: [0, 0, 0], axis: 'Z', teeth: 24, module: 2, pressure: 20, thickness: 10, bore: 10 }]);
const gearArea = R.measureVolume(r.shape) / 10 + Math.PI * 25;
check('involute gear', !r.errs.length && near(gearArea, Math.PI * 24 * 24, Math.PI * 24 * 24 * 0.06) && near(r.shape.boundingBox.bounds[1][0], 26, 0.2), r.errs.join(';') || gearArea.toFixed(1));

r = run([
  { type: 'box', op: 'add', pos: [0, 0, 0], w: 20, d: 20, h: 20 },
  { type: 'draft', angle: 5, plane: 'XY', offset: 0, faces: [{ p: [10, 0, 10], type: 'PLANE', dir: [0, 1, 0] }] },
]);
check('draft', !r.errs.length && near(R.measureVolume(r.shape), 8000 - 0.5 * 20 * 20 * Math.tan(5 * Math.PI / 180) * 20, 2), r.errs.join(';') || R.measureVolume(r.shape).toFixed(1));

r = run([
  { type: 'box', op: 'add', pos: [0, 0, 0], w: 100, d: 100, h: 5 },
  { type: 'cylinder', op: 'cut', pos: [20, 20, -1], r: 3, h: 10, axis: 'Z' },
  { type: 'linearPattern', of: 1, direction: 'X', spacing: 20, count: 3, direction2: 'Y', spacing2: 30, count2: 2 },
]);
check('grid pattern', !r.errs.length && near(R.measureVolume(r.shape), 50000 - 6 * Math.PI * 9 * 5, 0.5), r.errs.join(';') || R.measureVolume(r.shape).toFixed(1));

const views = drawingViews(run([{ type: 'box', op: 'add', pos: [0, 0, 0], w: 100, d: 60, h: 10 }]).shape);
check('drawing views', near(views.front.box[2], 100, 1e-3) && near(views.front.box[3], 10, 1e-3) && near(views.top.box[3], 60, 1e-3) && near(views.right.box[2], 60, 1e-3) && views.iso.visible.length > 0);

const { vars, errors } = paramValues([{ name: 'w', value: '40' }, { name: 'half', value: 'w / 2' }, { name: 'bad', value: 'nope + 1' }]);
check('parameters', vars.half === 20 && errors.length === 1 && errors[0] === 'bad');
check('formula grammar', near(evalExpr('=2 * (3 + 4) ^ 2 - sqrt(16) + cos(60)', {}), 94.5, 1e-9));
let injected = false;
try { evalExpr('constructor.constructor("x")()', {}); injected = true; } catch { /* rejected */ }
check('formula rejects code', !injected);
const applied = applyExprs({ type: 'box', w: 1, expr: { w: 'w_p * 2' }, sketch: { shapes: [{ r: 1, expr: { r: 'w_p' } }] } }, { w_p: 7 });
check('formulas applied', applied.w === 14 && applied.sketch.shapes[0].r === 7 && !('expr' in applied));

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
