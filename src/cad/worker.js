// Modelling kernel worker: OpenCascade (via replicad) off the UI thread.
import opencascade from '/node_modules/replicad-opencascadejs/dist/replicad_single.js';
import Manifold from '/node_modules/manifold-3d/manifold.js';
import * as R from '/node_modules/replicad/dist/replicad.js';
import { setKernel, evaluate, describe, isMesh } from './build.js';
import { weldMesh, meshToBody } from './meshsolid.js';

const WASM = '/node_modules/replicad-opencascadejs/dist/replicad_single.wasm';

let oc = null;
let mf = null;
const sources = new Map(); // id -> replicad shape (imported bases)
const parts = new Map(); // partId -> { cache, shape }
let nextSource = 1;

async function init() {
  if (oc) return;
  const [o, m] = await Promise.all([opencascade({ locateFile: () => WASM }), Manifold()]);
  m.setup();
  oc = o;
  mf = m;
  R.setOC(oc);
  R.setManifold(mf);
  setKernel(R);
}

function errInfo(err) {
  if (err && err.i18n) return { i18n: err.i18n, vars: err.vars || null, message: err.message };
  // OpenCascade throws WebAssembly exceptions with no message.
  let detail = '';
  try {
    if (oc && typeof oc.getExceptionMessage === 'function' && err instanceof WebAssembly.Exception) {
      detail = oc.getExceptionMessage(err).filter(Boolean).join(': ');
    }
  } catch { /* ignore */ }
  return { i18n: 'k.failed', vars: { detail: detail || err?.message || String(err) }, message: detail || err?.message || String(err) };
}

async function importFile(kind, bytes) {
  if (kind === 'step') return R.importSTEP(new Blob([bytes]));
  throw Object.assign(new Error('unsupported'), { i18n: 'k.noImport' });
}

const handlers = {
  async init() {
    await init();
    return { ok: true };
  },

  // Register a base shape from a file or a mesh. Returns its source id.
  // kind 'step': exact solid from STEP bytes. kind 'mesh': closed triangle mesh
  // (positions + indices, world space) as a mesh body. id restores a saved source.
  async addSource({ kind, bytes, positions, indices, id }) {
    await init();
    let shape;
    if (kind === 'mesh') {
      const w = weldMesh(positions, indices);
      if (w.openEdges || w.nonManifoldEdges) {
        throw Object.assign(new Error('open mesh'), { i18n: 'k.meshOpen', vars: { status: w.openEdges + ' / ' + w.nonManifoldEdges } });
      }
      shape = meshToBody(mf, R, w.positions, w.triangles);
    } else {
      shape = await importFile(kind, bytes);
      if (!shape || !shape.faces || !shape.faces.length) throw Object.assign(new Error('empty'), { i18n: 'k.emptyImport' });
    }
    const sid = id || 's' + nextSource++ + '-' + Date.now().toString(36);
    sources.set(sid, shape);
    return { id: sid, mesh: isMesh(shape) };
  },

  // Data needed to save a source in a project file.
  async sourceData({ id }) {
    await init();
    const s = sources.get(id);
    if (!s) throw Object.assign(new Error('no source'), { i18n: 'k.noSource' });
    if (isMesh(s)) {
      const d = describe(s);
      return { kind: 'mesh', positions: d.vertices, indices: d.triangles, __transfer: [d.vertices.buffer, d.triangles.buffer] };
    }
    const bytes = await s.blobSTEP().arrayBuffer();
    return { kind: 'step', bytes, __transfer: [bytes] };
  },

  // Snapshot a part's current result as a new source (used to combine parts).
  async snapshot({ partId }) {
    const p = parts.get(partId);
    if (!p || !p.shape) throw Object.assign(new Error('no body'), { i18n: 'k.noBody' });
    const id = 's' + nextSource++ + '-' + Date.now().toString(36);
    sources.set(id, p.shape.clone());
    return { id };
  },

  async build({ partId, features }) {
    await init();
    const prev = parts.get(partId);
    const t0 = performance.now();
    const res = evaluate(features, sources, prev?.cache || null);
    const ms = Math.round(performance.now() - t0);
    parts.set(partId, { cache: res.cache, shape: res.shape });
    const status = res.status.map((e) => (e ? errInfo(e) : null));
    if (!res.shape) return { status, body: null, ms };
    const body = describe(res.shape);
    const transfer = [body.vertices.buffer, body.normals.buffer, body.triangles.buffer, body.lines.buffer];
    return { status, body, ms, __transfer: transfer };
  },

  async exportPart({ partId, format }) {
    const p = parts.get(partId);
    if (!p || !p.shape) throw Object.assign(new Error('no body'), { i18n: 'k.noBody' });
    if (format === 'step' && isMesh(p.shape)) throw Object.assign(new Error('mesh'), { i18n: 'k.stepMesh' });
    const blob = format === 'stl' ? p.shape.blobSTL({ binary: true }) : p.shape.blobSTEP();
    const buf = await blob.arrayBuffer();
    return { bytes: buf, __transfer: [buf] };
  },

  async dropPart({ partId }) {
    parts.delete(partId);
    return { ok: true };
  },
};

self.onmessage = async (e) => {
  const { id, cmd, args } = e.data;
  try {
    const h = handlers[cmd];
    if (!h) throw new Error('unknown command ' + cmd);
    const result = await h(args || {});
    const transfer = result.__transfer || [];
    delete result.__transfer;
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    console.error(err);
    self.postMessage({ id, ok: false, error: errInfo(err) });
  }
};
