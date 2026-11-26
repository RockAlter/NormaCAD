// Writes small test files for formats FreeCAD cannot export into samples/formats/.
// The FreeCAD-made files (part.*, building.ifc, *.FCStd) come from test/fc_export.py.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync } from 'three/addons/libs/fflate.module.js';
import rhino3dm from 'rhino3dm';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'samples', 'formats');
mkdirSync(dir, { recursive: true });
const out = (name, data) => { writeFileSync(join(dir, name), data); console.log('wrote', name, data.length ?? data.byteLength); };

// A 40 x 20 x 10 box as triangles, used by several formats.
const V = [[0, 0, 0], [40, 0, 0], [40, 20, 0], [0, 20, 0], [0, 0, 10], [40, 0, 10], [40, 20, 10], [0, 20, 10]];
const Q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
const T = Q.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]);

// Rhino 3DM: a box mesh, a circle curve and a point, in millimetres.
const rhino = await rhino3dm();
const doc = new rhino.File3dm();
doc.settings().modelUnitSystem = rhino.UnitSystem.Millimeters;
const mesh = new rhino.Mesh();
for (const v of V) mesh.vertices().add(v[0], v[1], v[2]);
for (const [a, b, c, d] of Q) mesh.faces().addQuadFace(a, b, c, d);
mesh.normals().computeNormals();
mesh.compact();
doc.objects().add(mesh, null);
doc.objects().add(new rhino.Circle(15).toNurbsCurve(), null);
doc.objects().addPoint([0, 0, 30]);
out('rhino-box.3dm', doc.toByteArray());

// AMF (XML)
out('box.amf', `<?xml version="1.0" encoding="UTF-8"?>
<amf unit="millimeter"><object id="0"><mesh><vertices>
${V.map((v) => `<vertex><coordinates><x>${v[0]}</x><y>${v[1]}</y><z>${v[2]}</z></coordinates></vertex>`).join('\n')}
</vertices><volume>
${T.map((t) => `<triangle><v1>${t[0]}</v1><v2>${t[1]}</v2><v3>${t[2]}</v3></triangle>`).join('\n')}
</volume></mesh></object></amf>`);

// VTK legacy ASCII polydata
out('box.vtk', `# vtk DataFile Version 3.0\nbox\nASCII\nDATASET POLYDATA\nPOINTS ${V.length} float\n${V.map((v) => v.join(' ')).join('\n')}\nPOLYGONS ${T.length} ${T.length * 4}\n${T.map((t) => '3 ' + t.join(' ')).join('\n')}\n`);

// Point clouds: a 40 x 20 grid on z = 5
const grid = [];
for (let x = 0; x <= 40; x += 2) for (let y = 0; y <= 20; y += 2) grid.push([x, y, 5 + Math.sin(x / 6) * 2]);
out('scan.xyz', grid.map((p) => p.map((v) => v.toFixed(3)).join(' ')).join('\n'));
out('scan.pts', `${grid.length}\n` + grid.map((p) => `${p.map((v) => v.toFixed(3)).join(' ')} 0 200 80 40`).join('\n'));
out('scan.pcd', `# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH ${grid.length}\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${grid.length}\nDATA ascii\n${grid.map((p) => p.join(' ')).join('\n')}\n`);
out('scan-points.ply', `ply\nformat ascii 1.0\nelement vertex ${grid.length}\nproperty float x\nproperty float y\nproperty float z\nend_header\n${grid.map((p) => p.join(' ')).join('\n')}\n`);

// OBJ that needs its .mtl (opened together, or inside a zip)
out('coloured.obj', `mtllib coloured.mtl\nusemtl orange\n${V.map((v) => 'v ' + v.join(' ')).join('\n')}\n${Q.map((q) => 'f ' + q.map((i) => i + 1).join(' ')).join('\n')}\n`);
out('coloured.mtl', 'newmtl orange\nKd 0.95 0.45 0.10\n');

// ZIP with several models and the .mtl; KMZ = zipped Collada
const read = (n) => new Uint8Array(readFileSync(join(dir, n)));
out('bundle.zip', zipSync({ 'models/coloured.obj': read('coloured.obj'), 'models/coloured.mtl': read('coloured.mtl'), 'models/part.stl': read('part.stl'), 'readme.txt': new TextEncoder().encode('test bundle') }));
out('part.kmz', zipSync({ 'doc.dae': read('part.dae') }));

// A "SolidWorks" file: unreadable bytes with a PNG preview inside (taken from a FreeCAD thumbnail).
const png = unzipSync(read('PartDesignExample.FCStd'))['thumbnails/Thumbnail.png'];
const junk = new Uint8Array(20000).map((_, i) => (i * 131) & 255);
out('fake-part.sldprt', new Uint8Array([...junk, ...png, ...junk]));
