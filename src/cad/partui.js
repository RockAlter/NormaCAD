// Modelling UI: parts with a feature history, feature dialogs, picking and the sketcher.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { call, startKernel } from './kernel.js';
import { CREATE, MODIFY, FIELDS, LABELS, TOOL_FEATURES, EXACT_ONLY, defaults, toEngine, summary, niceStep } from './features.js';
import { evalExpr, paramValues, applyExprs, validName } from './expr.js';
import { SHEETS, buildSheet, buildDXF } from './drawing.js';
import { partMaterial, addComputedEdges } from '../meshkit.js';
import { t, errorText } from '../i18n.js';

const $ = (id) => document.getElementById(id);
const PART_COLOR = new THREE.Color(0x9fb3c8);
const PICK_COLOR = 0xff8a1f;

let ctx = null; // provided by main.js
let nextPart = 1;
let dialog = null; // open feature dialog state
const overlay = new THREE.Group(); // sketch plane, profile, pick highlights
overlay.renderOrder = 5;

export function isPart(model) {
  return !!model && model.kind === 'part';
}

// =================================================================================================
// Setup
// =================================================================================================

export function initParts(context) {
  ctx = context;
  ctx.scene.add(overlay);
  buildMenu('menu-create', CREATE, (type) => startFeature(type));
  buildMenu('menu-modify', MODIFY, (type) => startFeature(type));
  for (const [id, fn] of [
    ['part-new', () => newPart()],
    ['part-editable', () => makeEditable(ctx.getActive())],
    ['part-combine', () => openCombine()],
    ['part-params', () => openParams()],
    ['part-drawing', () => openDrawing()],
    ['part-save', () => saveProject()],
  ]) $(id).addEventListener('click', () => { closeMenus(); fn(); });
  for (const id of ['btn-part', 'btn-create', 'btn-modify']) {
    $(id).addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = $(id.replace('btn-', 'menu-'));
      const open = menu.hidden;
      closeMenus();
      menu.hidden = !open;
    });
  }
  document.addEventListener('click', closeMenus);

  // Sketch drawing and picking get the pointer before the camera controls do.
  ctx.viewport.addEventListener('pointerdown', onPointerDown, true);
  ctx.viewport.addEventListener('pointermove', onPointerMove, true);
  ctx.viewport.addEventListener('pointerup', onPointerUp, true);
  ctx.viewport.addEventListener('dblclick', onDoubleClick, true);
}

function closeMenus() {
  for (const id of ['menu-part', 'menu-create', 'menu-modify']) $(id).hidden = true;
}

function buildMenu(id, items, onPick) {
  const menu = $(id);
  menu.replaceChildren();
  for (const type of items) {
    if (type === '-') {
      const hr = document.createElement('hr');
      menu.append(hr);
      continue;
    }
    const b = document.createElement('button');
    b.dataset.i18n = 'f.' + type;
    b.textContent = t('f.' + type);
    b.addEventListener('click', () => { closeMenus(); onPick(type); });
    menu.append(b);
  }
}

// =================================================================================================
// Parts
// =================================================================================================

function createPartModel(name, features = []) {
  const id = 'p' + nextPart++ + '-' + Date.now().toString(36);
  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.userData.home = { p: pivot.position.clone(), q: pivot.quaternion.clone(), s: pivot.scale.clone() };
  const model = {
    id: ctx.nextModelId(),
    name,
    format: t('partFormat'),
    info: { note: 'note.part' },
    object: pivot,
    parts: [],
    bytes: 0,
    kind: 'part',
    part: { id, features, params: [], status: [], body: null, density: 7.85, seq: 0, color: PART_COLOR.clone() },
  };
  ctx.registerModel(model);
  return model;
}

async function withKernel(fn) {
  ctx.busy(t('k.loading'));
  try {
    await startKernel();
    return await fn();
  } catch (err) {
    console.error(err);
    ctx.toast(t('k.error'), errorText(err));
    return null;
  } finally {
    ctx.busy(null);
  }
}

function newPart() {
  const n = ctx.models.filter(isPart).length + 1;
  const m = createPartModel(t('partName', { n }));
  ctx.setActive(m);
  return m;
}

function activePart() {
  const m = ctx.getActive();
  return isPart(m) ? m : null;
}

function sanitize(f) {
  const out = {};
  for (const k of Object.keys(f)) if (!k.startsWith('_')) out[k] = f[k];
  return out;
}

// Formulas are resolved here, so the kernel only ever sees plain numbers.
function engineFeatures(features, params) {
  const { vars } = paramValues(params);
  return features.map((f) => toEngine(applyExprs(sanitize(f), vars)));
}

// Rebuild a part from a feature list (defaults to its own) and show the result.
async function rebuild(model, features = model.part.features, { fitView = false } = {}) {
  const part = model.part;
  const seq = ++part.seq;
  part.building = true;
  ctx.setStatus(t('k.building'));
  let res;
  try {
    await startKernel();
    res = await call('build', { partId: part.id, features: engineFeatures(features, part.params) });
  } catch (err) {
    if (seq === part.seq) {
      part.building = false;
      ctx.setStatus('');
      ctx.toast(t('k.error'), errorText(err));
    }
    return null;
  }
  if (seq !== part.seq || !ctx.models.includes(model)) return null; // superseded or closed
  part.building = false;
  ctx.setStatus(t('k.built', { ms: res.ms }));
  part.status = res.status;
  part.body = res.body;
  showBody(model, res.body);
  if (fitView && res.body) ctx.fit(null, model.box);
  return res;
}

function disposeChildren(group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((o) => {
      o.geometry?.dispose();
      if (o.material && o.material !== PICK_MATERIAL) for (const m of [].concat(o.material)) m.dispose();
    });
  }
}

function showBody(model, body) {
  const pivot = model.object;
  if (ctx.getSelection()?.model === model) ctx.clearSelection();
  disposeChildren(pivot);
  if (body) {
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(body.vertices, 3));
    g.setIndex(new THREE.BufferAttribute(body.triangles, 1));
    if (body.normals.length) g.setAttribute('normal', new THREE.BufferAttribute(body.normals, 3));
    else {
      // Mesh bodies: sharp edges stay sharp, curved areas stay smooth.
      g = toCreasedNormals(g, (35 * Math.PI) / 180);
    }
    const mesh = new THREE.Mesh(g, partMaterial(model.part.color));
    mesh.name = model.name;
    mesh.userData.isPart = true;
    mesh.userData.partModel = model;
    if (!body.mesh) {
      mesh.userData.faces = body.faceGroups
        .map((gr) => ({ start: gr.start, count: gr.count, face: gr.face, planar: body.faces[gr.face]?.type === 'PLANE' }))
        .sort((a, b) => a.start - b.start);
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.BufferAttribute(body.lines, 3));
      const lines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x14181f }));
      lines.userData.isEdges = true;
      // Segment -> CAD edge, for picking.
      const segEdge = new Int32Array(body.lines.length / 6).fill(-1);
      for (const gr of body.edgeGroups) for (let p = gr.start; p < gr.start + gr.count; p += 2) segEdge[p / 2] = gr.edge;
      lines.userData.segEdge = segEdge;
      lines.raycast = () => {}; // picked explicitly, never by the face picker
      mesh.add(lines);
    } else {
      addComputedEdges(mesh, 35);
    }
    pivot.add(mesh);
  }
  ctx.refreshModel(model);
  ctx.applyDisplayMode();
  ctx.refreshModelList();
  ctx.showProps();
  refreshOverlay();
  ctx.requestRender();
}

