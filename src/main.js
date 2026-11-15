import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { loadModel, extensionOf } from './loaders/index.js';
import { partMaterial, addComputedEdges, faceOutlineLines, DEFAULT_COLOR } from './meshkit.js';
import { t, errorText, applyStatic, setLang, getLang, APP_NAME } from './i18n.js';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');
const canvas = $('canvas');
const labelsEl = $('labels');

// =================================================================================================
// Scene
// =================================================================================================

THREE.Object3D.DEFAULT_UP.set(0, 0, 1); // CAD convention: Z up

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.autoClear = false;

const scene = new THREE.Scene();
const modelRoot = new THREE.Group();
const overlayRoot = new THREE.Group(); // measurements
scene.add(modelRoot, overlayRoot);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8a93a3, 1.1));
const headlight = new THREE.DirectionalLight(0xffffff, 2.0);
scene.add(headlight, headlight.target);

const FOV = 30;
const persp = new THREE.PerspectiveCamera(FOV, 1, 0.1, 1000);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
persp.position.set(1, -1, 0.8);
let camera = persp;
let orthoHalf = 1; // half height of the parallel view at zoom 1

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = false;
controls.zoomToCursor = true;
controls.rotateSpeed = 0.9;
controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
controls.addEventListener('change', requestRender);

const clipPlane = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
const NO_PLANES = [];

// Move / rotate / scale handle used in edit mode.
const gizmo = new TransformControls(camera, canvas);
gizmo.setSpace('world');
scene.add(gizmo.getHelper());

// ---- orientation triad ----------------------------------------------------------------------
const triadScene = new THREE.Scene();
const triadCam = new THREE.OrthographicCamera(-1.5, 1.5, 1.5, -1.5, 0.1, 20);
{
  const axes = [
    [new THREE.Vector3(1, 0, 0), 0xd9364a, 'X'],
    [new THREE.Vector3(0, 1, 0), 0x2f9e44, 'Y'],
    [new THREE.Vector3(0, 0, 1), 0x2f6fde, 'Z'],
  ];
  for (const [dir, color, text] of axes) {
    triadScene.add(new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color, 0.28, 0.14));
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    ctx.font = 'bold 44px Segoe UI, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.fillText(text, 32, 34);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
    sprite.position.copy(dir).multiplyScalar(1.25);
    sprite.scale.setScalar(0.42);
    triadScene.add(sprite);
  }
}

// =================================================================================================
// State
// =================================================================================================

const models = []; // { id, name, format, info, object (pivot group), parts[], box, stats, bytes }
let nextId = 1;
let activeModel = null;
let displayMode = 'shaded-edges';
const section = { on: false, axis: 'x', t: 0.5, flip: false };
const measure = { on: false, pending: null, items: [], hint: ['m.first'] };
let selection = null; // { model, mesh, face, faceIndex, highlight, area, size, point }

// Edit mode is strictly opt-in; in view mode nothing below can change a model.
const edit = { on: false, target: 'face', gizmo: null, undo: [], redo: [] };

let dirty = true;
function requestRender() { dirty = true; }

// =================================================================================================
// Helpers
// =================================================================================================

function sceneBox() {
  const box = new THREE.Box3();
  for (const m of models) if (m.object.visible) box.union(m.box);
  return box;
}

function fmt(v, digits = 2) {
  if (!Number.isFinite(v)) return '–';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}
const fmtInt = (v) => v.toLocaleString('en-US');
function fmtBytes(n) {
  if (n >= 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}

function toast(title, message = '') {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'alert');
  const b = document.createElement('b');
  b.textContent = title;
  el.append(b, document.createTextNode(message));
  $('toasts').append(el);
  setTimeout(() => el.remove(), message ? 12000 : 4000);
}

// =================================================================================================
// Camera
// =================================================================================================

const VIEWS = {
  iso: [1, -1, 0.8],
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, -0.0005, 1],
  bottom: [0, 0.0005, -1],
};

function fit(dirArray = null, box = sceneBox()) {
  if (box.isEmpty()) return;
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = Math.max(sphere.radius, 1e-6);
  const dir = dirArray
    ? new THREE.Vector3(...dirArray).normalize()
    : camera.position.clone().sub(controls.target).normalize();
  const dist = (r / Math.sin(THREE.MathUtils.degToRad(FOV / 2))) * 1.02;
  controls.target.copy(sphere.center);
  for (const cam of [persp, ortho]) {
    cam.position.copy(sphere.center).addScaledVector(dir, dist);
    cam.up.set(0, 0, 1);
    cam.lookAt(sphere.center);
  }
  orthoHalf = r * 1.02;
  ortho.zoom = 1;
  updateProjection();
  controls.update();
  requestRender();
}

