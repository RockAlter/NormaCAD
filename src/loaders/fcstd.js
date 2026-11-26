// FreeCAD document (.FCStd) reader.
//
// An .FCStd file is a zip: Document.xml lists the objects and their properties,
// GuiDocument.xml holds visibility and colours, and each shape is stored as an
// OpenCascade BREP file (<Object>.Shape.brp). This module decides which shapes FreeCAD
// would show and where; the BREP files themselves are read by OpenCascade elsewhere.
// No DOM is used so it also runs in Node tests.
import { unzipSync } from 'three/addons/libs/fflate.module.js';

const CONTAINERS = new Set(['App::Part', 'Assembly::AssemblyObject', 'App::LinkGroup']);
const LINKS = new Set(['App::Link', 'App::LinkElement', 'App::LinkPython']);
// Objects whose shapes are construction geometry rather than the model itself.
const SKIP_TYPES = /^(Sketcher::|App::(Origin|Line|Plane|Point)$|PartDesign::(Plane|Line|Point|CoordinateSystem|ShapeBinder|SubShapeBinder)$|Part::Part2DObject|TechDraw::)/;

const decoder = new TextDecoder();
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function prop(chunk, name) {
  const i = chunk.indexOf(`<Property name="${name}" `);
  if (i < 0) return null;
  const end = chunk.indexOf('</Property>', i);
  return chunk.slice(i, end < 0 ? undefined : end);
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/(\w+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function parseDocument(xml) {
  const objects = new Map();
  const head = xml.slice(0, xml.indexOf('<ObjectData'));
  for (const m of head.matchAll(/<Object type="([^"]+)" name="([^"]+)"/g)) objects.set(m[2], { type: m[1], name: m[2] });
  const data = xml.slice(xml.indexOf('<ObjectData'));
  const parts = data.split(/<Object name="/).slice(1);
  for (const chunk of parts) {
    const name = chunk.slice(0, chunk.indexOf('"'));
    const o = objects.get(name);
    if (!o) continue;
    const shape = prop(chunk, 'Shape');
    if (shape && shape.includes('Part::PropertyPartShape')) {
      const f = /file="([^"]*)"/.exec(shape);
      if (f) o.shapeFile = f[1];
    }
    const pl = prop(chunk, 'Placement');
    if (pl) {
      const t = /<PropertyPlacement ([^>]*)\/>/.exec(pl);
      if (t) o.placement = placementMatrix(attrs(t[1]));
    }
    const label = prop(chunk, 'Label');
    if (label) {
      const s = /<String value="([^"]*)"/.exec(label);
      if (s) o.label = unescape(s[1]);
    }
    const group = prop(chunk, 'Group');
    if (group) o.group = [...group.matchAll(/<Link value="([^"]*)"/g)].map((x) => x[1]).filter(Boolean);
    const linked = prop(chunk, 'LinkedObject');
    if (linked) {
      const x = /<XLink [^>]*name="([^"]*)"/.exec(linked) || /<Link value="([^"]*)"/.exec(linked);
      if (x && x[1]) o.linked = x[1];
    }
    const lt = prop(chunk, 'LinkTransform');
    if (lt) o.linkTransform = /<Bool value="true"/.test(lt);
    const vis = prop(chunk, 'Visibility');
    if (vis) o.docVisible = !/<Bool value="false"/.test(vis);
  }
  return objects;
}

// FreeCAD placement: position + quaternion (Q0..Q2 = x, y, z, Q3 = w).
// Returned as a column-major 4x4 array (three.js Matrix4.fromArray order).
function placementMatrix(a) {
  const x = +a.Q0 || 0, y = +a.Q1 || 0, z = +a.Q2 || 0, w = a.Q3 === undefined ? 1 : +a.Q3;
  const px = +a.Px || 0, py = +a.Py || 0, pz = +a.Pz || 0;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
    2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
    2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
    px, py, pz, 1,
  ];
}

