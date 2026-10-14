"""PDUMIND reusable assets. Run in an isolated SkyRig Blender background process.
Units: metres. Blender Z up, front +Y => glTF front -Z, glTF Y up.
Rack footprint and height follow the existing app (600x1000mm, 42*44.45mm).
PDU body and outlet are schematic templates, never inferred installed equipment.
Environment: PDUMIND_ASSET_OUT, RACK_WIDTH, RACK_DEPTH, RACK_U.
"""
import bpy, math, os, json
from pathlib import Path
from mathutils import Vector
assert bpy.app.background, 'Run a separate background Blender; do not clear a live scene'
OUT=Path(os.environ.get('PDUMIND_ASSET_OUT','C:/HS/exchange/pdumind-viewport-v1/assets'))
OUT.mkdir(parents=True, exist_ok=True)
W=float(os.environ.get('RACK_WIDTH','.6')); D=float(os.environ.get('RACK_DEPTH','1'))
U=int(os.environ.get('RACK_U','42')); H=U*.04445
bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
scene=bpy.context.scene; scene.unit_settings.system='METRIC'; scene.unit_settings.scale_length=1

def mat(name,c,metal=.0,rough=.5):
    m=bpy.data.materials.new(name); m.diffuse_color=(*c,1); m.use_nodes=True
    p=next(n for n in m.node_tree.nodes if n.type=='BSDF_PRINCIPLED')
    p.inputs['Base Color'].default_value=(*c,1); p.inputs['Metallic'].default_value=metal; p.inputs['Roughness'].default_value=rough
    return m
frame=mat('Graphite powdercoat',(.13,.15,.17),.45,.39)
panel=mat('Charcoal panels',(.075,.085,.10),.25,.5)
metal=mat('Brushed rail edges',(.32,.36,.39),.7,.36)
black=mat('Outlet polymer',(.019,.022,.026),.0,.62)
label=mat('Hardware markings',(.56,.61,.63),.15,.5)
display=mat('Unpowered display glass',(.012,.028,.032),.15,.24)
# Tiled alpha mask: one clean circular hole, embedded into the GLB; no shader dependency.
N=64; im=bpy.data.images.new('Door perforation mask',width=N,height=N,alpha=True)
pixels=[]
for y in range(N):
    for x in range(N):
        r=math.hypot((x+.5)/N-.5,(y+.5)/N-.5)
        pixels.extend((.23,.25,.28,0 if r<.35 else 1))
im.pixels[:]=pixels; im.filepath_raw=str(OUT/'perforation.png'); im.file_format='PNG'; im.save(); im.pack()
meshmat=mat('Perforated steel • alpha mask',(.18,.20,.23),.35,.6)
p=next(n for n in meshmat.node_tree.nodes if n.type=='BSDF_PRINCIPLED'); t=meshmat.node_tree.nodes.new('ShaderNodeTexImage');t.image=im
meshmat.node_tree.links.new(t.outputs['Color'],p.inputs['Base Color']);meshmat.node_tree.links.new(t.outputs['Alpha'],p.inputs['Alpha'])
# glTF exporter uses alpha threshold; read enums before assignment across Blender versions.
if hasattr(meshmat,'surface_render_method'):
    modes=[i.identifier for i in meshmat.bl_rna.properties['surface_render_method'].enum_items]
    meshmat.surface_render_method='DITHERED' if 'DITHERED' in modes else modes[0]
meshmat.alpha_threshold=.5; meshmat.use_backface_culling=False

def root(name):
    o=bpy.data.objects.new(name,None); scene.collection.objects.link(o); return o

def box(name,dim,pos,material,parent,bevel=.003):
    bpy.ops.mesh.primitive_cube_add(size=1,location=pos);o=bpy.context.object;o.name=name;o.dimensions=dim
    bpy.ops.object.transform_apply(location=False,rotation=False,scale=True)
    if bevel:
        b=o.modifiers.new('Manufactured edge radius','BEVEL');b.width=bevel;b.segments=2
        bpy.context.view_layer.objects.active=o;bpy.ops.object.modifier_apply(modifier=b.name)
        for f in o.data.polygons:f.use_smooth=True
        mod=o.modifiers.new('Weighted normals','WEIGHTED_NORMAL');bpy.ops.object.modifier_apply(modifier=mod.name)
    o.data.materials.append(material);o.parent=parent;return o

def join_parts(parent,name):
    children=[o for o in parent.children if o.type=='MESH']
    if not children:return
    bpy.ops.object.select_all(action='DESELECT')
    for o in children:o.select_set(True)
    bpy.context.view_layer.objects.active=children[0];bpy.ops.object.join();o=bpy.context.object;o.name=name
    # Parent preserves logical part pivots; exporter applies mesh transforms.
    return o

