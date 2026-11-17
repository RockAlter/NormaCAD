// Smoke test for the modelling kernel (replicad on OpenCascade WASM): node test/kernel.test.mjs
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import opencascade from 'replicad-opencascadejs';
import * as R from 'replicad';

const require = createRequire(import.meta.url);
const t0 = performance.now();
const wasmBinary = readFileSync(require.resolve('replicad-opencascadejs/wasm'));
const oc = await opencascade({ wasmBinary });
R.setOC(oc);
console.log('kernel ready in', Math.round(performance.now() - t0), 'ms');

const t1 = performance.now();
// Plate 100 x 60 x 10 with rounded vertical edges, a through hole and a pocket.
let plate = R.drawRectangle(100, 60).sketchOnPlane('XY').extrude(10);
plate = plate.fillet(5, (e) => e.inDirection('Z'));
const hole = R.makeCylinder(8, 30, [0, 0, -10]);
plate = plate.cut(hole);
const pocket = R.drawRectangle(30, 20).translate(30, 0).sketchOnPlane('XY', 6).extrude(10);
plate = plate.cut(pocket);
plate = plate.chamfer(1, (e) => e.inPlane('XY', 10));

const vol = R.measureVolume(plate);
const area = R.measureArea(plate);
const bb = plate.boundingBox;
console.log('model built in', Math.round(performance.now() - t1), 'ms');
console.log('volume', vol.toFixed(1), 'area', area.toFixed(1), 'bbox', JSON.stringify(bb.bounds));
console.log('faces', plate.faces.length, 'edges', plate.edges.length);

const m = plate.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
const e = plate.meshEdges({ tolerance: 0.05, angularTolerance: 0.3 });
console.log('mesh tris', m.triangles.length / 3, 'faceGroups', m.faceGroups.length, 'edgeGroups', e.edgeGroups.length);

// Expected volume: plate minus corner rounding minus hole minus pocket (chamfer small).
const expected = 100 * 60 * 10 - 4 * (25 - Math.PI * 25 / 4) * 10 - Math.PI * 64 * 10 - 30 * 20 * 4;
console.log('expected ~', expected.toFixed(1), 'diff', (vol - expected).toFixed(1));

// STEP round trip
const step = plate.blobSTEP();
const back = await R.importSTEP(step);
console.log('STEP bytes', step.size, 'reimported volume', R.measureVolume(back).toFixed(1));

// Pick-by-index fillet (what the UI will do): fillet one edge chosen by index.
const cube = R.makeBaseBox(20, 20, 20);
const idx = cube.edges.findIndex((ed) => R.measureLength(ed) > 19);
const filleted = cube.fillet(3, (f) => f.inList([cube.edges[idx]]));
console.log('single-edge fillet ok, volume', R.measureVolume(filleted).toFixed(1), 'expected', (8000 - 9 * (1 - Math.PI / 4) * 20).toFixed(1));

// A failing operation must surface as a catchable error, not kill the kernel.
try {
  cube.fillet(50);
  console.log('oversized fillet unexpectedly succeeded');
} catch (err) {
  console.log('oversized fillet rejected:', err?.constructor?.name, typeof err?.message);
}
console.log('kernel still usable after failure:', R.measureVolume(R.makeBaseBox(1, 2, 3)).toFixed(1));

// Revolve
const rev = R.draw([10, 0]).hLine(10).vLine(30).hLine(-10).close().sketchOnPlane('XZ').revolve([0, 0, 1]);
console.log('revolve volume', R.measureVolume(rev).toFixed(1), 'expected', (Math.PI * (400 - 100) * 30).toFixed(1));

// Shell: open the top face
const box = R.makeBaseBox(40, 40, 20);
const shelled = box.shell(2, (f) => f.inPlane('XY', 20));
console.log('shell volume', R.measureVolume(shelled).toFixed(1));
