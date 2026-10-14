import React, { useMemo, useRef, useEffect, useLayoutEffect, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF, Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { fitInspectionFrame } from '../../utils/inspectionFraming.js';

const BASE = '/models/pdumind-v1/';
const TEMPLATE = [.6, 42 * .04445, 1];
const CYAN = '#65d9e5';
const identity = new THREE.Quaternion();
const unit = new THREE.Vector3(1, 1, 1);
const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const feedGeometry = new THREE.BoxGeometry(.004, 1.25, .002);
const feedParts = ['#819f9b', '#a59a81'].map((color, i) => ({ name: `Slot stripe ${i}`, geometry: feedGeometry, material: new THREE.MeshStandardMaterial({color, roughness:.7}), matrix: new THREE.Matrix4().makeTranslation(.024, .77, .032) }));
const card = { background: '#151b22ed', color: '#dce4e9', border: '1px solid #52636e', borderRadius: 5, padding: '5px 8px', whiteSpace: 'nowrap', fontSize: 11, pointerEvents: 'none' };

function templateParts(scene) {
  scene.updateMatrixWorld(true);
  const parts = [];
  scene.traverse(o => {
    if (!o.isMesh) return;
    // GLB materials/geometries remain owned by useGLTF; instance buffers are local.
    if (o.material.alphaMap || o.material.transparent) {
      o.material.alphaTest = .5; o.material.transparent = false; o.material.depthWrite = true;
    }
    for (const material of (Array.isArray(o.material) ? o.material : [o.material])) material.envMapIntensity = .25;
    const path = []; for (let parent = o; parent; parent = parent.parent) path.unshift(parent.name);
    const side = path.includes('FrontDoor') ? 'Front' : path.includes('RearDoor') ? 'Rear' : null;
    parts.push({ name: path.join('/'), geometry: o.geometry, material: o.material, matrix: o.matrixWorld.clone(), door: !!side, side });
  });
  return parts;
}

function GeometryBatch({ part, items, onPick, onHover }) {
  const ref = useRef();
  useLayoutEffect(() => {
    if (!ref.current) return;
    items.forEach((item, i) => ref.current.setMatrixAt(i, item.matrix.clone().multiply(part.matrix)));
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.computeBoundingSphere();
  }, [items, part]);
  useEffect(() => {
    const instance = ref.current;
    return () => { if (instance) instance.dispatchEvent({ type: 'dispose' }); }; // Release only owned instance buffers; GLB resources are shared.
  }, [items.length, part]);
  if (!items.length) return null;
  return <instancedMesh ref={ref} args={[part.geometry, part.material, items.length]} dispose={null}
    castShadow={!part.door} receiveShadow
    onClick={e => { e.stopPropagation(); onPick?.(items[e.instanceId]); }}
    onPointerOver={e => { e.stopPropagation(); onHover?.(items[e.instanceId]); }}
    onPointerOut={e => { e.stopPropagation(); onHover?.(null); }} />;
}

export function Batch({part,items,onPick,onHover}) {
  const faded=useMemo(()=>{
    const material=part.material.clone();material.color?.multiplyScalar(.24);material.emissiveIntensity=0;
    return {...part,material};
  },[part]);
  useEffect(()=>()=>faded.material.dispose(),[faded]);
  const normal=useMemo(()=>items.filter(i=>!i.dim),[items]);
  const dim=useMemo(()=>items.filter(i=>i.dim),[items]);
  return <><GeometryBatch part={part} items={normal} onPick={onPick} onHover={onHover}/><GeometryBatch part={faded} items={dim} onPick={onPick} onHover={onHover}/></>;
}

export function RackFleet({ racks, selectedRack, hideDoors, openDoors, serviceSide, onSelect, onHover, dimmedIds }) {
  const { scene } = useGLTF(BASE + 'rack.glb');
  const parts = useMemo(() => templateParts(scene), [scene]);
  const items = useMemo(() => racks.map(rack => ({ rack, dim:dimmedIds?.has(rack.id), matrix: new THREE.Matrix4().compose(
    new THREE.Vector3(rack.position.x, rack.position.y || 0, rack.position.z), identity,
    new THREE.Vector3(rack.dimensions.width / TEMPLATE[0], rack.dimensions.height / TEMPLATE[1], rack.dimensions.depth / TEMPLATE[2])) })), [racks, dimmedIds]);
  const closed = useMemo(() => items.filter(i => !(hideDoors && i.rack.id === selectedRack?.id)), [items, hideDoors, selectedRack?.id]);
  return parts.map(part => {
    let instances = part.door ? closed : items;
    const side = serviceSide === 'rear' ? 'Rear' : 'Front';
    if (openDoors && part.side === side && part.door) {
      const z = side === 'Front' ? -.492 : .492;
      const swing = new THREE.Matrix4().makeTranslation(-.26,0,z)
        .multiply(new THREE.Matrix4().makeRotationY((side === 'Front' ? 1 : -1) * Math.PI * .60))
        .multiply(new THREE.Matrix4().makeTranslation(.26,0,-z));
      instances = instances.map(i => i.rack.id === selectedRack?.id ? {...i, matrix:i.matrix.clone().multiply(swing)} : i);
    }
    return <Batch key={part.name} part={part} items={instances}
    onPick={i => onSelect(i.rack)} onHover={i => onHover(i?.rack || null)} />; });
}

export function RackFeedback({ rack, selected, hovered, showLabel, live, alertLevel, hideDoors, heatmapLevel }) {
  const { dimensions: d, position: p } = rack;
  const connection = rack.pdus.length ? (live ? 'Online' : 'Offline / unknown') : 'Unassigned';
  const duplicateSlots = new Set(rack.pdus.map(p => p.position)).size < rack.pdus.length;
  const alarm = alertLevel === 'critical' ? 'Critical alarm' : alertLevel === 'warning' ? 'Warning' : null;
  const name = rack.label || rack.rackCode || rack.id;
  const marker = live ? '#81af9e' : '#77818d';
  const alarmColor = alertLevel === 'critical' ? '#ed625f' : '#e4b45e';
  return <group position={[p.x, (p.y || 0), p.z]}>
    {(selected || hovered) && <lineSegments geometry={edges} position={[0, d.height / 2, 0]} scale={[d.width + .014, d.height + .012, d.depth + .014]}>
      <lineBasicMaterial color={CYAN} transparent opacity={selected ? .9 : .4} />
    </lineSegments>}
    {heatmapLevel != null && <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .008, 0]}>
      <planeGeometry args={[d.width + .05, d.depth + .05]} /><meshBasicMaterial color={heatmapLevel >= 90 ? '#ed625f' : heatmapLevel >= 40 ? '#e4b45e' : '#607985'} transparent opacity={.28} />
    </mesh>}
    {selected && hideDoors && Array.from({ length: Math.ceil(rack.heightU / 5) }, (_, i) => Math.min(rack.heightU, i * 5 + 1)).map(u => <Html key={u} position={[-d.width * .38, .09 + (u - .5) / rack.heightU * (d.height - .18), -d.depth / 2 + .10]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
      <span style={{ color: '#bdc8ce', background: '#141a20cc', fontSize: 8 }}>{u}U</span>
    </Html>)}
  </group>;
}