// Replace a part's feature list as one undoable step.
function setFeatures(model, features, label = '') {
  const before = model.part.features;
  const apply = (list) => {
    model.part.features = list;
    rebuild(model);
  };
  ctx.pushCommand({ undo: () => apply(before), redo: () => apply(features), label });
  apply(features);
}

function partContext(model) {
  const body = model?.part?.body;
  const box = body ? body.props.bbox : null;
  const min = box ? box[0] : [0, 0, 0];
  const max = box ? box[1] : [0, 0, 0];
  const size = box ? Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) : 100;
  let lastTool = null;
  const feats = model?.part?.features || [];
  for (let i = feats.length - 1; i >= 0; i--) if (TOOL_FEATURES.has(feats[i].type)) { lastTool = i; break; }
  return {
    hasBody: !!body,
    min, max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: size || 100,
    lastTool,
    mesh: !!body?.mesh,
  };
}

// =================================================================================================
// Make editable, combine
// =================================================================================================

function worldMesh(model) {
  const positions = [];
  const indices = [];
  const v = new THREE.Vector3();
  for (const mesh of model.parts) {
    mesh.updateWorldMatrix(true, false);
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const base = positions.length / 3;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
      positions.push(v.x, v.y, v.z);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) indices.push(base + g.index.getX(i));
    else for (let i = 0; i < pos.count; i++) indices.push(base + i);
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

function hasIdentityPose(model) {
  const o = model.object;
  const h = o.userData.home;
  return !h || (o.position.equals(h.p) && o.quaternion.equals(h.q) && o.scale.equals(h.s));
}

// A source in the kernel for a loaded model: exact for STEP files, mesh otherwise.
async function sourceFor(model) {
  if (isPart(model)) {
    const r = await call('snapshot', { partId: model.part.id });
    return { id: r.id, mesh: !!model.part.body?.mesh };
  }
  if (model.sourceBytes && model.sourceKind === 'step' && hasIdentityPose(model)) {
    const bytes = model.sourceBytes.slice(0);
    return call('addSource', { kind: 'step', bytes }, [bytes]);
  }
  const { positions, indices } = worldMesh(model);
  return call('addSource', { kind: 'mesh', positions, indices }, [positions.buffer, indices.buffer]);
}

async function makeEditable(model) {
  if (!model) { ctx.toast(t('e.needModel')); return; }
  if (isPart(model)) { ctx.toast(t('k.alreadyPart')); return; }
  const res = await withKernel(() => sourceFor(model));
  if (!res) return;
  const part = createPartModel(t('editableName', { name: model.name }), [{ type: 'import', source: res.id, name: model.name, op: 'add' }]);
  model.object.visible = false;
  ctx.refreshModelList();
  ctx.setActive(part);
  await rebuild(part);
  if (res.mesh) ctx.toast(t('k.meshPartTitle'), t('k.meshPart'));
}

function openCombine() {
  const target = activePart();
  if (!target) { ctx.toast(t('k.needPart')); return; }
  const others = ctx.models.filter((m) => m !== target);
  if (!others.length) { ctx.toast(t('k.needOther')); return; }
  openDialog({
    model: target,
    title: t('combine'),
    custom: (body) => {
      const sel = selectEl(others.map((m) => [String(m.id), m.name]), String(others[0].id));
      const op = selectEl([['add', t('op.add')], ['cut', t('op.cut')], ['intersect', t('op.intersect')]], 'add');
      body.append(row(t('p.other'), sel), row(t('p.op'), op));
      return async () => {
        const other = others.find((m) => String(m.id) === sel.value);
        const res = await withKernel(() => sourceFor(other));
        if (!res) return false;
        setFeatures(target, [...target.part.features, { type: 'import', source: res.id, name: other.name, op: op.value }]);
        other.object.visible = false;
        ctx.refreshModelList();
        return true;
      };
    },
  });
}

// =================================================================================================
// Feature dialogs
// =================================================================================================

function startFeature(type) {
  let model = activePart();
  if (!model) {
    if (MODIFY.includes(type)) { ctx.toast(t('k.needPart')); return; }
    model = newPart();
  }
  if (EXACT_ONLY.has(type) && model.part.body?.mesh) { ctx.toast(t('k.error'), t('k.needExact')); return; }
  const pc = partContext(model);
  if ((type === 'linearPattern' || type === 'polarPattern') && pc.lastTool == null) { ctx.toast(t('k.error'), t('k.patternSource')); return; }
  const draft = { type, ...defaults(type, pc) };
  openFeatureDialog(model, draft, model.part.features.length, true);
}

function editFeature(model, index) {
  if (!ctx.isEditing()) return;
  const draft = JSON.parse(JSON.stringify(model.part.features[index]));
  openFeatureDialog(model, draft, index, false);
}

function openFeatureDialog(model, draft, index, isNew) {
  const pick = FIELDS[draft.type]?.find((f) => ['edges', 'faces', 'point'].includes(f[1]))?.[1] || null;
  openDialog({
    model,
    title: t('f.' + draft.type),
    draft,
    index,
    isNew,
    pick: pick && (isNew || !hasRefs(draft, pick)) ? pick : null,
    pickKind: pick,
    onOk: () => {
      const list = model.part.features.slice();
      const f = sanitize(dialog.draft);
      if (isNew) list.push(f);
      else list[index] = f;
      setFeatures(model, list);
      return true;
    },
  });
}

function hasRefs(draft, kind) {
  if (kind === 'point') return !!draft.p;
  return (draft[kind] || []).length > 0;
}

function openDialog(spec) {
  closeDialog(false);
  dialog = { ...spec, previewTimer: 0, tool: null, temp: null };
  const panel = $('feature-panel');
  panel.replaceChildren();
  panel.hidden = false;
  $('props').hidden = true;

  const h = document.createElement('h3');
  h.textContent = spec.title;
  const body = document.createElement('div');
  body.className = 'fp-body';
  const msg = document.createElement('p');
  msg.className = 'fp-msg';
  msg.id = 'fp-msg';
  const actions = document.createElement('div');
  actions.className = 'fp-actions';
  const ok = document.createElement('button');
  ok.className = 'primary';
  ok.textContent = t('ok');
  const cancel = document.createElement('button');
  cancel.textContent = t('cancel');
  actions.append(ok, cancel);
  panel.append(h, body, msg, actions);

  let commit = spec.onOk;
  if (spec.custom) commit = spec.custom(body);
  else renderFields(body);

  ok.addEventListener('click', async () => {
    const done = await commit();
    if (done !== false) closeDialog(false);
  });
  cancel.addEventListener('click', () => closeDialog(true));
  if (spec.draft) schedulePreview(0);
  ctx.requestRender();
}

export function closeDialog(restore = true) {
  if (!dialog) return;
  const d = dialog;
  dialog = null;
  clearTimeout(d.previewTimer);
  setTool(null, d);
  $('feature-panel').hidden = true;
  $('feature-panel').replaceChildren();
  $('props').hidden = false;
  ctx.setCursor('');
  overlay.clear();
  if (restore && d.model && ctx.models.includes(d.model)) rebuild(d.model);
  ctx.showProps();
  ctx.requestRender();
}

export function dialogOpen() {
  return !!dialog;
}

// While picking references the part is shown without the feature being edited, so the
// picked faces / edges are the ones the feature will act on.
function schedulePreview(delay = 250) {
  if (!dialog || !dialog.draft) return;
  clearTimeout(dialog.previewTimer);
  dialog.previewTimer = setTimeout(async () => {
    if (!dialog) return;
    const d = dialog;
    const base = d.model.part.features.slice(0, d.index);
    const rest = d.isNew ? [] : d.model.part.features.slice(d.index + 1);
    const list = d.pick ? base : [...base, d.draft, ...rest];
    const res = await rebuild(d.model, list);
    if (dialog !== d || !res) return;
    const err = d.pick ? null : res.status[d.index];
    const msg = $('fp-msg');
    if (msg) {
      msg.textContent = err ? errorText(err) : d.pick ? t('pick.' + d.pick) : '';
      msg.classList.toggle('err', !!err);
    }
    refreshOverlay();
  }, delay);
}

// ---- form building -----------------------------------------------------------------------------

function row(label, ...controls) {
  const r = document.createElement('label');
  r.className = 'fp-row';
  const s = document.createElement('span');
  s.textContent = label;
  r.append(s, ...controls);
  return r;
}

function numInput(value, onChange, step = 'any') {
  const i = document.createElement('input');
  i.type = 'number';
  i.step = step;
  i.value = Number.isFinite(value) ? String(+(+value).toFixed(4)) : '';
  i.addEventListener('input', () => {
    const v = parseFloat(i.value);
    if (Number.isFinite(v)) onChange(v);
  });
  return i;
}

function selectEl(options, value) {
  const s = document.createElement('select');
  for (const [v, label] of options) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    s.append(o);
  }
  s.value = value;
  return s;
}