function updateProjection() {
  const w = viewport.clientWidth || 1;
  const h = viewport.clientHeight || 1;
  const aspect = w / h;
  persp.aspect = aspect;
  // Keep the model inside the view volume whatever the zoom level.
  const box = sceneBox();
  let near = 0.1, far = 1000, onear = -1000;
  if (!box.isEmpty()) {
    const s = box.getBoundingSphere(new THREE.Sphere());
    const R = Math.max(s.radius, 1e-6) * 1.2;
    const dc = camera.position.distanceTo(s.center);
    far = dc + R;
    near = Math.max(dc - R, R * 0.002);
    onear = dc - R;
  }
  persp.near = near; persp.far = far;
  ortho.near = onear; ortho.far = far;
  const half = aspect >= 1 ? orthoHalf : orthoHalf / aspect;
  ortho.top = half; ortho.bottom = -half; ortho.left = -half * aspect; ortho.right = half * aspect;
  persp.updateProjectionMatrix();
  ortho.updateProjectionMatrix();
}

function updateProjLabel() {
  $('btn-proj').textContent = t(camera === ortho ? 'parallel' : 'perspective');
}

function setProjection(useOrtho) {
  if ((camera === ortho) === useOrtho) return;
  const tan = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const dir = camera.position.clone().sub(controls.target);
  const dist = dir.length();
  dir.normalize();
  if (useOrtho) {
    orthoHalf = dist * tan;
    ortho.zoom = 1;
    ortho.position.copy(camera.position);
    ortho.quaternion.copy(camera.quaternion);
    camera = ortho;
  } else {
    const d = orthoHalf / ortho.zoom / tan;
    persp.position.copy(controls.target).addScaledVector(dir, d);
    persp.quaternion.copy(camera.quaternion);
    camera = persp;
  }
  controls.object = camera;
  gizmo.camera = camera;
  controls.update();
  updateProjLabel();
  requestRender();
}

// =================================================================================================
// Rendering
// =================================================================================================

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  requestRender();
}
new ResizeObserver(resize).observe(viewport);

const _v = new THREE.Vector3();
function render() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  if (!w || !h) return;
  // Guard against a missed resize notification: the drawing buffer must match the element.
  const pr = renderer.getPixelRatio();
  if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) renderer.setSize(w, h, false);
  updateProjection();
  updateClipPlane();

  // Headlight follows the camera, slightly up and to the left.
  camera.updateMatrixWorld();
  _v.set(-0.35, 0.5, 1).applyQuaternion(camera.quaternion);
  headlight.position.copy(controls.target).add(_v);
  headlight.target.position.copy(controls.target);
  headlight.target.updateMatrixWorld();

  renderer.clippingPlanes = section.on ? [clipPlane] : NO_PLANES;
  renderer.setViewport(0, 0, w, h);
  renderer.clear();
  renderer.render(scene, camera);

  // Triad, bottom-left.
  renderer.clippingPlanes = NO_PLANES;
  renderer.clearDepth();
  renderer.setViewport(8, 8, 104, 104);
  triadCam.position.copy(camera.position).sub(controls.target).normalize().multiplyScalar(6);
  triadCam.quaternion.copy(camera.quaternion);
  triadCam.updateMatrixWorld();
  renderer.render(triadScene, triadCam);
  renderer.setViewport(0, 0, w, h);

  updateLabels(w, h);
}

function loop() {
  if (dirty) {
    dirty = false;
    render();
  }
  requestAnimationFrame(loop);
}

// =================================================================================================
// Display modes
// =================================================================================================

function applyDisplayMode() {
  for (const m of models) {
    for (const mesh of m.parts) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mat of mats) {
        if (mat.userData.baseOpacity === undefined) {
          mat.userData.baseOpacity = mat.opacity;
          mat.userData.baseTransparent = mat.transparent;
        }
        const xray = displayMode === 'xray';
        mat.wireframe = displayMode === 'triangles';
        mat.colorWrite = displayMode !== 'hidden-line';
        mat.transparent = xray || mat.userData.baseTransparent;
        mat.opacity = xray ? 0.28 : mat.userData.baseOpacity;
        mat.depthWrite = !xray;
        // In wireframe mode the surface is not drawn; hide through the material so that the
        // edge overlay (a child of the mesh) stays visible.
        mat.visible = displayMode !== 'wireframe';
        mat.needsUpdate = true;
      }
      for (const child of mesh.children) {
        if (child.userData.isEdges) child.visible = displayMode !== 'shaded' && displayMode !== 'triangles';
      }
    }
  }
  requestRender();
}

// =================================================================================================
// Section plane
// =================================================================================================

function updateClipPlane() {
  if (!section.on) return;
  const box = sceneBox();
  if (box.isEmpty()) return;
  const a = section.axis;
  const pos = box.min[a] + (box.max[a] - box.min[a]) * section.t;
  const sign = section.flip ? 1 : -1;
  clipPlane.normal.set(a === 'x' ? sign : 0, a === 'y' ? sign : 0, a === 'z' ? sign : 0);
  clipPlane.constant = -sign * pos;
  $('section-val').textContent = `${a.toUpperCase()} = ${fmt(pos, 1)}`;
}

function setSection(on) {
  section.on = on;
  $('btn-section').classList.toggle('on', on);
  $('section-panel').hidden = !on;
  requestRender();
}

// =================================================================================================
// Models
// =================================================================================================

function collectParts(object) {
  const parts = [];
  object.traverse((o) => { if (o.isMesh && o.userData.isPart) parts.push(o); });
  return parts;
}

