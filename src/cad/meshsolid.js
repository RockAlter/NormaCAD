// Mesh helpers for mesh-based parts (CATPart display meshes, STL, OBJ, ...).
//
// A closed triangle mesh becomes a Manifold body, which supports fast booleans. Turning
// it into an OpenCascade solid instead was tried: it works, but a part like the sample
// CATPart keeps ~24,000 faces after merging and every later operation takes minutes.

// Welds coincident vertices; returns { positions, triangles, openEdges, nonManifoldEdges }.
export function weldMesh(positions, indices, decimals = 4) {
  const key = new Map();
  const pos = [];
  const n = positions.length / 3;
  const remap = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const k = `${x.toFixed(decimals)},${y.toFixed(decimals)},${z.toFixed(decimals)}`;
    let v = key.get(k);
    if (v === undefined) { v = pos.length / 3; key.set(k, v); pos.push(x, y, z); }
    remap[i] = v;
  }
  const idx = indices || Array.from({ length: n }, (_, i) => i);
  const tri = [];
  for (let i = 0; i < idx.length; i += 3) {
    const a = remap[idx[i]], b = remap[idx[i + 1]], c = remap[idx[i + 2]];
    if (a !== b && b !== c && a !== c) tri.push(a, b, c);
  }
  const nv = pos.length / 3;
  const use = new Map();
  for (let i = 0; i < tri.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const a = tri[i + k], b = tri[i + ((k + 1) % 3)];
      const e = a < b ? a * nv + b : b * nv + a;
      use.set(e, (use.get(e) || 0) + 1);
    }
  }
  let openEdges = 0, nonManifoldEdges = 0;
  for (const c of use.values()) {
    if (c === 1) openEdges++;
    else if (c > 2) nonManifoldEdges++;
  }
  return { positions: Float32Array.from(pos), triangles: Uint32Array.from(tri), openEdges, nonManifoldEdges };
}

// mf = Manifold module, R = replicad. Returns a replicad MeshShape.
export function meshToBody(mf, R, positions, triangles) {
  const mesh = new mf.Mesh({ numProp: 3, vertProperties: positions, triVerts: triangles });
  const manifold = new mf.Manifold(mesh);
  const status = manifold.status();
  if (status !== 'NoError') {
    throw Object.assign(new Error('Mesh is not a closed solid: ' + status), { i18n: 'k.meshOpen', vars: { status } });
  }
  let body = new R.MeshShape(manifold);
  // Inside-out meshes have negative volume; flip the triangles.
  if (body.volume() < 0) {
    const flipped = new Uint32Array(triangles.length);
    for (let i = 0; i < triangles.length; i += 3) {
      flipped[i] = triangles[i];
      flipped[i + 1] = triangles[i + 2];
      flipped[i + 2] = triangles[i + 1];
    }
    body = new R.MeshShape(new mf.Manifold(new mf.Mesh({ numProp: 3, vertProperties: positions, triVerts: flipped })));
  }
  return body;
}
