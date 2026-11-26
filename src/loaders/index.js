// File format dispatch. Every loader resolves to
//   { object: THREE.Object3D, info: { format, note }, source? }
// `source` describes exact geometry the modelling kernel can use (STEP bytes, BREP text).
import * as THREE from 'three';
import { unzipSync } from 'three/addons/libs/fflate.module.js';
import { parseCATPart } from './catpart.js';
import { parseFCStd } from './fcstd.js';
import { parseDXF } from './dxf.js';
import { parseOFF, parsePointsText, parseX3D, findPreview } from './simple.js';
import { makePartMesh, partMaterial, addComputedEdges } from '../meshkit.js';

const OCCT_DIR = '/node_modules/occt-import-js/dist/';

// Grouped for the help text; every extension here can be opened.
export const FORMAT_GROUPS = {
  cad: ['catpart', 'cgr', 'fcstd', 'step', 'stp', 'iges', 'igs', 'brep', 'brp', '3dm', 'ifc', 'dxf'],
  mesh: ['stl', 'ast', 'obj', 'smf', 'ply', 'off', '3mf', 'amf', 'gltf', 'glb', 'dae', 'kmz', 'fbx', '3ds', 'wrl', 'vrml', 'x3d', 'vtk', 'vtp', 'usdz'],
  points: ['xyz', 'asc', 'pts', 'csv', 'txt', 'pcd'],
  other: ['norma', 'zip'],
};
export const SUPPORTED = Object.values(FORMAT_GROUPS).flat();
// Files that only accompany a model (materials, buffers, textures).
export const RESOURCE_EXT = new Set(['mtl', 'bin', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'tga', 'tif', 'tiff', 'dds', 'ktx2', 'webp', 'hdr']);

// Proprietary formats: Norma shows the preview image stored in the file, if any.
const PROPRIETARY = {
  catproduct: ['unsup.catproduct'],
  catdrawing: ['unsup.catdrawing'],
  sldprt: ['unsup.proprietary', { name: 'SolidWorks' }],
  sldasm: ['unsup.proprietary', { name: 'SolidWorks' }],
  slddrw: ['unsup.proprietary', { name: 'SolidWorks' }],
  ipt: ['unsup.proprietary', { name: 'Inventor' }],
  iam: ['unsup.proprietary', { name: 'Inventor' }],
  idw: ['unsup.proprietary', { name: 'Inventor' }],
  par: ['unsup.proprietary', { name: 'Solid Edge' }],
  psm: ['unsup.proprietary', { name: 'Solid Edge' }],
  prt: ['unsup.proprietary', { name: 'NX / Creo' }],
  asm: ['unsup.proprietary', { name: 'Creo / Solid Edge' }],
  f3d: ['unsup.proprietary', { name: 'Fusion' }],
  skp: ['unsup.proprietary', { name: 'SketchUp' }],
  x_t: ['unsup.notyet', { name: 'Parasolid' }],
  x_b: ['unsup.notyet', { name: 'Parasolid' }],
  sat: ['unsup.notyet', { name: 'ACIS' }],
  sab: ['unsup.notyet', { name: 'ACIS' }],
  jt: ['unsup.notyet', { name: 'JT' }],
  '3dxml': ['unsup.notyet', { name: '3DXML' }],
  dwg: ['unsup.dwg'],
};

// Error carrying a translation key so the UI can show it in the current language.
function fail(key, vars, extra) {
  return Object.assign(new Error(key), { i18n: key, vars }, extra);
}

export function extensionOf(name) {
  // Creo versions files as part.prt.3: use the real extension.
  const m = /\.([^.\\/]+?)(?:\.\d+)?$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

const baseName = (p) => decodeURIComponent(String(p)).split(/[\\/]/).pop().split('?')[0].toLowerCase();
const text = (buffer) => new TextDecoder().decode(buffer);

// Resolves file references (textures, .mtl, .bin) to files the user opened alongside.
function managerFor(resources) {
  const manager = new THREE.LoadingManager();
  const urls = new Map();
  manager.setURLModifier((url) => {
    if (/^(data|blob):/.test(url)) return url;
    const key = baseName(url);
    const res = resources?.get(key);
    if (!res) return url;
    if (!urls.has(key)) urls.set(key, URL.createObjectURL(new Blob([res])));
    return urls.get(key);
  });
  return manager;
}

// ---- helpers for non-mesh results ------------------------------------------------------------

function pointsObject(positions, colors, name = 'Points') {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (colors) g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const p = new THREE.Points(g, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: !!colors, color: colors ? 0xffffff : 0x2a5fa8 }));
  p.name = name;
  p.userData.isCloud = true;
  return p;
}