// Recompute everything derived from a model's meshes (after loading or any edit).
function refreshModel(model) {
  model.object.updateMatrixWorld(true);
  model.parts = collectParts(model.object);
  const box = new THREE.Box3();
  let triangles = 0, faces = 0, vertices = 0;
  for (const mesh of model.parts) {
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    box.union(g.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    vertices += g.attributes.position.count;
    faces += mesh.userData.faces ? mesh.userData.faces.length : 0;
  }
  model.box = box;
  model.stats = { triangles, faces, vertices, bodies: model.parts.length };
}

function addModel(name, bytes, result) {
  // Wrap the loaded object in a pivot placed at its centre, so the edit handle sits on the
  // model rather than at the CAD origin (which can be metres away).
  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.add(result.object);
  modelRoot.add(pivot);
  const model = { id: nextId++, name, format: result.info.format, info: result.info, object: pivot, bytes };
  refreshModel(model);
  if (!model.parts.length) {
    modelRoot.remove(pivot);
    throw Object.assign(new Error('No displayable surfaces.'), { i18n: 'err.noSurfaces' });
  }
  const center = model.box.getCenter(new THREE.Vector3());
  pivot.position.copy(center);
  result.object.position.sub(center);
  pivot.userData.home = { p: pivot.position.clone(), q: pivot.quaternion.clone(), s: pivot.scale.clone() };
  refreshModel(model);

  models.push(model);
  activeModel = model;
  applyDisplayMode();
  refreshModelList();
  showProps();
  syncGizmo();
  return model;
}

function disposeObject(object) {
  object.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
  });
}

function removeModel(model) {
  if (selection && selection.model === model) clearSelection();
  modelRoot.remove(model.object);
  disposeObject(model.object);
  models.splice(models.indexOf(model), 1);
  if (activeModel === model) activeModel = models[models.length - 1] || null;
  // Edit history may reference the closed model.
  edit.undo.length = 0;
  edit.redo.length = 0;
  updateEditButtons();
  syncGizmo();
  refreshModelList();
  showProps();
  requestRender();
}

function setActive(model) {
  activeModel = model;
  syncGizmo();
  refreshModelList();
  showProps();
}

function refreshModelList() {
  const list = $('model-list');
  list.replaceChildren();
  for (const m of models) {
    const row = document.createElement('div');
    row.className = 'model' + (m === activeModel ? ' active' : '');
    row.title = t('rowTitle');

    const vis = document.createElement('input');
    vis.type = 'checkbox';
    vis.checked = m.object.visible;
    vis.title = t('showHide');
    vis.setAttribute('aria-label', `${t('showHide')}: ${m.name}`);
    vis.addEventListener('click', (e) => e.stopPropagation());
    vis.addEventListener('change', () => {
      m.object.visible = vis.checked;
      if (!vis.checked && selection && selection.model === m) clearSelection();
      syncGizmo();
      requestRender();
    });

    const nameEl = document.createElement('span');
    nameEl.className = 'name';
    nameEl.textContent = m.name;

    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = t('closeModel');
    del.setAttribute('aria-label', `${t('closeModel')}: ${m.name}`);
    del.addEventListener('click', (e) => { e.stopPropagation(); removeModel(m); });

    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = t('modelSub', { format: m.format, n: fmtInt(m.stats.triangles) });

    row.append(vis, nameEl, del, sub);
    row.addEventListener('click', () => setActive(m));
    row.addEventListener('dblclick', () => fit(null, m.box));
    list.append(row);
  }
  $('model-empty').hidden = models.length > 0;
  $('drop-hint').style.display = models.length ? 'none' : '';
  let tris = 0;
  for (const m of models) tris += m.stats.triangles;
  $('status-right').textContent = models.length ? t('statusRight', { n: models.length, t: fmtInt(tris) }) : '';
}

// =================================================================================================
// Properties panel
// =================================================================================================

function dl(rows) {
  const el = document.createElement('dl');
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    if (v instanceof Node) dd.append(v);
    else dd.textContent = v;
    el.append(dt, dd);
  }
  return el;
}

function heading(text) {
  const h = document.createElement('h3');
  h.textContent = text;
  return h;
}

function note(text) {
  const p = document.createElement('p');
  p.className = 'note';
  p.textContent = text;
  return p;
}

function numberInput(value, step, onCommit) {
  const input = document.createElement('input');
  input.type = 'number';
  input.step = step;
  input.value = String(Math.round(value * 1000) / 1000);
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (Number.isFinite(v)) onCommit(v);
    else showProps();
  });
  return input;
}