export function PduFleet({ racks, selectedRack, onSelectRack, onPduClick, showPduLabels, outletInventory = {}, dimmedIds }) {
  const body = useGLTF(BASE + 'pdu.glb');
  const socket = useGLTF(BASE + 'outlet.glb');
  const bodyParts = useMemo(() => templateParts(body.scene), [body.scene]);
  const outletParts = useMemo(() => templateParts(socket.scene), [socket.scene]);
  const [hovered, setHovered] = useState(null);
  const devices = useMemo(() => racks.flatMap(rack => rack.pdus.map((pdu, index) => {
    const d = rack.dimensions, p = rack.position;
    const slot = ['A', 'B', 'C', 'D'].indexOf(pdu.position);
    const side = (slot >= 0 ? slot : index) % 2 ? 1 : -1;
    const layer = Math.floor((slot >= 0 ? slot : index) / 2);
    const height = Math.min(1.62, d.height - .20);
    const pos = new THREE.Vector3(p.x + side * (d.width / 2 - .09 - layer * .07), (p.y || 0) + .10, p.z + d.depth / 2 - .095);
    const matrix = new THREE.Matrix4().compose(pos, identity, new THREE.Vector3(1, height / 1.62, 1));
    // Only actual observed outlet inventory creates sockets. Unknown is not zero.
    const count = outletInventory[pdu.ip] ?? pdu.outletCount;
    return { rack, pdu, pos, height, matrix, dim:dimmedIds?.has(rack.id), labelLevel: layer, count: Number.isInteger(count) && count > 0 ? count : null };
  })), [racks, outletInventory, dimmedIds]);
  const outlets = useMemo(() => devices.flatMap(item => item.count ? Array.from({ length: item.count }, (_, i) => ({ ...item,
    matrix: new THREE.Matrix4().compose(new THREE.Vector3(item.pos.x, item.pos.y + .10 + (i + .5) / item.count * (item.height - .38), item.pos.z + .036), identity, unit) })) : []), [devices]);
  const pick = item => { onSelectRack(item.rack); onPduClick?.(item.pdu); };
  return <>
    {hovered && <lineSegments geometry={edges} position={[hovered.pos.x, hovered.pos.y + hovered.height / 2, hovered.pos.z]} scale={[.065, hovered.height, .07]}><lineBasicMaterial color={CYAN} /></lineSegments>}
    {bodyParts.map(part => <Batch key={part.name} part={part} items={devices} onPick={pick} onHover={setHovered} />)}
    {feedParts.map((part,index) => <Batch key={part.name} part={part} items={devices.filter(i => (['B','D'].includes(i.pdu.position) ? 1 : 0) === index)} onPick={pick} onHover={setHovered} />)}
    {outletParts.map(part => <Batch key={part.name} part={part} items={outlets} onPick={pick} onHover={setHovered} />)}
    {devices.filter(i => hovered && i.pdu.ip === hovered.pdu.ip).map(i => <group key={i.pdu.dbId ?? i.pdu.ip}>
      <Html position={[i.pos.x, i.pos.y + i.height + .06 + i.labelLevel * .10, i.pos.z]} center zIndexRange={[30, 0]}>
        <button onClick={() => pick(i)} aria-label={`Open PDU ${i.pdu.hostname || i.pdu.id}`}
          title={`${i.pdu.hostname || i.pdu.id} · ${i.count ? i.count + ' observed outlets' : 'Outlet inventory unavailable'} · schematic geometry · feed connection unverified`}
          style={{ ...card, cursor: 'pointer', pointerEvents: 'auto', borderColor: i.pdu.position === 'A' ? '#86aaa7' : '#a99d82', whiteSpace: 'nowrap', fontSize: 10 }}>
          <b>{i.pdu.position}</b> · {i.count ?? '—'}
        </button>
      </Html>
    </group>)}
  </>;
}

