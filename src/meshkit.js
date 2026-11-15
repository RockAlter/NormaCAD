// Shared helpers that turn raw arrays into the objects the viewer understands.
//
// Viewer conventions:
//   mesh.userData.isPart  = true        -> pickable / styled by display modes
//   mesh.userData.faces   = [{start, count, color?, planar?}]   CAD faces as index ranges (optional)
//   line.userData.isEdges = true        -> CAD edge overlay belonging to its parent mesh
import * as THREE from 'three';

export const DEFAULT_COLOR = new THREE.Color(0xb9c2d0);
const EDGE_COLOR = 0x14181f;

export function partMaterial(color, vertexColors = false) {
  return new THREE.MeshStandardMaterial({
    color: vertexColors ? 0xffffff : color ?? DEFAULT_COLOR,
    vertexColors,
    roughness: 0.6,
    metalness: 0.05,
    side: THREE.DoubleSide,
    polygonOffset: true, // keeps the edge overlay from z-fighting with the surface
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

export function edgeLines(positions) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: EDGE_COLOR }));
  line.userData.isEdges = true;
  line.raycast = () => {};
  return line;
}

// Feature edges for meshes that come without CAD edges (STL, OBJ, ...).
export function addComputedEdges(mesh, angle = 28) {
  const g = mesh.geometry;
  const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
  if (tris > 1_500_000) return null; // too heavy to be worth it
  const eg = new THREE.EdgesGeometry(g, angle);
  const line = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: EDGE_COLOR }));
  line.userData.isEdges = true;
  line.raycast = () => {};
  mesh.add(line);
  return line;
}

// Outline of every CAD face: the triangle edges used by exactly one triangle of that face.
// Used to rebuild the edge overlay after faces have been deleted.
export function faceOutlineLines(geometry, faces) {
  const index = geometry.index.array;
  const pos = geometry.attributes.position.array;
  const n = geometry.attributes.position.count;
  const out = [];
  for (const f of faces) {
    const count = new Map();
    for (let i = f.start; i < f.start + f.count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = index[i + k];
        const b = index[i + ((k + 1) % 3)];
        const key = a < b ? a * n + b : b * n + a;
        count.set(key, (count.get(key) || 0) + 1);
      }
    }
    for (const [key, c] of count) {
      if (c !== 1) continue;
      const a = Math.floor(key / n) * 3;
      const b = (key % n) * 3;
      out.push(pos[a], pos[a + 1], pos[a + 2], pos[b], pos[b + 1], pos[b + 2]);
    }
  }
  return edgeLines(new Float32Array(out));
}

export function makePartMesh({ name, positions, normals, indices, color, faces, edges }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  if (indices) g.setIndex(new THREE.BufferAttribute(indices, 1));
  if (normals) g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  else g.computeVertexNormals();

  // Per-face colours only when faces actually differ; otherwise one material colour.
  let base = color ? new THREE.Color(color[0], color[1], color[2]) : null;
  let vertexColors = false;
  if (faces && faces.length) {
    const first = faces.find((f) => f.color)?.color;
    const varied = first && faces.some((f) => f.color && (f.color[0] !== first[0] || f.color[1] !== first[1] || f.color[2] !== first[2]));
    if (first && !varied && !base) base = new THREE.Color(first[0], first[1], first[2]);
    if (varied && indices) {
      const col = new Float32Array(positions.length);
      const fallback = base ?? DEFAULT_COLOR;
      for (const f of faces) {
        const c = f.color ?? [fallback.r, fallback.g, fallback.b];
        for (let i = f.start; i < f.start + f.count; i++) {
          const v = indices[i] * 3;
          col[v] = c[0]; col[v + 1] = c[1]; col[v + 2] = c[2];
        }
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      vertexColors = true;
    }
  }

  const mesh = new THREE.Mesh(g, partMaterial(base, vertexColors));
  mesh.name = name || 'Mesh';
  mesh.userData.isPart = true;
  if (faces && faces.length) mesh.userData.faces = faces;
  if (edges && edges.length) mesh.add(edgeLines(edges));
  else addComputedEdges(mesh);
  return mesh;
}