function showProps() {
  const el = $('props');
  el.replaceChildren();
  const m = selection ? selection.model : activeModel;
  if (!m) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = t('propsEmpty');
    el.append(p);
    return;
  }
  const size = m.box.getSize(new THREE.Vector3());
  const rows = [[t('format'), m.format]];
  if (m.info.version) rows.push([t('savedBy'), m.info.version]);
  rows.push(
    [t('fileSize'), fmtBytes(m.bytes)],
    [t('sizeX'), fmt(size.x) + ' mm'],
    [t('sizeY'), fmt(size.y) + ' mm'],
    [t('sizeZ'), fmt(size.z) + ' mm'],
    [t('bodies'), fmtInt(m.stats.bodies)]
  );
  if (m.stats.faces) rows.push([t('faces'), fmtInt(m.stats.faces)]);
  rows.push([t('triangles'), fmtInt(m.stats.triangles)], [t('vertices'), fmtInt(m.stats.vertices)]);
  el.append(heading(m.name), dl(rows));

  if (selection) {
    const s = selection;
    const frows = [];
    if (s.faceIndex >= 0) frows.push([t('face'), t('faceOf', { n: s.faceIndex + 1, total: fmtInt(s.mesh.userData.faces.length) })]);
    if (s.faceIndex >= 0 && s.face.planar !== undefined) frows.push([t('type'), t(s.face.planar ? 'planar' : 'curved')]);
    frows.push(
      [t('area'), fmt(s.area) + ' mm²'],
      [t('triangles'), fmtInt(s.face.count / 3)],
      [t('extent'), `${fmt(s.size.x, 1)} × ${fmt(s.size.y, 1)} × ${fmt(s.size.z, 1)}`],
      [t('pickedAt'), `${fmt(s.point.x, 1)}, ${fmt(s.point.y, 1)}, ${fmt(s.point.z, 1)}`]
    );
    el.append(heading(t(s.faceIndex >= 0 ? 'selFace' : 'selBody')), dl(frows));
  }

  if (edit.on) {
    const o = m.object;
    const home = o.userData.home;
    const e = new THREE.Euler().setFromQuaternion(o.quaternion, 'XYZ');
    const deg = THREE.MathUtils.radToDeg;
    const rad = THREE.MathUtils.degToRad;
    const setPos = (axis) => (v) => transformModel(m, () => { o.position[axis] = home.p[axis] + v; });
    const setRot = (axis) => (v) => transformModel(m, () => { e[axis] = rad(v); o.quaternion.setFromEuler(e); });
    el.append(
      heading(t('transform')),
      dl([
        [t('offX'), numberInput(o.position.x - home.p.x, 1, setPos('x'))],
        [t('offY'), numberInput(o.position.y - home.p.y, 1, setPos('y'))],
        [t('offZ'), numberInput(o.position.z - home.p.z, 1, setPos('z'))],
        [t('rotX'), numberInput(deg(e.x), 5, setRot('x'))],
        [t('rotY'), numberInput(deg(e.y), 5, setRot('y'))],
        [t('rotZ'), numberInput(deg(e.z), 5, setRot('z'))],
        [t('scaleF'), numberInput(o.scale.x, 0.1, (v) => { if (v > 0) transformModel(m, () => o.scale.setScalar(v)); else showProps(); })],
      ]),
      note(t('note.edit'))
    );
  } else if (m.info.note) {
    el.append(note(t(m.info.note)));
  }
}

// =================================================================================================
// Picking, selection
// =================================================================================================

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function pick(ev) {
  const rect = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  if (displayMode === 'wireframe') return null; // nothing solid to hit
  const targets = [];
  for (const m of models) if (m.object.visible) targets.push(...m.parts);
  for (const hit of raycaster.intersectObjects(targets, false)) {
    if (section.on && clipPlane.distanceToPoint(hit.point) < 0) continue; // cut away
    return hit;
  }
  return null;
}

function findFace(mesh, indexOffset) {
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

const highlightMaterial = new THREE.MeshBasicMaterial({
  color: 0xff8a1f, transparent: true, opacity: 0.8, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
});

function clearSelection() {
  if (!selection) return;
  selection.mesh.remove(selection.highlight);
  selection.highlight.geometry.dispose();
  selection = null;
  showProps();
  requestRender();
}

function select(hit, wholeBody = false) {
  clearSelection();
  const mesh = hit.object;
  const model = models.find((m) => m.parts.includes(mesh));
  if (!model) return;
  const src = mesh.geometry;
  const total = src.index ? src.index.count : src.attributes.position.count;
  const faceIndex = wholeBody ? -1 : findFace(mesh, hit.faceIndex * 3);
  const face = faceIndex >= 0 ? mesh.userData.faces[faceIndex] : { start: 0, count: total };

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.attributes.position);
  if (src.index) g.setIndex(new THREE.BufferAttribute(src.index.array.subarray(face.start, face.start + face.count), 1));
  else g.setDrawRange(face.start, face.count);
  const highlight = new THREE.Mesh(g, highlightMaterial);
  highlight.raycast = () => {};
  highlight.renderOrder = 2;
  mesh.add(highlight);

  // Area and extent in world units.
  const pos = src.attributes.position;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const box = new THREE.Box3();
  let area = 0;
  for (let i = face.start; i < face.start + face.count; i += 3) {
    const ia = src.index ? src.index.getX(i) : i;
    const ib = src.index ? src.index.getX(i + 1) : i + 1;
    const ic = src.index ? src.index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(pos, ia).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(pos, ib).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(pos, ic).applyMatrix4(mesh.matrixWorld);
    box.expandByPoint(a).expandByPoint(b).expandByPoint(c);
    area += b.sub(a).cross(c.sub(a)).length() / 2;
  }
  selection = { model, mesh, face, faceIndex, highlight, area, size: box.getSize(new THREE.Vector3()), point: hit.point.clone() };
  activeModel = model;
  syncGizmo();
  refreshModelList();
  showProps();
  requestRender();
}

// =================================================================================================
// Edit mode
// =================================================================================================