rack=root('RackTemplate'); rack['dimensions_m']=[W,H,D]; rack['height_u']=U
frameRoot=root('CabinetFrame'); frameRoot.parent=rack
for x in [-W/2+.021,W/2-.021]:
    for y in [-D/2+.024,D/2-.024]:box('Corner post',(.04,.045,H-.08),(x,y,H/2),frame,frameRoot)
for z in [.045,H-.035]:
    for y in [-D/2+.025,D/2-.025]:box('Cross member',(W,.05,.06),(0,y,z),frame,frameRoot)
    for x in [-W/2+.02,W/2-.02]:box('Depth member',(.04,D,.06),(x,0,z),frame,frameRoot)
for x in [-W/2+.055,W/2-.055]:
    for y in [-D/2+.075,D/2-.075]:box('Foot',(.07,.085,.032),(x,y,.016),black,frameRoot)
join_parts(frameRoot,'Frame_and_feet')
sideRoot=root('SidePanels');sideRoot.parent=rack
for x in [-W/2+.009,W/2-.009]:
    box('Removable side',(.018,D-.13,H-.18),(x,0,H/2),panel,sideRoot)
    # Recessed latches, service seams.
    for z in [H*.25,H*.75]:box('Side latch',(.005,.055,.03),(x+(0.011 if x>0 else -.011),.29,z),metal,sideRoot,.001)
box('Roof',(W-.075,D-.1,.016),(0,0,H-.029),panel,sideRoot)
box('Plinth',(W-.075,D-.1,.022),(0,0,.062),panel,sideRoot)
# Subtle roof louvers and panel seams remain readable at inspection distance.
for x in [-W*.25,W*.25]:
    for j in range(14):box('Roof ventilation slot',(.11,.008,.001),(x,-.22+j*.028,H-.020),black,sideRoot,0)
for x in [-W/2-.001,W/2+.001]:
    box('Side panel service seam',(.001,D-.15,.003),(x,0,H*.5),black,sideRoot,0)
join_parts(sideRoot,'Panels_roof_plinth')
rails=root('MountingRails'); rails.parent=rack
for x in [-.2413,.2413]:
    for y in [-D/2+.13,D/2-.13]:
        box('19 inch rail',(.025,.028,H-.18),(x,y,H/2),metal,rails,.001)
        for u in range(U):
            z=.10+(H-.20)*(u+.5)/U
            box('U tick',(.017,.001,.0015),(x,y+(.016 if y>0 else -.016),z),label,rails,0)
join_parts(rails,'Rails_U_ticks')
for front in [True,False]:
    door=root('FrontDoor' if front else 'RearDoor');door.parent=rack
    # Hinge at left edge in Blender; glTF pivot retains exact hinge.
    yy=D/2-.008 if front else -D/2+.008
    for x in [-W/2+.057,W/2-.057]:box('Door stile',(.033,.025,H-.16),(x,yy,H/2),frame,door)
    for z in [.10,H-.10]:box('Door header',(W-.095,.025,.04),(0,yy,z),frame,door)
    for z in [.28,H-.28]:box('Hinge',(.018,.035,.09),(-W/2+.036,yy,z),metal,door,.002)
    box('Flush handle',(.018,.032,.19),(W/2-.065,yy+(.018 if front else -.018),H*.47),metal,door,.003)
    # Face fasteners, escutcheon and lock; no installed IT equipment is implied.
    sign=1 if front else -1
    box('Handle recess',(.025,.003,.22),(W/2-.065,yy+sign*.015,H*.47),black,door,.002)
    for x in [-W/2+.057,W/2-.057]:
        for z in [.11,H-.11]:
            bpy.ops.mesh.primitive_cylinder_add(vertices=8,radius=.0035,depth=.002,location=(x,yy+sign*.015,z),rotation=(math.pi/2,0,0))
            bolt=bpy.context.object;bolt.name='Door fastener';bolt.parent=door;bolt.data.materials.append(metal)
    # Manufacturer plate as editable vector geometry, exported with the door.
    bpy.ops.object.text_add(location=(-.10,yy+sign*.015,H-.107),rotation=(math.pi/2 if front else -math.pi/2,0,0))
    text=bpy.context.object;text.name='PDUMIND wordmark';text.data.body='PDUMIND';text.data.size=.014;text.data.extrude=.0002
    if front:text.rotation_euler.z=math.pi
    text.parent=door;text.data.materials.append(label)
    bpy.context.view_layer.objects.active=text;bpy.ops.object.convert(target='MESH')
    join_parts(door,('Front' if front else 'Rear')+'_door_hardware')
    # 2 sided plane, tile UV in object space: ~9mm perforation pitch.
    a=W/2-.074;b=.125;c=H-.125
    me=bpy.data.meshes.new('Screen');me.from_pydata([(-a,yy,b),(a,yy,b),(a,yy,c),(-a,yy,c)],[],[(0,1,2,3)])
    me.uv_layers.new(name='UVMap')
    for i,uv in enumerate([(0,0),(2*a/.009,0),(2*a/.009,(c-b)/.009),(0,(c-b)/.009)]):me.uv_layers.active.data[i].uv=uv
    o=bpy.data.objects.new(('Front' if front else 'Rear')+'_perforated_screen',me);scene.collection.objects.link(o);o.parent=door;me.materials.append(meshmat)
    # Move parent to hinge without moving geometry.
    door.location=(-W/2+.04,yy,0)
    for ch in door.children:ch.location-=door.location
