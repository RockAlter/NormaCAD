# Norma

A desktop CAD viewer and modeller that also opens CATIA V5 `.CATPart` files, without needing CATIA.

*Norma* is Latin for a draftsman's square — the root of the word "normal".

The interface is available in English, 日本語 and 中文.

## What it opens

| Format | Extensions | How it is read | Make editable as |
|---|---|---|---|
| CATIA V5 part | `.CATPart`, `.cgr` | The tessellated display mesh stored inside the file (see below) | Mesh solid |
| FreeCAD document | `.FCStd` | Visible objects with FreeCAD's colours, placements, App::Part containers and assembly links | Exact solid |
| STEP | `.step`, `.stp` | Exact geometry, tessellated by OpenCascade | Exact solid |
| IGES | `.iges`, `.igs` | Exact geometry, tessellated by OpenCascade | Mesh solid |
| OpenCascade BREP | `.brep`, `.brp` | Exact geometry, tessellated by OpenCascade | Exact solid |
| Rhino | `.3dm` | Meshes, curves and points (via rhino3dm) | Mesh solid |
| IFC (BIM) | `.ifc` | Building elements with colours (via web-ifc) | Mesh solid |
| DXF | `.dxf` (ASCII) | Lines, arcs, circles, ellipses, polylines with bulges, splines, 3D faces, polyface meshes, blocks and dimension blocks; units from `$INSUNITS` | – |
| Meshes and scenes | `.stl`, `.ast`, `.obj` (+`.mtl`), `.smf`, `.ply`, `.off`, `.3mf`, `.amf`, `.gltf`/`.glb` (+`.bin`, textures), `.dae`, `.kmz`, `.fbx`, `.3ds`, `.wrl`/`.vrml`, `.x3d`, `.vtk`/`.vtp`, `.usdz` | Triangle meshes | Mesh solid (closed meshes) |
| Point clouds | `.xyz`, `.asc`, `.pts`, `.csv`, `.txt`, `.pcd`, point-only `.ply` | Points, with colours when present | – |
| Archives | `.zip` | Opens every supported file inside, with their materials and textures | – |
| Norma project | `.norma` | Parts with their full feature history | – |

Companion files (`.mtl`, glTF `.bin`, textures) are picked up when opened together with the model or packed in the same zip.