function updateEditButtons() {
  $('edit-undo').disabled = edit.undo.length === 0;
  $('edit-redo').disabled = edit.redo.length === 0;
}

// Every edit goes through here so it can be undone. `command` = { undo(), redo() }.
function pushCommand(command) {
  edit.undo.push(command);
  edit.redo.length = 0;
  updateEditButtons();
}

function afterEdit(model) {
  if (model && models.includes(model)) refreshModel(model);
  applyDisplayMode();
  refreshModelList();
  showProps();
  requestRender();
}

function undo() {
  const c = edit.undo.pop();
  if (!c) return;
  clearSelection();
  c.undo();
  edit.redo.push(c);
  updateEditButtons();
}

function redo() {
  const c = edit.redo.pop();
  if (!c) return;
  clearSelection();
  c.redo();
  edit.undo.push(c);
  updateEditButtons();
}

// ---- transform ------------------------------------------------------------------------------

const snapshot = (o) => ({ p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() });
function restore(o, s) {
  o.position.copy(s.p);
  o.quaternion.copy(s.q);
  o.scale.copy(s.s);
}
const sameTRS = (a, b) => a.p.equals(b.p) && a.q.equals(b.q) && a.s.equals(b.s);

function recordTransform(model, before) {
  const after = snapshot(model.object);
  if (sameTRS(before, after)) return;
  pushCommand({
    undo: () => { restore(model.object, before); afterEdit(model); },
    redo: () => { restore(model.object, after); afterEdit(model); },
  });
  afterEdit(model);
}

function transformModel(model, change) {
  const before = snapshot(model.object);
  change();
  recordTransform(model, before);
}

function syncGizmo() {
  const m = activeModel;
  if (edit.on && edit.gizmo && m && m.object.visible) {
    gizmo.attach(m.object);
    gizmo.setMode(edit.gizmo);
  } else {
    gizmo.detach();
  }
  for (const b of $('edit-gizmo').querySelectorAll('[data-gizmo]')) b.classList.toggle('on', edit.on && b.dataset.gizmo === edit.gizmo);
  requestRender();
}

let gizmoStart = null;
gizmo.addEventListener('change', requestRender);
gizmo.addEventListener('dragging-changed', (e) => {
  controls.enabled = !e.value;
  if (!activeModel) return;
  if (e.value) gizmoStart = snapshot(activeModel.object);
  else if (gizmoStart) { recordTransform(activeModel, gizmoStart); gizmoStart = null; }
});

// ---- colour ---------------------------------------------------------------------------------

function paintSelection(hex) {
  if (!selection) { toast(t('e.needSel')); return; }
  const { mesh, face, model } = selection;
  const g = mesh.geometry;
  const before = { attr: g.attributes.color ? g.attributes.color.clone() : null, material: mesh.material };

  // Per-vertex colours let one face differ from the rest of the body.
  let material = mesh.material;
  let attr = g.attributes.color ? g.attributes.color.clone() : null;
  if (!attr || Array.isArray(material) || !material.vertexColors) {
    const base = !Array.isArray(material) && material.color ? material.color : DEFAULT_COLOR;
    if (!attr) {
      const arr = new Float32Array(g.attributes.position.count * 3);
      for (let i = 0; i < arr.length; i += 3) { arr[i] = base.r; arr[i + 1] = base.g; arr[i + 2] = base.b; }
      attr = new THREE.BufferAttribute(arr, 3);
    }
    material = partMaterial(null, true);
  }
  const c = new THREE.Color(hex);
  const index = g.index;
  for (let i = face.start; i < face.start + face.count; i++) {
    const v = index ? index.getX(i) : i;
    attr.setXYZ(v, c.r, c.g, c.b);
  }
  const after = { attr, material };

  const apply = (state) => {
    if (state.attr) g.setAttribute('color', state.attr);
    else g.deleteAttribute('color');
    mesh.material = state.material;
    afterEdit(model);
  };
  pushCommand({ undo: () => apply(before), redo: () => apply(after) });
  apply(after);
}

// ---- delete ---------------------------------------------------------------------------------

function swapEdges(mesh, lines) {
  for (const child of [...mesh.children]) if (child.userData.isEdges) mesh.remove(child);
  if (lines) mesh.add(lines);
}

function deleteSelection() {
  if (!selection) { toast(t('e.needSel')); return; }
  const { mesh, model, faceIndex, face } = selection;
  clearSelection();

  if (faceIndex < 0 || mesh.userData.faces.length <= 1) {
    // Whole body.
    const parent = mesh.parent;
    const apply = (present) => {
      if (present) parent.add(mesh);
      else parent.remove(mesh);
      afterEdit(model);
    };
    pushCommand({ undo: () => apply(true), redo: () => apply(false) });
    apply(false);
    return;
  }

  // One CAD face: drop its triangles from the index and rebuild the face outlines.
  const g = mesh.geometry;
  const oldIndex = g.index;
  const oldFaces = mesh.userData.faces;
  const oldEdges = mesh.children.find((ch) => ch.userData.isEdges) || null;

  const src = oldIndex.array;
  const arr = new src.constructor(src.length - face.count);
  arr.set(src.subarray(0, face.start), 0);
  arr.set(src.subarray(face.start + face.count), face.start);
  const newIndex = new THREE.BufferAttribute(arr, 1);
  const newFaces = [];
  oldFaces.forEach((f, i) => {
    if (i === faceIndex) return;
    newFaces.push(i > faceIndex ? { ...f, start: f.start - face.count } : f);
  });
  let newEdges = null;

  const apply = (index, faces, edges) => {
    g.setIndex(index);
    g.boundingBox = null;
    g.boundingSphere = null;
    mesh.userData.faces = faces;
    swapEdges(mesh, edges);
    afterEdit(model);
  };
  const redoIt = () => {
    g.setIndex(newIndex);
    if (!newEdges) newEdges = faceOutlineLines(g, newFaces);
    apply(newIndex, newFaces, newEdges);
  };
  pushCommand({ undo: () => apply(oldIndex, oldFaces, oldEdges), redo: redoIt });
  redoIt();
}

