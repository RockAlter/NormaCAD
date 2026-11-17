// UI translations: English, Japanese, Simplified Chinese.
// Static markup uses data-i18n (text), data-i18n-title (tooltip) and data-i18n-aria (aria-label).

import * as cad from './i18n-cad.js';

export const APP_NAME = 'Norma';
export const LANGS = { en: 'English', ja: '日本語', zh: '中文' };

const en = {
  open: 'Open…', 'open.t': 'Open CAD files (O)',
  samples: 'Samples ▾', 'samples.t': 'Load a file from the samples folder',
  fit: 'Fit', 'fit.t': 'Fit all (F)',
  iso: 'Iso', front: 'Front', back: 'Back', left: 'Left', right: 'Right', top: 'Top', bottom: 'Bottom',
  display: 'Display',
  'mode.shaded-edges': 'Shaded with edges', 'mode.shaded': 'Shaded', 'mode.hidden-line': 'Hidden line',
  'mode.wireframe': 'Wireframe', 'mode.xray': 'X-ray', 'mode.triangles': 'Triangle mesh',
  perspective: 'Perspective', parallel: 'Parallel', 'proj.t': 'Toggle perspective / parallel projection (P)',
  section: 'Section', 'section.t': 'Section plane (S)',
  measure: 'Measure', 'measure.t': 'Measure the distance between two points (M)',
  screenshot: 'Screenshot', 'shot.t': 'Save a PNG of the current view',
  flip: 'Flip', 'flip.t': 'Flip the kept side', clear: 'Clear',
  language: 'Language',
  viewMode: 'View', editMode: 'Edit', 'viewMode.t': 'View only: nothing can be changed', 'editMode.t': 'Edit mode: transform, recolour, delete, export',
  models: 'Models', properties: 'Properties',
  noModels: 'No models loaded.',
  propsEmpty: 'Open a model, then click a face to inspect it.',
  dropTitle: 'Drop CAD files here',
  dropSub: 'or use Open… — CATPart, STEP, IGES, BREP, STL, OBJ, PLY, 3MF, glTF',
  statusHint: 'Left drag: rotate · Right / middle drag: pan · Wheel: zoom · Click: select',
  statusRight: '{n} model(s) · {t} triangles · units: mm',
  loading: 'Loading {name}…',
  'm.first': 'Click the first point', 'm.second': 'Click the second point',
  modelSub: '{format} · {n} triangles',
  rowTitle: 'Click to inspect, double-click to zoom to this model',
  showHide: 'Show / hide', closeModel: 'Close this model',
  format: 'Format', savedBy: 'Saved by', fileSize: 'File size',
  sizeX: 'Size X', sizeY: 'Size Y', sizeZ: 'Size Z',
  bodies: 'Bodies', faces: 'Faces', triangles: 'Triangles', vertices: 'Vertices',
  selFace: 'Selected face', selBody: 'Selected body',
  face: 'Face', faceOf: '#{n} of {total}', type: 'Type', planar: 'Planar', curved: 'Curved',
  area: 'Area', extent: 'Extent', pickedAt: 'Picked at',
  'note.catia': 'Showing the tessellated display copy stored in the file (exact surfaces are not read).',
  'note.occt': 'Exact geometry, tessellated with OpenCascade.',
  'note.mesh': 'Triangle mesh (no CAD faces).',
  'note.edit': 'Edits change the displayed geometry only. The original file is never modified — use Export to save the result.',
  'err.open': 'Could not open {name}',
  'err.notCatia': 'Not a CATIA V5 file (missing V5_CFV2 signature).',
  'err.noMesh': 'No embedded display mesh was found in this CATIA file. It may have been saved without its display cache, or uses a variant this reader does not know yet.',
  'err.noSurfaces': 'The file was read but contains no displayable surfaces.',
  'err.occtLoad': 'Could not load the OpenCascade import module.',
  'err.occtRead': 'OpenCascade could not read this file (no geometry was produced).',
  'err.plyCloud': 'This PLY file is a point cloud; only meshes are supported.',
  'err.unknown': 'Unknown file type ".{ext}". Supported: {list}.',
  'err.sample': 'Sample not found (HTTP {status}).',
  'unsup.catproduct': 'CATIA assemblies (.CATProduct) only reference part files. Open the .CATPart files themselves, or export the assembly to STEP.',
  'unsup.catdrawing': 'CATIA drawings (.CATDrawing) are 2D and not supported. Export to PDF or DXF.',
  'unsup.proprietary': '{name} files are proprietary and cannot be read. Export to STEP (.step) from {name}.',
  'unsup.notyet': '{name} files are not supported yet. Export to STEP (.step).',
  'unsup.2d': '{name} is not supported. Export to STEP for 3D models.',
  target: 'Select', tFace: 'Face', tBody: 'Body',
  move: 'Move', rotate: 'Rotate', scale: 'Scale', reset: 'Reset',
  'move.t': 'Drag the active model', 'rotate.t': 'Rotate the active model', 'scale.t': 'Scale the active model', 'reset.t': 'Put the active model back where it was loaded',
  paint: 'Paint', 'paint.t': 'Apply this colour to the selected face or body', colour: 'Colour',
  delete: 'Delete', 'delete.t': 'Delete the selected face or body (Del)',
  undo: 'Undo', redo: 'Redo', 'undo.t': 'Undo (Ctrl+Z)', 'redo.t': 'Redo (Ctrl+Y)',
  export: 'Export ▾', 'export.t': 'Save the visible models, including edits',
  exportStl: 'STL (binary)', saveProjectT: 'Save project', exportGlb: 'glTF binary (.glb)', exportObj: 'Wavefront OBJ',
  transform: 'Transform', offX: 'Offset X', offY: 'Offset Y', offZ: 'Offset Z',
  rotX: 'Rotation X', rotY: 'Rotation Y', rotZ: 'Rotation Z', scaleF: 'Scale factor',
  'e.needSel': 'Click a face or body first.',
  'e.needModel': 'Open a model first.',
  'e.nothing': 'There is nothing visible to export.',
  'e.title': 'Edit',
};