function checkEl(value, onChange) {
  const c = document.createElement('input');
  c.type = 'checkbox';
  c.checked = !!value;
  c.addEventListener('change', () => onChange(c.checked));
  return c;
}

function button(label, onClick, cls = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (cls) b.className = cls;
  b.addEventListener('click', (e) => { e.preventDefault(); onClick(b); });
  return b;
}

// A number box that also takes a formula such as "=width / 2".
function exprInput(obj, key, onChange) {
  const i = document.createElement('input');
  i.type = 'text';
  i.inputMode = 'decimal';
  i.className = 'num';
  i.spellcheck = false;
  const show = (v) => (Number.isFinite(v) ? String(+(+v).toFixed(4)) : '');
  i.value = obj.expr?.[key] ? '=' + obj.expr[key] : show(obj[key]);
  i.title = obj.expr?.[key] ? show(obj[key]) : t('expr.hint');
  i.addEventListener('input', () => {
    const text = i.value.trim();
    try {
      const v = evalExpr(text, paramValues(dialog.model.part.params).vars);
      if (text.startsWith('=')) obj.expr = { ...obj.expr, [key]: text.slice(1).trim() };
      else if (obj.expr) { delete obj.expr[key]; if (!Object.keys(obj.expr).length) delete obj.expr; }
      obj[key] = v;
      i.classList.remove('bad');
      i.title = text.startsWith('=') ? show(v) : t('expr.hint');
      onChange(v);
    } catch {
      i.classList.add('bad');
    }
  });
  return i;
}

function renderFields(body) {
  const d = dialog.draft;
  const changed = () => { schedulePreview(); refreshOverlay(); };
  const fields = FIELDS[d.type] || [];
  const conditional = fields.some((f) => f[3]);
  const rerender = () => { body.replaceChildren(); renderFields(body); changed(); };
  for (const [key, kind, options, when] of fields) {
    if (when && !when(d)) continue;
    const label = t(LABELS[d.type + '.' + key] || 'p.' + key);
    if (kind === 'num') {
      body.append(row(label, exprInput(d, key, changed)));
    } else if (kind === 'text') {
      const ta = document.createElement('textarea');
      ta.rows = 3;
      ta.value = d[key] || '';
      ta.title = t('p.ptsHint');
      ta.addEventListener('input', () => { d[key] = ta.value; changed(); });
      body.append(row(label, ta));
    } else if (kind === 'vec3') {
      const wrap = document.createElement('span');
      wrap.className = 'vec3';
      const v = d[key] || [0, 0, 0];
      d[key] = v;
      ['X', 'Y', 'Z'].forEach((axis, i) => {
        const inp = numInput(v[i], (x) => { v[i] = x; changed(); });
        inp.title = axis;
        inp.setAttribute('aria-label', `${label} ${axis}`);
        wrap.append(inp);
      });
      body.append(row(label, wrap));
    } else if (kind === 'select') {
      const s = selectEl(options.map(([v, l]) => [v, l.includes('.') ? t(l) : l]), d[key]);
      s.addEventListener('change', () => { d[key] = s.value; if (conditional) rerender(); else changed(); });
      body.append(row(label, s));
    } else if (kind === 'check') {
      body.append(row(label, checkEl(d[key], (v) => { d[key] = v; changed(); })));
    } else if (kind === 'source') {
      const feats = dialog.model.part.features;
      const opts = [];
      feats.forEach((f, i) => { if (TOOL_FEATURES.has(f.type) && i < dialog.index) opts.push([String(i), `${i + 1}. ${summary(f, t)}`]); });
      const s = selectEl(opts, String(d[key]));
      s.addEventListener('change', () => { d[key] = Number(s.value); changed(); });
      body.append(row(label, s));
    } else if (kind === 'edges' || kind === 'faces' || kind === 'point') {
      body.append(refsRow(kind));
    } else if (kind === 'sketch') {
      body.append(sketchEditor());
    }
  }
}

function refsRow(kind) {
  const d = dialog.draft;
  const wrap = document.createElement('div');
  wrap.className = 'fp-refs';
  const count = document.createElement('span');
  const update = () => {
    if (kind === 'point') count.textContent = d.p ? `${d.p.map((v) => v.toFixed(1)).join(', ')}` : t('pick.none');
    else count.textContent = t('pick.count.' + kind, { n: (d[kind] || []).length });
  };
  update();
  dialog.updateRefs = update;
  const pickBtn = button(t('pick.button'), (b) => {
    dialog.pick = dialog.pick ? null : kind;
    b.classList.toggle('on', !!dialog.pick);
    ctx.setCursor(dialog.pick ? 'crosshair' : '');
    schedulePreview(0);
  }, 'toggle' + (dialog.pick ? ' on' : ''));
  const clearBtn = button(t('clear'), () => {
    if (kind === 'point') { d.p = null; d.normal = null; } else d[kind] = [];
    update();
    schedulePreview(0);
    refreshOverlay();
  });
  if (dialog.pick) ctx.setCursor('crosshair');
  wrap.append(count, pickBtn, clearBtn);
  return row(t(LABELS[d.type + '.' + kind] || 'p.' + kind), wrap);
}

// ---- sketch editor ---------------------------------------------------------------------------

function sketchEditor() {
  const sk = dialog.draft.sketch;
  const box = document.createElement('div');
  box.className = 'sketch';

  // Plane
  const planeSel = selectEl([['XY', 'XY'], ['XZ', 'XZ'], ['YZ', 'YZ'], ['face', t('sk.face')]], typeof sk.plane === 'string' ? sk.plane : 'face');
  planeSel.addEventListener('change', () => {
    if (planeSel.value === 'face') { dialog.pick = 'plane'; ctx.setCursor('crosshair'); setMsg(t('pick.plane')); schedulePreview(0); }
    else { sk.plane = planeSel.value; dialog.pick = null; ctx.setCursor(''); schedulePreview(); refreshOverlay(); }
  });
  dialog.planeSel = planeSel;
  const offset = numInput(sk.offset || 0, (v) => { sk.offset = v; schedulePreview(); refreshOverlay(); });
  const look = button(t('sk.look'), () => lookAtSketch());
  box.append(row(t('sk.plane'), planeSel, look), row(t('p.offset'), offset));

  // Drawing tools
  const tools = document.createElement('div');
  tools.className = 'sk-tools';
  for (const tool of ['rect', 'circle', 'polyline']) {
    const b = button(t('sk.draw.' + tool), () => setTool(dialog.tool === tool ? null : tool), 'toggle');
    b.dataset.tool = tool;
    tools.append(b);
  }
  const snap = numInput(sk.snap || niceStep(partContext(dialog.model).size), (v) => { sk.snap = v > 0 ? v : 0; });
  snap.className = 'snap';
  snap.title = t('sk.snap');
  tools.append(snap);
  box.append(row(t('sk.draw'), tools));

  // Add by numbers
  const adds = document.createElement('div');
  adds.className = 'sk-tools';
  for (const type of ['rect', 'circle', 'polygon', 'slot', 'polyline']) {
    adds.append(button('+ ' + t('sk.' + type), () => { addShape(newShape(type)); }));
  }
  box.append(row(t('sk.add'), adds));

  const list = document.createElement('div');
  list.className = 'sk-list';
  dialog.shapeList = list;
  box.append(list);
  renderShapes();
  return box;
}

