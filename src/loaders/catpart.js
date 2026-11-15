// CATIA V5 (.CATPart / .cgr) reader.
//
// The exact B-Rep inside a CATPart is proprietary and is NOT read here. CATIA also stores a
// tessellated visualization copy of the part (an embedded "CGR" container holding a SceneGraph
// stream). This module decodes that copy: vertices, per-face triangles, and edge polylines.
// The layout below was reverse engineered from sample files (V5R30); every block is
// self-validated while parsing so that unknown variants fail cleanly instead of producing junk.

const SMOOTH_COS = Math.cos((40 * Math.PI) / 180);

// ---------------------------------------------------------------------------------------------
// V5_CFV2 container
// ---------------------------------------------------------------------------------------------

function be32(u8, o) {
  return ((u8[o] << 24) | (u8[o + 1] << 16) | (u8[o + 2] << 8) | u8[o + 3]) >>> 0;
}

function matchAscii(u8, o, s) {
  if (o < 0 || o + s.length > u8.length) return false;
  for (let i = 0; i < s.length; i++) if (u8[o + i] !== s.charCodeAt(i)) return false;
  return true;
}

function findContainers(u8) {
  const out = [];
  const n = u8.length;
  let i = u8.indexOf(0x56, 0);
  while (i >= 0 && i + 16 <= n) {
    if (matchAscii(u8, i, 'V5_CFV2') && u8[i + 7] === 0) {
      const dirOff = be32(u8, i + 8);
      const dirLen = be32(u8, i + 12);
      if (matchAscii(u8, i + dirOff, 'CATIA_V5') && i + dirOff + dirLen <= n) {
        out.push({ base: i, dirOff, dirLen });
      }
    }
    i = u8.indexOf(0x56, i + 1);
  }
  return out;
}

// Directory entries: [utf16be name][00 00][00 00][00 6a|7e][u32 id][u16 type] ...
// type 2 = stream: size @+10, fragment count @+78, fragments (20 bytes each: offset, size, ...) @+82
function readDirectory(u8, c) {
  const d = u8.subarray(c.base + c.dirOff, c.base + c.dirOff + c.dirLen);
  const entries = [];
  for (let i = 2; i + 12 < d.length; i++) {
    if (d[i] | d[i + 1] | d[i + 2] | d[i + 3] | d[i + 4]) continue;
    if ((d[i + 5] !== 0x6a && d[i + 5] !== 0x7e) || d[i + 6] !== 0 || d[i + 7] !== 0) continue;
    let j = i;
    let name = '';
    while (j >= 2 && d[j - 2] === 0 && d[j - 1] >= 0x20 && d[j - 1] < 0x7f) {
      name = String.fromCharCode(d[j - 1]) + name;
      j -= 2;
    }
    if (name.length < 3) continue;
    const s = i + 6;
    const type = (d[s + 4] << 8) | d[s + 5];
    const entry = { name, type, frags: null };
    if (type === 2 && s + 82 <= d.length) {
      const nfrag = be32(d, s + 78);
      const frags = [];
      let p = s + 82;
      let ok = nfrag > 0 && nfrag < 4096;
      for (let k = 0; ok && k < nfrag; k++, p += 20) {
        if (p + 8 > d.length) { ok = false; break; }
        const off = be32(d, p);
        const len = be32(d, p + 4);
        if (c.base + off + len > u8.length) { ok = false; break; }
        frags.push([c.base + off, len]);
      }
      if (ok) entry.frags = frags;
    }
    entries.push(entry);
  }
  return entries;
}

function concatFrags(u8, frags) {
  if (frags.length === 1) return u8.subarray(frags[0][0], frags[0][0] + frags[0][1]);
  let total = 0;
  for (const f of frags) total += f[1];
  const out = new Uint8Array(total);
  let p = 0;
  for (const f of frags) {
    out.set(u8.subarray(f[0], f[0] + f[1]), p);
    p += f[1];
  }
  return out;
}

