// Exact shapes from OpenCascade BREP text (BREP files, FreeCAD .FCStd shapes).

// matrix: column-major 4x4 (three.js order); only rotation + translation are used.
export function transformShape(oc, R, shape, m) {
  const id = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (!m || m.every((v, i) => Math.abs(v - id[i]) < 1e-12)) return shape;
  const trsf = new oc.gp_Trsf();
  trsf.SetValues(m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14]);
  const op = new oc.BRepBuilderAPI_Transform(shape.wrapped, trsf, true, false);
  const out = R.cast(op.Shape());
  trsf.delete();
  op.delete();
  return out;
}

// items: [{ brep, matrix }] -> one replicad shape (a compound when there are several).
export function brepItemsToShape(oc, R, items) {
  const shapes = [];
  for (const it of items) {
    const s = R.deserializeShape(it.brep);
    if (!s || s.isNull) continue;
    shapes.push(transformShape(oc, R, s, it.matrix));
  }
  if (!shapes.length) return null;
  return shapes.length === 1 ? shapes[0] : R.makeCompound(shapes);
}