function linesObject(positions, color, name = 'Lines') {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color }));
  l.name = name;
  l.userData.isWire = true;
  return l;
}

function adoptMeshes(object, { keepMaterials = false } = {}) {
  object.traverse((o) => {
    if (o.isPoints) { o.userData.isCloud = true; return; }
    if (o.isLine || o.isLineSegments) { if (!o.userData.isEdges) o.userData.isWire = true; return; }
    if (!o.isMesh) return;
    if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
    if (!keepMaterials) {
      const hasColors = !!o.geometry.attributes.color;
      o.material = partMaterial(null, hasColors);
    } else {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        m.side = THREE.DoubleSide;
        m.polygonOffset = true;
        m.polygonOffsetFactor = 1;
        m.polygonOffsetUnits = 1;
      }
    }
    o.userData.isPart = true;
    addComputedEdges(o);
  });
  return object;
}

// Most scene formats are Y-up; the viewer (like CAD systems) is Z-up.
function zUp(object) {
  const wrapper = new THREE.Group();
  wrapper.add(object);
  wrapper.rotation.x = Math.PI / 2;
  return wrapper;
}

// ---- CATIA -----------------------------------------------------------------------------------

function loadCatia(buffer) {
  const { meshes, info } = parseCATPart(buffer);
  const group = new THREE.Group();
  for (const m of meshes) group.add(makePartMesh(m));
  return { object: group, info };
}

// ---- STEP / IGES / BREP / FreeCAD through OpenCascade (WebAssembly) ----------------------------

let occtPromise = null;
function getOcct() {
  if (!occtPromise) {
    occtPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = OCCT_DIR + 'occt-import-js.js';
      s.onload = () => window.occtimportjs({ locateFile: (f) => OCCT_DIR + f }).then(resolve, reject);
      s.onerror = () => reject(fail('err.occtLoad'));
      document.head.appendChild(s);
    });
    occtPromise.catch(() => { occtPromise = null; });
  }
  return occtPromise;
}

const OCCT_PARAMS = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.35 };

function occtMeshes(result, colorFor) {
  return result.meshes.map((m, i) => {
    const faces = (m.brep_faces || []).map((f) => ({ start: f.first * 3, count: (f.last - f.first + 1) * 3, color: f.color || null }));
    const custom = colorFor?.(i, faces.length);
    if (custom?.faceColors) faces.forEach((f, k) => { f.color = custom.faceColors[k] || f.color; });
    return makePartMesh({
      name: m.name,
      positions: new Float32Array(m.attributes.position.array),
      normals: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
      indices: new Uint32Array(m.index.array),
      color: custom?.color || m.color || null,
      faces,
    });
  });
}

async function loadOcct(buffer, kind) {
  const occt = await getOcct();
  const bytes = new Uint8Array(buffer);
  const result = kind === 'step' ? occt.ReadStepFile(bytes, OCCT_PARAMS) : kind === 'iges' ? occt.ReadIgesFile(bytes, OCCT_PARAMS) : occt.ReadBrepFile(bytes, OCCT_PARAMS);
  if (!result || !result.success || !result.meshes?.length) throw fail('err.occtRead');
  const built = occtMeshes(result);
  // Rebuild the assembly tree so names show up in the model list.
  const build = (node) => {
    const g = new THREE.Group();
    g.name = node.name || '';
    for (const i of node.meshes || []) if (built[i]) g.add(built[i]);
    for (const c of node.children || []) g.add(build(c));
    return g;
  };
  const root = result.root ? build(result.root) : new THREE.Group();
  for (const b of built) if (!b.parent) root.add(b);
  const format = kind === 'step' ? 'STEP' : kind === 'iges' ? 'IGES' : 'OpenCascade BREP';
  const source = kind === 'step' ? { kind: 'step', bytes: buffer } : kind === 'brep' ? { kind: 'brep', text: text(buffer) } : null;
  return { object: root, info: { format, note: 'note.occt' }, source };
}