// ---- export ---------------------------------------------------------------------------------

function download(data, filename, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportAs(kind) {
  // Flatten to plain meshes in world space: no edge overlays, no highlight, edits baked in.
  const root = new THREE.Group();
  for (const m of models) {
    if (!m.object.visible) continue;
    for (const mesh of m.parts) {
      const cleanMaterial = (mat) => {
        const c = mat.clone();
        c.opacity = mat.userData.baseOpacity ?? 1;
        c.transparent = mat.userData.baseTransparent ?? false;
        c.wireframe = false;
        c.visible = true;
        c.colorWrite = true;
        c.depthWrite = true;
        return c;
      };
      const material = Array.isArray(mesh.material) ? mesh.material.map(cleanMaterial) : cleanMaterial(mesh.material);
      const copy = new THREE.Mesh(mesh.geometry, material);
      copy.name = mesh.name || m.name;
      mesh.updateWorldMatrix(true, false);
      copy.applyMatrix4(mesh.matrixWorld);
      root.add(copy);
    }
  }
  if (!root.children.length) { toast(t('e.nothing')); return; }
  root.updateMatrixWorld(true);
  const base = (activeModel ? activeModel.name.replace(/\.[^.]+$/, '') : 'model') + '-edited';
  try {
    if (kind === 'stl') {
      const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
      download(new STLExporter().parse(root, { binary: true }), base + '.stl', 'model/stl');
    } else if (kind === 'obj') {
      const { OBJExporter } = await import('three/addons/exporters/OBJExporter.js');
      download(new OBJExporter().parse(root), base + '.obj', 'text/plain');
    } else {
      const { GLTFExporter } = await import('three/addons/exporters/GLTFExporter.js');
      const wrapper = new THREE.Group();
      wrapper.rotation.x = -Math.PI / 2; // viewer is Z-up, glTF is Y-up
      wrapper.add(root);
      wrapper.updateMatrixWorld(true);
      const buffer = await new GLTFExporter().parseAsync(wrapper, { binary: true });
      download(buffer, base + '.glb', 'model/gltf-binary');
    }
  } catch (err) {
    console.error(err);
    toast('Export', errorText(err));
  }
}

// ---- mode switch ----------------------------------------------------------------------------

function setEditMode(on) {
  edit.on = on;
  $('mode-view').classList.toggle('on', !on);
  $('mode-edit').classList.toggle('on', on);
  $('editbar').hidden = !on;
  document.body.classList.toggle('editing', on);
  if (!on) {
    edit.gizmo = null;
    $('export-menu').hidden = true;
    // A body selection only exists in edit mode.
    if (selection && selection.faceIndex < 0 && selection.mesh.userData.faces) clearSelection();
  }
  syncGizmo();
  showProps();
}

// =================================================================================================
// Measure
// =================================================================================================

const measureLineMaterial = new THREE.LineBasicMaterial({ color: 0xe0356b, depthTest: false });
const labels = []; // { el, pos }

function setMeasureHint(key, vars) {
  measure.hint = [key, vars];
  $('measure-hint').textContent = key === 'raw' ? vars.text : t(key, vars);
}

function addLabel(pos, text, cls = '') {
  const el = document.createElement('div');
  el.className = 'label ' + cls;
  el.textContent = text;
  labelsEl.append(el);
  const label = { el, pos: pos.clone() };
  labels.push(label);
  return label;
}

function removeLabel(label) {
  label.el.remove();
  const i = labels.indexOf(label);
  if (i >= 0) labels.splice(i, 1);
}

function updateLabels(w, h) {
  for (const l of labels) {
    _v.copy(l.pos).project(camera);
    const visible = _v.z > -1 && _v.z < 1;
    l.el.style.display = visible ? '' : 'none';
    if (visible) {
      l.el.style.left = ((_v.x + 1) / 2) * w + 'px';
      l.el.style.top = ((1 - _v.y) / 2) * h + 'px';
    }
  }
}

// Snap to a corner of the hit triangle when the cursor is close to it.
function snapPoint(hit, ev) {
  const rect = canvas.getBoundingClientRect();
  const pos = hit.object.geometry.attributes.position;
  let best = hit.point.clone();
  let bestD = 12; // px
  for (const i of [hit.face.a, hit.face.b, hit.face.c]) {
    const p = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(hit.object.matrixWorld);
    _v.copy(p).project(camera);
    const dx = ((_v.x + 1) / 2) * rect.width - (ev.clientX - rect.left);
    const dy = ((1 - _v.y) / 2) * rect.height - (ev.clientY - rect.top);
    const d = Math.hypot(dx, dy);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function measureClick(hit, ev) {
  const p = snapPoint(hit, ev);
  if (!measure.pending) {
    measure.pending = { point: p, dot: addLabel(p, '', 'dot') };
    setMeasureHint('m.second');
  } else {
    const a = measure.pending.point;
    const g = new THREE.BufferGeometry().setFromPoints([a, p]);
    const line = new THREE.Line(g, measureLineMaterial);
    line.renderOrder = 10;
    overlayRoot.add(line);
    const d = p.clone().sub(a);
    const mid = a.clone().add(p).multiplyScalar(0.5);
    const deltas = `ΔX ${fmt(Math.abs(d.x))} · ΔY ${fmt(Math.abs(d.y))} · ΔZ ${fmt(Math.abs(d.z))}`;
    const item = { line, labels: [measure.pending.dot, addLabel(p, '', 'dot'), addLabel(mid, `${fmt(d.length())} mm`)] };
    item.labels[2].el.title = deltas;
    measure.items.push(item);
    measure.pending = null;
    setMeasureHint('raw', { text: `${fmt(d.length())} mm  (${deltas})` });
  }
  requestRender();
}

function cancelPending() {
  if (!measure.pending) return false;
  removeLabel(measure.pending.dot);
  measure.pending = null;
  setMeasureHint('m.first');
  requestRender();
  return true;
}

function clearMeasurements() {
  cancelPending();
  for (const item of measure.items) {
    overlayRoot.remove(item.line);
    item.line.geometry.dispose();
    item.labels.forEach(removeLabel);
  }
  measure.items.length = 0;
  setMeasureHint('m.first');
  requestRender();
}

function setMeasure(on) {
  measure.on = on;
  if (!on) cancelPending();
  $('btn-measure').classList.toggle('on', on);
  $('measure-panel').hidden = !on && measure.items.length === 0;
  canvas.style.cursor = on ? 'crosshair' : '';
}

// =================================================================================================
// Pointer handling (click vs. drag)
// =================================================================================================

let down = null;
canvas.addEventListener('pointerdown', (e) => {
  // A press that starts on the edit handle is a transform, never a selection.
  down = { x: e.clientX, y: e.clientY, button: e.button, onGizmo: gizmo.axis !== null && !!gizmo.object };
});
canvas.addEventListener('pointerup', (e) => {
  if (!down || down.button !== 0 || e.button !== 0 || down.onGizmo) { down = null; return; }
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 4) return;
  const hit = pick(e);
  if (measure.on) {
    if (hit) measureClick(hit, e);
    return;
  }
  if (hit) select(hit, edit.on && edit.target === 'body');
  else clearSelection();
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// =================================================================================================
// Loading files
// =================================================================================================

function busy(text) {
  $('busy').hidden = !text;
  if (text) $('busy-text').textContent = text;
}

// Let the "Loading…" overlay paint first; the timeout covers background tabs where rAF is paused.
const nextPaint = () => new Promise((r) => { requestAnimationFrame(() => setTimeout(r, 0)); setTimeout(r, 120); });

async function openBuffers(items) {
  let loaded = 0;
  for (const { name, getBuffer } of items) {
    busy(t('loading', { name }));
    await nextPaint();
    try {
      const buffer = await getBuffer();
      const result = await loadModel(name, buffer);
      addModel(name, buffer.byteLength, result);
      loaded++;
    } catch (err) {
      console.error(err);
      toast(t('err.open', { name }), errorText(err));
    }
  }
  busy(null);
  if (loaded) {
    if (models.length === loaded) fit(VIEWS.iso);
    else fit();
  }
}

function openFiles(fileList) {
  const items = [...fileList].map((f) => ({ name: f.name, getBuffer: () => f.arrayBuffer() }));
  if (items.length) openBuffers(items);
}

function openSample(name) {
  return openBuffers([{
    name,
    getBuffer: async () => {
      const res = await fetch('/samples/' + encodeURIComponent(name));
      if (!res.ok) throw Object.assign(new Error('Sample not found'), { i18n: 'err.sample', vars: { status: res.status } });
      return res.arrayBuffer();
    },
  }]);
}

async function initSamples() {
  let files = [];
  try {
    const res = await fetch('/api/samples');
    if (res.ok) files = await res.json();
  } catch { /* server without samples support */ }
  if (!files.length) return;
  const menu = $('samples-menu');
  for (const f of files) {
    const b = document.createElement('button');
    const n = document.createElement('span');
    n.textContent = f.name;
    const s = document.createElement('small');
    s.textContent = fmtBytes(f.size);
    b.append(n, s);
    b.addEventListener('click', () => { menu.hidden = true; openSample(f.name); });
    menu.append(b);
  }
  $('samples-wrap').hidden = false;
  $('btn-samples').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
}

// Drag and drop
let dragDepth = 0;
viewport.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; viewport.classList.add('dragging'); });
viewport.addEventListener('dragover', (e) => e.preventDefault());
viewport.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; viewport.classList.remove('dragging'); } });
viewport.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  viewport.classList.remove('dragging');
  if (e.dataTransfer?.files?.length) openFiles(e.dataTransfer.files);
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// =================================================================================================
// Toolbar wiring
// =================================================================================================