function setMsg(text, err = false) {
  const m = $('fp-msg');
  if (m) { m.textContent = text; m.classList.toggle('err', err); }
}

function newShape(type) {
  const s = dialog.draft.sketch.snap || niceStep(partContext(dialog.model).size);
  switch (type) {
    case 'rect': return { type, cx: 0, cy: 0, w: s * 10, h: s * 6, r: 0 };
    case 'circle': return { type, cx: 0, cy: 0, r: s * 3 };
    case 'polygon': return { type, cx: 0, cy: 0, r: s * 3, n: 6 };
    case 'slot': return { type, x1: -s * 3, y1: 0, x2: s * 3, y2: 0, r: s };
    default: return { type: 'polyline', pts: [[0, 0], [s * 10, 0], [0, s * 6]] };
  }
}

function addShape(shape) {
  const sk = dialog.draft.sketch;
  // A shape whose centre lies inside an existing one starts as a hole.
  const c = shapeCenter(shape);
  if (sk.shapes.some((o) => !o.hole && pointInLoop(c, outline(o)))) shape.hole = true;
  sk.shapes.push(shape);
  renderShapes();
  schedulePreview();
  refreshOverlay();
}

const SHAPE_FIELDS = {
  rect: ['cx', 'cy', 'w', 'h', 'r', 'angle'],
  circle: ['cx', 'cy', 'r'],
  polygon: ['cx', 'cy', 'r', 'n', 'angle'],
  slot: ['x1', 'y1', 'x2', 'y2', 'r'],
};

function renderShapes() {
  const list = dialog.shapeList;
  if (!list) return;
  list.replaceChildren();
  const sk = dialog.draft.sketch;
  sk.shapes.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'sk-shape';
    const head = document.createElement('div');
    head.className = 'sk-head';
    const name = document.createElement('strong');
    name.textContent = `${i + 1}. ${t('sk.' + s.type)}`;
    const hole = document.createElement('label');
    hole.className = 'sk-hole';
    hole.append(checkEl(s.hole, (v) => { s.hole = v; schedulePreview(); refreshOverlay(); }), document.createTextNode(t('sk.hole')));
    const del = button('✕', () => { sk.shapes.splice(i, 1); renderShapes(); schedulePreview(); refreshOverlay(); });
    del.className = 'icon';
    del.title = t('delete');
    head.append(name, hole, del);
    card.append(head);
    const grid = document.createElement('div');
    grid.className = 'sk-grid';
    if (s.type === 'polyline') {
      const ta = document.createElement('textarea');
      ta.rows = 2;
      ta.value = s.pts.map((p) => `${+p[0].toFixed(3)}, ${+p[1].toFixed(3)}`).join('; ');
      ta.title = t('sk.ptsHint');
      ta.addEventListener('change', () => {
        const pts = ta.value.split(/[;\n]/).map((x) => x.split(',').map(Number)).filter((p) => p.length === 2 && p.every(Number.isFinite));
        if (pts.length >= 3) { s.pts = pts; schedulePreview(); refreshOverlay(); }
      });
      grid.append(ta);
    } else {
      for (const k of SHAPE_FIELDS[s.type]) {
        const l = document.createElement('label');
        l.textContent = t('sk.f.' + k);
        s[k] ??= 0;
        l.append(exprInput(s, k, () => { schedulePreview(); refreshOverlay(); }));
        grid.append(l);
      }
    }
    card.append(grid);
    list.append(card);
  });
  if (!sk.shapes.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('sk.empty');
    list.append(p);
  }
}

function setTool(tool, d = dialog) {
  if (!d) return;
  d.tool = tool;
  d.temp = null;
  for (const b of document.querySelectorAll('.sk-tools [data-tool]')) b.classList.toggle('on', b.dataset.tool === tool);
  ctx.setCursor(tool ? 'crosshair' : '');
  if (tool) setMsg(t('sk.hint.' + tool));
  refreshOverlay();
}

// ---- plane math --------------------------------------------------------------------------------

const STD = {
  XY: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, 0, 1] },
  XZ: { origin: [0, 0, 0], xDir: [1, 0, 0], normal: [0, -1, 0] },
  YZ: { origin: [0, 0, 0], xDir: [0, 1, 0], normal: [1, 0, 0] },
};

function basis(sketch) {
  const def = typeof sketch.plane === 'string' ? STD[sketch.plane] : sketch.plane;
  const n = new THREE.Vector3(...def.normal).normalize();
  const x = new THREE.Vector3(...def.xDir).normalize();
  const y = new THREE.Vector3().crossVectors(n, x).normalize();
  const o = new THREE.Vector3(...def.origin).addScaledVector(n, sketch.offset || 0);
  return { o, x, y, n };
}

const toWorld = (b, u, v) => b.o.clone().addScaledVector(b.x, u).addScaledVector(b.y, v);

function planeHit(e, b) {
  const ray = ctx.rayFromEvent(e);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(b.n, b.o);
  const p = ray.intersectPlane(plane, new THREE.Vector3());
  if (!p) return null;
  const d = p.sub(b.o);
  const snap = dialog.draft.sketch.snap || niceStep(partContext(dialog.model).size);
  const s = (v) => (snap > 0 ? Math.round(v / snap) * snap : v);
  return [s(d.dot(b.x)), s(d.dot(b.y))];
}

function lookAtSketch() {
  const b = basis(dialog.draft.sketch);
  const n = b.n.clone();
  // Keep the sketch's V axis pointing up on screen where possible.
  ctx.lookAlong([n.x + b.y.x * -0.001, n.y + b.y.y * -0.001, n.z + b.y.z * -0.001], b.y);
}

// ---- outlines (for drawing the profile in the viewport) ----------------------------------------

function outline(s) {
  const pts = [];
  const rot = (p, deg) => {
    if (!deg) return p;
    const a = (deg * Math.PI) / 180, c = Math.cos(a), sn = Math.sin(a);
    return [p[0] * c - p[1] * sn, p[0] * sn + p[1] * c];
  };
  switch (s.type) {
    case 'rect': {
      const w = Math.abs(s.w) / 2, h = Math.abs(s.h) / 2;
      const r = Math.min(Math.max(0, s.r || 0), w, h);
      const corners = [[w - r, h - r, 0], [-w + r, h - r, 90], [-w + r, -h + r, 180], [w - r, -h + r, 270]];
      for (const [cx, cy, a0] of corners) {
        for (let k = 0; k <= 8; k++) {
          const a = ((a0 + (k * 90) / 8) * Math.PI) / 180;
          pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
          if (!r) break;
        }
      }
      return pts.map((p) => rot(p, s.angle)).map((p) => [p[0] + (s.cx || 0), p[1] + (s.cy || 0)]);
    }
    case 'circle':
      for (let k = 0; k < 64; k++) { const a = (k / 64) * Math.PI * 2; pts.push([(s.cx || 0) + s.r * Math.cos(a), (s.cy || 0) + s.r * Math.sin(a)]); }
      return pts;
    case 'polygon': {
      const n = Math.max(3, Math.round(s.n || 6));
      for (let i = 0; i < n; i++) {
        const th = -((Math.PI * 2) / n) * i;
        const p = rot([s.r * Math.sin(th), s.r * Math.cos(th)], s.angle);
        pts.push([p[0] + (s.cx || 0), p[1] + (s.cy || 0)]);
      }
      return pts;
    }
    case 'slot': {
      const ang = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
      for (const [cx, cy, a0] of [[s.x2, s.y2, ang - Math.PI / 2], [s.x1, s.y1, ang + Math.PI / 2]]) {
        for (let k = 0; k <= 16; k++) { const a = a0 + (k / 16) * Math.PI; pts.push([cx + s.r * Math.cos(a), cy + s.r * Math.sin(a)]); }
      }
      return pts;
    }
    case 'polyline':
      return (s.pts || []).slice();
    default:
      return pts;
  }
}

