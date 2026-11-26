// Parser checks for the dependency-free readers: node test/formats.test.mjs
// Uses samples/formats/ (made by test/fc_export.py and test/make-format-samples.mjs) when present.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { parseDXF } from '../src/loaders/dxf.js';
import { parseOFF, parseX3D, parsePointsText, findImage, findPreview } from '../src/loaders/simple.js';
import { extensionOf } from '../src/loaders/index.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'formats');
let failed = 0;
const check = (name, ok, extra = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (!ok) failed++; };
const bbox = (arr) => {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < arr.length; i++) { mn[i % 3] = Math.min(mn[i % 3], arr[i]); mx[i % 3] = Math.max(mx[i % 3], arr[i]); }
  return mx.map((v, k) => +(v - mn[k]).toFixed(3));
};
// Arcs are drawn as chords, so outlines may sit a few hundredths of a millimetre inside.
const same = (a, b, tol = 1e-3) => a.every((v, i) => Math.abs(v - b[i]) < tol);

// DXF: block insert with rotation, bulge arc, units
const dxf = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '1', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'BLOCKS', '0', 'BLOCK', '2', 'B1', '10', '0', '20', '0', '30', '0', '0', 'LINE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '10', '21', '0', '31', '0', '0', 'ENDBLK', '0', 'ENDSEC',
  '0', 'SECTION', '2', 'ENTITIES', '0', 'INSERT', '8', '0', '2', 'B1', '10', '100', '20', '0', '30', '0', '50', '90',
  '0', 'LWPOLYLINE', '8', '0', '90', '2', '70', '0', '10', '0', '20', '0', '42', '1', '10', '10', '20', '0',
  '0', '3DFACE', '8', '0', '10', '0', '20', '0', '30', '0', '11', '1', '21', '0', '31', '0', '12', '1', '22', '1', '32', '0', '13', '0', '23', '1', '33', '0',
  '0', 'ENDSEC', '0', 'EOF'].join('\n');
const d = parseDXF(dxf);
const lines = [...d.lines.values()][0];
check('dxf inches -> mm', d.unitScale === 25.4);
check('dxf rotated block insert', lines[0] === 100 * 25.4 && Math.abs(lines[4] - 10 * 25.4) < 1e-6);
check('dxf 3DFACE quad -> 2 triangles', [...d.faces.values()][0].length === 18);

const has = (f) => existsSync(join(dir, f));
if (has('part.dxf')) {
  const r = parseDXF(readFileSync(join(dir, 'part.dxf'), 'utf8'));
  const all = Float32Array.from([...r.lines.values()].flatMap((a) => [...a]));
  check('dxf from FreeCAD', same(bbox(all), [145, 70, 100], 0.05), bbox(all).join(' x '));
}
if (has('part.off')) {
  const o = parseOFF(readFileSync(join(dir, 'part.off'), 'utf8'));
  check('off from FreeCAD', same(bbox(o.positions), [145, 70, 100]) && o.indices.length / 3 === 598);
}
if (has('part.x3d')) {
  const x = parseX3D(readFileSync(join(dir, 'part.x3d'), 'utf8'));
  check('x3d from FreeCAD', same(bbox(x[0].positions), [145, 70, 100]) && x[0].indices.length / 3 === 598);
}
const pts = parsePointsText('# scan\n3\n0 0 0 255 0 0\n1,2,3,0,255,0\n4;5;6;0;0;255\nnot a point\n');
check('points text with colours', pts.positions.length === 9 && pts.colors[0] === 1 && pts.colors[8] === 1);

if (has('PartDesignExample.FCStd')) {
  const png = unzipSync(new Uint8Array(readFileSync(join(dir, 'PartDesignExample.FCStd'))))['thumbnails/Thumbnail.png'];
  const junk = new Uint8Array(5000).map((_, i) => (i * 37) & 255);
  const img = findImage(new Uint8Array([...junk, ...png, ...junk]));
  check('embedded preview found', img && img.mime === 'image/png' && img.bytes.length === png.length);
}
check('no preview in noise', !findPreview(new Uint8Array(4000).map((_, i) => (i * 7) & 255)));
check('creo versioned file extension', extensionOf('bracket.prt.12') === 'prt' && extensionOf('a.b.STEP') === 'step');

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