**Proprietary formats** — SolidWorks (`.sldprt`, `.sldasm`, `.slddrw`), Inventor (`.ipt`, `.iam`, `.idw`), Solid Edge (`.par`, `.psm`, `.asm`), NX / Creo (`.prt`, including Creo's `.prt.N`), Fusion (`.f3d`), SketchUp (`.skp`), CATProduct and CATDrawing cannot be read. When such a file contains a preview picture (most do), Norma shows it, with a note to export STEP. Parasolid, ACIS, JT and 3DXML are not supported yet. DWG is closed; save as DXF or use the free ODA File Converter.

## View mode

The app always starts in View mode, where nothing can change a model.

- Open by file picker or drag-and-drop; several models at once
- Rotate, pan, zoom to cursor, fit, seven standard views, perspective or parallel projection
- Display modes: shaded with edges, shaded, hidden line, wireframe, X-ray, triangle mesh
- Section plane along X, Y or Z
- Measure: point-to-point distance with ΔX / ΔY / ΔZ and vertex snapping, angle between two faces, and edge length, radius, diameter or face area under the cursor
- Click a face to see its number, planar or curved type, area and extent
- Screenshot to PNG

## Edit mode

Switch with the **View | Edit** control. Edit mode adds its own toolbar with two kinds of editing.

### Modelling (parts)

A **part** is a solid built from an ordered list of features, shown as a tree under the part in the model list. Click a feature to change its values; the part rebuilds from that point on. Features can be switched off, reordered or deleted, and every change can be undone.

- **Part ▾** — new empty part; make the active model editable; combine with another model (add, subtract, intersect); save the project as `.norma`
- **Create ▾** — box, cylinder, sphere, cone, torus; extrude a sketch (pad or pocket, reverse, symmetric, through all); revolve a sketch; loft between two profiles; sweep a profile along a helix or 3D polyline (pipes, springs); involute spur gear
- **Modify ▾** — hole (with optional counterbore), fillet and chamfer on picked edges, shell with picked faces open, draft (taper) on picked faces, mirror, linear pattern in one or two directions, polar pattern, cut by plane, move / rotate / scale
- **Parameters** — name values under Part ▾ → Parameters, then type formulas such as `=width / 2` in any size field; changing a parameter updates the whole part
- **2D drawings** — Part ▾ → 2D drawing: third-angle front, top and right views with hidden lines, an isometric view, overall dimensions and a title block on A4, A3 or A2. Export SVG or true-size DXF, or print to PDF. Exact solids only.
- **Sketches** — on the XY, XZ or YZ plane (with offset) or on any flat face you click. Draw rectangles and circles by dragging and polylines by clicking on a snapping grid, or add rectangles, circles, polygons, slots and polylines by numbers. A shape drawn inside another becomes a hole.
- **Properties** — volume, surface area, centre of mass, and mass from a density you set; type, area and normal of a clicked face
- **Export** — STEP (exact) for the active part; STL, GLB or OBJ for everything visible

Parts come in two kinds:

| Part made from | Body | Available |
|---|---|---|
| Nothing (new part), or a STEP file | Exact solid (B-Rep, OpenCascade) | Everything, including STEP export |
| A CATPart, STL, OBJ or other mesh | Mesh solid (Manifold) | Everything except fillet, chamfer, shell and draft; no STEP export or 2D drawings |

Fillets, chamfers and shells reference edges and faces by position and direction, so they follow the geometry when earlier features change size. If a reference becomes ambiguous the feature reports an error (⚠) instead of guessing; edit it and pick again.

The original files are never modified.

### Plain models

For models that are not parts: select a face or body, move / rotate / scale with a drag handle or exact values, recolour or delete faces and bodies, then export as STL, GLB or OBJ.

## How CATPart files are read

CATPart is a closed format with no public specification. Norma does **not** read the exact surfaces (the B-Rep). CATIA also stores a tessellated copy of the part for display, and Norma decodes that: vertices, per-face triangles, edge polylines and face colours. The layout was worked out by inspecting sample files and is documented in the comments of [`src/loaders/catpart.js`](src/loaders/catpart.js).

Consequences:

- Dimensions are as accurate as CATIA's display tessellation, not the exact model.
- It has only been validated against parts saved by **V5R30**. Other releases may not open.
- A part saved without its display cache has nothing for Norma to show.
- Vertex normals in the file are not decoded; they are recomputed from the triangles.

## Install (Windows)

Download `Norma-<version>-win-x64.zip` from [Releases](../../releases), unzip it anywhere, and run `Norma.exe`. Keep the whole folder together.

The build is not code-signed, so Windows SmartScreen may warn on first start.

## Run from source

Requires [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Then open http://localhost:5173 in a browser. To run it as a desktop window instead:

```bash
npm run app
```

To package the Windows app into `dist/`:

```bash
npm run build
```

Tests:

```bash
npm test
```

That runs the modelling-kernel tests, the format-parser tests, the FreeCAD reader on files in `samples/formats/`, and the CATPart reader check on files in `samples/`. To make the format test files, run `test/fc_export.py` with FreeCAD's `freecadcmd` (set `NORMA_OUT` to `samples/formats`) and then `node test/make-format-samples.mjs`. To check the reader, or mesh-part editing, against your own file:

```bash
node test/catpart.test.mjs path/to/part.CATPart
```

```bash
node test/mesh2solid.test.mjs path/to/part.CATPart
```

## Project layout

| Path | Purpose |
|---|---|
| `index.html`, `src/style.css` | Page and styles |
| `src/main.js` | Viewer, edit mode, UI wiring |
| `src/i18n.js`, `src/i18n-cad.js` | English, Japanese and Chinese strings |
| `src/meshkit.js` | Mesh, material and edge helpers |
| `src/loaders/catpart.js` | CATIA V5 reader |
| `src/loaders/index.js` | Format dispatch (OpenCascade, three.js, web-ifc and rhino3dm loaders) |
| `src/loaders/fcstd.js` | FreeCAD document reader (visibility, placements, links, colours) |
| `src/loaders/dxf.js` | DXF reader |
| `src/loaders/simple.js` | OFF, X3D, point clouds, and preview images in proprietary files |
| `src/cad/brep.js` | Exact shapes from BREP text |
| `src/cad/build.js` | Feature-history evaluation (runs in the kernel worker and in Node tests) |
| `src/cad/worker.js`, `src/cad/kernel.js` | Modelling kernel in a Web Worker, and its client |
| `src/cad/partui.js`, `src/cad/features.js` | Feature tree, dialogs, picking and sketcher |
| `src/cad/meshsolid.js` | Turning closed meshes into mesh solids |
| `src/cad/expr.js` | Parameters and the formula parser |
| `src/cad/drawing.js` | 2D drawing sheet, SVG and DXF output |
| `server.js` | Small static server, no dependencies |
| `electron-main.js` | Desktop shell |

## Built with

- [three.js](https://threejs.org) (MIT) — rendering, mesh loaders and exporters
- [occt-import-js](https://github.com/kovacsv/occt-import-js) (LGPL-2.1), built on OpenCascade — STEP, IGES and BREP import
- [replicad](https://replicad.xyz) (MIT) with [replicad-opencascadejs](https://github.com/sgenoud/replicad) (LGPL-2.1, OpenCascade) — solid modelling
- [Manifold](https://github.com/elalish/manifold) (Apache-2.0) — booleans on mesh solids
- [web-ifc](https://github.com/ThatOpen/engine_web-ifc) (MPL-2.0) — IFC import
- [rhino3dm](https://github.com/mcneel/rhino3dm) (MIT) — Rhino 3DM import
- [Electron](https://www.electronjs.org) (MIT) — desktop packaging

## Notice

CATIA is a registered trademark of Dassault Systèmes. Norma is an independent project and is not affiliated with or endorsed by Dassault Systèmes.