function findSceneGraphStreams(u8) {
  const streams = [];
  for (const c of findContainers(u8)) {
    let parent = '';
    for (const e of readDirectory(u8, c)) {
      if (e.type !== 2) { parent = e.name; continue; }
      if (e.name === 'MainDataStream' && parent === 'SceneGraph' && e.frags) {
        streams.push(concatFrags(u8, e.frags));
      }
    }
  }
  return streams;
}

// ---------------------------------------------------------------------------------------------
// Tessellated rep
// ---------------------------------------------------------------------------------------------

// Counts are one byte, or 0xff followed by a little-endian u32.
function readCount(d, dv, st) {
  const b = d[st.p];
  if (b === 0xff) {
    if (st.p + 5 > d.length) return -1;
    const v = dv.getUint32(st.p + 1, true);
    st.p += 5;
    return v;
  }
  st.p += 1;
  return b === undefined ? -1 : b;
}

// Vertex block:  count nv, count nn (vertices that carry normals), 4 zero bytes,
//   2 bits per vertex (LSB first), count of floats, floats.
// Vertices are sorted by (x, y, z) and prefix-compressed. Code per vertex:
//   0 -> new x, y, z   3 -> new y, z   2 -> new z   1 -> same position as previous vertex
function tryVertexBlock(d, dv, p) {
  const n = d.length;
  const st = { p };
  const nv = readCount(d, dv, st);
  if (nv < 3 || nv > (n - st.p) * 4) return null;
  const nn = readCount(d, dv, st);
  if (nn < 0 || nn > nv) return null;
  let q = st.p;
  if (q + 5 > n || d[q] | d[q + 1] | d[q + 2] | d[q + 3]) return null;
  const sym = q + 4;
  if (d[sym] & 3) return null; // first vertex must be a full xyz
  const nbytes = (nv + 3) >> 2;
  if (sym + nbytes + 1 > n) return null;

  let c0 = 0, c2 = 0, c3 = 0;
  for (let i = 0; i < nv; i++) {
    const c = (d[sym + (i >> 2)] >> ((i & 3) * 2)) & 3;
    if (c === 0) c0++; else if (c === 2) c2++; else if (c === 3) c3++;
  }
  const expected = c0 * 3 + c3 * 2 + c2;
  st.p = sym + nbytes;
  const nf = readCount(d, dv, st);
  if (nf !== expected) return null;
  const f0 = st.p;
  if (f0 + nf * 4 > n) return null;

  const pos = new Float32Array(nv * 3);
  const cluster = new Int32Array(nv); // index of first vertex sharing this position
  let x = 0, y = 0, z = 0, k = f0, px = -Infinity;
  for (let i = 0; i < nv; i++) {
    const c = (d[sym + (i >> 2)] >> ((i & 3) * 2)) & 3;
    if (c === 0) {
      x = dv.getFloat32(k, true); y = dv.getFloat32(k + 4, true); z = dv.getFloat32(k + 8, true);
      k += 12;
      if (x < px && i !== nn) return null; // sorted, except where the normal-less group starts
      px = x;
    } else if (c === 3) {
      y = dv.getFloat32(k, true); z = dv.getFloat32(k + 4, true);
      k += 8;
    } else if (c === 2) {
      z = dv.getFloat32(k, true);
      k += 4;
    }
    if (!(Math.abs(x) < 1e9 && Math.abs(y) < 1e9 && Math.abs(z) < 1e9)) return null; // also rejects NaN
    pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
    cluster[i] = c === 1 && i > 0 ? cluster[i - 1] : i;
  }
  return { nv, nn, pos, cluster, end: k };
}