export function InspectionCamera({ racks, hall, selectedRack, preset, viewOffset, viewPanMode, openDoors }) {
  const ref = useRef();
  const { camera, size } = useThree();
  const motion = useRef(null);
  const bounds = useMemo(() => {
    const b = new THREE.Box3();
    for (const r of racks) {
      const { position: p, dimensions: d } = r;
      b.expandByPoint(new THREE.Vector3(p.x - d.width / 2, p.y || 0, p.z - d.depth / 2));
      b.expandByPoint(new THREE.Vector3(p.x + d.width / 2, (p.y || 0) + d.height, p.z + d.depth / 2));
    }
    if (b.isEmpty()) b.set(new THREE.Vector3(0,0,0), new THREE.Vector3(hall.length,2,hall.width));
    return b;
  }, [racks, hall.length, hall.width]);
  // Bounds signature avoids interrupting the camera on telemetry refreshes.
  const boundsKey = bounds.min.toArray().concat(bounds.max.toArray()).join(',');
  useEffect(() => {
    if (!ref.current) return;
    const focus = selectedRack && preset.mode !== 'overview' ? selectedRack : null;
    const center = focus ? new THREE.Vector3(focus.position.x, (focus.position.y || 0) + focus.dimensions.height / 2, focus.position.z) : bounds.getCenter(new THREE.Vector3());
    const dims = focus ? new THREE.Vector3(focus.dimensions.width, focus.dimensions.height, focus.dimensions.depth) : bounds.getSize(new THREE.Vector3());
    // Include rail labels and the swung door in close inspection bounds.
    if (focus) {
      dims.y += .25;
      if (openDoors) { dims.x += focus.dimensions.width * 2; dims.z += focus.dimensions.width * 2; }
    }
    camera.aspect = size.width / Math.max(size.height, 1);
    const direction = preset.mode === 'front' ? new THREE.Vector3(0,.10,-1) : preset.mode === 'rear' ? new THREE.Vector3(0,.12,1) : preset.mode === 'selected' ? new THREE.Vector3(.45,.22,-1) : new THREE.Vector3(.85,.48,-1);
    const distance = fitInspectionFrame(dims.toArray(), size.width / Math.max(size.height, 1), camera.fov, 1.24, direction.toArray());
    const end = center.clone().addScaledVector(direction.normalize(), distance);
    camera.far = Math.max(100, distance * 5); camera.updateProjectionMatrix();
    motion.current = { end, target: center };
  }, [boundsKey, selectedRack?.id, preset.mode, preset.seq, size.width, size.height, openDoors]);
  useFrame((_, dt) => {
    camera.position.y = Math.max(.08, camera.position.y);
    if (!motion.current || !ref.current) return;
    const a = 1 - Math.exp(-7 * Math.min(dt, .1));
    camera.position.lerp(motion.current.end, a); ref.current.target.lerp(motion.current.target, a); ref.current.update();
    if (camera.position.distanceTo(motion.current.end) < .005) motion.current = null;
  });
  return <OrbitControls ref={ref} makeDefault enableDamping dampingFactor={.08} minPolarAngle={.15} maxPolarAngle={Math.PI / 2 - .035} minDistance={.6} maxDistance={Math.max(hall.length, hall.width) * 5}
    onStart={() => { motion.current = null; }} mouseButtons={{ LEFT: viewPanMode ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: viewPanMode ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN }} />;
}