const ja = {
  open: '開く…', 'open.t': 'CADファイルを開く (O)',
  samples: 'サンプル ▾', 'samples.t': 'samplesフォルダーのファイルを読み込む',
  fit: '全体表示', 'fit.t': '全体表示 (F)',
  iso: '等角', front: '正面', back: '背面', left: '左', right: '右', top: '上', bottom: '下',
  display: '表示',
  'mode.shaded-edges': 'シェーディング＋エッジ', 'mode.shaded': 'シェーディング', 'mode.hidden-line': '隠線',
  'mode.wireframe': 'ワイヤーフレーム', 'mode.xray': '透過', 'mode.triangles': '三角形メッシュ',
  perspective: '透視投影', parallel: '平行投影', 'proj.t': '透視投影／平行投影を切り替え (P)',
  section: '断面', 'section.t': '断面平面 (S)',
  measure: '計測', 'measure.t': '2点間の距離を計測 (M)',
  screenshot: 'スクリーンショット', 'shot.t': '現在のビューをPNGで保存',
  flip: '反転', 'flip.t': '残す側を反転', clear: 'クリア',
  language: '言語',
  viewMode: '閲覧', editMode: '編集', 'viewMode.t': '閲覧のみ：変更はできません', 'editMode.t': '編集モード：移動・色変更・削除・エクスポート',
  models: 'モデル', properties: 'プロパティ',
  noModels: 'モデルが読み込まれていません。',
  propsEmpty: 'モデルを開き、面をクリックすると詳細が表示されます。',
  dropTitle: 'CADファイルをここにドロップ',
  dropSub: 'または「開く…」を使用 — CATPart、STEP、IGES、BREP、STL、OBJ、PLY、3MF、glTF',
  statusHint: '左ドラッグ：回転 · 右／中ドラッグ：移動 · ホイール：ズーム · クリック：選択',
  statusRight: 'モデル {n} 個 · 三角形 {t} 個 · 単位：mm',
  loading: '{name} を読み込み中…',
  'm.first': '1点目をクリック', 'm.second': '2点目をクリック',
  modelSub: '{format} · 三角形 {n} 個',
  rowTitle: 'クリックで情報表示、ダブルクリックでこのモデルにズーム',
  showHide: '表示／非表示', closeModel: 'このモデルを閉じる',
  format: '形式', savedBy: '保存元', fileSize: 'ファイルサイズ',
  sizeX: 'サイズ X', sizeY: 'サイズ Y', sizeZ: 'サイズ Z',
  bodies: 'ボディ', faces: '面', triangles: '三角形', vertices: '頂点',
  selFace: '選択した面', selBody: '選択したボディ',
  face: '面', faceOf: '#{n} / {total}', type: '種類', planar: '平面', curved: '曲面',
  area: '面積', extent: '範囲', pickedAt: 'クリック位置',
  'note.catia': 'ファイルに保存されている表示用の三角形データを表示しています（正確な曲面は読み込みません）。',
  'note.occt': '正確な形状をOpenCascadeで三角形分割しています。',
  'note.mesh': '三角形メッシュ（CADの面情報なし）。',
  'note.edit': '編集は表示形状にのみ反映されます。元のファイルは変更されません。結果は「エクスポート」で保存してください。',
  'err.open': '{name} を開けませんでした',
  'err.notCatia': 'CATIA V5ファイルではありません（V5_CFV2シグネチャがありません）。',
  'err.noMesh': 'このCATIAファイルには表示用メッシュが見つかりません。表示キャッシュなしで保存されたか、未対応の形式の可能性があります。',
  'err.noSurfaces': 'ファイルは読み込めましたが、表示できる面がありません。',
  'err.occtLoad': 'OpenCascade読み込みモジュールをロードできませんでした。',
  'err.occtRead': 'OpenCascadeでこのファイルを読み込めませんでした（形状が生成されませんでした）。',
  'err.plyCloud': 'このPLYファイルは点群です。メッシュのみ対応しています。',
  'err.unknown': '不明なファイル形式「.{ext}」です。対応形式：{list}。',
  'err.sample': 'サンプルが見つかりません（HTTP {status}）。',
  'unsup.catproduct': 'CATIAアセンブリ（.CATProduct）は部品ファイルを参照するだけです。.CATPartファイルを直接開くか、アセンブリをSTEPにエクスポートしてください。',
  'unsup.catdrawing': 'CATIA図面（.CATDrawing）は2Dのため未対応です。PDFまたはDXFにエクスポートしてください。',
  'unsup.proprietary': '{name} のファイルは独自形式のため読み込めません。{name} からSTEP（.step）にエクスポートしてください。',
  'unsup.notyet': '{name} ファイルはまだ対応していません。STEP（.step）にエクスポートしてください。',
  'unsup.2d': '{name} は未対応です。3DモデルはSTEPにエクスポートしてください。',
  target: '選択対象', tFace: '面', tBody: 'ボディ',
  move: '移動', rotate: '回転', scale: '拡大縮小', reset: 'リセット',
  'move.t': 'アクティブなモデルを移動', 'rotate.t': 'アクティブなモデルを回転', 'scale.t': 'アクティブなモデルを拡大縮小', 'reset.t': 'アクティブなモデルを読み込み時の位置に戻す',
  paint: '塗る', 'paint.t': '選択した面またはボディにこの色を適用', colour: '色',
  delete: '削除', 'delete.t': '選択した面またはボディを削除 (Del)',
  undo: '元に戻す', redo: 'やり直し', 'undo.t': '元に戻す (Ctrl+Z)', 'redo.t': 'やり直し (Ctrl+Y)',
  export: 'エクスポート ▾', 'export.t': '表示中のモデルを編集内容込みで保存',
  exportStl: 'STL（バイナリ）', exportGlb: 'glTFバイナリ（.glb）', exportObj: 'Wavefront OBJ',
  transform: '変換', offX: 'オフセット X', offY: 'オフセット Y', offZ: 'オフセット Z',
  rotX: '回転 X', rotY: '回転 Y', rotZ: '回転 Z', scaleF: '倍率',
  'e.needSel': '先に面またはボディをクリックしてください。',
  'e.needModel': '先にモデルを開いてください。',
  'e.nothing': 'エクスポートできる表示中のモデルがありません。',
  'e.title': '編集',
};

