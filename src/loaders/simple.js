// Small text and binary formats with no dependencies (run in the browser and in Node).

// ---- OFF (Object File Format) --------------------------------------------------------------
// One vertex or face per line; extra values on a line (normals, colours) are ignored.
export function parseOFF(text) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean);
  const bad = () => Object.assign(new Error('not OFF'), { i18n: 'err.badFile', vars: { format: 'OFF' } });
  if (!lines.length || !/^[A-Z]*OFF/.test(lines[0])) throw bad();
  let head = lines[0].replace(/^[A-Z]*OFF/, '').trim();
  let li = 1;
  if (!head) head = lines[li++] || '';
  const [nv, nf] = head.split(/\s+/).map(Number);
  if (!(nv >= 0 && nf >= 0) || li + nv + nf > lines.length) throw bad();
  const positions = new Float32Array(nv * 3);
  for (let v = 0; v < nv; v++) {
    const p = lines[li++].split(/\s+/).map(Number);
    positions[v * 3] = p[0]; positions[v * 3 + 1] = p[1]; positions[v * 3 + 2] = p[2];
  }
  const indices = [];
  for (let f = 0; f < nf; f++) {
    const p = lines[li++].split(/\s+/).map(Number);
    const k = p[0];
    for (let t = 1; t + 1 < k; t++) indices.push(p[1], p[1 + t], p[2 + t]);
  }
  return { positions, indices: Uint32Array.from(indices) };
}

// ---- point clouds: XYZ / ASC / PTS / CSV / TXT ---------------------------------------------
// Lines of "x y z [r g b] [...]"; separators: spaces, tabs, commas or semicolons.
// PTS files start with a point count; header lines that are not numbers are skipped.
export function parsePointsText(text) {
  const positions = [];
  const colors = [];
  let withColor = true;
  for (const line of text.split(/\r?\n/)) {
    const v = line.trim().split(/[\s,;]+/).map(Number);
    if (v.length < 3 || !Number.isFinite(v[0]) || !Number.isFinite(v[1]) || !Number.isFinite(v[2])) continue;
    positions.push(v[0], v[1], v[2]);
    // x y z r g b  or  x y z intensity r g b (PTS)
    const rgb = v.length >= 7 ? v.slice(4, 7) : v.length >= 6 ? v.slice(3, 6) : null;
    if (rgb && rgb.every((c) => Number.isFinite(c) && c >= 0 && c <= 255)) colors.push(...rgb.map((c) => (rgb.some((x) => x > 1) ? c / 255 : c)));
    else withColor = false;
  }
  if (!positions.length) throw Object.assign(new Error('no points'), { i18n: 'err.noPoints' });
  return { positions: Float32Array.from(positions), colors: withColor && colors.length === positions.length ? Float32Array.from(colors) : null };
}