async function loadFCStd(buffer) {
  const doc = parseFCStd(buffer);
  if (!doc.items.length) throw fail('err.fcstdEmpty');
  const occt = await getOcct();
  const root = new THREE.Group();
  const encoder = new TextEncoder();
  const cache = new Map();
  for (const item of doc.items) {
    let result = cache.get(item.file);
    if (!result) {
      result = occt.ReadBrepFile(encoder.encode(item.brep), OCCT_PARAMS);
      cache.set(item.file, result);
    }
    if (!result?.success || !result.meshes?.length) continue; // wires, points: nothing to shade
    const mats = item.materials;
    const meshes = occtMeshes(result, (i, faceCount) => {
      if (!mats || !mats.length) return null;
      return { color: mats[0].color, faceColors: mats.length === faceCount && mats.length > 1 ? mats.map((m) => m.color) : null };
    });
    const g = new THREE.Group();
    g.name = item.name;
    for (const mesh of meshes) {
      mesh.name = item.name;
      if (mats?.[0]?.transparency > 0.01) {
        mesh.material.transparent = true;
        mesh.material.opacity = Math.max(0.1, 1 - mats[0].transparency);
        mesh.material.depthWrite = false;
      }
      g.add(mesh);
    }
    g.matrixAutoUpdate = false;
    g.matrix.fromArray(item.matrix);
    root.add(g);
  }
  if (!root.children.length) throw fail('err.fcstdEmpty');
  return {
    object: root,
    info: { format: 'FreeCAD', note: doc.hiddenFallback ? 'note.fcstdHidden' : 'note.fcstd' },
    source: { kind: 'brepList', items: doc.items.map((it) => ({ brep: it.brep, matrix: it.matrix })) },
  };
}

// ---- mesh, scene and point formats --------------------------------------------------------------

async function loadStl(buffer) {
  const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
  const mesh = new THREE.Mesh(new STLLoader().parse(buffer));
  mesh.name = 'Mesh';
  return { object: adoptMeshes(mesh), info: { format: 'STL', note: 'note.mesh' } };
}

async function loadObj(buffer, resources, format = 'Wavefront OBJ') {
  const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
  const src = text(buffer);
  const loader = new OBJLoader();
  let keep = false;
  // Materials from a .mtl opened alongside.
  const mtlName = /^mtllib\s+(.+)$/m.exec(src)?.[1]?.trim();
  const mtl = mtlName && resources?.get(baseName(mtlName));
  if (mtl) {
    const { MTLLoader } = await import('three/addons/loaders/MTLLoader.js');
    const materials = new MTLLoader(managerFor(resources)).parse(text(mtl), '');
    materials.preload();
    loader.setMaterials(materials);
    keep = true;
  }
  return { object: adoptMeshes(loader.parse(src), { keepMaterials: keep }), info: { format, note: 'note.mesh' } };
}

async function loadPly(buffer) {
  const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
  const geometry = new PLYLoader().parse(buffer);
  if (!geometry.index && !geometry.attributes.normal) {
    return { object: pointsObject(geometry.attributes.position.array, geometry.attributes.color?.array || null), info: { format: 'PLY', note: 'note.points' } };
  }
  const mesh = new THREE.Mesh(geometry);
  mesh.name = 'Mesh';
  return { object: adoptMeshes(mesh), info: { format: 'PLY', note: 'note.mesh' } };
}

async function load3mf(buffer) {
  const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
  return { object: adoptMeshes(new ThreeMFLoader().parse(buffer)), info: { format: '3MF', note: 'note.mesh' } };
}

async function loadAmf(buffer) {
  const { AMFLoader } = await import('three/addons/loaders/AMFLoader.js');
  return { object: adoptMeshes(new AMFLoader().parse(buffer)), info: { format: 'AMF', note: 'note.mesh' } };
}

async function loadGltf(buffer, resources) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new Promise((resolve, reject) => new GLTFLoader(managerFor(resources)).parse(buffer, '', resolve, reject));
  return { object: adoptMeshes(zUp(gltf.scene), { keepMaterials: true }), info: { format: 'glTF', note: 'note.mesh' } };
}

async function loadCollada(buffer, resources, format = 'Collada') {
  const { ColladaLoader } = await import('three/addons/loaders/ColladaLoader.js');
  const result = new ColladaLoader(managerFor(resources)).parse(text(buffer), '');
  if (!result?.scene) throw fail('err.badFile', { format });
  // The loader converts the file to Y-up metres; the viewer is Z-up millimetres.
  const object = zUp(result.scene);
  object.scale.setScalar(1000);
  return { object: adoptMeshes(object, { keepMaterials: true }), info: { format, note: 'note.mesh' } };
}