function shapeCenter(s) {
  if (s.type === 'slot') return [(s.x1 + s.x2) / 2, (s.y1 + s.y2) / 2];
  if (s.type === 'polyline') {
    const p = s.pts || [];
    return [p.reduce((a, q) => a + q[0], 0) / (p.length || 1), p.reduce((a, q) => a + q[1], 0) / (p.length || 1)];
  }
  return [s.cx || 0, s.cy || 0];
}

function pointInLoop([x, y], loop) {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// =================================================================================================
// Overlay: sketch plane, profile, picked references
// =================================================================================================

const PICK_MATERIAL = new THREE.MeshBasicMaterial({
  color: PICK_COLOR, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthTest: false,
});

function lineLoop(points, color, opacity = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(points);
  const l = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: false }));
  l.renderOrder = 10;
  return l;
}

function refreshOverlay() {
  for (const c of [...overlay.children]) {
    overlay.remove(c);
    c.traverse((o) => { o.geometry?.dispose(); if (o.material && o.material !== PICK_MATERIAL) o.material.dispose(); });
  }
  if (!dialog || !dialog.draft) { ctx.requestRender(); return; }
  const d = dialog.draft;
  const mesh = dialog.model.parts[0];

  if (d.sketch) {
    const b = basis(d.sketch);
    const pc = partContext(dialog.model);
    // Grid sized to the part and the sketch.
    let ext = pc.size * 0.6;
    for (const s of d.sketch.shapes) for (const p of outline(s)) ext = Math.max(ext, Math.abs(p[0]) * 1.2, Math.abs(p[1]) * 1.2);
    const step = d.sketch.snap || niceStep(pc.size);
    const divisions = Math.min(200, Math.max(4, Math.round((2 * ext) / step)));
    const grid = new THREE.GridHelper(divisions * step, divisions, 0x4c9aff, 0x8aa6c8);
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    grid.material.depthWrite = false;
    // GridHelper lies in XZ; rotate it into the sketch plane.
    const m = new THREE.Matrix4().makeBasis(b.x, b.n, b.y.clone().negate());
    grid.quaternion.setFromRotationMatrix(m);
    grid.position.copy(b.o);
    overlay.add(grid);
    // Axes of the sketch.
    const axes = new THREE.BufferGeometry().setFromPoints([toWorld(b, -ext, 0), toWorld(b, ext, 0), toWorld(b, 0, -ext), toWorld(b, 0, ext)]);
    const axisLines = new THREE.LineSegments(axes, new THREE.LineBasicMaterial({ color: 0x2f6fde, depthTest: false, transparent: true, opacity: 0.8 }));
    axisLines.renderOrder = 9;
    overlay.add(axisLines);
    for (const s of d.sketch.shapes) {
      const loop = outline(s).map(([u, v]) => toWorld(b, u, v));
      if (loop.length >= 2) overlay.add(lineLoop(loop, s.hole ? 0xe0356b : 0x0b7a3b));
    }
    if (dialog.temp) {
      const loop = outline(dialog.temp).map(([u, v]) => toWorld(b, u, v));
      if (loop.length >= 2) overlay.add(lineLoop(loop, PICK_COLOR));
    }
  }

  // Highlight picked references on the current body.
  const body = dialog.model.part.body;
  if (mesh && body && !body.mesh) {
    if (d.edges && d.edges.length) {
      const lines = mesh.children.find((c) => c.userData.segEdge);
      const pos = lines?.geometry.attributes.position;
      const pts = [];
      for (const ref of d.edges) {
        const ei = matchEdge(body, ref);
        if (ei < 0) continue;
        const segEdge = lines.userData.segEdge;
        for (let s = 0; s < segEdge.length; s++) if (segEdge[s] === ei) {
          pts.push(new THREE.Vector3().fromBufferAttribute(pos, s * 2), new THREE.Vector3().fromBufferAttribute(pos, s * 2 + 1));
        }
      }
      if (pts.length) {
        const hl = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: PICK_COLOR, depthTest: false }));
        hl.renderOrder = 11;
        overlay.add(hl);
      }
    }
    if (d.faces && d.faces.length) {
      const idx = [];
      const index = mesh.geometry.index.array;
      for (const ref of d.faces) {
        const gr = mesh.userData.faces.find((g) => g.face === ref._face);
        if (gr) for (let i = gr.start; i < gr.start + gr.count; i++) idx.push(index[i]);
      }
      if (idx.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', mesh.geometry.attributes.position);
        g.setIndex(idx);
        const hl = new THREE.Mesh(g, PICK_MATERIAL);
        hl.renderOrder = 11;
        overlay.add(hl);
      }
    }
  }
  if (d.p && d.normal) {
    // Hole position marker: a short line along the drilling direction.
    const p = new THREE.Vector3(...d.p);
    const n = new THREE.Vector3(...d.normal).normalize();
    const len = Math.max(d.depth || 0, d.diameter || 1) || 10;
    const ring = [];
    const u = new THREE.Vector3().crossVectors(n, Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)).normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      ring.push(p.clone().addScaledVector(u, (d.diameter / 2) * Math.cos(a)).addScaledVector(v, (d.diameter / 2) * Math.sin(a)));
    }
    overlay.add(lineLoop(ring, PICK_COLOR));
    const axis = new THREE.Line(new THREE.BufferGeometry().setFromPoints([p.clone().addScaledVector(n, len * 0.3), p.clone().addScaledVector(n, -len)]),
      new THREE.LineBasicMaterial({ color: PICK_COLOR, depthTest: false }));
    axis.renderOrder = 11;
    overlay.add(axis);
  }
  ctx.requestRender();
}

function matchEdge(body, ref) {
  let best = -1, bestD = Infinity;
  body.edges.forEach((e, i) => {
    if (!e.mid) return;
    const dd = Math.hypot(e.mid[0] - ref.p[0], e.mid[1] - ref.p[1], e.mid[2] - ref.p[2]);
    if (dd < bestD) { bestD = dd; best = i; }
  });
  return bestD < 1e-3 * (1 + Math.abs(ref.p[0]) + Math.abs(ref.p[1]) + Math.abs(ref.p[2])) ? best : -1;
}

// =================================================================================================
// Pointer handling: picking references and drawing sketches
// =================================================================================================

let down = null;

function onPointerDown(e) {
  if (!dialog || e.button !== 0) return;
  down = { x: e.clientX, y: e.clientY };
  if (dialog.tool && dialog.draft?.sketch && dialog.tool !== 'polyline') {
    const b = basis(dialog.draft.sketch);
    const p = planeHit(e, b);
    if (!p) return;
    e.stopPropagation();
    ctx.controls.enabled = false;
    dialog.drag = { start: p, b };
  }
}

