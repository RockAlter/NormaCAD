// File format dispatch. Every loader resolves to { object: THREE.Object3D, info: {format, ...} }.
import * as THREE from 'three';
import { parseCATPart } from './catpart.js';
import { makePartMesh, partMaterial, addComputedEdges } from '../meshkit.js';

const OCCT_DIR = '/node_modules/occt-import-js/dist/';

export const SUPPORTED = ['catpart', 'cgr', 'step', 'stp', 'iges', 'igs', 'brep', 'brp', 'stl', 'obj', 'ply', '3mf', 'gltf', 'glb'];

// Proprietary formats we recognise but cannot read, with the practical way forward.
// Values are [translation key, variables]; the text lives in i18n.js.
const UNSUPPORTED = {
  catproduct: ['unsup.catproduct'],
  catdrawing: ['unsup.catdrawing'],
  sldprt: ['unsup.proprietary', { name: 'SolidWorks' }],
  sldasm: ['unsup.proprietary', { name: 'SolidWorks' }],
  ipt: ['unsup.proprietary', { name: 'Inventor' }],
  iam: ['unsup.proprietary', { name: 'Inventor' }],
  prt: ['unsup.proprietary', { name: 'NX / Creo' }],
  asm: ['unsup.proprietary', { name: 'Creo' }],
  f3d: ['unsup.proprietary', { name: 'Fusion' }],
  x_t: ['unsup.notyet', { name: 'Parasolid' }],
  x_b: ['unsup.notyet', { name: 'Parasolid' }],
  sat: ['unsup.notyet', { name: 'ACIS' }],
  jt: ['unsup.notyet', { name: 'JT' }],
  '3dm': ['unsup.notyet', { name: 'Rhino' }],
  dwg: ['unsup.2d', { name: 'DWG' }],
  dxf: ['unsup.2d', { name: 'DXF' }],
};

// Error carrying a translation key so the UI can show it in the current language.
function fail(key, vars) {
  return Object.assign(new Error(key), { i18n: key, vars });
}

export function extensionOf(name) {
  const m = /\.([^.\\/]+)$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

// ---- CATIA -----------------------------------------------------------------------------------

function loadCatia(buffer) {
  const { meshes, info } = parseCATPart(buffer);
  const group = new THREE.Group();
  for (const m of meshes) group.add(makePartMesh(m));
  return { object: group, info };
}

// ---- STEP / IGES / BREP through OpenCascade (WebAssembly) ---------------------------------------

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

async function loadOcct(buffer, kind) {
  const occt = await getOcct();
  const bytes = new Uint8Array(buffer);
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.35 };
  const result = kind === 'step' ? occt.ReadStepFile(bytes, params) : kind === 'iges' ? occt.ReadIgesFile(bytes, params) : occt.ReadBrepFile(bytes, params);
  if (!result || !result.success || !result.meshes?.length) {
    throw fail('err.occtRead');
  }

  const built = result.meshes.map((m) => {
    const faces = (m.brep_faces || []).map((f) => ({ start: f.first * 3, count: (f.last - f.first + 1) * 3, color: f.color || null }));
    return makePartMesh({
      name: m.name,
      positions: new Float32Array(m.attributes.position.array),
      normals: m.attributes.normal ? new Float32Array(m.attributes.normal.array) : null,
      indices: new Uint32Array(m.index.array),
      color: m.color || null,
      faces,
    });
  });

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
  return { object: root, info: { format, note: 'note.occt' } };
}

// ---- Mesh formats through three.js loaders ----------------------------------------------------

function adoptMeshes(object, { keepMaterials = false } = {}) {
  object.traverse((o) => {
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

async function loadStl(buffer) {
  const { STLLoader } = await import('three/addons/loaders/STLLoader.js');
  const geometry = new STLLoader().parse(buffer);
  const mesh = new THREE.Mesh(geometry);
  mesh.name = 'Mesh';
  return { object: adoptMeshes(mesh), info: { format: 'STL', note: 'note.mesh' } };
}

async function loadObj(buffer) {
  const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
  const object = new OBJLoader().parse(new TextDecoder().decode(buffer));
  return { object: adoptMeshes(object), info: { format: 'Wavefront OBJ', note: 'note.mesh' } };
}

async function loadPly(buffer) {
  const { PLYLoader } = await import('three/addons/loaders/PLYLoader.js');
  const geometry = new PLYLoader().parse(buffer);
  if (!geometry.index && !geometry.attributes.normal) throw fail('err.plyCloud');
  const mesh = new THREE.Mesh(geometry);
  mesh.name = 'Mesh';
  return { object: adoptMeshes(mesh), info: { format: 'PLY', note: 'note.mesh' } };
}

async function load3mf(buffer) {
  const { ThreeMFLoader } = await import('three/addons/loaders/3MFLoader.js');
  const object = new ThreeMFLoader().parse(buffer);
  return { object: adoptMeshes(object), info: { format: '3MF', note: 'note.mesh' } };
}

async function loadGltf(buffer) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const gltf = await new Promise((resolve, reject) => new GLTFLoader().parse(buffer, '', resolve, reject));
  const wrapper = new THREE.Group();
  wrapper.add(gltf.scene);
  wrapper.rotation.x = Math.PI / 2; // glTF is Y-up; the viewer is Z-up like CAD systems
  return { object: adoptMeshes(wrapper, { keepMaterials: true }), info: { format: 'glTF', note: 'note.mesh' } };
}

// ---- Entry point --------------------------------------------------------------------------------

export async function loadModel(name, buffer) {
  const ext = extensionOf(name);
  switch (ext) {
    case 'catpart':
    case 'cgr':
      return loadCatia(buffer);
    case 'step':
    case 'stp':
      return loadOcct(buffer, 'step');
    case 'iges':
    case 'igs':
      return loadOcct(buffer, 'iges');
    case 'brep':
    case 'brp':
      return loadOcct(buffer, 'brep');
    case 'stl':
      return loadStl(buffer);
    case 'obj':
      return loadObj(buffer);
    case 'ply':
      return loadPly(buffer);
    case '3mf':
      return load3mf(buffer);
    case 'gltf':
    case 'glb':
      return loadGltf(buffer);
    default:
      if (UNSUPPORTED[ext]) throw fail(...UNSUPPORTED[ext]);
      throw fail('err.unknown', { ext, list: SUPPORTED.map((e) => '.' + e).join(', ') });
  }
}