// Face record: 01, flags, [ntri] [nstrip] [nfan] (present per flag bits 1/2/4), total index count,
//   [3 float normal if flag 8 = planar face], strip lengths, fan lengths, big-endian indices.
function parseFaces(d, dv, p, nv, width) {
  const n = d.length;
  const st = { p };
  const nfaces = readCount(d, dv, st);
  if (nfaces < 1 || nfaces > n) return null;
  const faces = [];
  for (let f = 0; f < nfaces; f++) {
    if (st.p + 3 > n) return null;
    const lead = d[st.p];
    const flags = d[st.p + 1];
    st.p += 2;
    if (lead !== 1 || (flags & 0xb0) !== 0 || (flags & 7) === 0) return null;
    const ntri = flags & 1 ? readCount(d, dv, st) : 0;
    const nstrip = flags & 2 ? readCount(d, dv, st) : 0;
    const nfan = flags & 4 ? readCount(d, dv, st) : 0;
    const total = readCount(d, dv, st);
    if (ntri < 0 || nstrip < 0 || nfan < 0 || total < 3) return null;
    if (nstrip + nfan > n || total > n) return null;
    let normal = null;
    if (flags & 8) {
      if (st.p + 12 > n) return null;
      normal = [dv.getFloat32(st.p, true), dv.getFloat32(st.p + 4, true), dv.getFloat32(st.p + 8, true)];
      const len = Math.hypot(normal[0], normal[1], normal[2]);
      if (!(len > 0.5 && len < 1.5)) return null;
      st.p += 12;
    }
    const strips = new Array(nstrip);
    const fans = new Array(nfan);
    let sum = ntri * 3;
    for (let i = 0; i < nstrip; i++) { const v = readCount(d, dv, st); if (v < 3) return null; strips[i] = v; sum += v; }
    for (let i = 0; i < nfan; i++) { const v = readCount(d, dv, st); if (v < 3) return null; fans[i] = v; sum += v; }
    if (sum !== total || st.p + total * width > n) return null;
    const idx = new Uint32Array(total);
    for (let i = 0, q = st.p; i < total; i++, q += width) {
      const v = width === 2 ? (d[q] << 8) | d[q + 1] : width === 4 ? be32(d, q) : d[q];
      if (v >= nv) return null;
      idx[i] = v;
    }
    st.p += total * width;
    faces.push({ ntri, strips, fans, normal, idx, color: null });
  }
  return { faces, end: st.p };
}

// Edge groups: 01, kind (1 boundary / 2 internal), count, then polylines: 02, npoints, indices.
function parseEdgeGroup(d, dv, p, nv, width) {
  const n = d.length;
  if (p + 3 > n || d[p] !== 1 || (d[p + 1] !== 1 && d[p + 1] !== 2)) return null;
  const kind = d[p + 1];
  const st = { p: p + 2 };
  const count = readCount(d, dv, st);
  if (count < 1 || count > n) return null;
  const lines = [];
  for (let i = 0; i < count; i++) {
    if (st.p + 2 > n || d[st.p] !== 2) return null;
    st.p += 1;
    const np = readCount(d, dv, st);
    if (np < 2 || st.p + np * width > n) return null;
    const idx = new Uint32Array(np);
    for (let k = 0, q = st.p; k < np; k++, q += width) {
      const v = width === 2 ? (d[q] << 8) | d[q + 1] : width === 4 ? be32(d, q) : d[q];
      if (v >= nv) return null;
      idx[k] = v;
    }
    st.p += np * width;
    lines.push(idx);
  }
  return { kind, lines, end: st.p };
}

function parseRepAt(d, dv, p) {
  const vb = tryVertexBlock(d, dv, p);
  if (!vb) return null;
  const { nv, nn } = vb;

  // Normals block (not decoded; normals are recomputed): count, u16 values, 4 bits per normal.
  const st = { p: vb.end };
  const n16 = readCount(d, dv, st);
  if (n16 < 0) return null;
  const afterNormals = st.p + n16 * 2 + ((nn + 1) >> 1);
  if (afterNormals > d.length) return null;

  const widths = nv > 65536 ? [4, 2] : nv > 256 ? [2] : [2, 1];
  let parsed = null;
  let width = 2;
  outer: for (const w of widths) {
    for (let off = 0; off <= 32; off++) {
      const r = parseFaces(d, dv, afterNormals + off, nv, w);
      if (r) { parsed = r; width = w; break outer; }
    }
  }
  if (!parsed) return null;

  // Per-face graphic attributes: 30 04 04 ff ff B G R
  let q = parsed.end;
  for (let f = 0; f < parsed.faces.length && q + 8 <= d.length && d[q] === 0x30; f++, q += 8) {
    parsed.faces[f].color = [d[q + 7] / 255, d[q + 6] / 255, d[q + 5] / 255];
  }

  const edgeGroups = [];
  for (let g = 0; g < 4; g++) {
    const eg = parseEdgeGroup(d, dv, q, nv, width);
    if (!eg) break;
    edgeGroups.push(eg);
    q = eg.end;
    if (q + 8 <= d.length && d[q] === 0x10) q += 8; // edge graphic attributes
  }
  return { ...vb, faces: parsed.faces, edgeGroups, end: q };
}

