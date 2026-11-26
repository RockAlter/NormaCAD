// FreeCAD .FCStd reader: node test/fcstd.test.mjs [files...]  (defaults to samples/formats/*.FCStd)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import opencascade from 'replicad-opencascadejs';
import * as R from 'replicad';
import { parseFCStd } from '../src/loaders/fcstd.js';
import { brepItemsToShape } from '../src/cad/brep.js';

const require = createRequire(import.meta.url);
const oc = await opencascade({ wasmBinary: readFileSync(require.resolve('replicad-opencascadejs/wasm')) });
R.setOC(oc);

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let files = process.argv.slice(2);
if (!files.length) {
  const dir = join(root, 'samples', 'formats');
  files = existsSync(dir) ? readdirSync(dir).filter((f) => /\.fcstd$/i.test(f)).map((f) => join(dir, f)) : [];
}
let failed = 0;
for (const f of files) {
  const t0 = performance.now();
  try {
    const buf = readFileSync(f);
    const doc = parseFCStd(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const t1 = performance.now();
    const shape = brepItemsToShape(oc, R, doc.items);
    const [a, b] = shape ? shape.boundingBox.bounds : [[0, 0, 0], [0, 0, 0]];
    const coloured = doc.items.filter((i) => i.materials).length;
    console.log(`${basename(f)}: ${doc.objectCount} objects -> ${doc.items.length} shown (${coloured} coloured), parse ${Math.round(t1 - t0)} ms, exact load ${Math.round(performance.now() - t1)} ms`);
    console.log(`   bbox ${a.map((v) => v.toFixed(1))} .. ${b.map((v) => v.toFixed(1))}   ${doc.items.slice(0, 6).map((i) => i.name).join(', ')}${doc.items.length > 6 ? ', …' : ''}`);
    if (!doc.items.length) failed++;
  } catch (e) {
    failed++;
    console.log(`${basename(f)}: FAILED ${e.message}`);
  }
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