const zh = {
  open: '打开…', 'open.t': '打开CAD文件 (O)',
  samples: '示例 ▾', 'samples.t': '从samples文件夹加载文件',
  fit: '全部显示', 'fit.t': '全部显示 (F)',
  iso: '等轴测', front: '前', back: '后', left: '左', right: '右', top: '上', bottom: '下',
  display: '显示',
  'mode.shaded-edges': '着色带边线', 'mode.shaded': '着色', 'mode.hidden-line': '消隐线',
  'mode.wireframe': '线框', 'mode.xray': '透视', 'mode.triangles': '三角网格',
  perspective: '透视投影', parallel: '平行投影', 'proj.t': '切换透视／平行投影 (P)',
  section: '剖切', 'section.t': '剖切平面 (S)',
  measure: '测量', 'measure.t': '测量两点之间的距离 (M)',
  screenshot: '截图', 'shot.t': '将当前视图保存为PNG',
  flip: '反向', 'flip.t': '反转保留的一侧', clear: '清除',
  language: '语言',
  viewMode: '查看', editMode: '编辑', 'viewMode.t': '仅查看：不能修改任何内容', 'editMode.t': '编辑模式：变换、改色、删除、导出',
  models: '模型', properties: '属性',
  noModels: '尚未加载模型。',
  propsEmpty: '打开模型后，点击某个面即可查看其信息。',
  dropTitle: '将CAD文件拖放到此处',
  dropSub: '或使用“打开…” — CATPart、STEP、IGES、BREP、STL、OBJ、PLY、3MF、glTF',
  statusHint: '左键拖动：旋转 · 右键／中键拖动：平移 · 滚轮：缩放 · 单击：选择',
  statusRight: '{n} 个模型 · {t} 个三角形 · 单位：mm',
  loading: '正在加载 {name}…',
  'm.first': '点击第一个点', 'm.second': '点击第二个点',
  modelSub: '{format} · {n} 个三角形',
  rowTitle: '单击查看信息，双击缩放到此模型',
  showHide: '显示／隐藏', closeModel: '关闭此模型',
  format: '格式', savedBy: '保存版本', fileSize: '文件大小',
  sizeX: '尺寸 X', sizeY: '尺寸 Y', sizeZ: '尺寸 Z',
  bodies: '实体', faces: '面', triangles: '三角形', vertices: '顶点',
  selFace: '选中的面', selBody: '选中的实体',
  face: '面', faceOf: '第 {n} 个，共 {total} 个', type: '类型', planar: '平面', curved: '曲面',
  area: '面积', extent: '范围', pickedAt: '拾取位置',
  'note.catia': '显示的是文件中保存的显示用三角网格（未读取精确曲面）。',
  'note.occt': '精确几何，由OpenCascade进行三角剖分。',
  'note.mesh': '三角网格（无CAD面信息）。',
  'note.edit': '编辑只改变显示的几何，不会修改原始文件。请使用“导出”保存结果。',
  'err.open': '无法打开 {name}',
  'err.notCatia': '不是CATIA V5文件（缺少V5_CFV2标识）。',
  'err.noMesh': '在此CATIA文件中未找到显示网格。它可能在保存时未包含显示缓存，或使用了本程序尚不支持的格式变体。',
  'err.noSurfaces': '文件已读取，但没有可显示的面。',
  'err.occtLoad': '无法加载OpenCascade导入模块。',
  'err.occtRead': 'OpenCascade无法读取此文件（未生成几何）。',
  'err.plyCloud': '此PLY文件是点云，仅支持网格。',
  'err.unknown': '未知的文件类型“.{ext}”。支持的格式：{list}。',
  'err.sample': '未找到示例文件（HTTP {status}）。',
  'unsup.catproduct': 'CATIA装配（.CATProduct）只引用零件文件。请直接打开.CATPart文件，或将装配导出为STEP。',
  'unsup.catdrawing': 'CATIA工程图（.CATDrawing）是二维的，暂不支持。请导出为PDF或DXF。',
  'unsup.proprietary': '{name} 文件为专有格式，无法读取。请在 {name} 中导出为STEP（.step）。',
  'unsup.notyet': '暂不支持 {name} 文件。请导出为STEP（.step）。',
  'unsup.2d': '不支持 {name}。三维模型请导出为STEP。',
  target: '选择对象', tFace: '面', tBody: '实体',
  move: '移动', rotate: '旋转', scale: '缩放', reset: '重置',
  'move.t': '拖动当前模型', 'rotate.t': '旋转当前模型', 'scale.t': '缩放当前模型', 'reset.t': '将当前模型恢复到加载时的位置',
  paint: '上色', 'paint.t': '将此颜色应用到选中的面或实体', colour: '颜色',
  delete: '删除', 'delete.t': '删除选中的面或实体 (Del)',
  undo: '撤销', redo: '重做', 'undo.t': '撤销 (Ctrl+Z)', 'redo.t': '重做 (Ctrl+Y)',
  export: '导出 ▾', 'export.t': '保存可见模型（包含编辑内容）',
  exportStl: 'STL（二进制）', exportGlb: 'glTF二进制（.glb）', exportObj: 'Wavefront OBJ',
  transform: '变换', offX: '偏移 X', offY: '偏移 Y', offZ: '偏移 Z',
  rotX: '旋转 X', rotY: '旋转 Y', rotZ: '旋转 Z', scaleF: '缩放系数',
  'e.needSel': '请先点击一个面或实体。',
  'e.needModel': '请先打开模型。',
  'e.nothing': '没有可导出的可见模型。',
  'e.title': '编辑',
};