export function ViewportMetrics({ racks }) {
  const { gl, size } = useThree();
  const buffer = useRef([]), elapsed = useRef(0), [stats, setStats] = useState(null);
  useFrame((_, dt) => {
    if (dt > 0 && dt < .5) buffer.current.push(dt * 1000);
    elapsed.current += dt;
    if (elapsed.current < 2) return;
    const a = buffer.current.slice().sort((a,b) => a-b);
    if (a.length) setStats({ fps: Math.round(1000 / (a.reduce((x,y) => x+y,0) / a.length)), p95: a[Math.floor(a.length * .95)].toFixed(1), draws: gl.info.render.calls, triangles: gl.info.render.triangles });
    elapsed.current = 0; buffer.current = [];
  });
  return stats && <Html calculatePosition={() => [16, size.height - 65]} style={{ pointerEvents:'none' }} zIndexRange={[5, 0]}><div data-testid="viewport-metrics" style={card}>{racks.length} racks · {racks.reduce((n,r) => n+r.pdus.length,0)} PDUs · {stats.fps} fps · p95 {stats.p95} ms · {stats.draws} draws · {stats.triangles.toLocaleString()} triangles</div></Html>;
}

// Procedural studio reflection map generated locally; no HDR download or authoring-host dependency.
export function StudioEnvironment() {
  const { gl, scene } = useThree();
  useEffect(() => {
    let active = true, texture, room, generator;
    import('three/examples/jsm/environments/RoomEnvironment.js').then(({ RoomEnvironment }) => {
      if (!active) return;
      room = new RoomEnvironment(); generator = new THREE.PMREMGenerator(gl);
      texture = generator.fromScene(room, .04);
      scene.environment = texture.texture;
      room.dispose(); generator.dispose();
    });
    return () => { active = false; if (texture) { scene.environment = null; texture.dispose(); } };
  }, [gl, scene]);
  return null;
}


export function IndustrialFloorMaterial({ length, width, tileSize = .6 }) {
  const textures = useMemo(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 256;
    const ctx = canvas.getContext('2d'), pixels = ctx.createImageData(256,256);
    let seed = 7183;
    for (let i=0;i<pixels.data.length;i+=4) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const n = 32 + (seed % 7);
      pixels.data.set([n,n+3,n+5,255],i);
    }
    ctx.putImageData(pixels,0,0);
    ctx.fillStyle='#22282c';ctx.fillRect(0,0,256,2);ctx.fillRect(0,0,2,256);
    ctx.fillStyle='#3e454a';ctx.fillRect(2,2,254,1);ctx.fillRect(2,2,1,254);
    const map = new THREE.CanvasTexture(canvas); map.colorSpace=THREE.SRGBColorSpace;
    map.wrapS=map.wrapT=THREE.RepeatWrapping;map.repeat.set(length/tileSize,width/tileSize);map.anisotropy=4;
    return map;
  },[length,width,tileSize]);
  useEffect(()=>()=>textures.dispose(),[textures]);
  return <meshStandardMaterial map={textures} roughness={.65} metalness={.12} envMapIntensity={.18} />;
}
