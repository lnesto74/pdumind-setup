import React, {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {GLTFLoader} from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';
import {AGODA_PRESET} from '../../utils/agodaPreset.js';

// One shared immutable asset cache. Late loads can populate cache but cannot change
// an unmounted/disabled hall. Geometry/textures are reused across toggle cycles.
let pending;
function loadKit() {
  if (!pending) {
    const loader = new GLTFLoader();
    pending = Promise.all(AGODA_PRESET.assets.map(async name => [name, await loader.loadAsync(`${AGODA_PRESET.base}${name}.glb`)]))
      .then(entries => Object.fromEntries(entries)).catch(error => {pending = null; throw error;});
  }
  return pending;
}
export function useAgodaAssets(enabled, hallKey) {
  const [result, setResult] = useState({});
  useEffect(() => {
    let active = true;
    if (!enabled) {setResult({}); return () => {active = false;};}
    setResult({loading:true, hallKey});
    loadKit().then(assets => {if (active) setResult({assets, hallKey});})
      .catch(() => {if (active) setResult({error:'Unable to load Agoda assets. Turn the preset off and on to retry.', hallKey});});
    return () => {active = false;};
  }, [enabled, hallKey]);
  return enabled && result.hallKey === hallKey ? result : {};
}
const noPick = () => null;
function DecorationBatch({part, matrices, opacity}) {
  const ref = useRef();
  const material = useMemo(() => {
    const m = part.material.clone();m.envMapIntensity=.18;
    m.transparent=opacity < 1;m.opacity=opacity;m.depthWrite=opacity===1;
    return m;
  }, [part, opacity]);
  useEffect(() => () => material.dispose(), [material]);
  useLayoutEffect(() => {
    matrices.forEach((matrix,i) => ref.current.setMatrixAt(i,matrix.clone().multiply(part.matrix)));
    ref.current.instanceMatrix.needsUpdate=true;ref.current.computeBoundingSphere();
  }, [matrices,part,material]);
  useEffect(() => {const mesh=ref.current;return () => mesh?.dispatchEvent({type:'dispose'});}, [material,matrices.length]);
  return <instancedMesh ref={ref} args={[part.geometry,material,matrices.length]} dispose={null} raycast={noPick} receiveShadow castShadow={opacity===1}/>;
}
function RepeatedAsset({asset, matrices, mode='visible'}) {
  const parts=useMemo(() => {
    const out=[];asset.scene.updateMatrixWorld(true);
    asset.scene.traverse(o => {if(o.isMesh)out.push({name:o.uuid,geometry:o.geometry,material:o.material,matrix:o.matrixWorld.clone()});});
    return out;
  },[asset]);
  if(mode==='hidden' || !matrices.length)return null;
  return parts.map(part=><DecorationBatch key={part.name} part={part} matrices={matrices} opacity={mode==='faded'?.16:1}/>);
}
const transform=(x,y,z,yaw=0,sx=1,sy=1,sz=1)=>new THREE.Matrix4().compose(new THREE.Vector3(x,y,z),new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0),yaw),new THREE.Vector3(sx,sy,sz));
export function AgodaEnvironment({assets, layout, visibility, inspection}) {
  const {hall,floor,racks}=layout;
  const instances=useMemo(()=>{
    const tile=Math.max(.2,floor.tileSize || .6), tiles=[],panels=[],gates=[],trays=[],ceiling=[];
    for(let x=0;x<hall.length;x+=tile)for(let z=0;z<hall.width;z+=tile){
      const w=Math.min(tile,hall.length-x),d=Math.min(tile,hall.width-z);
      tiles.push(transform(x+w/2,0,z+d/2,0,w/.6,1,d/.6));
    }
    // Visual boundary follows saved hall extents. Gate/tray placement is provisional,
    // never saved as customer infrastructure or used for rack/power calculations.
    const h=Math.min(2.7,hall.height || 3.5), inset=.12;
    for(const side of [0,1]){
      const length=hall.length-2*inset,n=Math.max(1,Math.ceil(length/1.2)),w=length/n;
      for(let i=0;i<n;i++)(side===0 && i===Math.floor(n/2)?gates:panels).push(transform(inset+(i+.5)*w,0,side?hall.width-inset:inset,0,w/1.2,h/2.7,1));
      const depth=hall.width-2*inset,m=Math.max(1,Math.ceil(depth/1.2)),d=depth/m;
      for(let i=0;i<m;i++)panels.push(transform(side?hall.length-inset:inset,0,inset+(i+.5)*d,Math.PI/2,d/1.2,h/2.7,1));
    }
    const rows=new Map();for(const rack of racks){const list=rows.get(rack.rowIndex)||[];list.push(rack);rows.set(rack.rowIndex,list);}
    const trayY=Math.min(hall.height-.35,Math.max(...racks.map(r=>r.position.y+r.dimensions.height),2)+.5);
    for(const row of rows.values()){
      const x0=Math.min(...row.map(r=>r.position.x-r.dimensions.width/2)),x1=Math.max(...row.map(r=>r.position.x+r.dimensions.width/2));
      const z0=Math.min(...row.map(r=>r.position.z)),z1=Math.max(...row.map(r=>r.position.z));
      const alongZ=z1-z0>x1-x0,span=alongZ?z1-z0+row[0].dimensions.depth:x1-x0;
      for(let i=0;i<Math.ceil(span);i++)trays.push(transform(alongZ?row[0].position.x:x0+i,trayY,alongZ?z0-row[0].dimensions.depth/2+i:row[0].position.z,alongZ?-Math.PI/2:0,Math.min(1,span-i)));
    }
    // Open ceiling grid/light modules preserve an overhead inspection view.
    for(let x=1;x<hall.length-1;x+=2.4)for(let z=1;z<hall.width-1;z+=2.4)ceiling.push(transform(x,hall.height-.08,z));
    return {tiles,panels,gates,trays,ceiling};
  },[hall,floor,racks]);
  return <group name="AgodaAppearanceOnly">
    <RepeatedAsset asset={assets['floor-tile']} matrices={instances.tiles}/>
    <mesh rotation={[-Math.PI/2,0,0]} position={[hall.length/2,-.035,hall.width/2]} raycast={noPick}><planeGeometry args={[hall.length,hall.width]}/><meshStandardMaterial color="#515859" roughness={1}/></mesh>
    {!inspection && <>
      <RepeatedAsset asset={assets['cage-panel']} matrices={instances.panels} mode={visibility.cage}/>
      <RepeatedAsset asset={assets['cage-gate']} matrices={instances.gates} mode={visibility.cage}/>
      <RepeatedAsset asset={assets.tray} matrices={instances.trays} mode={visibility.trays}/>
      <RepeatedAsset asset={assets.ceiling} matrices={instances.ceiling} mode={visibility.ceiling}/>
    </>}
  </group>;
}