// ---- X3D (XML): IndexedFaceSet / IndexedTriangleSet inside Transforms --------------------
export function parseX3D(text) {
  const out = []; // { positions, indices, color }
  const stack = [[1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]];
  const num = (s) => (s || '').trim().split(/[\s,]+/).filter(Boolean).map(Number);
  let color = null;
  const tagRe = /<\/?([A-Za-z]+)\b([^>]*?)(\/?)>/g;
  let m;
  let pending = null;
  while ((m = tagRe.exec(text))) {
    const [, name, attrText, selfClose] = m;
    const closing = m[0][1] === '/';
    const attr = (k) => { const a = new RegExp(`\\b${k}\\s*=\\s*["']([^"']*)["']`).exec(attrText); return a ? a[1] : null; };
    if (name === 'Transform') {
      if (closing) { stack.pop(); continue; }
      const t = num(attr('translation')), r = num(attr('rotation')), s = num(attr('scale'));
      const T = t.length === 3 ? t : [0, 0, 0], S = s.length === 3 ? s : [1, 1, 1];
      let R = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      if (r.length === 4 && r[3]) {
        const [x, y, z] = r, l = Math.hypot(x, y, z) || 1, a = r[3], c = Math.cos(a), sn = Math.sin(a), C = 1 - c;
        const ux = x / l, uy = y / l, uz = z / l;
        R = [c + ux * ux * C, ux * uy * C - uz * sn, ux * uz * C + uy * sn, uy * ux * C + uz * sn, c + uy * uy * C, uy * uz * C - ux * sn, uz * ux * C - uy * sn, uz * uy * C + ux * sn, c + uz * uz * C];
      }
      const local = [R[0] * S[0], R[1] * S[1], R[2] * S[2], T[0], R[3] * S[0], R[4] * S[1], R[5] * S[2], T[1], R[6] * S[0], R[7] * S[1], R[8] * S[2], T[2]];
      const p = stack[stack.length - 1];
      const o = new Array(12);
      for (let rr = 0; rr < 3; rr++) for (let cc = 0; cc < 4; cc++) o[rr * 4 + cc] = p[rr * 4] * local[cc] + p[rr * 4 + 1] * local[4 + cc] + p[rr * 4 + 2] * local[8 + cc] + (cc === 3 ? p[rr * 4 + 3] : 0);
      if (!selfClose) stack.push(o);
    } else if (name === 'Material' && !closing) {
      const d = num(attr('diffuseColor'));
      if (d.length === 3) color = d;
    } else if ((name === 'IndexedFaceSet' || name === 'IndexedTriangleSet') && !closing) {
      pending = { kind: name, index: num(attr(name === 'IndexedFaceSet' ? 'coordIndex' : 'index')), color };
    } else if (name === 'Coordinate' && !closing && pending) {
      const p = num(attr('point'));
      const M = stack[stack.length - 1];
      const positions = new Float32Array(p.length);
      for (let i = 0; i + 2 < p.length; i += 3) {
        positions[i] = M[0] * p[i] + M[1] * p[i + 1] + M[2] * p[i + 2] + M[3];
        positions[i + 1] = M[4] * p[i] + M[5] * p[i + 1] + M[6] * p[i + 2] + M[7];
        positions[i + 2] = M[8] * p[i] + M[9] * p[i + 1] + M[10] * p[i + 2] + M[11];
      }
      const indices = [];
      if (pending.kind === 'IndexedTriangleSet') indices.push(...pending.index);
      else {
        let poly = [];
        for (const k of [...pending.index, -1]) {
          if (k < 0) { for (let t = 1; t + 1 < poly.length; t++) indices.push(poly[0], poly[t], poly[t + 1]); poly = []; }
          else poly.push(k);
        }
      }
      out.push({ positions, indices: Uint32Array.from(indices), color: pending.color });
      pending = null;
    } else if (name === 'Shape' && closing) {
      color = null;
    }
  }
  if (!out.length) throw Object.assign(new Error('no geometry'), { i18n: 'err.badFile', vars: { format: 'X3D' } });
  return out;
}

// ---- embedded previews in proprietary files ---------------------------------------------------
// Microsoft compound file (OLE / CFB): SolidWorks before 2015, Inventor, Solid Edge, older
// CATIA and many others. Returns { streamName: Uint8Array }.
export function readCompoundFile(u8) {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (u8.length < 512 || sig.some((b, i) => u8[i] !== b)) return null;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const ss = 1 << dv.getUint16(30, true);
  const mss = 1 << dv.getUint16(32, true);
  const nFat = dv.getUint32(44, true);
  const dirStart = dv.getUint32(48, true);
  const cutoff = dv.getUint32(56, true);
  const miniFatStart = dv.getUint32(60, true);
  let difatSector = dv.getUint32(68, true);
  const sectorOff = (s) => (s + 1) * ss; // the header occupies the first sector (512 B or 4 KB)
  const difat = [];
  for (let i = 0; i < 109; i++) difat.push(dv.getUint32(76 + i * 4, true));
  for (let guard = 0; difatSector < 0xfffffffa && guard < 1e5; guard++) {
    const o = sectorOff(difatSector);
    for (let i = 0; i < ss / 4 - 1; i++) difat.push(dv.getUint32(o + i * 4, true));
    difatSector = dv.getUint32(o + ss - 4, true);
  }
  const fat = [];
  for (const s of difat.slice(0, nFat)) {
    if (s >= 0xfffffffa) continue;
    const o = sectorOff(s);
    for (let i = 0; i < ss / 4 && o + i * 4 + 4 <= u8.length; i++) fat.push(dv.getUint32(o + i * 4, true));
  }
  const chain = (start, table) => {
    const out = [];
    for (let s = start, guard = 0; s < 0xfffffffa && guard < table.length + 1; s = table[s], guard++) out.push(s);
    return out;
  };
  const readChain = (start, size) => {
    const secs = chain(start, fat);
    const buf = new Uint8Array(secs.length * ss);
    secs.forEach((s, i) => buf.set(u8.subarray(sectorOff(s), Math.min(u8.length, sectorOff(s) + ss)), i * ss));
    return size != null ? buf.subarray(0, size) : buf;
  };
  const dir = readChain(dirStart);
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const nameLen = dir[o + 64] | (dir[o + 65] << 8);
    const type = dir[o + 66];
    if (!type) continue;
    let name = '';
    for (let k = 0; k + 2 <= Math.min(64, nameLen - 2); k += 2) name += String.fromCharCode(dir[o + k] | (dir[o + k + 1] << 8));
    const ddv = new DataView(dir.buffer, dir.byteOffset + o, 128);
    entries.push({ name, type, start: ddv.getUint32(116, true), size: ddv.getUint32(120, true) });
  }
  const rootEntry = entries.find((e) => e.type === 5);
  const miniStream = rootEntry ? readChain(rootEntry.start, rootEntry.size) : new Uint8Array(0);
  let miniFat = [];
  if (miniFatStart < 0xfffffffa) {
    const mf = readChain(miniFatStart);
    const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
    miniFat = Array.from({ length: mf.length / 4 }, (_, i) => mdv.getUint32(i * 4, true));
  }
  const streams = {};
  for (const e of entries) {
    if (e.type !== 2 || e.size > 64 * 1024 * 1024) continue;
    if (e.size < cutoff && miniFat.length) {
      const secs = chain(e.start, miniFat);
      const buf = new Uint8Array(secs.length * mss);
      secs.forEach((s, i) => buf.set(miniStream.subarray(s * mss, s * mss + mss), i * mss));
      streams[e.name] = buf.subarray(0, e.size);
    } else {
      streams[e.name] = readChain(e.start, e.size);
    }
  }
  return streams;
}

