// CATPart display mesh as an editable mesh part:  node test/mesh2solid.test.mjs [file]
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import opencascade from 'replicad-opencascadejs';
import Manifold from 'manifold-3d';
import * as R from 'replicad';
import { parseCATPart } from '../src/loaders/catpart.js';
import { weldMesh, meshToBody } from '../src/cad/meshsolid.js';
import { setKernel, evaluate, describe } from '../src/cad/build.js';

const require = createRequire(import.meta.url);
R.setOC(await opencascade({ wasmBinary: readFileSync(require.resolve('replicad-opencascadejs/wasm')) }));
const mf = await Manifold();
mf.setup();
R.setManifold(mf);
setKernel(R);

let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++; };

const file = process.argv[2] || new URL('../samples/0794-mian.catpart', import.meta.url);
const buf = readFileSync(file);
const { meshes } = parseCATPart(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const m = meshes[0];

let t = performance.now();
const w = weldMesh(m.positions, m.indices);
const body = meshToBody(mf, R, w.positions, w.triangles);
check('mesh body', body.volume() > 0, `${Math.round(performance.now() - t)} ms, volume ${body.volume().toFixed(0)}`);

const sources = new Map([['base', body]]);
// A point that is inside material: the first vertex, nudged along its face normal inward
// is fiddly, so drill where the mesh has a vertex on its top surface instead.
const [a, b] = body.boundingBox.bounds;
let top = 0;
for (let i = 2; i < w.positions.length; i += 3) if (w.positions[i] > w.positions[top + 2]) top = i - 2;
const p = [w.positions[top], w.positions[top + 1], w.positions[top + 2]];

const features = [
  { type: 'import', source: 'base' },
  { type: 'hole', p, normal: [0, 0, 1], diameter: 20, through: true },
  { type: 'box', op: 'add', pos: [a[0], a[1], a[2] - 20], w: 50, d: 50, h: 20 },
  { type: 'mirror', plane: 'YZ', origin: [(a[0] + b[0]) / 2, 0, 0] },
  { type: 'cutPlane', plane: 'XY', offset: (a[2] + b[2]) / 2, keep: 'negative' },
  { type: 'transform', translate: [0, 0, 100] },
  { type: 'fillet', radius: 1, edges: [{ p }] },
];
t = performance.now();
const r = evaluate(features, sources);
const ms = Math.round(performance.now() - t);
const errs = r.status.map((e, i) => (e ? `#${i}:${e.i18n || e.message}` : null)).filter(Boolean);
check('features on mesh body', errs.length === 1 && errs[0] === '#6:k.needExact', `${ms} ms, errors ${errs.join(' ')}`);

const d = describe(r.shape);
check('describe mesh body', d.mesh && d.vertices.length > 0 && d.triangles.length > 0 && d.props.volume > 0,
  `${d.triangles.length / 3} tris, volume ${d.props.volume.toFixed(0)}, bbox z ${d.props.bbox[0][2].toFixed(1)}..${d.props.bbox[1][2].toFixed(1)}`);
check('cut by plane kept lower half', d.props.bbox[1][2] <= (a[2] + b[2]) / 2 + 100 + 1e-3);

// Exact base + mesh import fused: result becomes a mesh.
const r2 = evaluate([{ type: 'box', op: 'add', pos: [0, 0, 0], w: 10, d: 10, h: 10 }, { type: 'import', source: 'base', op: 'add' }], sources);
check('exact + mesh = mesh', !r2.status.some(Boolean) && r2.shape instanceof R.MeshShape);

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