export const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function mul(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

// Inverse of a rigid transform (rotation + translation).
function invRigid(m) {
  const r = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  const t = [m[12], m[13], m[14]];
  r[12] = -(r[0] * t[0] + r[4] * t[1] + r[8] * t[2]);
  r[13] = -(r[1] * t[0] + r[5] * t[1] + r[9] * t[2]);
  r[14] = -(r[2] * t[0] + r[6] * t[1] + r[10] * t[2]);
  return r;
}

// Packed FreeCAD colour: 0xRRGGBBAA stored little-endian.
function unpack(dv, o) {
  return [dv.getUint8(o + 3) / 255, dv.getUint8(o + 2) / 255, dv.getUint8(o + 1) / 255];
}

// App::PropertyMaterialList binary: count, then per material four packed colours
// (ambient, diffuse, specular, emissive), shininess, transparency, and (version 3) four
// length-prefixed strings.
function parseMaterials(bytes) {
  if (!bytes || bytes.length < 28) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  if (n < 1 || n > 1e6) return null;
  const out = [];
  let p = 4;
  for (let i = 0; i < n && p + 24 <= bytes.length; i++) {
    const diffuse = unpack(dv, p + 4);
    const transparency = dv.getFloat32(p + 20, true);
    p += 24;
    for (let s = 0; s < 4 && p + 4 <= bytes.length; s++) {
      const len = dv.getUint32(p, true);
      if (len > bytes.length) break;
      p += 4 + len;
    }
    out.push({ color: diffuse, transparency: Number.isFinite(transparency) ? transparency : 0 });
  }
  return out;
}

// Older files: App::PropertyColorList (count + packed colours).
function parseColorList(bytes) {
  if (!bytes || bytes.length < 8) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = dv.getUint32(0, true);
  if (n < 1 || 4 + n * 4 > bytes.length) return null;
  return Array.from({ length: n }, (_, i) => ({ color: unpack(dv, 4 + i * 4), transparency: (255 - dv.getUint8(4 + i * 4)) / 255 }));
}

function parseGui(xml, files) {
  const vps = new Map();
  if (!xml) return vps;
  for (const chunk of xml.split(/<ViewProvider name="/).slice(1)) {
    const name = chunk.slice(0, chunk.indexOf('"'));
    const v = {};
    const vis = prop(chunk, 'Visibility');
    if (vis) v.visible = !/<Bool value="false"/.test(vis);
    const app = prop(chunk, 'ShapeAppearance');
    const mf = app && /<MaterialList file="([^"]+)"/.exec(app);
    if (mf) v.materials = parseMaterials(files[mf[1]]);
    if (!v.materials) {
      const dc = prop(chunk, 'DiffuseColor');
      const cf = dc && /<ColorList file="([^"]+)"/.exec(dc);
      if (cf) v.materials = parseColorList(files[cf[1]]);
    }
    if (!v.materials) {
      const sc = prop(chunk, 'ShapeColor');
      const c = sc && /<PropertyColor value="(\d+)"/.exec(sc);
      if (c) {
        const u = +c[1];
        const tr = prop(chunk, 'Transparency');
        const tv = tr && /<Integer value="(\d+)"/.exec(tr);
        v.materials = [{ color: [((u >>> 24) & 255) / 255, ((u >>> 16) & 255) / 255, ((u >>> 8) & 255) / 255], transparency: tv ? +tv[1] / 100 : 0 }];
      }
    }
    vps.set(name, v);
  }
  return vps;
}

