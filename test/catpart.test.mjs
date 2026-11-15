// Smoke test: node test/catpart.test.mjs [files...]   (defaults to everything in samples/)
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCATPart } from '../src/loaders/catpart.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let files = process.argv.slice(2);
if (!files.length) {
  const dir = join(root, 'samples');
  files = readdirSync(dir).filter((f) => /\.(catpart|cgr)$/i.test(f)).map((f) => join(dir, f));
}

let failed = 0;
for (const file of files) {
  const buf = readFileSync(file);
  const t0 = performance.now();
  try {
    const res = parseCATPart(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const ms = (performance.now() - t0).toFixed(0);
    for (const m of res.meshes) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < m.positions.length; i++) {
        const v = m.positions[i];
        if (v < min[i % 3]) min[i % 3] = v;
        if (v > max[i % 3]) max[i % 3] = v;
      }
      let badNormals = 0;
      for (let i = 0; i < m.normals.length; i += 3) {
        const l = Math.hypot(m.normals[i], m.normals[i + 1], m.normals[i + 2]);
        if (!(Math.abs(l - 1) < 1e-3)) badNormals++;
      }
      console.log(
        `${file}\n  ${res.info.version} ${m.name}: ${m.positions.length / 3} verts, ${m.indices.length / 3} tris, ` +
          `${m.faces.length} faces, ${m.edges ? m.edges.length / 6 : 0} edge segments, ${ms} ms\n` +
          `  bbox ${min.map((v) => v.toFixed(1))} .. ${max.map((v) => v.toFixed(1))}  badNormals=${badNormals}` +
          `  color=${m.faces[0].color?.map((c) => Math.round(c * 255))}`
      );
      if (badNormals || !m.faces.length) failed++;
    }
  } catch (e) {
    failed++;
    console.log(`${file}\n  FAILED: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