const DICT = { en: { ...en, ...cad.en }, ja: { ...ja, ...cad.ja }, zh: { ...zh, ...cad.zh } };
const HTML_LANG = { en: 'en', ja: 'ja', zh: 'zh-Hans' };
let lang = 'en';

function detect() {
  try {
    const saved = localStorage.getItem('lang');
    if (saved && DICT[saved]) return saved;
  } catch { /* storage unavailable */ }
  const n = (navigator.language || 'en').toLowerCase();
  if (n.startsWith('ja')) return 'ja';
  if (n.startsWith('zh')) return 'zh';
  return 'en';
}

export function t(key, vars) {
  let s = DICT[lang][key] ?? DICT.en[key] ?? key;
  if (vars) for (const k of Object.keys(vars)) s = s.replaceAll(`{${k}}`, vars[k]);
  return s;
}

// Message for an Error thrown by a loader (which may carry a translation key).
export function errorText(err) {
  if (err && err.i18n) return t(err.i18n, err.vars);
  return err?.message || String(err);
}

export function getLang() { return lang; }

export function applyStatic(root = document) {
  document.documentElement.lang = HTML_LANG[lang];
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  for (const el of root.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}

export function setLang(next) {
  if (!DICT[next]) return;
  lang = next;
  try { localStorage.setItem('lang', next); } catch { /* ignore */ }
  applyStatic();
}

lang = detect();