function scanReps(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const reps = [];
  const n = d.length;
  let p = 0;
  while (p < n - 16) {
    const rep = parseRepAt(d, dv, p);
    if (rep) { reps.push(rep); p = rep.end; } else p++;
  }
  return reps;
}

// ---------------------------------------------------------------------------------------------
// Rep -> render-ready mesh
// ---------------------------------------------------------------------------------------------

function buildMesh(rep, name) {
  const { nv, pos, cluster, faces } = rep;

  // 1. Expand strips / fans to triangles (original vertex indices).
  let totalIdx = 0;
  for (const f of faces) {
    let t = f.ntri;
    for (const s of f.strips) t += s - 2;
    for (const s of f.fans) t += s - 2;
    f.triCount = t;
    totalIdx += t * 3;
  }
  const tri = new Uint32Array(totalIdx);
  let w = 0;
  for (const f of faces) {
    const idx = f.idx;
    let p = 0;
    f.start = w;
    for (let i = 0; i < f.ntri; i++, p += 3) { tri[w++] = idx[p]; tri[w++] = idx[p + 1]; tri[w++] = idx[p + 2]; }
    for (const L of f.strips) {
      for (let i = 0; i < L - 2; i++) {
        if (i & 1) { tri[w++] = idx[p + i + 1]; tri[w++] = idx[p + i]; } else { tri[w++] = idx[p + i]; tri[w++] = idx[p + i + 1]; }
        tri[w++] = idx[p + i + 2];
      }
      p += L;
    }
    for (const L of f.fans) {
      for (let i = 1; i < L - 1; i++) { tri[w++] = idx[p]; tri[w++] = idx[p + i]; tri[w++] = idx[p + i + 1]; }
      p += L;
    }
  }

  // 2. Area-weighted normal per original vertex.
  const acc = new Float64Array(nv * 3);
  for (let t = 0; t < totalIdx; t += 3) {
    const a = tri[t] * 3, b = tri[t + 1] * 3, c = tri[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    acc[a] += nx; acc[a + 1] += ny; acc[a + 2] += nz;
    acc[b] += nx; acc[b + 1] += ny; acc[b + 2] += nz;
    acc[c] += nx; acc[c + 1] += ny; acc[c + 2] += nz;
  }

  // 3. Smooth across vertices that share a position unless they meet at a crease.
  const unit = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    const l = Math.hypot(acc[i * 3], acc[i * 3 + 1], acc[i * 3 + 2]);
    if (l > 0) { unit[i * 3] = acc[i * 3] / l; unit[i * 3 + 1] = acc[i * 3 + 1] / l; unit[i * 3 + 2] = acc[i * 3 + 2] / l; }
  }
  const smooth = new Float32Array(nv * 3);
  let cs = 0;
  while (cs < nv) {
    let ce = cs + 1;
    while (ce < nv && cluster[ce] === cs) ce++;
    for (let i = cs; i < ce; i++) {
      let sx = 0, sy = 0, sz = 0;
      const ix = unit[i * 3], iy = unit[i * 3 + 1], iz = unit[i * 3 + 2];
      for (let j = cs; j < ce; j++) {
        if (ix * unit[j * 3] + iy * unit[j * 3 + 1] + iz * unit[j * 3 + 2] >= SMOOTH_COS) {
          sx += acc[j * 3]; sy += acc[j * 3 + 1]; sz += acc[j * 3 + 2];
        }
      }
      const l = Math.hypot(sx, sy, sz) || 1;
      smooth[i * 3] = sx / l; smooth[i * 3 + 1] = sy / l; smooth[i * 3 + 2] = sz / l;
    }
    cs = ce;
  }

  // 4. Emit vertices per face so planar faces keep their exact normal and faces can be coloured.
  const outPos = new Float32Array(totalIdx * 3);
  const outNrm = new Float32Array(totalIdx * 3);
  const outIdx = new Uint32Array(totalIdx);
  const remap = new Int32Array(nv).fill(-1);
  const outFaces = [];
  let vcount = 0;
  for (const f of faces) {
    const touched = [];
    const end = f.start + f.triCount * 3;
    for (let t = f.start; t < end; t++) {
      const v = tri[t];
      let m = remap[v];
      if (m < 0) {
        m = vcount++;
        remap[v] = m;
        touched.push(v);
        outPos[m * 3] = pos[v * 3]; outPos[m * 3 + 1] = pos[v * 3 + 1]; outPos[m * 3 + 2] = pos[v * 3 + 2];
        if (f.normal) {
          outNrm[m * 3] = f.normal[0]; outNrm[m * 3 + 1] = f.normal[1]; outNrm[m * 3 + 2] = f.normal[2];
        } else {
          outNrm[m * 3] = smooth[v * 3]; outNrm[m * 3 + 1] = smooth[v * 3 + 1]; outNrm[m * 3 + 2] = smooth[v * 3 + 2];
        }
      }
      outIdx[t] = m;
    }
    for (const v of touched) remap[v] = -1;
    outFaces.push({ start: f.start, count: f.triCount * 3, color: f.color, planar: !!f.normal });
  }

  // 5. Edge polylines -> line segments.
  let nseg = 0;
  for (const g of rep.edgeGroups) for (const l of g.lines) nseg += l.length - 1;
  const edges = new Float32Array(nseg * 6);
  let e = 0;
  for (const g of rep.edgeGroups) {
    for (const l of g.lines) {
      for (let i = 0; i + 1 < l.length; i++) {
        const a = l[i] * 3, b = l[i + 1] * 3;
        edges[e++] = pos[a]; edges[e++] = pos[a + 1]; edges[e++] = pos[a + 2];
        edges[e++] = pos[b]; edges[e++] = pos[b + 1]; edges[e++] = pos[b + 2];
      }
    }
  }

  return {
    name,
    positions: outPos.slice(0, vcount * 3),
    normals: outNrm.slice(0, vcount * 3),
    indices: outIdx,
    faces: outFaces,
    edges: nseg ? edges : null,
  };
}

