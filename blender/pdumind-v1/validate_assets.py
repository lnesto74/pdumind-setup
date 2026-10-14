import json,struct,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[2]/'frontend/public/models/pdumind-v1'
if not root.exists():root=Path('/private/tmp/pdumind-viewport/assets')
report={}
for file in root.glob('*.glb'):
 raw=file.read_bytes();magic,version,size=struct.unpack_from('<4sII',raw)
 assert magic==b'glTF' and version==2 and size==len(raw)
 length=struct.unpack_from('<I',raw,12)[0];g=json.loads(raw[20:20+length])
 assert not any('uri' in image for image in g.get('images',[])), 'External texture'
 assert not any('uri' in buffer for buffer in g.get('buffers',[])), 'External buffer'
 triangles=sum(g['accessors'][p['indices']]['count']//3 for m in g['meshes'] for p in m['primitives'])
 for mesh in g['meshes']:
  for p in mesh['primitives']:assert 'NORMAL' in p['attributes']
 names=[n.get('name') for n in g['nodes']]
 if file.name=='rack.glb':
  assert all(n in names for n in ['RackTemplate','FrontDoor','RearDoor','MountingRails','SidePanels'])
  assert any(m.get('alphaMode')=='MASK' for m in g['materials'])
 report[file.name]={'bytes':len(raw),'triangles':triangles,'nodes':names,'sha256':hashlib.sha256(raw).hexdigest()}
print(json.dumps(report,indent=2))