function onPointerMove(e) {
  if (!dialog || !dialog.draft?.sketch) return;
  const b = basis(dialog.draft.sketch);
  if (dialog.drag) {
    const p = planeHit(e, b);
    if (!p) return;
    const [u0, v0] = dialog.drag.start;
    if (dialog.tool === 'rect') dialog.temp = { type: 'rect', cx: (u0 + p[0]) / 2, cy: (v0 + p[1]) / 2, w: Math.abs(p[0] - u0), h: Math.abs(p[1] - v0), r: 0 };
    else dialog.temp = { type: 'circle', cx: u0, cy: v0, r: Math.hypot(p[0] - u0, p[1] - v0) };
    refreshOverlay();
  } else if (dialog.tool === 'polyline' && dialog.poly) {
    const p = planeHit(e, b);
    if (p) { dialog.temp = { type: 'polyline', pts: [...dialog.poly, p] }; refreshOverlay(); }
  }
}

function onPointerUp(e) {
  if (!dialog || e.button !== 0) return;
  const moved = down ? Math.hypot(e.clientX - down.x, e.clientY - down.y) : 0;
  down = null;
  if (dialog.drag) {
    e.stopPropagation();
    ctx.controls.enabled = true;
    const tmp = dialog.temp;
    dialog.drag = null;
    dialog.temp = null;
    const ok = tmp && (tmp.type === 'rect' ? tmp.w > 0 && tmp.h > 0 : tmp.r > 0);
    if (ok) addShape(tmp);
    else refreshOverlay();
    return;
  }
  if (moved > 4) return;
  if (dialog.tool === 'polyline' && dialog.draft?.sketch) {
    e.stopPropagation();
    const p = planeHit(e, basis(dialog.draft.sketch));
    if (!p) return;
    dialog.poly = dialog.poly || [];
    const first = dialog.poly[0];
    const snap = dialog.draft.sketch.snap || 1;
    if (first && dialog.poly.length >= 3 && Math.hypot(p[0] - first[0], p[1] - first[1]) < snap * 1.5) finishPolyline();
    else { dialog.poly.push(p); dialog.temp = { type: 'polyline', pts: dialog.poly.slice() }; refreshOverlay(); }
    return;
  }
  if (dialog.pick) {
    e.stopPropagation();
    pickAt(e);
  }
}

function onDoubleClick(e) {
  if (dialog && dialog.tool === 'polyline' && dialog.poly) {
    e.stopPropagation();
    finishPolyline();
  }
}

export function finishPolyline() {
  if (!dialog || !dialog.poly) return false;
  // A double click adds the last point twice; drop duplicates.
  const pts = dialog.poly.filter((p, i, a) => i === 0 || Math.hypot(p[0] - a[i - 1][0], p[1] - a[i - 1][1]) > 1e-9);
  dialog.poly = null;
  dialog.temp = null;
  if (pts.length >= 3) addShape({ type: 'polyline', pts });
  else refreshOverlay();
  return true;
}

// Escape: cancel the current drawing step, then the tool, then the dialog.
export function escape() {
  if (!dialog) return false;
  if (dialog.poly || dialog.drag) { dialog.poly = null; dialog.drag = null; dialog.temp = null; ctx.controls.enabled = true; refreshOverlay(); return true; }
  if (dialog.tool) { setTool(null); return true; }
  closeDialog(true);
  return true;
}

function pickAt(e) {
  const model = dialog.model;
  const mesh = model.parts[0];
  const body = model.part.body;
  if (!mesh || !body) return;
  const d = dialog.draft;
  const ray = ctx.raycasterFromEvent(e);

  if (dialog.pick === 'edges') {
    if (body.mesh) return;
    const lines = mesh.children.find((c) => c.userData.segEdge);
    if (!lines) return;
    ray.params.Line.threshold = ctx.worldPerPixel(mesh) * 6;
    const hits = [];
    const saved = lines.raycast;
    lines.raycast = THREE.LineSegments.prototype.raycast;
    ray.intersectObject(lines, false, hits);
    lines.raycast = saved;
    const hit = hits.sort((a, b) => a.distanceToRay - b.distanceToRay)[0];
    if (!hit) return;
    const ei = lines.userData.segEdge[Math.floor(hit.index / 2)];
    const info = body.edges[ei];
    if (!info?.mid) return;
    const list = d.edges || (d.edges = []);
    const at = list.findIndex((r) => matchEdge(body, r) === ei);
    if (at >= 0) list.splice(at, 1);
    else list.push({ p: info.mid, type: info.type, ...(info.dir ? { dir: info.dir } : {}) });
  } else {
    const hit = ray.intersectObject(mesh, false)[0];
    if (!hit) return;
    const gi = findGroup(mesh, hit.faceIndex * 3);
    const face = gi >= 0 ? mesh.userData.faces?.[gi]?.face ?? -1 : -1;
    const info = face >= 0 ? body.faces[face] : null;
    const tri = hit.face.normal.clone().transformDirection(mesh.matrixWorld).normalize();
    const p = [hit.point.x, hit.point.y, hit.point.z];
    if (dialog.pick === 'faces') {
      if (body.mesh || face < 0) return;
      const list = d.faces || (d.faces = []);
      const at = list.findIndex((r) => r._face === face);
      if (at >= 0) list.splice(at, 1);
      else list.push({ p, type: info.type, ...(info.dir ? { dir: info.dir } : {}), _face: face });
    } else if (dialog.pick === 'point') {
      const n = info?.normal ? orient(info.normal, tri) : [tri.x, tri.y, tri.z];
      d.p = p;
      d.normal = n;
      dialog.pick = null;
      ctx.setCursor('');
      for (const b of document.querySelectorAll('.fp-refs .toggle')) b.classList.remove('on');
    } else if (dialog.pick === 'plane') {
      if (info && info.type !== 'PLANE' && !body.mesh) { setMsg(t('pick.notPlanar'), true); return; }
      const n = info?.normal ? orient(info.normal, tri) : [tri.x, tri.y, tri.z];
      d.sketch.plane = { origin: p, xDir: perpendicular(n), normal: n };
      d.sketch.offset = 0;
      dialog.pick = null;
      ctx.setCursor('');
      lookAtSketch();
    }
  }
  dialog.updateRefs?.();
  schedulePreview(0);
  refreshOverlay();
}

