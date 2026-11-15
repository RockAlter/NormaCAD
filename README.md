# Norma

A desktop viewer and light editor for CAD files, including CATIA V5 `.CATPart` files, without needing CATIA.

*Norma* is Latin for a draftsman's square — the root of the word "normal".

The interface is available in English, 日本語 and 中文.

## What it opens

| Format | Extensions | How it is read |
|---|---|---|
| CATIA V5 part | `.CATPart`, `.cgr` | The tessellated display mesh stored inside the file (see below) |
| STEP | `.step`, `.stp` | Exact geometry, tessellated by OpenCascade |
| IGES | `.iges`, `.igs` | Exact geometry, tessellated by OpenCascade |
| OpenCascade BREP | `.brep`, `.brp` | Exact geometry, tessellated by OpenCascade |
| Meshes | `.stl`, `.obj`, `.ply`, `.3mf`, `.gltf`, `.glb` | Triangle mesh |

Other proprietary formats (SolidWorks, NX, Creo, Inventor, Parasolid, JT, …) are not supported; export them to STEP first.

## View mode

The app always starts in View mode, where nothing can change a model.

- Open by file picker or drag-and-drop; several models at once
- Rotate, pan, zoom to cursor, fit, seven standard views, perspective or parallel projection
- Display modes: shaded with edges, shaded, hidden line, wireframe, X-ray, triangle mesh
- Section plane along X, Y or Z
- Point-to-point measurement with ΔX / ΔY / ΔZ and vertex snapping
- Click a face to see its number, planar or curved type, area and extent
- Screenshot to PNG

## Edit mode

Switch with the **View | Edit** control. Edit mode adds its own toolbar:

- Select by face or by body
- Move, rotate and scale with a drag handle or exact values
- Recolour a face or a body
- Delete a face or a body
- Undo and redo for every edit
- Export the result as STL, GLB or OBJ

Edits apply to the displayed mesh only. This is not parametric CAD editing, the original file is never modified, and Norma cannot write `.CATPart` files.

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

To check the CATPart reader against your own files:

```bash
node test/catpart.test.mjs path/to/part.CATPart
```

## Project layout

| Path | Purpose |
|---|---|
| `index.html`, `src/style.css` | Page and styles |
| `src/main.js` | Viewer, edit mode, UI wiring |
| `src/i18n.js` | English, Japanese and Chinese strings |
| `src/meshkit.js` | Mesh, material and edge helpers |
| `src/loaders/catpart.js` | CATIA V5 reader |
| `src/loaders/index.js` | Format dispatch (OpenCascade and three.js loaders) |
| `server.js` | Small static server, no dependencies |
| `electron-main.js` | Desktop shell |

## Built with

- [three.js](https://threejs.org) (MIT) — rendering, mesh loaders and exporters
- [occt-import-js](https://github.com/kovacsv/occt-import-js) (LGPL-2.1), built on OpenCascade — STEP, IGES and BREP import
- [Electron](https://www.electronjs.org) (MIT) — desktop packaging

## Notice

CATIA is a registered trademark of Dassault Systèmes. Norma is an independent project and is not affiliated with or endorsed by Dassault Systèmes.