// Returns { items: [{ name, brep (string), matrix, materials }], thumbnail, objectCount }.
export function parseFCStd(buffer) {
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer));
  } catch {
    throw Object.assign(new Error('not a zip'), { i18n: 'err.fcstd' });
  }
  if (!files['Document.xml']) throw Object.assign(new Error('no Document.xml'), { i18n: 'err.fcstd' });
  const objects = parseDocument(decoder.decode(files['Document.xml']));
  const gui = parseGui(files['GuiDocument.xml'] ? decoder.decode(files['GuiDocument.xml']) : '', files);

  const parent = new Map();
  for (const o of objects.values()) for (const c of o.group || []) if (!parent.has(c)) parent.set(c, o.name);

  const visible = (name) => {
    const v = gui.get(name)?.visible;
    if (v !== undefined) return v;
    return objects.get(name)?.docVisible !== false;
  };
  const ancestors = (name) => {
    const out = [];
    for (let p = parent.get(name), guard = 0; p && guard < 100; p = parent.get(p), guard++) out.push(objects.get(p));
    return out.filter(Boolean);
  };
  // Container placements apply to the shapes inside them.
  const containerMatrix = (name) => {
    let m = IDENTITY;
    for (const a of ancestors(name).reverse()) if (CONTAINERS.has(a.type) && a.placement) m = mul(m, a.placement);
    return m;
  };
  const hiddenByContainer = (name) => ancestors(name).some((a) => (CONTAINERS.has(a.type) || a.type === 'PartDesign::Body') && !visible(a.name));
  const insideBody = (name) => ancestors(name).some((a) => a.type === 'PartDesign::Body');

  const items = [];
  const hasShape = (o) => o && o.shapeFile && files[o.shapeFile] && files[o.shapeFile].length > 0;
  const add = (o, matrix, label) => {
    items.push({
      name: label || o.label || o.name,
      file: o.shapeFile,
      brep: decoder.decode(files[o.shapeFile]),
      matrix,
      materials: gui.get(o.name)?.materials || null,
    });
  };
  // Everything a link (or a container reached through a link) shows.
  const addTree = (o, matrix, label, depth = 0) => {
    if (!o || depth > 20) return;
    if (LINKS.has(o.type)) {
      const target = objects.get(o.linked);
      if (!target) return;
      const own = o.placement || IDENTITY;
      // By default a link replaces the target's placement with its own.
      const m = o.linkTransform ? mul(matrix, own) : mul(mul(matrix, own), target.placement && !CONTAINERS.has(target.type) ? invRigid(target.placement) : IDENTITY);
      addTree(target, CONTAINERS.has(target.type) && !o.linkTransform ? mul(mul(matrix, own), target.placement ? invRigid(target.placement) : IDENTITY) : m, label || o.label, depth + 1);
      return;
    }
    if (CONTAINERS.has(o.type)) {
      const inner = o.placement ? mul(matrix, o.placement) : matrix;
      for (const c of o.group || []) {
        const child = objects.get(c);
        if (child && visible(c) && !SKIP_TYPES.test(child.type)) addTree(child, inner, null, depth + 1);
      }
      return;
    }
    if (hasShape(o) && !SKIP_TYPES.test(o.type)) add(o, matrix, label);
  };

  // Objects used by a visible link are library copies (e.g. the source parts of an
  // assembly); FreeCAD shows the placed instances, so the originals are not drawn again.
  const linkedTargets = new Set();
  for (const o of objects.values()) if (LINKS.has(o.type) && o.linked && visible(o.name)) linkedTargets.add(o.linked);

  for (const o of objects.values()) {
    if (!visible(o.name) || SKIP_TYPES.test(o.type) || insideBody(o.name) || hiddenByContainer(o.name)) continue;
    if (linkedTargets.has(o.name)) continue;
    // Contents of containers are reached through the container itself, except when the
    // container is shown through a link elsewhere: then top-level containers draw them.
    const inContainer = ancestors(o.name).some((a) => CONTAINERS.has(a.type));
    if (inContainer) continue;
    if (LINKS.has(o.type) || CONTAINERS.has(o.type)) addTree(o, IDENTITY);
    else if (hasShape(o)) add(o, containerMatrix(o.name));
  }

  // Nothing visible that has a solid (e.g. only FEM meshes or results are shown): fall back
  // to the document's geometry, hidden or not, so the file still opens.
  let hiddenFallback = false;
  if (!items.length) {
    for (const o of objects.values()) {
      if (SKIP_TYPES.test(o.type) || insideBody(o.name) || !hasShape(o)) continue;
      if (ancestors(o.name).some((a) => CONTAINERS.has(a.type))) continue;
      add(o, containerMatrix(o.name));
    }
    hiddenFallback = items.length > 0;
  }

  return { items, hiddenFallback, thumbnail: files['thumbnails/Thumbnail.png'] || null, objectCount: objects.size };
}