// Largest PNG / JPEG / Windows bitmap found inside some bytes.
export function findImage(u8) {
  let best = null;
  const consider = (bytes, mime) => { if (!best || bytes.length > best.bytes.length) best = { bytes, mime }; };
  for (let i = 0; i + 8 < u8.length; i++) {
    if (u8[i] === 0x89 && u8[i + 1] === 0x50 && u8[i + 2] === 0x4e && u8[i + 3] === 0x47 && u8[i + 4] === 0x0d && u8[i + 5] === 0x0a) {
      // Walk PNG chunks to the end marker.
      let p = i + 8;
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      while (p + 12 <= u8.length) {
        const len = dv.getUint32(p);
        const type = String.fromCharCode(u8[p + 4], u8[p + 5], u8[p + 6], u8[p + 7]);
        p += 12 + len;
        if (type === 'IEND' || len > u8.length) break;
      }
      if (p <= u8.length && p - i > 64) { consider(u8.slice(i, p), 'image/png'); i = p - 1; }
    } else if (u8[i] === 0xff && u8[i + 1] === 0xd8 && u8[i + 2] === 0xff && (u8[i + 3] & 0xf0) === 0xe0) {
      for (let p = i + 4; p + 1 < u8.length; p++) {
        if (u8[p] === 0xff && u8[p + 1] === 0xd9) {
          if (p - i > 256) consider(u8.slice(i, p + 2), 'image/jpeg');
          i = p + 1;
          break;
        }
      }
    } else if (u8[i] === 40 && u8[i + 1] === 0 && u8[i + 2] === 0 && u8[i + 3] === 0 && i + 40 < u8.length) {
      // BITMAPINFOHEADER (device-independent bitmap): wrap it in a BMP file header.
      const dv = new DataView(u8.buffer, u8.byteOffset + i, Math.min(40, u8.length - i));
      const w = dv.getInt32(4, true), h = dv.getInt32(8, true), planes = dv.getUint16(12, true), bpp = dv.getUint16(14, true), comp = dv.getUint32(16, true);
      if (planes === 1 && [8, 24, 32].includes(bpp) && comp === 0 && w > 15 && w < 4096 && Math.abs(h) > 15 && Math.abs(h) < 4096) {
        const stride = Math.ceil((w * bpp) / 32) * 4;
        const palette = bpp === 8 ? 1024 : 0;
        const size = 40 + palette + stride * Math.abs(h);
        if (i + size <= u8.length) {
          const bmp = new Uint8Array(14 + size);
          const bdv = new DataView(bmp.buffer);
          bmp[0] = 0x42; bmp[1] = 0x4d;
          bdv.setUint32(2, 14 + size, true);
          bdv.setUint32(10, 14 + 40 + palette, true);
          bmp.set(u8.subarray(i, i + size), 14);
          consider(bmp, 'image/bmp');
          i += size - 1;
        }
      }
    }
  }
  return best;
}

export function findPreview(u8) {
  const streams = readCompoundFile(u8);
  if (streams) {
    let best = null;
    for (const [name, bytes] of Object.entries(streams)) {
      const img = findImage(bytes);
      if (img && (!best || img.bytes.length > best.bytes.length || /preview|thumb/i.test(name))) best = img;
    }
    if (best) return best;
  }
  return findImage(u8);
}