$('btn-open').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', (e) => { openFiles(e.target.files); e.target.value = ''; });
$('btn-fit').addEventListener('click', () => fit());
for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => fit(VIEWS[b.dataset.view]));
$('sel-mode').addEventListener('change', (e) => { displayMode = e.target.value; applyDisplayMode(); });
$('btn-proj').addEventListener('click', () => setProjection(camera !== ortho));
$('btn-section').addEventListener('click', () => setSection(!section.on));
$('btn-measure').addEventListener('click', () => setMeasure(!measure.on));
$('measure-clear').addEventListener('click', () => { clearMeasurements(); if (!measure.on) $('measure-panel').hidden = true; });

for (const b of $('section-axis').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    section.axis = b.dataset.axis;
    for (const o of $('section-axis').querySelectorAll('button')) o.classList.toggle('on', o === b);
    requestRender();
  });
}
$('section-pos').addEventListener('input', (e) => { section.t = e.target.value / 1000; requestRender(); });
$('section-flip').addEventListener('click', () => { section.flip = !section.flip; requestRender(); });

$('btn-shot').addEventListener('click', () => {
  scene.background = new THREE.Color(0xf2f4f7);
  render();
  const url = canvas.toDataURL('image/png');
  scene.background = null;
  requestRender();
  const a = document.createElement('a');
  a.href = url;
  a.download = (activeModel ? activeModel.name.replace(/\.[^.]+$/, '') : 'view') + '.png';
  a.click();
});