function findGroup(mesh, indexOffset) {
  const faces = mesh.userData.faces;
  if (!faces) return -1;
  let lo = 0, hi = faces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = faces[mid];
    if (indexOffset < f.start) hi = mid - 1;
    else if (indexOffset >= f.start + f.count) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// Face normals from the kernel follow face orientation; flip to agree with the visible side.
function orient(n, tri) {
  const dot = n[0] * tri.x + n[1] * tri.y + n[2] * tri.z;
  return dot < 0 ? [-n[0], -n[1], -n[2]] : n.slice();
}

function perpendicular(n) {
  const v = new THREE.Vector3(...n);
  const ref = Math.abs(v.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
  const x = new THREE.Vector3().crossVectors(ref, v).normalize();
  return [x.x, x.y, x.z];
}

// =================================================================================================
// Model list: feature tree
// =================================================================================================

export function renderTree(model) {
  const wrap = document.createElement('div');
  wrap.className = 'tree';
  const feats = model.part.features;
  if (!feats.length) {
    const p = document.createElement('div');
    p.className = 'tree-empty';
    p.textContent = t('tree.empty');
    wrap.append(p);
    return wrap;
  }
  const editing = ctx.isEditing();
  const { vars } = paramValues(model.part.params);
  feats.forEach((f, i) => {
    const r = document.createElement('div');
    const err = model.part.status[i];
    r.className = 'tree-row' + (f.suppressed ? ' off' : '') + (err ? ' err' : '');
    if (dialog && dialog.model === model && dialog.index === i && !dialog.isNew) r.classList.add('editing');
    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = `${i + 1}. ${summary(applyExprs(f, vars), t)}`;
    r.title = err ? errorText(err) : editing ? t('tree.editHint') : '';
    if (err) {
      const w = document.createElement('span');
      w.className = 'tree-warn';
      w.textContent = '⚠';
      r.append(w);
    }
    r.append(label);
    if (editing) {
      const sup = document.createElement('input');
      sup.type = 'checkbox';
      sup.checked = !f.suppressed;
      sup.title = t('tree.suppress');
      sup.setAttribute('aria-label', `${t('tree.suppress')}: ${label.textContent}`);
      sup.addEventListener('click', (e) => e.stopPropagation());
      sup.addEventListener('change', () => {
        const list = feats.map((x, k) => (k === i ? { ...x, suppressed: !sup.checked || undefined } : x));
        if (!list[i].suppressed) delete list[i].suppressed;
        setFeatures(model, list);
      });
      const up = button('↑', () => moveFeature(model, i, -1), 'icon');
      up.title = t('tree.up');
      up.disabled = i === 0;
      const del = button('✕', () => deleteFeature(model, i), 'icon');
      del.title = t('delete');
      r.prepend(sup);
      r.append(up, del);
      r.addEventListener('click', (e) => { e.stopPropagation(); editFeature(model, i); });
    }
    wrap.append(r);
  });
  return wrap;
}

function deleteFeature(model, i) {
  const list = model.part.features.slice();
  list.splice(i, 1);
  // Pattern references point at feature indices; shift or drop them.
  for (let k = 0; k < list.length; k++) {
    const f = list[k];
    if (f.of == null) continue;
    if (f.of === i) list[k] = { ...f, of: null };
    else if (f.of > i) list[k] = { ...f, of: f.of - 1 };
  }
  setFeatures(model, list);
}

function moveFeature(model, i, delta) {
  const j = i + delta;
  const list = model.part.features.slice();
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  for (let k = 0; k < list.length; k++) {
    const f = list[k];
    if (f.of == null) continue;
    if (f.of === i) list[k] = { ...f, of: j };
    else if (f.of === j) list[k] = { ...f, of: i };
  }
  setFeatures(model, list);
}

// =================================================================================================
// Properties
// =================================================================================================

const SURFACE = { PLANE: 'sf.plane', CYLINDRE: 'sf.cylinder', CONE: 'sf.cone', SPHERE: 'sf.sphere', TORUS: 'sf.torus', BSPLINE_SURFACE: 'sf.bspline', BEZIER_SURFACE: 'sf.bspline', REVOLUTION_SURFACE: 'sf.revolution', EXTRUSION_SURFACE: 'sf.extrusion', MESH: 'sf.mesh' };

export function partProps(model, el, helpers) {
  const { heading, dl, fmt } = helpers;
  const body = model.part.body;
  const rows = [[t('bodyType'), t(body?.mesh ? 'bodyMesh' : 'bodyExact')], [t('features'), String(model.part.features.length)]];
  if (body) {
    const p = body.props;
    if (p.volume != null) rows.push([t('volume'), `${fmt(p.volume / 1000)} cm³`]);
    if (p.area != null) rows.push([t('area'), `${fmt(p.area)} mm²`]);
    const size = [0, 1, 2].map((k) => p.bbox[1][k] - p.bbox[0][k]);
    rows.push([t('sizeX'), fmt(size[0]) + ' mm'], [t('sizeY'), fmt(size[1]) + ' mm'], [t('sizeZ'), fmt(size[2]) + ' mm']);
    if (p.com) rows.push([t('com'), p.com.map((v) => fmt(v, 1)).join(', ')]);
  }
  el.append(heading(model.name), dl(rows));

  if (body && body.props.volume != null) {
    const dens = document.createElement('input');
    dens.type = 'number';
    dens.step = '0.01';
    dens.min = '0';
    dens.value = String(model.part.density);
    const mass = document.createElement('span');
    const upd = () => {
      const g = (body.props.volume / 1000) * model.part.density;
      mass.textContent = g >= 1000 ? `${fmt(g / 1000, 3)} kg` : `${fmt(g, 1)} g`;
    };
    dens.addEventListener('input', () => {
      const v = parseFloat(dens.value);
      if (v >= 0) { model.part.density = v; upd(); }
    });
    upd();
    el.append(heading(t('massTitle')), dl([[t('density'), dens], [t('mass'), mass]]));
  }

  const sel = ctx.getSelection();
  if (sel && sel.model === model && body) {
    const gr = sel.mesh.userData.faces?.[sel.faceIndex];
    const info = gr ? body.faces[gr.face] : null;
    if (info) {
      const r = [[t('type'), t(SURFACE[info.type] || 'sf.other')], [t('area'), fmt(info.area) + ' mm²']];
      if (info.normal) r.push([t('normal'), info.normal.map((v) => fmt(v, 3)).join(', ')]);
      el.append(heading(t('selFace')), dl(r));
    }
  }
  const errs = model.part.status.filter(Boolean).length;
  if (errs) {
    const p = document.createElement('p');
    p.className = 'note err';
    p.textContent = t('k.someFailed', { n: errs });
    el.append(p);
  }
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = t(body?.mesh ? 'note.meshPart' : 'note.part');
  el.append(p);
}

// =================================================================================================
// Export, save and open projects
// =================================================================================================

export async function exportPart(model, format) {
  const res = await withKernel(() => call('exportPart', { partId: model.part.id, format }));
  if (!res) return;
  const ext = format === 'stl' ? 'stl' : 'step';
  ctx.download(res.bytes, model.name.replace(/[\\/:*?"<>|]+/g, '_') + '.' + ext, format === 'stl' ? 'model/stl' : 'application/step');
}

function b64(buf) {
  const bytes = new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function saveProject() {
  const parts = ctx.models.filter(isPart);
  if (!parts.length) { ctx.toast(t('k.needPart')); return; }
  const out = await withKernel(async () => {
    const sources = {};
    for (const m of parts) {
      for (const f of m.part.features) {
        if (f.type !== 'import' || sources[f.source]) continue;
        const s = await call('sourceData', { id: f.source });
        sources[f.source] = s.kind === 'mesh'
          ? { kind: 'mesh', positions: b64(s.positions), indices: b64(s.indices) }
          : { kind: 'step', data: b64(new Uint8Array(s.bytes)) };
      }
    }
    return {
      app: 'Norma',
      format: 1,
      parts: parts.map((m) => ({ name: m.name, density: m.part.density, params: m.part.params, visible: m.object.visible, features: m.part.features.map(sanitize) })),
      sources,
    };
  });
  if (!out) return;
  const name = (activePart() || parts[0]).name.replace(/[\\/:*?"<>|]+/g, '_');
  ctx.download(JSON.stringify(out), name + '.norma', 'application/json');
}

export async function openProject(name, buffer) {
  let doc;
  try {
    doc = JSON.parse(new TextDecoder().decode(buffer));
  } catch {
    throw Object.assign(new Error('bad project'), { i18n: 'k.badProject' });
  }
  if (!doc || doc.app !== 'Norma' || !Array.isArray(doc.parts)) throw Object.assign(new Error('bad project'), { i18n: 'k.badProject' });
  await startKernel();
  for (const [id, s] of Object.entries(doc.sources || {})) {
    if (s.kind === 'mesh') {
      const positions = new Float32Array(unb64(s.positions).buffer);
      const indices = new Uint32Array(unb64(s.indices).buffer);
      await call('addSource', { kind: 'mesh', positions, indices, id }, [positions.buffer, indices.buffer]);
    } else {
      const bytes = unb64(s.data).buffer;
      await call('addSource', { kind: 'step', bytes, id }, [bytes]);
    }
  }
  const made = [];
  for (const p of doc.parts) {
    const m = createPartModel(p.name || name, p.features || []);
    m.part.density = p.density ?? 7.85;
    m.part.params = p.params || [];
    if (p.visible === false) m.object.visible = false;
    made.push(m);
  }
  for (const m of made) await rebuild(m);
  return made;
}

// =================================================================================================
// Parameters (named values usable as =formulas in any size field)
// =================================================================================================

function openParams() {
  const model = activePart();
  if (!model) { ctx.toast(t('k.needPart')); return; }
  const list = model.part.params.map((p) => ({ ...p }));
  openDialog({
    model,
    title: t('params.title'),
    custom: (body) => {
      const hint = document.createElement('p');
      hint.className = 'muted fp-hint';
      hint.textContent = t('params.hint');
      const rows = document.createElement('div');
      rows.className = 'param-list';
      const render = () => {
        rows.replaceChildren();
        const { vars } = paramValues(list);
        list.forEach((p, i) => {
          const r = document.createElement('div');
          r.className = 'param-row';
          const name = document.createElement('input');
          name.value = p.name;
          name.placeholder = t('params.name');
          name.setAttribute('aria-label', t('params.name'));
          const value = document.createElement('input');
          value.value = p.value;
          value.placeholder = t('params.value');
          value.setAttribute('aria-label', t('params.value'));
          const out = document.createElement('output');
          out.textContent = p.name in vars ? String(+vars[p.name].toFixed(4)) : '–';
          name.addEventListener('change', () => { p.name = name.value.trim(); render(); });
          value.addEventListener('change', () => { p.value = value.value.trim(); render(); });
          r.append(name, value, out, button('✕', () => { list.splice(i, 1); render(); }, 'icon'));
          rows.append(r);
        });
      };
      render();
      body.append(hint, rows, button(t('params.add'), () => { list.push({ name: 'p' + (list.length + 1), value: '10' }); render(); }));
      return () => {
        const names = list.map((p) => p.name);
        const badName = names.find((n, i) => !validName(n) || names.indexOf(n) !== i);
        if (badName !== undefined) { setMsg(t('params.badName', { name: badName }), true); return false; }
        const { errors } = paramValues(list);
        if (errors.length) { setMsg(t('params.badValue', { name: errors[0] }), true); return false; }
        const before = model.part.params;
        const apply = (params) => { model.part.params = params; rebuild(model); };
        ctx.pushCommand({ undo: () => apply(before), redo: () => apply(list) });
        apply(list);
        return true;
      };
    },
  });
}

// =================================================================================================
// 2D drawings
// =================================================================================================

async function openDrawing() {
  const model = activePart();
  if (!model) { ctx.toast(t('k.needPart')); return; }
  if (dialog) closeDialog(false);
  await rebuild(model);
  const views = await withKernel(() => call('drawing', { partId: model.part.id }));
  if (!views) return;
  const stage = $('drawing-stage');
  const sizeSel = $('drawing-size');
  const safeName = model.name.replace(/[\\/:*?"<>|]+/g, '_');
  const sheet = () => {
    const p = model.part.body?.props;
    const g = p?.volume != null ? (p.volume / 1000) * model.part.density : null;
    return buildSheet(views, {
      name: model.name,
      size: sizeSel.value,
      date: new Date().toISOString().slice(0, 10),
      mass: g == null ? '' : g >= 1000 ? (g / 1000).toFixed(3) + ' kg' : g.toFixed(1) + ' g',
    }, {
      title: t('dr.title'), scale: t('dr.scale'), sheet: t('dr.sheet'), units: t('dr.units'), mass: t('mass'),
      date: t('dr.date'), projection: t('dr.projection'), third: t('dr.third'),
    });
  };
  const render = () => { stage.innerHTML = sheet(); };
  sizeSel.onchange = render;
  $('drawing-svg').onclick = () => ctx.download(sheet(), safeName + '.svg', 'image/svg+xml');
  $('drawing-dxf').onclick = () => ctx.download(buildDXF(views).text, safeName + '.dxf', 'application/dxf');
  $('drawing-print').onclick = () => {
    const [w, h] = SHEETS[sizeSel.value];
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0';
    frame.srcdoc = '<!doctype html><style>@page{size:' + w + 'mm ' + h + 'mm;margin:0}html,body{margin:0}svg{display:block;width:' + w + 'mm;height:' + h + 'mm}</style>' + sheet();
    frame.onload = () => { frame.contentWindow.print(); setTimeout(() => frame.remove(), 60000); };
    document.body.append(frame);
  };
  $('drawing-close').onclick = () => { $('drawing-modal').hidden = true; stage.replaceChildren(); };
  render();
  $('drawing-modal').hidden = false;
}

// =================================================================================================
// Measure: what is under the cursor
// =================================================================================================

const n2 = (v) => (+v).toLocaleString('en-US', { maximumFractionDigits: 2 });

export function measureInfo(hit, e) {
  const mesh = hit.object;
  const model = mesh.userData.partModel;
  const body = model?.part.body;
  if (!body) return null;
  if (body.mesh) return [t('sf.mesh')];
  const lines = mesh.children.find((c) => c.userData.segEdge);
  if (lines) {
    const ray = ctx.raycasterFromEvent(e);
    ray.params.Line.threshold = ctx.worldPerPixel(mesh) * 5;
    const hits = [];
    THREE.LineSegments.prototype.raycast.call(lines, ray, hits);
    const near = hits.sort((a, b) => a.distanceToRay - b.distanceToRay)[0];
    const info = near ? body.edges[lines.userData.segEdge[Math.floor(near.index / 2)]] : null;
    if (info) {
      const out = [t(info.type === 'LINE' ? 'ms.line' : info.type === 'CIRCLE' ? 'ms.arc' : 'ms.curve'), t('ms.length') + ' ' + n2(info.length) + ' mm'];
      if (info.radius) out.push('R ' + n2(info.radius) + ' mm', 'Ø ' + n2(info.radius * 2) + ' mm');
      return out;
    }
  }
  const gi = findGroup(mesh, hit.faceIndex * 3);
  const info = gi >= 0 ? body.faces[mesh.userData.faces[gi].face] : null;
  if (!info) return null;
  const out = [t(SURFACE[info.type] || 'sf.other'), t('area') + ' ' + n2(info.area) + ' mm²'];
  if (info.radius) out.push('R ' + n2(info.radius) + ' mm', 'Ø ' + n2(info.radius * 2) + ' mm');
  return out;
}

export function dropPart(model) {
  if (dialog && dialog.model === model) closeDialog(false);
  call('dropPart', { partId: model.part.id }).catch(() => {});
}

export function refreshTexts() {
  for (const id of ['menu-create', 'menu-modify']) {
    for (const b of $(id).querySelectorAll('[data-i18n]')) b.textContent = t(b.dataset.i18n);
  }
  for (const m of ctx.models) if (isPart(m)) m.format = t('partFormat');
  if (dialog && dialog.draft) {
    const d = dialog;
    openFeatureDialog(d.model, d.draft, d.index, d.isNew);
  }
}

export function partMenusEnabled(on) {
  for (const id of ['btn-part', 'btn-create', 'btn-modify']) $(id).disabled = !on;
}