pdu=root('PDUChassisTemplate');pdu['schematic']=True;pdu['dimensions_m']=[.055,1.62,.06]
body=root('PDUHousing');body.parent=pdu
box('Extruded enclosure',(.055,.06,1.62),(0,0,.81),frame,body,.004)
for z in [.13,1.49]:box('Mount bracket',(.092,.027,.035),(0,.036,z),metal,body,.002)
box('Display bezel',(.046,.007,.072),(0,-.033,1.46),black,body,.002)
box('Display',(.034,.002,.047),(0,-.038,1.46),display,body,.001)
box('Feed label plate',(.042,.002,.042),(0,-.038,1.56),label,body,.001)
# Small controller keys, panel seams and a network-port recess (schematic).
for x in [-.012,0,.012]:box('Control key',(.007,.003,.008),(x,-.034,1.40),metal,body,.001)
box('Controller seam',(.048,.002,.002),(0,-.031,1.35),black,body,0)
box('Network port recess',(.017,.006,.014),(0,-.034,1.30),black,body,.001)
for z in [.045,1.59]:
    box('Endcap screw',(.004,.002,.004),(0,-.032,z),metal,body,0)
join_parts(body,'PDU_chassis_display_brackets')
# Separate outlet prototype: repeat only when outlet inventory is known.
outlet=root('OutletTemplate');outlet['schematic']=True
for x in [-.018,.018]:box('Socket side',(.006,.01,.026),(x,0,0),black,outlet,0)
for z in [-.013,.013]:box('Socket top',(.04,.01,.006),(0,0,z),black,outlet,0)
for x,z in [(-.009,0),(.009,0),(0,.007)]:box('Pin slot',(.003,.002,.007),(x,-.006,z),metal,outlet,0)
join_parts(outlet,'Outlet_C13_schematic')
blank=root('BlankingPanelTemplate');blank['optional']=True
box('1U blank',(.4826,.016,.04445),(0,0,.022225),panel,blank,.001)
join_parts(blank,'Blank_1U')

def export(obj,file):
    bpy.ops.object.select_all(action='DESELECT');obj.select_set(True)
    for ch in obj.children_recursive:ch.select_set(True)
    bpy.context.view_layer.objects.active=obj
    bpy.ops.export_scene.gltf(filepath=str(OUT/file),export_format='GLB',use_selection=True,export_yup=True,export_apply=True,export_extras=True)
    # Explicit alpha MASK for stable depth and low overdraw in glTF viewers.
    import struct
    path=OUT/file;raw=path.read_bytes();size=struct.unpack_from('<I',raw,12)[0]
    doc=json.loads(raw[20:20+size])
    for m in doc.get('materials',[]):
        if m.get('name','').startswith('Perforated steel'):
            m['alphaMode']='MASK';m['alphaCutoff']=.5;m['doubleSided']=True
    js=json.dumps(doc,separators=(',',':')).encode();js+=b' '*((-len(js))%4)
    tail=raw[20+size:];path.write_bytes(struct.pack('<4sII',b'glTF',2,20+len(js)+len(tail))+struct.pack('<I4s',len(js),b'JSON')+js+tail)
for ob,f in [(rack,'rack.glb'),(pdu,'pdu.glb'),(outlet,'outlet.glb'),(blank,'blank-1u.glb')]:export(ob,f)
# Editable master contains separate templates, without lighting/render dependencies.
bpy.ops.wm.save_as_mainfile(filepath=str(OUT/'pdumind-rack-kit.blend'))
manifest={'units':'metres','gltf_up':'+Y','rack_front':'-Z','rack_dimensions_m':[W,H,D],'rack_u':U,'pdu_dimensions_m':[.055,1.62,.06],'assumptions':['Rack height follows existing app: U * 44.45mm including enclosure.','PDU chassis, socket types and mounting hardware are schematic, not a vendor CAD model.','No installed servers, blanking panels, feeds or outlet counts are inferred.'],'assets':{f:{'bytes':(OUT/f).stat().st_size} for f in ['rack.glb','pdu.glb','outlet.glb','blank-1u.glb']},'objects':[o.name for o in bpy.data.objects]}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2))
print('PDUMIND_ASSETS_COMPLETE',json.dumps(manifest['assets']))