function findVersion(u8) {
  const head = u8.subarray(0, Math.min(u8.length, 65536));
  let s = '';
  for (let i = 0; i < head.length; i++) s += head[i] >= 0x20 && head[i] < 0x7f ? String.fromCharCode(head[i]) : ' ';
  const m = /V5-?6?R\d{1,4}(SP\d+)?(HF\d+)?/.exec(s);
  return m ? m[0] : null;
}

export function parseCATPart(buffer) {
  const u8 = new Uint8Array(buffer);
  if (!matchAscii(u8, 0, 'V5_CFV2')) {
    throw Object.assign(new Error('Not a CATIA V5 file (missing V5_CFV2 signature).'), { i18n: 'err.notCatia' });
  }
  let reps = [];
  for (const s of findSceneGraphStreams(u8)) reps = reps.concat(scanReps(s));
  if (!reps.length) reps = scanReps(u8); // unknown directory layout: scan the whole file
  if (!reps.length) {
    throw Object.assign(new Error('No embedded display mesh was found in this CATIA file.'), { i18n: 'err.noMesh' });
  }
  const meshes = reps.map((r, i) => buildMesh(r, reps.length > 1 ? `Body ${i + 1}` : 'Body'));
  return {
    meshes,
    info: {
      format: 'CATIA V5',
      version: findVersion(u8),
      note: 'note.catia',
    },
  };
}