async function loadKmz(buffer) {
  const files = unzipSync(new Uint8Array(buffer));
  const resources = new Map(Object.entries(files).map(([k, v]) => [baseName(k), v]));
  const dae = Object.keys(files).find((k) => k.toLowerCase().endsWith('.dae'));
  if (!dae) throw fail('err.badFile', { format: 'KMZ' });
  return loadCollada(files[dae].buffer.slice(files[dae].byteOffset, files[dae].byteOffset + files[dae].byteLength), resources, 'KMZ');
}

async function loadFbx(buffer, resources) {
  const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
  const object = new FBXLoader(managerFor(resources)).parse(buffer, '');
  return { object: adoptMeshes(zUp(object), { keepMaterials: true }), info: { format: 'FBX', note: 'note.mesh' } };
}

async function load3ds(buffer, resources) {
  const { TDSLoader } = await import('three/addons/loaders/TDSLoader.js');
  const object = new TDSLoader(managerFor(resources)).parse(buffer, '');
  return { object: adoptMeshes(object, { keepMaterials: true }), info: { format: '3DS', note: 'note.mesh' } };
}

async function loadVrml(buffer, resources) {
  const { VRMLLoader } = await import('three/addons/loaders/VRMLLoader.js');
  const object = new VRMLLoader(managerFor(resources)).parse(text(buffer), '');
  // CAD exporters (FreeCAD, CATIA, NX) write their own Z-up coordinates into VRML.
  return { object: adoptMeshes(object, { keepMaterials: true }), info: { format: 'VRML', note: 'note.mesh' } };
}

function loadX3d(buffer) {
  const group = new THREE.Group();
  for (const s of parseX3D(text(buffer))) {
    group.add(makePartMesh({ name: 'Shape', positions: s.positions, indices: s.indices, color: s.color }));
  }
  return { object: group, info: { format: 'X3D', note: 'note.mesh' } };
}

function loadOff(buffer) {
  const { positions, indices } = parseOFF(text(buffer));
  return { object: makePartMesh({ name: 'Mesh', positions, indices }), info: { format: 'OFF', note: 'note.mesh' } };
}

async function loadVtk(buffer, ext) {
  const { VTKLoader } = await import('three/addons/loaders/VTKLoader.js');
  // The loader always reads a 250-byte header; pad tiny text files with blank lines.
  if (buffer.byteLength < 256 && !/binary/i.test(text(buffer).slice(0, 200))) {
    const padded = new Uint8Array(256).fill(10);
    padded.set(new Uint8Array(buffer));
    buffer = padded.buffer;
  }
  const geometry = new VTKLoader().parse(buffer, '');
  const format = ext === 'vtp' ? 'VTK (XML)' : 'VTK';
  if (!geometry.index && geometry.attributes.position.count % 3 !== 0) {
    return { object: pointsObject(geometry.attributes.position.array, geometry.attributes.color?.array || null), info: { format, note: 'note.points' } };
  }
  const mesh = new THREE.Mesh(geometry);
  mesh.name = 'Mesh';
  return { object: adoptMeshes(mesh), info: { format, note: 'note.mesh' } };
}

async function loadUsdz(buffer) {
  const { USDZLoader } = await import('three/addons/loaders/USDZLoader.js');
  return { object: adoptMeshes(zUp(new USDZLoader().parse(buffer)), { keepMaterials: true }), info: { format: 'USDZ', note: 'note.mesh' } };
}

async function loadPcd(buffer) {
  const { PCDLoader } = await import('three/addons/loaders/PCDLoader.js');
  const points = new PCDLoader().parse(buffer);
  const g = points.geometry;
  return { object: pointsObject(g.attributes.position.array, g.attributes.color?.array || null), info: { format: 'PCD', note: 'note.points' } };
}

function loadPointsText(buffer, ext) {
  const { positions, colors } = parsePointsText(text(buffer));
  return { object: pointsObject(positions, colors), info: { format: ext.toUpperCase() + ' points', note: 'note.points' } };
}

// ---- DXF, IFC, Rhino ---------------------------------------------------------------------------

