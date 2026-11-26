# Generate test files in many formats with FreeCAD (run with freecadcmd).
import os, sys, traceback
import FreeCAD, Part, Mesh, MeshPart

OUT = os.environ['NORMA_OUT']
EX = os.path.join(FreeCAD.getHomePath(), 'data', 'examples')
os.makedirs(OUT, exist_ok=True)
report = []

def attempt(name, fn):
    try:
        fn()
        size = os.path.getsize(os.path.join(OUT, name)) if os.path.exists(os.path.join(OUT, name)) else -1
        report.append('ok   %-28s %d' % (name, size))
    except Exception as e:
        report.append('FAIL %-28s %s' % (name, str(e).splitlines()[0][:120] if str(e) else type(e).__name__))

doc = FreeCAD.openDocument(os.path.join(EX, 'PartDesignExample.FCStd'))
solids = [o for o in doc.Objects if o.TypeId == 'PartDesign::Body']
if not solids:
    solids = [o for o in doc.Objects if hasattr(o, 'Shape') and o.Shape.Solids]
shape = Part.makeCompound([o.Shape for o in solids])
report.append('bodies: %s  volume %.1f  bbox %s' % ([o.Label for o in solids], shape.Volume, shape.BoundBox))
p = lambda n: os.path.join(OUT, n)

attempt('part.iges', lambda: shape.exportIges(p('part.iges')))
attempt('part.brep', lambda: shape.exportBrep(p('part.brep')))
attempt('part.step', lambda: shape.exportStep(p('part.step')))
mesh = MeshPart.meshFromShape(Shape=shape, LinearDeflection=0.05, AngularDeflection=0.3)
for ext in ['stl', 'obj', 'ply', 'off', 'amf', '3mf', 'wrl', 'x3d', 'iv', 'smf', 'ast']:
    attempt('part.' + ext, lambda ext=ext: mesh.write(p('part.' + ext)))

def dae():
    import importDAE
    importDAE.export(solids, p('part.dae'))
attempt('part.dae', dae)

def dxf():
    import Import
    Import.writeDXFShape([shape], p('part.dxf'))
attempt('part.dxf', dxf)

def dxf2():
    import importDXF
    importDXF.export(solids, p('part-draft.dxf'))
attempt('part-draft.dxf', dxf2)

FreeCAD.closeDocument(doc.Name)

def ifc():
    bim = FreeCAD.openDocument(os.path.join(EX, 'BIMExample.FCStd'))
    from importers import exportIFC
    objs = [o for o in bim.Objects if getattr(o, 'IfcType', None) in ('Building', 'Site', 'Project')] or bim.Objects
    exportIFC.export(objs, p('building.ifc'))
    FreeCAD.closeDocument(bim.Name)
attempt('building.ifc', ifc)

print('\n'.join(report))