// Mode switch and edit bar
$('mode-view').addEventListener('click', () => setEditMode(false));
$('mode-edit').addEventListener('click', () => setEditMode(true));
for (const b of $('edit-target').querySelectorAll('button')) {
  b.addEventListener('click', () => {
    edit.target = b.dataset.target;
    for (const o of $('edit-target').querySelectorAll('button')) o.classList.toggle('on', o === b);
    clearSelection();
  });
}
for (const b of $('edit-gizmo').querySelectorAll('[data-gizmo]')) {
  b.addEventListener('click', () => {
    if (!activeModel) { toast(t('e.needModel')); return; }
    edit.gizmo = edit.gizmo === b.dataset.gizmo ? null : b.dataset.gizmo;
    syncGizmo();
  });
}
$('edit-reset').addEventListener('click', () => {
  if (!activeModel) { toast(t('e.needModel')); return; }
  const m = activeModel;
  transformModel(m, () => restore(m.object, m.object.userData.home));
});
$('edit-paint').addEventListener('click', () => paintSelection($('edit-color').value));
$('edit-delete').addEventListener('click', deleteSelection);
$('edit-undo').addEventListener('click', undo);
$('edit-redo').addEventListener('click', redo);
$('btn-export').addEventListener('click', (e) => { e.stopPropagation(); $('export-menu').hidden = !$('export-menu').hidden; });
for (const b of $('export-menu').querySelectorAll('[data-export]')) {
  b.addEventListener('click', () => { $('export-menu').hidden = true; exportAs(b.dataset.export); });
}
document.addEventListener('click', () => { $('samples-menu').hidden = true; $('export-menu').hidden = true; });

// Language
function refreshTexts() {
  applyStatic();
  document.title = APP_NAME;
  updateProjLabel();
  setMeasureHint(...measure.hint);
  refreshModelList();
  showProps();
}
$('sel-lang').value = getLang();
$('sel-lang').addEventListener('change', (e) => { setLang(e.target.value); refreshTexts(); });

window.addEventListener('keydown', (e) => {
  const tag = e.target?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  const k = e.key.toLowerCase();
  if (e.ctrlKey || e.metaKey) {
    if (!edit.on) return;
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    return;
  }
  if (e.altKey) return;
  const viewKeys = { 1: 'iso', 2: 'front', 3: 'back', 4: 'left', 5: 'right', 6: 'top', 7: 'bottom' };
  if (viewKeys[k]) fit(VIEWS[viewKeys[k]]);
  else if (k === 'f') fit();
  else if (k === 'o') $('file-input').click();
  else if (k === 'p') setProjection(camera !== ortho);
  else if (k === 's') setSection(!section.on);
  else if (k === 'm') setMeasure(!measure.on);
  else if ((k === 'delete' || k === 'backspace') && edit.on && selection) deleteSelection();
  else if (k === 'escape') {
    if (cancelPending()) return;
    if (measure.on) setMeasure(false);
    else if (edit.gizmo) { edit.gizmo = null; syncGizmo(); }
    else clearSelection();
  }
});

// =================================================================================================
// Start
// =================================================================================================

refreshTexts();
resize();
loop();
initSamples();
const startSample = new URLSearchParams(location.search).get('sample');
if (startSample) openSample(startSample);

// Small hook for automated checks.
window.__viewer = {
  models, fit, edit, extensionOf, setEditMode, paintSelection, deleteSelection, undo, redo, select, pick,
  get camera() { return camera; },
  get selection() { return selection; },
};