function loadDxf(buffer) {
  const src = text(buffer);
  if (/^AutoCAD Binary DXF/.test(src)) throw fail('err.dxfBinary');
  const d = parseDXF(src);
  const root = new THREE.Group();
  for (const [color, pos] of d.lines) if (pos.length) root.add(linesObject(pos, color, 'Lines'));
  for (const [color, pos] of d.faces) {
    if (!pos.length) continue;
    root.add(makePartMesh({ name: 'Faces', positions: pos, color: [((color >> 16) & 255) / 255, ((color >> 8) & 255) / 255, (color & 255) / 255] }));
  }
  if (d.points.length) root.add(pointsObject(d.points, null, 'Points'));
  if (!root.children.length) throw fail('err.dxfEmpty', { skipped: Object.keys(d.skipped).join(', ') || '—' });
  const skipped = Object.entries(d.skipped).filter(([k]) => !/^(TEXT|MTEXT|HATCH|VIEWPORT|LEADER|MLEADER|IMAGE|WIPEOUT)$/.test(k));
  return {
    object: root,
    info: skipped.length
      ? { format: 'DXF', note: 'note.dxf', noteVars: { skipped: skipped.map(([k, n]) => `${k} ×${n}`).join(', ') } }
      : { format: 'DXF', note: 'note.dxfAll' },
  };
}

async function loadIfc(buffer) {
  let WebIFC;
  try {
    WebIFC = await import('/node_modules/web-ifc/web-ifc-api.js');
  } catch {
    throw fail('err.libLoad', { name: 'web-ifc' });
  }
  const api = new WebIFC.IfcAPI();
  api.SetWasmPath('/node_modules/web-ifc/', true);
  await api.Init();
  const id = api.OpenModel(new Uint8Array(buffer));
  const byColor = new Map();
  const m = new THREE.Matrix4();
  const v = new THREE.Vector3();
  api.StreamAllMeshes(id, (mesh) => {
    const list = mesh.geometries;
    for (let i = 0; i < list.size(); i++) {
      const pg = list.get(i);
      const geom = api.GetGeometry(id, pg.geometryExpressID);
      const verts = api.GetVertexArray(geom.GetVertexData(), geom.GetVertexDataSize());
      const idx = api.GetIndexArray(geom.GetIndexData(), geom.GetIndexDataSize());
      m.fromArray(pg.flatTransformation);
      const c = pg.color;
      const key = `${c.x.toFixed(3)},${c.y.toFixed(3)},${c.z.toFixed(3)},${c.w.toFixed(2)}`;
      let bucket = byColor.get(key);
      if (!bucket) byColor.set(key, (bucket = { color: [c.x, c.y, c.z], opacity: c.w, pos: [], idx: [] }));
      const base = bucket.pos.length / 3;
      for (let k = 0; k < verts.length; k += 6) {
        v.set(verts[k], verts[k + 1], verts[k + 2]).applyMatrix4(m);
        bucket.pos.push(v.x * 1000, v.y * 1000, v.z * 1000); // web-ifc works in metres
      }
      for (let k = 0; k < idx.length; k++) bucket.idx.push(base + idx[k]);
      geom.delete?.();
    }
  });
  api.CloseModel(id);
  const group = new THREE.Group();
  for (const b of byColor.values()) {
    const mesh = makePartMesh({ name: 'IFC', positions: new Float32Array(b.pos), indices: new Uint32Array(b.idx), color: b.color });
    if (b.opacity < 0.99) {
      mesh.material.transparent = true;
      mesh.material.opacity = Math.max(0.15, b.opacity);
      mesh.material.depthWrite = false;
    }
    group.add(mesh);
  }
  if (!group.children.length) throw fail('err.badFile', { format: 'IFC' });
  return { object: zUp(group), info: { format: 'IFC', note: 'note.ifc' } };
}

const RHINO_UNITS = { 1: 0.001, 2: 1, 3: 10, 4: 1000, 5: 1e6, 8: 25.4, 9: 304.8, 10: 1609344 };

async function load3dm(buffer) {
  const { Rhino3dmLoader } = await import('three/addons/loaders/3DMLoader.js');
  const loader = new Rhino3dmLoader();
  loader.setLibraryPath('/node_modules/rhino3dm/');
  const object = await new Promise((resolve, reject) => loader.parse(buffer, resolve, (e) => reject(fail('err.libLoad', { name: 'rhino3dm', detail: String(e) }))));
  loader.dispose();
  // Text and annotation sprites only get in the way of a CAD review.
  object.traverse((o) => { if (o.isSprite) o.visible = false; });
  const unit = object.userData?.settings?.modelUnitSystem?.value ?? object.userData?.settings?.modelUnitSystem;
  const scale = RHINO_UNITS[unit] ?? 1;
  if (scale !== 1) object.scale.setScalar(scale);
  return { object: adoptMeshes(object, { keepMaterials: true }), info: { format: 'Rhino 3DM', note: 'note.3dm' } };
}

// ---- archives and proprietary files -----------------------------------------------------------

async function loadZip(buffer, resources, depth) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw fail('err.badFile', { format: 'ZIP' });
  }
  const res = new Map(resources || []);
  for (const [k, v] of Object.entries(files)) res.set(baseName(k), v);
  const group = new THREE.Group();
  const failures = [];
  let sources = 0;
  for (const [path, data] of Object.entries(files)) {
    const ext = extensionOf(path);
    if (path.endsWith('/') || RESOURCE_EXT.has(ext) || !SUPPORTED.includes(ext) || ext === 'norma') continue;
    try {
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const r = await loadModel(path.split('/').pop(), ab, { resources: res, depth: depth + 1 });
      r.object.name = path.split('/').pop();
      group.add(r.object);
      sources++;
    } catch (e) {
      failures.push(path.split('/').pop());
    }
  }
  if (!sources) throw fail('err.zipEmpty');
  return { object: group, info: { format: `ZIP (${sources})`, note: failures.length ? 'note.zipPartial' : 'note.mesh', noteVars: { files: failures.join(', ') } } };
}

function proprietary(ext, buffer) {
  const u8 = new Uint8Array(buffer);
  let preview = findPreview(u8);
  if (!preview && u8[0] === 0x50 && u8[1] === 0x4b) {
    // Zip-based formats (Fusion, 3DXML): look for an image entry.
    try {
      const files = unzipSync(u8);
      const img = Object.keys(files).filter((k) => /\.(png|jpe?g)$/i.test(k)).sort((a, b) => files[b].length - files[a].length)[0];
      if (img) preview = { bytes: files[img], mime: img.toLowerCase().endsWith('png') ? 'image/png' : 'image/jpeg' };
    } catch { /* not a zip after all */ }
  }
  return fail(...PROPRIETARY[ext], preview ? { preview } : undefined);
}

// ---- entry point --------------------------------------------------------------------------------

// options.resources: Map(lower-case file name -> ArrayBuffer) of files opened alongside.
export async function loadModel(name, buffer, options = {}) {
  const ext = extensionOf(name);
  const res = options.resources;
  switch (ext) {
    case 'catpart':
    case 'cgr': return loadCatia(buffer);
    case 'fcstd': return loadFCStd(buffer);
    case 'step':
    case 'stp': return loadOcct(buffer, 'step');
    case 'iges':
    case 'igs': return loadOcct(buffer, 'iges');
    case 'brep':
    case 'brp': return loadOcct(buffer, 'brep');
    case 'stl':
    case 'ast': return loadStl(buffer);
    case 'obj': return loadObj(buffer, res);
    case 'smf': return loadObj(buffer, res, 'SMF');
    case 'ply': return loadPly(buffer);
    case 'off': return loadOff(buffer);
    case '3mf': return load3mf(buffer);
    case 'amf': return loadAmf(buffer);
    case 'gltf':
    case 'glb': return loadGltf(buffer, res);
    case 'dae': return loadCollada(buffer, res);
    case 'kmz': return loadKmz(buffer);
    case 'fbx': return loadFbx(buffer, res);
    case '3ds': return load3ds(buffer, res);
    case 'wrl':
    case 'vrml': return loadVrml(buffer, res);
    case 'x3d': return loadX3d(buffer);
    case 'vtk':
    case 'vtp': return loadVtk(buffer, ext);
    case 'usdz': return loadUsdz(buffer);
    case 'pcd': return loadPcd(buffer);
    case 'xyz':
    case 'asc':
    case 'pts':
    case 'csv':
    case 'txt': return loadPointsText(buffer, ext);
    case 'dxf': return loadDxf(buffer);
    case 'ifc': return loadIfc(buffer);
    case '3dm': return load3dm(buffer);
    case 'zip':
      if ((options.depth || 0) > 2) throw fail('err.zipEmpty');
      return loadZip(buffer, res, options.depth || 0);
    default:
      if (PROPRIETARY[ext]) throw proprietary(ext, buffer);
      throw fail('err.unknown', { ext, list: SUPPORTED.map((e) => '.' + e).join(', ') });
  }
}
