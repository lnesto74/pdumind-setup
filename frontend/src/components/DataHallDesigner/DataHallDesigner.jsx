import React, { useState, useMemo, useCallback, Suspense, useEffect, useLayoutEffect, useRef } from 'react';
import { Canvas, useLoader, useThree, useFrame } from '@react-three/fiber';
import { OrbitControls, Grid, Text, Environment, useGLTF, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { defaultDataHallConfig, generateDataHallLayout, validateConfig } from './dataHallConfig';
import { modelCache, cloneShared, disposeObject3D } from '../../3d';
import CageMetricsOverlay from './CageMetricsOverlay';
import HudSparkChart from './HudSparkChart';
import {
  cableUnplugAlertKey,
  collectOutletCableWarnings,
  isCableUnplugRackAlert,
} from '../../utils/neuralOpsAlerts';
import { aggregateCageMetrics } from '../../utils/cageMetrics';
import { downloadHallCustomerReport } from '../../utils/hallCustomerReport';

const HUD_CARD = 'rounded-[10px] border border-white/[0.08] bg-[#0c1018]/90 backdrop-blur-sm';
const HUD_LABEL = 'text-[8px] font-semibold text-[#8A929B] uppercase tracking-[0.12em]';
const TELEMETRY_CHART = '#00E5FF';
// NetworkScanner removed — replaced by CommissioningWizard in Dashboard2

// API base URL
const API_BASE = import.meta.env.VITE_API_URL || '';

/** Human-readable rack name — custom label when set, else layout id (Row-02/Rack-01). */
export const getRackDisplayName = (rack) => {
  if (!rack) return '';
  const custom = (rack.label || '').trim();
  return custom || rack.id || '';
};

/** Daisy-chain hostname without the trailing -1/-2/-3/-4 unit index. */
export const pduHostnameStem = (name) => {
  if (!name) return '';
  const m = String(name).trim().match(/^(.*)-(\d+)$/);
  return m ? m[1] : String(name).trim();
};

/** Commissioned PDU identity (RDC1-PDU-RACK-CN10-1), not the A/B/C/D slot. */
export const pduDisplayId = (pdu) =>
  (pdu?.hostname || pdu?.label || pdu?.id || '').trim();

/** Real rack ID from PDU hostnames, e.g. RDC1-PDU-RACK-CN10. */
export const getRackAssetId = (rack) => {
  const stems = (rack?.pdus || []).map((p) => pduHostnameStem(pduDisplayId(p))).filter(Boolean);
  if (!stems.length) return '';
  const first = stems[0];
  if (stems.every((s) => s === first)) return first;
  let prefix = first;
  for (const s of stems.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < s.length && prefix[i] === s[i]) i += 1;
    prefix = prefix.slice(0, i);
  }
  return prefix.replace(/[-_/]+$/, '') || first;
};

// Floor Grid Component
const FloorGrid = ({ hall, tileSize }) => {
  return (
    <group position={[hall.length / 2, 0, hall.width / 2]}>
      <Grid
        args={[hall.length, hall.width]}
        cellSize={tileSize}
        cellThickness={0.5}
        cellColor="#1a3a4a"
        sectionSize={tileSize * 5}
        sectionThickness={1}
        sectionColor="#00E5FF"
        fadeDistance={50}
        fadeStrength={1}
        followCamera={false}
      />
      {/* Floor plane */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.01, 0]}>
        <planeGeometry args={[hall.length, hall.width]} />
        <meshStandardMaterial color="#0a1520" />
      </mesh>
    </group>
  );
};

// ---------------------------------------------------------------------------
// Free-placed scene props (visual references the user drops onto the floor)
// ---------------------------------------------------------------------------

// Catalog of object types available in the palette. Keep `build` purely
// procedural so no external assets/uploads are required.
export const SCENE_OBJECT_CATALOG = [
  { type: 'cage-entrance', label: 'Cage Entrance', icon: 'meeting_room' },
];

// A chain-link style wire-mesh panel built from thin bars inside a frame.
const WireMeshPanel = ({ width, height, color, accent }) => {
  const frame = 0.04;
  const bar = 0.012;
  const cols = Math.max(2, Math.round(width / 0.18));
  const rows = Math.max(2, Math.round(height / 0.18));
  const verticals = Array.from({ length: cols - 1 }, (_, i) => -width / 2 + (width / cols) * (i + 1));
  const horizontals = Array.from({ length: rows - 1 }, (_, i) => -height / 2 + (height / rows) * (i + 1));
  return (
    <group>
      {/* Outer frame */}
      <mesh position={[0, height / 2, 0]}><boxGeometry args={[width, frame, frame]} /><meshStandardMaterial color={accent} metalness={0.7} roughness={0.35} /></mesh>
      <mesh position={[0, -height / 2, 0]}><boxGeometry args={[width, frame, frame]} /><meshStandardMaterial color={accent} metalness={0.7} roughness={0.35} /></mesh>
      <mesh position={[-width / 2, 0, 0]}><boxGeometry args={[frame, height, frame]} /><meshStandardMaterial color={accent} metalness={0.7} roughness={0.35} /></mesh>
      <mesh position={[width / 2, 0, 0]}><boxGeometry args={[frame, height, frame]} /><meshStandardMaterial color={accent} metalness={0.7} roughness={0.35} /></mesh>
      {/* Wire mesh */}
      {verticals.map((x, i) => (
        <mesh key={`v${i}`} position={[x, 0, 0]}><boxGeometry args={[bar, height, bar]} /><meshStandardMaterial color={color} metalness={0.5} roughness={0.5} /></mesh>
      ))}
      {horizontals.map((y, i) => (
        <mesh key={`h${i}`} position={[0, y, 0]}><boxGeometry args={[width, bar, bar]} /><meshStandardMaterial color={color} metalness={0.5} roughness={0.5} /></mesh>
      ))}
    </group>
  );
};

// Cage entrance: two posts, a top header beam, fixed side panels, and an
// open swing-gate. Origin is at floor level, centered on the doorway.
const CageEntrance = ({ selected }) => {
  const accent = selected ? '#00E5FF' : '#6b8595';
  const mesh = selected ? '#9fd9e6' : '#8aa0ad';
  const height = 2.1;
  const postT = 0.08;
  const openingHalf = 0.8;     // doorway half-width
  const sidePanelW = 0.9;      // fixed cage wall on each side
  const totalHalf = openingHalf + sidePanelW;
  return (
    <group>
      {/* Top header beam spanning the whole entrance */}
      <mesh position={[0, height + 0.05, 0]}>
        <boxGeometry args={[totalHalf * 2 + postT, 0.12, 0.1]} />
        <meshStandardMaterial color={accent} metalness={0.7} roughness={0.35} />
      </mesh>
      {/* Posts: outer + doorway jambs */}
      {[-totalHalf, -openingHalf, openingHalf, totalHalf].map((x, i) => (
        <mesh key={i} position={[x, height / 2, 0]}>
          <boxGeometry args={[postT, height, postT]} />
          <meshStandardMaterial color={accent} metalness={0.7} roughness={0.35} />
        </mesh>
      ))}
      {/* Fixed side cage walls */}
      <group position={[-(openingHalf + sidePanelW / 2), height / 2, 0]}>
        <WireMeshPanel width={sidePanelW} height={height} color={mesh} accent={accent} />
      </group>
      <group position={[openingHalf + sidePanelW / 2, height / 2, 0]}>
        <WireMeshPanel width={sidePanelW} height={height} color={mesh} accent={accent} />
      </group>
      {/* Swing gate, hinged on the left jamb and opened ~55° */}
      <group position={[-openingHalf, 0, 0]} rotation={[0, -0.95, 0]}>
        <group position={[openingHalf, height / 2, 0]}>
          <WireMeshPanel width={openingHalf * 2 - 0.04} height={height - 0.06} color={mesh} accent={'#cfe9f1'} />
        </group>
        {/* Gate handle */}
        <mesh position={[openingHalf * 2 - 0.12, height / 2, 0.04]}>
          <boxGeometry args={[0.04, 0.25, 0.04]} />
          <meshStandardMaterial color="#d0d8de" metalness={0.8} roughness={0.3} />
        </mesh>
      </group>
      {/* Signage above the doorway */}
      <Text position={[0, height + 0.22, 0.06]} fontSize={0.16} color={selected ? '#00E5FF' : '#cbd5e1'} anchorX="center" anchorY="bottom">
        ENTRANCE
      </Text>
    </group>
  );
};

// Renders one placed scene prop. When selected (and editable) it is wrapped in
// a TransformControls gizmo so it can be dragged / rotated on the floor.
const SceneProp = ({ obj, selected, editable, transformMode, onSelect, onCommit }) => {
  const ref = useRef();

  const renderModel = () => {
    switch (obj.type) {
      case 'cage-entrance':
      default:
        return <CageEntrance selected={selected} />;
    }
  };

  // Invisible bounding box so the (mostly hollow) prop is easy to click.
  // visible={false} would skip raycasting, so we use a fully transparent
  // material that still receives pointer events.
  const hb = { w: 3.7, h: 2.5, d: 1.4, cy: 1.2 }; // cage-entrance footprint
  const selectHandlers = editable ? {
    onClick: (e) => { e.stopPropagation(); onSelect(obj.id); },
    onPointerDown: (e) => { e.stopPropagation(); },
  } : {};

  const commit = () => {
    const o = ref.current;
    if (!o || !onCommit) return;
    onCommit(obj.id, {
      position: { x: o.position.x, y: o.position.y, z: o.position.z },
      rotation: { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z },
      scale: o.scale.x,
    });
  };

  // The object group and the gizmo are SIBLINGS — the gizmo attaches directly
  // to this group via `object={ref}`, so it tracks the object and edits it in
  // place (the children-wrapping form detaches the gizmo and loses the commit).
  return (
    <>
      <group
        ref={ref}
        position={[obj.position.x, obj.position.y || 0, obj.position.z]}
        rotation={[obj.rotation?.x || 0, obj.rotation?.y || 0, obj.rotation?.z || 0]}
        scale={obj.scale || 1}
      >
        <mesh position={[0, hb.cy, 0]} {...selectHandlers}>
          <boxGeometry args={[hb.w, hb.h, hb.d]} />
          <meshBasicMaterial transparent opacity={selected ? 0.06 : 0} depthWrite={false} color="#00E5FF" />
        </mesh>
        {renderModel()}
      </group>

      {selected && editable && (
        <TransformControls
          object={ref}
          mode={transformMode}
          size={1.1}
          showX={transformMode !== 'rotate'}
          showZ={transformMode !== 'rotate'}
          showY={transformMode !== 'translate'}
          translationSnap={0.5}
          rotationSnap={Math.PI / 12}
          scaleSnap={0.1}
          onMouseUp={commit}
        />
      )}
    </>
  );
};

// Captures the live three.js camera so HTML drag-drop can raycast onto the
// floor plane to compute a world drop position.
const CameraBridge = ({ apiRef }) => {
  const { camera, raycaster } = useThree();
  useEffect(() => {
    apiRef.current = { camera, raycaster };
  }, [camera, raycaster, apiRef]);
  return null;
};

/** Keep R3F's size store + the WebGL buffer matched to the wrap.
 *  Calling gl.setSize alone leaves R3F at 0×0 after a 0-height first paint;
 *  switching Stencil ↔ Switchboard was the only thing that retriggered measure. */
const FitCanvas = ({ wrapRef, layoutEpoch = 0 }) => {
  const { camera, invalidate, setSize, setDpr } = useThree();
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    let raf = 0;
    let alive = true;
    let lastW = 0;
    let lastH = 0;

    const apply = () => {
      if (!alive) return;
      const w = Math.round(el.clientWidth);
      const h = Math.round(el.clientHeight);
      if (w < 8 || h < 8) {
        raf = requestAnimationFrame(apply);
        return;
      }
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      setDpr(Math.min(window.devicePixelRatio || 1, 2));
      setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      invalidate();
    };

    apply();
    const ro = new ResizeObserver(() => {
      lastW = 0;
      lastH = 0;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(apply);
    });
    ro.observe(el);
    window.addEventListener('resize', apply);
    const t1 = setTimeout(apply, 50);
    const t2 = setTimeout(apply, 250);
    const t3 = setTimeout(apply, 800);
    const t4 = setTimeout(apply, 1600);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', apply);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
      clearTimeout(t4);
    };
  }, [camera, invalidate, setSize, setDpr, wrapRef, layoutEpoch]);
  return null;
};

/**
 * CustomRackModel - Optimized GLTF Rack Model Component
 * 
 * Uses ModelCache to load each GLB/GLTF only once and reuses the prototype.
 * Clones share geometry/materials/textures to minimize memory usage.
 * 
 * MEMORY OPTIMIZATION:
 * - Model loaded once via modelCache.get(url)
 * - Clones use cloneShared() to share underlying GPU resources
 * - Proper cleanup on unmount via disposeObject3D()
 */
const CustomRackModel = ({ url, dimensions, colors, onClick, onPointerOver, onPointerOut, assets, onLoadSuccess, onLoadError }) => {
  const groupRef = useRef();
  const [model, setModel] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const modelUrlRef = useRef(url);
  const prevUrlRef = useRef(null);
  
  useEffect(() => {
    if (!url) return;
    
    let cancelled = false;
    
    const loadModel = async () => {
      try {
        // Use ModelCache - loads only once, returns cached prototype
        // For blob URLs with assets, we need custom loading manager
        let prototype;
        
        if (assets && Object.keys(assets).length > 1) {
          // Multi-file GLTF with assets - use custom loader with URL modifier
          const loadingManager = new THREE.LoadingManager();
          loadingManager.setURLModifier((originalUrl) => {
            const fileName = originalUrl.split('/').pop();
            if (assets[fileName]) return assets[fileName];
            const textureMatch = originalUrl.match(/textures\/(.+)$/);
            if (textureMatch && assets[textureMatch[1]]) return assets[textureMatch[1]];
            for (const [key, blobUrl] of Object.entries(assets)) {
              if (key.endsWith(fileName) || originalUrl.includes(key)) return blobUrl;
            }
            return originalUrl;
          });
          
          // Load directly for multi-file assets (can't cache blob URLs reliably)
          const loader = new GLTFLoader(loadingManager);
          await new Promise((resolve, reject) => {
            loader.load(url, (gltf) => {
              prototype = { scene: gltf.scene };
              resolve();
            }, undefined, reject);
          });
        } else {
          // Single file GLB - use cache
          prototype = await modelCache.get(url);
          modelCache.acquire(url);
        }
        
        if (cancelled || !prototype?.scene) return;
        
        // Clone with shared resources (geometry/materials stay on GPU once)
        const loadedModel = cloneShared(prototype.scene);
        
        // Reset transforms
        loadedModel.position.set(0, 0, 0);
        loadedModel.rotation.set(0, 0, 0);
        loadedModel.scale.set(1, 1, 1);
        
        // Calculate bounding box and scale to fit rack dimensions
        const originalBox = new THREE.Box3().setFromObject(loadedModel);
        const originalSize = new THREE.Vector3();
        originalBox.getSize(originalSize);
        
        // Uniform scale to fit within rack box (preserves proportions)
        const scaleX = dimensions.width / originalSize.x;
        const scaleY = dimensions.height / originalSize.y;
        const scaleZ = dimensions.depth / originalSize.z;
        const uniformScale = Math.min(scaleX, scaleY, scaleZ);
        loadedModel.scale.set(uniformScale, uniformScale, uniformScale);
        
        // Position: center X/Z, align bottom with rack bottom
        const scaledBox = new THREE.Box3().setFromObject(loadedModel);
        const scaledMin = scaledBox.min.clone();
        const scaledCenter = new THREE.Vector3();
        scaledBox.getCenter(scaledCenter);
        
        loadedModel.position.set(
          -scaledCenter.x,
          -scaledMin.y - (dimensions.height / 2),
          -scaledCenter.z
        );
        
        // Apply emissive color for selection/alert states
        // Note: We clone materials here because emissive state is per-instance
        loadedModel.traverse((child) => {
          if (child.isMesh && child.material) {
            child.material = child.material.clone();
            child.material.emissive = new THREE.Color(colors.emissive);
            child.material.emissiveIntensity = colors.intensity;
          }
        });
        
        setModel(loadedModel);
        setLoadError(false);
        if (onLoadSuccess) onLoadSuccess();
      } catch (error) {
        console.error('[CustomRackModel] Error loading GLTF:', error);
        setLoadError(true);
        if (onLoadError) onLoadError();
      }
    };
    
    loadModel();
    
    // Cleanup on unmount or URL change
    return () => {
      cancelled = true;
      if (model) {
        disposeObject3D(model, { useRefCounting: true });
      }
      // Release cache reference for single-file GLBs
      if (modelUrlRef.current && !assets) {
        modelCache.release(modelUrlRef.current);
      }
    };
  }, [url, dimensions.width, dimensions.height, dimensions.depth, colors.emissive, colors.intensity, assets]);
  
  // Update emissive when colors change (without reloading model)
  useEffect(() => {
    if (model) {
      model.traverse((child) => {
        if (child.isMesh && child.material) {
          child.material.emissive = new THREE.Color(colors.emissive);
          child.material.emissiveIntensity = colors.intensity;
        }
      });
    }
  }, [model, colors.emissive, colors.intensity]);
  
  // Return null if no model loaded or if there was an error (parent will fall back to default box)
  if (!model || loadError) return null;
  
  return (
    <group ref={groupRef}>
      <primitive 
        object={model} 
        onClick={onClick}
        onPointerOver={onPointerOver}
        onPointerOut={onPointerOut}
      />
    </group>
  );
};

// Rack 3D Component
const Rack3D = ({ rack, isSelected, isHovered, alertLevel, alertInfo, showLabel, onSelect, onHover, customModelUrl, customModelAssets, hasPdus, pduCount, heatmapLevel, commissioned = false, live = false }) => {
  const { position, dimensions } = rack;

  // Rack status dot semantics:
  //   red    = critical alarm (solid)
  //   amber  = soft/warning alarm (blinking)
  //   green  = commissioned + at least one live PDU, no active alarm
  //   white  = uncommissioned, or commissioned but offline (no live PDU)
  const statusColor =
    alertLevel === 'critical' ? '#ff2d2d'
    : alertLevel === 'warning' ? '#ffae00'
    : (commissioned && live) ? '#19ff5a'
    : '#ffffff';
  const statusBlinks = alertLevel === 'warning';

  // Refs for the blinking warning state (pulse emissiveIntensity over time).
  const ledRef = useRef();
  const beaconRef = useRef();
  useFrame(({ clock }) => {
    if (!statusBlinks) return;
    // ~1.5 Hz pulse between dim and bright amber.
    const pulse = 0.6 + 0.9 * (0.5 + 0.5 * Math.sin(clock.elapsedTime * 9));
    if (ledRef.current) ledRef.current.emissiveIntensity = pulse;
    if (beaconRef.current) beaconRef.current.emissiveIntensity = pulse * 1.6;
  });
  
  // Determine colors based on alert level or load heatmap
  const getColors = () => {
    if (isSelected) {
      return { color: '#00E5FF', emissive: '#00E5FF', intensity: 0.3, outline: '#00E5FF' };
    }
    if (isHovered) {
      return { color: '#00E5FF', emissive: '#00E5FF', intensity: 0.15, outline: '#00E5FF' };
    }
    if (alertLevel === 'critical') {
      return { color: '#7F1D1D', emissive: '#EF4444', intensity: 0.4, outline: '#EF4444' };
    }
    if (alertLevel === 'warning') {
      return { color: '#78350F', emissive: '#F59E0B', intensity: 0.3, outline: '#F59E0B' };
    }
    if (heatmapLevel != null) {
      if (heatmapLevel === 0) {
        return { color: '#1e293b', emissive: '#334155', intensity: 0.05, outline: '#475569' };
      }
      if (heatmapLevel >= 90) {
        return { color: '#7F1D1D', emissive: '#EF4444', intensity: 0.35, outline: '#EF4444' };
      }
      if (heatmapLevel >= 70) {
        return { color: '#9a3412', emissive: '#F97316', intensity: 0.28, outline: '#F97316' };
      }
      if (heatmapLevel >= 40) {
        return { color: '#78350F', emissive: '#F59E0B', intensity: 0.22, outline: '#F59E0B' };
      }
      return { color: '#14532d', emissive: '#22C55E', intensity: 0.18, outline: '#22C55E' };
    }
    return { color: '#2D4A5E', emissive: '#000000', intensity: 0, outline: '#3D6A7E' };
  };
  
  const colors = getColors();
  const labelColor = alertLevel === 'critical' ? '#EF4444' : alertLevel === 'warning' ? '#F59E0B' : '#00E5FF';
  
  // Track if custom model loaded successfully
  const [customModelLoaded, setCustomModelLoaded] = useState(false);
  
  // Reset customModelLoaded when URL changes
  useEffect(() => {
    setCustomModelLoaded(false);
  }, [customModelUrl]);
  
  return (
    <group position={[position.x, position.y + dimensions.height / 2, position.z]}>
      {/* Always render default box as base - hidden if custom model loads */}
      {!customModelLoaded && (
        <group
          onClick={(e) => { e.stopPropagation(); onSelect(rack); }}
          onPointerOver={(e) => { e.stopPropagation(); onHover(rack); }}
          onPointerOut={(e) => { e.stopPropagation(); onHover(null); }}
        >
          {/* Main rack body */}
          <mesh>
            <boxGeometry args={[dimensions.width, dimensions.height, dimensions.depth]} />
            <meshStandardMaterial 
              color="#1a1a2e"
              emissive={colors.emissive}
              emissiveIntensity={colors.intensity}
              metalness={0.7}
              roughness={0.3}
              transparent
              opacity={0.9}
            />
          </mesh>
          
          {/* Front panel face */}
          <mesh position={[0, 0, -dimensions.depth / 2 + 0.01]}>
            <boxGeometry args={[dimensions.width * 0.95, dimensions.height * 0.95, 0.02]} />
            <meshStandardMaterial 
              color="#0f172a"
              emissive={colors.emissive}
              emissiveIntensity={colors.intensity * 0.3}
              metalness={0.6}
              roughness={0.4}
            />
          </mesh>
          
          {/* Status LED indicator — toneMapped:false keeps the color a pure,
              saturated LED instead of a washed-out halo. */}
          <mesh position={[dimensions.width * 0.35, dimensions.height * 0.4, -dimensions.depth / 2 + 0.02]}>
            <sphereGeometry args={[0.035, 12, 12]} />
            <meshStandardMaterial
              ref={ledRef}
              color={statusColor}
              emissive={statusColor}
              emissiveIntensity={2}
              toneMapped={false}
            />
          </mesh>
        </group>
      )}
      
      {/* Overlay custom model if URL provided */}
      {customModelUrl && (
        <CustomRackModel
          url={customModelUrl}
          dimensions={dimensions}
          colors={colors}
          assets={customModelAssets}
          onClick={(e) => { e.stopPropagation(); onSelect(rack); }}
          onPointerOver={(e) => { e.stopPropagation(); onHover(rack); }}
          onPointerOut={(e) => { e.stopPropagation(); onHover(null); }}
          onLoadSuccess={() => setCustomModelLoaded(true)}
          onLoadError={() => setCustomModelLoaded(false)}
        />
      )}
      
      {/* Rack outline glow for selection/hover */}
      {(isSelected || isHovered) && (
        <lineSegments>
          <edgesGeometry args={[new THREE.BoxGeometry(dimensions.width, dimensions.height, dimensions.depth)]} />
          <lineBasicMaterial color={colors.outline} linewidth={2} />
        </lineSegments>
      )}
      
      {/* Rack label — real asset ID (RDC1-PDU-RACK-CN10) when PDUs are assigned */}
      {(showLabel || isHovered) && !alertLevel && (
        <Text
          position={[0, dimensions.height / 2 + 0.15, 0]}
          fontSize={0.08}
          color={labelColor}
          anchorX="center"
          anchorY="bottom"
          maxWidth={1.8}
        >
          {getRackAssetId(rack) || getRackDisplayName(rack)}
        </Text>
      )}

      {/* PDU indicator — glowing beacon on racks with commissioned PDUs.
          Color follows live status: green (live), amber blink (warning),
          red (critical), white (commissioned but offline). */}
      {hasPdus && (
        <group position={[0, dimensions.height / 2 + 0.08, -dimensions.depth / 2 + 0.05]}>
          {/* Solid LED core — toneMapped:false = pure saturated colour (real LED),
              not the ACES-washed pale halo. */}
          <mesh>
            <sphereGeometry args={[0.055, 16, 16]} />
            <meshStandardMaterial
              ref={beaconRef}
              color={statusColor}
              emissive={statusColor}
              emissiveIntensity={3}
              toneMapped={false}
            />
          </mesh>
          {/* Soft surrounding glow */}
          <mesh>
            <sphereGeometry args={[0.085, 16, 16]} />
            <meshBasicMaterial color={statusColor} transparent opacity={0.22} toneMapped={false} />
          </mesh>
          <mesh>
            <ringGeometry args={[0.1, 0.14, 24]} />
            <meshBasicMaterial color={statusColor} transparent opacity={0.35} side={THREE.DoubleSide} toneMapped={false} />
          </mesh>
          {pduCount > 1 && (
            <Text
              position={[0.12, 0, 0]}
              fontSize={0.07}
              color={statusColor}
              anchorX="left"
              anchorY="middle"
            >
              {`×${pduCount}`}
            </Text>
          )}
        </group>
      )}
    </group>
  );
};

// Row Label Component
const RowLabel = ({ row, hallLength }) => {
  return (
    <Text
      position={[-0.5, 0.1, row.position.z]}
      fontSize={0.2}
      color="#00E5FF"
      anchorX="right"
      anchorY="middle"
      rotation={[0, 0, 0]}
    >
      {row.id}
    </Text>
  );
};

// Walls Component
const Walls = ({ hall }) => {
  const wallHeight = hall.height;
  const wallThickness = 0.1;
  const wallColor = '#1a2a3a';
  
  return (
    <group>
      {/* Back wall */}
      <mesh position={[hall.length / 2, wallHeight / 2, 0]}>
        <boxGeometry args={[hall.length, wallHeight, wallThickness]} />
        <meshStandardMaterial color={wallColor} transparent opacity={0.3} />
      </mesh>
      {/* Front wall */}
      <mesh position={[hall.length / 2, wallHeight / 2, hall.width]}>
        <boxGeometry args={[hall.length, wallHeight, wallThickness]} />
        <meshStandardMaterial color={wallColor} transparent opacity={0.3} />
      </mesh>
      {/* Left wall */}
      <mesh position={[0, wallHeight / 2, hall.width / 2]}>
        <boxGeometry args={[wallThickness, wallHeight, hall.width]} />
        <meshStandardMaterial color={wallColor} transparent opacity={0.3} />
      </mesh>
      {/* Right wall */}
      <mesh position={[hall.length, wallHeight / 2, hall.width / 2]}>
        <boxGeometry args={[wallThickness, wallHeight, hall.width]} />
        <meshStandardMaterial color={wallColor} transparent opacity={0.3} />
      </mesh>
    </group>
  );
};

// Orbit controls with optional view-pan mode (left-drag pans, right-drag rotates)
const SceneOrbitControls = ({ hall, viewOffset = { x: 0, z: 0 }, viewPanMode = false }) => {
  const controlsRef = useRef();
  const targetX = hall.length / 2 + viewOffset.x;
  const targetZ = hall.width / 2 + viewOffset.z;

  useEffect(() => {
    const ctrl = controlsRef.current;
    if (!ctrl) return;
    ctrl.target.set(targetX, 0, targetZ);
    ctrl.update();
  }, [targetX, targetZ]);

  return (
    <OrbitControls
      ref={controlsRef}
      makeDefault
      minPolarAngle={0.1}
      maxPolarAngle={Math.PI / 2.1}
      minDistance={5}
      maxDistance={50}
      target={[targetX, 0, targetZ]}
      mouseButtons={{
        LEFT: viewPanMode ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: viewPanMode ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN,
      }}
    />
  );
};

// Main 3D Scene
const DataHallScene = ({ layout, selectedRack, hoveredRack, alerts, showLabels, onSelectRack, onHoverRack, customRackModelUrl, customRackModelAssets, lighting, heatmapByRack, pduLiveStatus = {}, sceneObjects = [], selectedObjectId = null, onSelectObject, onCommitObject, transformMode = 'translate', objectsEditable = false, cameraApiRef, viewOffset = { x: 0, z: 0 }, viewPanMode = false }) => {
  // Debug: Log when customRackModelUrl changes
  useEffect(() => {
    console.log('[DataHallScene] customRackModelUrl:', customRackModelUrl);
  }, [customRackModelUrl]);
  
  if (!layout) return null;
  
  const { hall, floor, racks, rows } = layout;
  const { ambient, main, fill, top, mainPos, fillPos, topPos } = lighting || {
    ambient: 0.8, main: 1.0, fill: 0.6, top: 0.4,
    mainPos: { x: 10, y: 20, z: 10 },
    fillPos: { x: -10, y: 20, z: -10 },
    topPos: { x: 0, y: 30, z: 0 }
  };
  
  // Get alert info for a rack based on its PDUs
  const getRackAlertInfo = (rack) => {
    for (const pdu of rack.pdus) {
      const alert = alerts.find(a =>
        a.pduIp === pdu.ip ||
        a.pduId === pdu.id ||
        a.pduId === pdu.dbId ||
        a.rackId === rack.id ||
        a.rackId === rack.rackCode
      );
      if (alert) {
        return {
          level: alert.severity,
          title: alert.title,
          message: alert.message,
          pduPosition: pdu.position,
          ip: pdu.ip,
          category: alert.category,
        };
      }
    }
    return null;
  };
  
  return (
    <>
      {/* Lighting - controlled via props */}
      <ambientLight intensity={ambient} />
      <directionalLight position={[mainPos.x, mainPos.y, mainPos.z]} intensity={main} castShadow />
      <directionalLight position={[fillPos.x, fillPos.y, fillPos.z]} intensity={fill} />
      <directionalLight position={[topPos.x, topPos.y, topPos.z]} intensity={top} />
      
      {/* Floor */}
      <FloorGrid hall={hall} tileSize={floor.tileSize} />
      
      {/* Walls */}
      <Walls hall={hall} />
      
      {/* Row Labels */}
      {rows.map(row => (
        <RowLabel key={row.id} row={row} hallLength={hall.length} />
      ))}
      
      {/* Racks */}
      {racks.map(rack => {
        const alertInfo = getRackAlertInfo(rack);
        const hasPdus = rack.pdus && rack.pdus.length > 0;
        // A rack is "live" when at least one of its commissioned PDUs is online.
        const live = hasPdus && rack.pdus.some(
          (p) => pduLiveStatus[p.ip] === 'online'
        );
        return (
          <Rack3D
            key={rack.id}
            rack={rack}
            isSelected={selectedRack?.id === rack.id}
            isHovered={hoveredRack?.id === rack.id}
            alertLevel={alertInfo?.level}
            alertInfo={alertInfo}
            showLabel={showLabels}
            onSelect={onSelectRack}
            onHover={onHoverRack}
            customModelUrl={customRackModelUrl}
            customModelAssets={customRackModelAssets}
            hasPdus={hasPdus}
            pduCount={rack.pdus ? rack.pdus.length : 0}
            heatmapLevel={heatmapByRack?.[rack.id] ?? null}
            commissioned={hasPdus}
            live={live}
          />
        );
      })}
      
      {/* Free-placed scene props (cage entrances, etc.) */}
      {sceneObjects.map(obj => (
        <SceneProp
          key={obj.id}
          obj={obj}
          selected={selectedObjectId === obj.id}
          editable={objectsEditable}
          transformMode={transformMode}
          onSelect={onSelectObject}
          onCommit={onCommitObject}
        />
      ))}

      {/* Bridge to expose camera for drag-drop placement */}
      {cameraApiRef && <CameraBridge apiRef={cameraApiRef} />}

      <SceneOrbitControls hall={hall} viewOffset={viewOffset} viewPanMode={viewPanMode} />
    </>
  );
};

// Collapsible accordion section for the Parameters panel
const AccordionSection = ({ id, title, icon, children, defaultOpen = false }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mb-1 border border-[#233544] rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen(o => !o)}
        className="sticky top-0 z-10 w-full flex items-center justify-between px-3 py-2.5 bg-[#161E2E] hover:bg-[#1a2535] transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-wider">
          {icon && <span className="material-icons-outlined text-sm text-slate-500">{icon}</span>}
          {title}
        </span>
        <span className={`material-icons-outlined text-sm text-slate-500 transition-transform duration-200 ${open ? 'rotate-180' : ''}`}>expand_more</span>
      </button>
      {open && <div className="px-3 pb-3 pt-1 bg-[#0B1120]">{children}</div>}
    </div>
  );
};

// Parameter Input Component with custom spinner
const ParamInput = ({ label, value, onChange, min, max, step = 1, unit, disabled }) => {
  const increment = () => {
    const newVal = Math.min((value || 0) + step, max ?? Infinity);
    onChange(parseFloat(newVal.toFixed(2)));
  };
  const decrement = () => {
    const newVal = Math.max((value || 0) - step, min ?? -Infinity);
    onChange(parseFloat(newVal.toFixed(2)));
  };
  
  return (
    <div className="flex items-center justify-between py-2 border-b border-[#233544]">
      <label className="text-xs text-slate-400">{label}</label>
      <div className="flex items-center gap-2">
        <div className="flex items-center bg-[#0B1120] border border-[#233544] rounded overflow-hidden focus-within:border-[#00E5FF]">
          <input
            type="number"
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
            min={min}
            max={max}
            step={step}
            disabled={disabled}
            className="w-14 bg-transparent px-2 py-1 text-sm font-mono text-white text-right focus:outline-none disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <div className="flex flex-col border-l border-[#233544]">
            <button
              type="button"
              onClick={increment}
              disabled={disabled}
              className="px-1.5 py-0.5 text-[#00E5FF] hover:bg-[#233544] transition-colors disabled:opacity-50"
            >
              <span className="material-icons-outlined text-[10px]">expand_less</span>
            </button>
            <button
              type="button"
              onClick={decrement}
              disabled={disabled}
              className="px-1.5 py-0.5 text-[#00E5FF] hover:bg-[#233544] transition-colors border-t border-[#233544] disabled:opacity-50"
            >
              <span className="material-icons-outlined text-[10px]">expand_more</span>
            </button>
          </div>
        </div>
        {unit && <span className="text-[10px] text-slate-500 w-8">{unit}</span>}
      </div>
    </div>
  );
};

// Parameter Select Component
const ParamSelect = ({ label, value, onChange, options }) => (
  <div className="flex items-center justify-between py-2 border-b border-[#233544]">
    <label className="text-xs text-slate-400">{label}</label>
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-[#0B1120] border border-[#233544] rounded px-2 py-1 text-sm font-mono text-white focus:border-[#00E5FF] focus:outline-none"
    >
      {options.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
  </div>
);

// Rack Details Panel
const RackDetailsPanel = ({ rack, alerts = [], onClose, onPduClick, onSaveLabel, readOnly = false }) => {
  const [labelDraft, setLabelDraft] = useState('');
  const [savingLabel, setSavingLabel] = useState(false);

  useEffect(() => {
    setLabelDraft((rack?.label || '').trim());
  }, [rack?.id, rack?.label]);

  if (!rack) return null;

  const displayName = getRackAssetId(rack) || getRackDisplayName(rack);
  const layoutName = getRackDisplayName(rack);
  const hasCustomLabel = !!(rack.label || '').trim() || !!(getRackAssetId(rack) && layoutName !== displayName);

  // Get alerts for this rack
  const rackAlerts = alerts.filter(a => a.rackId === rack.id || a.rackId === rack.rackCode);
  const hasAlerts = rackAlerts.length > 0;
  const hasCritical = rackAlerts.some(a => a.severity === 'critical');

  const handleSaveLabel = async () => {
    if (!onSaveLabel || readOnly) return;
    setSavingLabel(true);
    try {
      await onSaveLabel(rack, labelDraft.trim());
    } finally {
      setSavingLabel(false);
    }
  };

  return (
    <div className={`absolute bottom-4 right-4 w-72 max-w-[calc(100%-2rem)] max-h-[calc(100vh-8rem)] flex flex-col overflow-hidden bg-[#161E2E] border ${hasCritical ? 'border-red-500' : hasAlerts ? 'border-amber-500' : 'border-[#233544]'} rounded-xl p-4 shadow-2xl z-10`}>
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          {hasCritical && <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse flex-shrink-0"></span>}
          {!hasCritical && hasAlerts && <span className="w-2 h-2 rounded-full bg-amber-500 flex-shrink-0"></span>}
          <div className="min-w-0">
            <h3 className={`text-sm font-bold truncate ${hasCritical ? 'text-red-400' : hasAlerts ? 'text-amber-400' : 'text-[#00E5FF]'}`}>
              {displayName}
            </h3>
            {hasCustomLabel && (
              <p className="text-[9px] text-slate-500 font-mono truncate">{layoutName}{rack.id && layoutName !== rack.id ? ` · ${rack.id}` : ''}</p>
            )}
          </div>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white flex-shrink-0">
          <span className="material-icons-outlined text-sm">close</span>
        </button>
      </div>

      {!readOnly && onSaveLabel && (
        <div className="mb-4 flex-shrink-0 bg-[#0B1120] border border-[#233544] rounded-lg p-2.5">
          <p className="text-[9px] text-slate-500 uppercase tracking-wider mb-1.5">Rack Label</p>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={labelDraft}
              onChange={(e) => setLabelDraft(e.target.value)}
              placeholder={rack.id}
              className="flex-1 min-w-0 bg-[#161E2E] border border-[#233544] rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-[#00E5FF]"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveLabel(); }}
            />
            <button
              type="button"
              onClick={handleSaveLabel}
              disabled={savingLabel || labelDraft.trim() === (rack.label || '').trim()}
              className="px-2 py-1 rounded bg-[#00E5FF]/15 border border-[#00E5FF]/40 text-[#00E5FF] text-[10px] font-bold uppercase disabled:opacity-40"
            >
              {savingLabel ? '…' : 'Save'}
            </button>
          </div>
          <p className="text-[8px] text-slate-600 mt-1">Shown on 3D hover and telemetry overlay</p>
        </div>
      )}

      {/* Scrollable body so the panel never overflows the screen */}
      <div className="overflow-y-auto flex-1 min-h-0 -mr-2 pr-2">
      {/* Alerts Section */}
      {hasAlerts && (
        <div className="mb-4 space-y-2">
          {rackAlerts.map(alert => (
            <div 
              key={alert.id} 
              className={`p-2 rounded border-l-2 ${alert.severity === 'critical' ? 'bg-red-500/10 border-l-red-500' : 'bg-amber-500/10 border-l-amber-500'}`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span className={`text-[10px] font-bold uppercase ${alert.severity === 'critical' ? 'text-red-400' : 'text-amber-400'}`}>
                  {alert.severity}
                </span>
                <span className="text-xs text-white">{alert.title}</span>
              </div>
              <p className="text-[10px] text-slate-400">{alert.message}</p>
            </div>
          ))}
        </div>
      )}
      
      <div className="space-y-3 text-xs font-mono">
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-[#0B1120] p-2 rounded">
            <p className="text-slate-500 text-[10px]">Model</p>
            <p className="text-white">{rack.model}</p>
          </div>
          <div className="bg-[#0B1120] p-2 rounded">
            <p className="text-slate-500 text-[10px]">Height</p>
            <p className="text-white">{rack.heightU}U</p>
          </div>
        </div>
        
        <div className="bg-[#0B1120] p-2 rounded">
          <p className="text-slate-500 text-[10px] mb-1">Dimensions</p>
          <p className="text-white">
            {(rack.dimensions.width * 1000).toFixed(0)}mm × {(rack.dimensions.depth * 1000).toFixed(0)}mm × {(rack.dimensions.height * 1000).toFixed(0)}mm
          </p>
        </div>
        
        <div className="bg-[#0B1120] p-2 rounded">
          <p className="text-slate-500 text-[10px] mb-1">Position</p>
          <p className="text-white">
            X: {rack.position.x.toFixed(2)}m, Z: {rack.position.z.toFixed(2)}m
          </p>
        </div>
        
        <div>
          <p className="text-slate-500 text-[10px] mb-2">PDUs ({rack.pdus.length})</p>
          <div className="space-y-1">
            {rack.pdus.map(pdu => {
              const pduAlert = alerts.find(a => a.pduId === pdu.id);
              const isCommissioned = !!pdu.dbId;
              return (
                <button
                  key={pdu.id}
                  onClick={() => onPduClick && onPduClick(pdu)}
                  className={`w-full flex items-center justify-between p-2 rounded cursor-pointer hover:ring-1 hover:ring-[#00E5FF]/50 transition-all ${pduAlert ? (pduAlert.severity === 'critical' ? 'bg-red-500/10 hover:bg-red-500/20' : 'bg-amber-500/10 hover:bg-amber-500/20') : 'bg-[#0B1120] hover:bg-[#1a2535]'}`}
                >
                  <div className="flex items-center min-w-0">
                    <span className="w-4 flex-shrink-0">
                      {pduAlert ? (
                        <span className={`w-1.5 h-1.5 rounded-full inline-block ${pduAlert.severity === 'critical' ? 'bg-red-500' : 'bg-amber-500'}`}></span>
                      ) : isCommissioned ? (
                        <span className="w-1.5 h-1.5 rounded-full inline-block bg-emerald-500"></span>
                      ) : (
                        <span className="w-1.5 h-1.5 rounded-full inline-block bg-slate-600 border border-dashed border-slate-500"></span>
                      )}
                    </span>
                    <div className="min-w-0 ml-1">
                      <span className="text-[#00E5FF] text-[10px] font-mono truncate block" title={pduDisplayId(pdu)}>
                        {pduDisplayId(pdu) || `PDU ${pdu.position}`}
                      </span>
                      <span className="text-slate-500 text-[8px]">{pdu.position}{pdu.ip ? ` · ${pdu.ip}` : ''}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {isCommissioned ? (
                      <span className="text-emerald-400 font-mono text-xs">{pdu.ip}</span>
                    ) : (
                      <span className="text-slate-600 font-mono text-xs italic">{pdu.ip || 'planned'}</span>
                    )}
                    {isCommissioned && <span className="material-icons-outlined text-[#00E5FF] text-xs">open_in_new</span>}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
};

// Parse the leading numeric part of a value like "224.6V" / "0.500kW" / 1.2
const parseLeadingNumber = (raw) => {
  if (raw == null) return null;
  if (typeof raw === 'number') return raw;
  const m = String(raw).replace(/"/g, '').trim().match(/^-?[\d.]+/);
  return m ? parseFloat(m[0]) : null;
};

// Enhanced Rack Telemetry Tooltip Component — pulls REAL-TIME values from the
// /live endpoint (same source the main dashboard uses), mapping NPDU MIB OID
// names first and falling back to web-admin CGI field names.
const RackTelemetryTooltip = ({ rack, onClose }) => {
  const [telemetryData, setTelemetryData] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!rack?.pdus?.length) return;
    let cancelled = false;

    const fetchAll = async () => {
      const results = {};
      await Promise.all(rack.pdus.map(async (pdu) => {
        if (!pdu.ip) { results[pdu.id] = { online: false }; return; }
        try {
          const rh = pdu.remote_host ? `?remote_host=${encodeURIComponent(pdu.remote_host)}` : '';
          const [liveRes, chartRes] = await Promise.all([
            fetch(`${API_BASE}/api/pdus/by-ip/${pdu.ip}/live${rh}`),
            fetch(`${API_BASE}/api/pdus/by-ip/${pdu.ip}/telemetry/chart?period=day`),
          ]);
          const live = liveRes.ok ? await liveRes.json() : null;
          const chart = chartRes.ok ? await chartRes.json() : null;
          const rows = live?.results || [];

          const pick = (...names) => {
            for (const n of names) {
              const it = rows.find(r => r.name === n);
              if (it && it.value != null) return parseLeadingNumber(it.value);
            }
            return null;
          };

          const current = pick('MasterCurrentP1', 'l1_current', 'total_current');
          const voltage = pick('MasterVoltageP1', 'l1_voltage');
          const power   = pick('MasterPowerP1', 'total_active_power', 'l1_active_power');
          const pf      = pick('MasterPFP1', 'total_pf', 'l1_pf');
          const energy  = pick('MasterEnergyP1', 'total_active_energy');

          const spark = (chart?.data || [])
            .slice(-24)
            .map(d => (typeof d.current === 'number' ? d.current : parseLeadingNumber(d.current)))
            .filter(v => v != null);

          const online = rows.length > 0 && ((current ?? 0) > 0 || (voltage ?? 0) > 0);
          results[pdu.id] = { online, current, voltage, power, pf, energy, spark };
        } catch (err) {
          results[pdu.id] = { online: false };
        }
      }));
      if (!cancelled) { setTelemetryData(results); setLoading(false); }
    };

    setLoading(true);
    fetchAll();
    const interval = setInterval(fetchAll, 5000); // Refresh every 5s
    return () => { cancelled = true; clearInterval(interval); };
  }, [rack]);

  if (!rack) return null;

  const onlineCount = Object.values(telemetryData).filter(t => t.online).length;
  const hasAnyTelemetry = onlineCount > 0;
  const fmt = (v, digits) => (typeof v === 'number' ? v.toFixed(digits) : '--');

  return (
    <aside
      className="absolute top-14 left-4 z-30 w-[min(400px,92vw)] max-h-[calc(100%-5rem)] pointer-events-none flex flex-col bg-[#070a10]/92 backdrop-blur-md border border-white/[0.08] rounded-[10px]"
      aria-label="Rack telemetry"
    >
      <div className="px-3 py-2.5 border-b border-white/[0.06] flex-shrink-0">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="w-5 h-5 rounded-md border border-white/10 flex items-center justify-center">
            <span className="material-icons-outlined text-[11px] text-[#8A929B]">sensors</span>
          </span>
          <span className={HUD_LABEL}>Telemetry Overlay</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <span className="text-[15px] font-semibold text-white tracking-tight block truncate" title={getRackAssetId(rack) || getRackDisplayName(rack)}>
              {getRackAssetId(rack) || getRackDisplayName(rack)}
            </span>
            <span className="text-[9px] text-[#6b7280] font-mono truncate block">
              {getRackDisplayName(rack)}
              {rack.id && getRackDisplayName(rack) !== rack.id ? ` · ${rack.id}` : ''}
            </span>
          </div>
          <span className={`text-[8px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border flex-shrink-0 ${
            hasAnyTelemetry
              ? 'border-emerald-500/40 text-emerald-400/90 bg-emerald-500/10'
              : 'border-white/10 text-[#6b7280] bg-white/[0.03]'
          }`}>
            {loading ? 'Loading…' : hasAnyTelemetry ? `${onlineCount}/${rack.pdus.length} Online` : 'Offline'}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2.5 py-2 space-y-2 min-h-0">
        {rack.pdus.map((pdu) => {
          const data = telemetryData[pdu.id] || { online: false };
          const spark = data.spark || [];

          return (
            <div key={pdu.id} className={`${HUD_CARD} px-3 py-2.5`}>
              <div className="flex items-center justify-between mb-2 gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${data.online ? 'bg-emerald-500/90' : 'bg-red-500/80'}`} />
                  <div className="min-w-0">
                    <span className="text-[9px] font-semibold text-white tracking-wide block truncate" title={pduDisplayId(pdu)}>
                      {pduDisplayId(pdu) || `PDU ${pdu.position}`}
                    </span>
                    <span className="text-[8px] text-[#6b7280] font-mono truncate block">
                      {pdu.position ? `${pdu.position} · ` : ''}{pdu.ip || 'N/A'}
                    </span>
                  </div>
                </div>
                <div className="text-[15px] font-semibold text-white tabular-nums flex-shrink-0">
                  {fmt(data.current, 2)}
                  <span className="text-[10px] text-[#8A929B] ml-0.5">A</span>
                </div>
              </div>

              <div className="mb-2">
                <div className="text-[7px] text-[#6b7280] uppercase tracking-wider mb-1">24h Load</div>
                {spark.length > 1 ? (
                  <HudSparkChart
                    data={spark}
                    id={`rt-${pdu.id}`}
                    h={28}
                    className="h-7"
                    color={TELEMETRY_CHART}
                    showDots="last"
                  />
                ) : (
                  <div className="h-7 flex items-center justify-center text-[8px] text-[#4a5568]">
                    {data.online ? 'Building history…' : 'No telemetry data'}
                  </div>
                )}
              </div>

              <div className="grid grid-cols-4 gap-1">
                {[
                  { label: 'Curr', value: fmt(data.current, 2), unit: 'A' },
                  { label: 'Volt', value: fmt(data.voltage, 1), unit: 'V' },
                  { label: 'Power', value: fmt(data.power, 2), unit: 'kW' },
                  { label: 'PF', value: fmt(data.pf, 2), unit: '' },
                ].map((m) => (
                  <div key={m.label} className="text-center py-1 border-t border-white/[0.06]">
                    <div className="text-[7px] text-[#6b7280] uppercase tracking-wider">{m.label}</div>
                    <div className="text-[10px] text-white font-medium tabular-nums">
                      {m.value}
                      {m.unit && <span className="text-[7px] text-[#6b7280] ml-0.5">{m.unit}</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}

        {rack.pdus.length === 0 && (
          <div className="text-center py-4 text-[#6b7280] text-[10px]">
            No PDUs configured in this rack
          </div>
        )}
      </div>

      <div className="px-3 py-1.5 border-t border-white/[0.06] flex items-center justify-between flex-shrink-0">
        <span className="text-[7px] text-[#4a5568] uppercase tracking-[0.15em]">
          {loading ? 'Fetching…' : 'Live sync'}
        </span>
        <span className={`w-1.5 h-1.5 rounded-full ${loading ? 'bg-white/40' : 'bg-emerald-500/80'} animate-pulse`} />
      </div>
    </aside>
  );
};

// MIB Drag-and-Drop Upload Zone with persistence
const MibDropZone = ({ hallId }) => {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);
  const [mibs, setMibs] = useState([]);

  const loadMibs = useCallback(async () => {
    if (!hallId) return;
    try {
      const res = await fetch(`${API_BASE}/api/halls/${hallId}/mibs`);
      const data = await res.json();
      if (data.success) setMibs(data.mibs || []);
    } catch (e) { /* ignore */ }
  }, [hallId]);

  useEffect(() => { loadMibs(); }, [loadMibs]);

  const uploadFile = async (file) => {
    setUploading(true);
    setResult(null);
    const formData = new FormData();
    formData.append('file', file);
    if (hallId) formData.append('hall_id', hallId);
    try {
      const response = await fetch(`${API_BASE}/api/mibs/upload`, { method: 'POST', body: formData });
      const data = await response.json();
      if (data.success) {
        setResult({ ok: true, msg: `${data.originalName || data.fileName} — ${data.oidCount || 0} OIDs parsed` });
        loadMibs();
      } else {
        setResult({ ok: false, msg: data.error || 'Upload failed' });
      }
    } catch (err) {
      setResult({ ok: false, msg: err.message });
    } finally {
      setUploading(false);
    }
  };

  const deleteMib = async (mibId) => {
    try {
      await fetch(`${API_BASE}/api/mibs/${mibId}`, { method: 'DELETE' });
      loadMibs();
    } catch (e) { /* ignore */ }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) uploadFile(file);
  };

  return (
    <div className="space-y-2">
      {/* Existing MIBs */}
      {mibs.length > 0 && (
        <div className="space-y-1">
          {mibs.map(mib => (
            <div key={mib.id} className="flex items-center gap-2 p-2 bg-[#0B1120] border border-[#233544] rounded-lg group">
              <span className="material-icons-outlined text-emerald-400 text-xs">description</span>
              <div className="flex-1 min-w-0">
                <p className="text-[10px] text-white font-mono truncate">{mib.original_name}</p>
                <p className="text-[9px] text-slate-600">{mib.oid_count} OIDs • {new Date(mib.created_at).toLocaleDateString()}</p>
              </div>
              <button
                onClick={() => deleteMib(mib.id)}
                className="opacity-0 group-hover:opacity-100 text-red-400 hover:text-red-300 transition-all"
                title="Remove MIB"
              >
                <span className="material-icons-outlined" style={{fontSize:'14px'}}>close</span>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`relative flex flex-col items-center justify-center gap-1 w-full py-4 rounded-lg cursor-pointer transition-all border-2 border-dashed ${
          dragOver
            ? 'border-[#00E5FF] bg-[#00E5FF]/10 scale-[1.02]'
            : 'border-[#233544] bg-[#0B1120] hover:border-[#00E5FF]/50 hover:bg-[#00E5FF]/5'
        }`}
      >
        <input
          type="file"
          accept=".mib,.my,.txt,.MIB,.MY,.asn1,.smi"
          className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); e.target.value = ''; }}
        />
        {uploading ? (
          <span className="material-icons-outlined text-[#00E5FF] text-lg animate-spin">sync</span>
        ) : (
          <span className="material-icons-outlined text-[#00E5FF] text-lg">
            {dragOver ? 'file_download' : 'upload_file'}
          </span>
        )}
        <span className="text-[10px] text-slate-400">
          {dragOver ? 'Drop file here' : uploading ? 'Uploading...' : <>Drag & drop or <span className="text-[#00E5FF] font-bold">browse</span></>}
        </span>
        <span className="text-[9px] text-slate-600">.mib .my .txt .asn1 .smi</span>
      </div>

      {/* Upload result toast */}
      {result && (
        <div className={`p-2 rounded-lg text-[10px] flex items-center gap-1.5 ${
          result.ok ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400' : 'bg-red-500/10 border border-red-500/30 text-red-400'
        }`}>
          <span className="material-icons-outlined text-xs">{result.ok ? 'check_circle' : 'error'}</span>
          <span className="flex-1 truncate">{result.msg}</span>
          <button onClick={() => setResult(null)} className="text-slate-500 hover:text-slate-300">
            <span className="material-icons-outlined" style={{fontSize:'12px'}}>close</span>
          </button>
        </div>
      )}
    </div>
  );
};

// Main Component
const DataHallDesigner = ({
  onNavigateToPdu,
  selectedHallId: externalHallId,
  onHallChange,
  onConfigSaved,
  alerts: externalAlerts,
  readOnly = false,
  heatmapByRack = {},
  fullBleed = false,
  neuralMode = false,
  showNeuralToggle = false,
  showIntegrationsGear = false,
  onOpenIntegrations,
  neuralOpsEnabled = false,
  onNeuralOpsChange,
  opsPanelOpen = true,
  onToggleOpsPanel,
  hallRefreshTrigger = 0,
  pduLiveStatus = {},
  hallPDUs = [],
  pduAlarms = {},
  pduEnv = {},
  fleetPduResults = {},
}) => {
  const readCagePulsePref = useCallback((isNeural) => {
    const key = isNeural ? 'pdumind_cage_pulse_switchboard' : 'pdumind_cage_pulse';
    const stored = localStorage.getItem(key);
    if (stored != null) return stored === '1';
    return !isNeural; // Stencil: default on · Switchboard: default off
  }, []);
  const [cagePulseOn, setCagePulseOn] = useState(() => readCagePulsePref(neuralMode));
  const [viewPanMode, setViewPanMode] = useState(
    () => localStorage.getItem('pdumind_view_pan') === '1',
  );
  const [viewOffset, setViewOffset] = useState({ x: 0, z: 0 });
  const cageShiftApplied = useRef(false);
  const [config, setConfig] = useState(defaultDataHallConfig);
  const [selectedRack, setSelectedRack] = useState(null);
  const [hoveredRack, setHoveredRack] = useState(null);
  const prevCableWarningIdsRef = useRef(new Set());
  const openedCableWarningIdsRef = useRef(new Set());
  const dismissedCableRackRef = useRef(new Set());
  const [showLabels, setShowLabels] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(readOnly);
  
  // Lighting controls state
  const [showLightingPanel, setShowLightingPanel] = useState(false);
  const [lighting, setLighting] = useState({
    ambient: 1.5,
    main: 2.0,
    fill: 1.2,
    top: 0.8,
    // Light positions (x, y, z)
    mainPos: { x: 10, y: 20, z: 10 },
    fillPos: { x: -10, y: 20, z: -10 },
    topPos: { x: 0, y: 30, z: 0 }
  });
  
  // Hall management state
  const [halls, setHalls] = useState([]);
  const [currentHall, setCurrentHall] = useState(null);
  const [hallId, setHallId] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [lastSaved, setLastSaved] = useState(null);
  const [showNewHallDialog, setShowNewHallDialog] = useState(false);
  const [newHallName, setNewHallName] = useState('');
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [storedPdus, setStoredPdus] = useState([]); // PDUs from database with actual IPs
  const [storedRacks, setStoredRacks] = useState([]); // DB racks for rack_code mapping

  // Scene props (free-placed reference objects like cage entrances)
  const [selectedObjectId, setSelectedObjectId] = useState(null);
  const [transformMode, setTransformMode] = useState('translate'); // 'translate' | 'rotate'
  const cameraApiRef = useRef(null);
  const canvasWrapRef = useRef(null);
  
  useEffect(() => {
    if (neuralMode) setPanelCollapsed(true);
  }, [neuralMode]);

  useEffect(() => {
    setCagePulseOn(readCagePulsePref(neuralMode));
    cageShiftApplied.current = false;
  }, [neuralMode, readCagePulsePref]);

  useEffect(() => {
    if (neuralMode) setShowLightingPanel(false);
  }, [neuralMode]);

  // FIX blank-canvas-on-first-load WITHOUT remounting the Canvas (remounting
  // destroys/recreates the WebGL context → "Context Lost" → blue canvas).
  // Mount immediately; FitCanvas + ResizeObserver size the GL buffer once the
  // flex parent actually has a box (refresh often measures 0×0 on the first frame).
  // Bumped to force a fresh <Canvas> (new WebGL context) after a context loss
  // that the browser doesn't auto-restore. Without this the canvas stays blank.
  const [glEpoch, setGlEpoch] = useState(0);
  const glRestoreTimer = useRef(null);
  const glAttempts = useRef(0);
  useEffect(() => () => { if (glRestoreTimer.current) clearTimeout(glRestoreTimer.current); }, []);
  
  // Fetch all halls
  const fetchHalls = useCallback(async () => {
    try {
      const response = await fetch(`${API_BASE}/api/halls`);
      if (response.ok) {
        const data = await response.json();
        setHalls(data.halls || []);
        return data.halls || [];
      }
    } catch (error) {
      console.log('[DataHallDesigner] Failed to fetch halls:', error);
    }
    return [];
  }, []);
  
  // Ref to reliably guard auto-save during loads (avoids React batching issues)
  const isLoadingRef = useRef(true);
  // Ref to track the save timer so we can flush it before switching halls
  const saveTimerRef = useRef(null);
  // Ref to always have current hallId + config for the flush-save
  const hallIdRef = useRef(null);
  const configRef = useRef(config);
  useEffect(() => { hallIdRef.current = hallId; }, [hallId]);
  useEffect(() => { configRef.current = config; }, [config]);

  const buildRackSavePayload = useCallback((layoutRacks, racksFromDb = storedRacks) => {
    return layoutRacks.map((rack) => {
      const dbRack = racksFromDb.find(
        (r) => r.row_index === rack.rowIndex && r.position_index === rack.positionInRow,
      );
      const payload = {
        rack_code: rack.id,
        row_index: rack.rowIndex,
        position_index: rack.positionInRow,
        x_m: rack.position.x,
        y_m: rack.position.y,
        z_m: rack.position.z,
        width_mm: Math.round(rack.dimensions.width * 1000),
        depth_mm: Math.round(rack.dimensions.depth * 1000),
        height_u: rack.heightU,
        model: rack.model,
      };
      if (dbRack?.label) payload.label = dbRack.label;
      return payload;
    });
  }, [storedRacks]);

  const saveRackLabel = useCallback(async (rack, label) => {
    const dbRack = storedRacks.find(
      (r) => r.row_index === rack.rowIndex && r.position_index === rack.positionInRow,
    ) || (rack.dbRackId ? storedRacks.find((r) => r.id === rack.dbRackId) : null);
    if (!dbRack?.id) return;
    const trimmed = label.trim();
    try {
      const res = await fetch(`${API_BASE}/api/racks/${dbRack.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: trimmed || null }),
      });
      if (!res.ok) return;
      const normalized = trimmed || null;
      setStoredRacks((prev) => prev.map((r) => (
        r.id === dbRack.id ? { ...r, label: normalized } : r
      )));
      const patch = (prev) => (
        prev && prev.rowIndex === rack.rowIndex && prev.positionInRow === rack.positionInRow
          ? { ...prev, label: normalized }
          : prev
      );
      setSelectedRack(patch);
      setHoveredRack(patch);
    } catch (e) {
      console.error('[DataHallDesigner] Failed to save rack label:', e);
    }
  }, [storedRacks]);

  // Immediately flush any pending save (called before switching halls)
  const flushSave = useCallback(async () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const hid = hallIdRef.current;
    const cfg = configRef.current;
    if (!hid) return;
    try {
      const layout = generateDataHallLayout(cfg);
      const racks = layout.success ? buildRackSavePayload(layout.layout.racks) : [];
      await fetch(`${API_BASE}/api/halls/${hid}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg, racks, pdus: [] })
      });
      console.log('[DataHallDesigner] Flushed save for hall', hid);
    } catch (e) {
      console.error('[DataHallDesigner] Flush save failed:', e);
    }
  }, [buildRackSavePayload]);

  // Load specific hall state
  const loadHallState = useCallback(async (id) => {
    try {
      isLoadingRef.current = true;
      setIsLoading(true);
      const response = await fetch(`${API_BASE}/api/halls/${id}/state`);
      if (response.ok) {
        const data = await response.json();
        setCurrentHall(data.hall);
        setHallId(data.hall.id);
        if (data.config) {
          setConfig(data.config);
          console.log('[DataHallDesigner] Loaded config for hall:', data.hall.name, 'rackModel:', data.config.rackModel);
        } else {
          setConfig(defaultDataHallConfig);
          console.log('[DataHallDesigner] Using default config for hall:', data.hall.name);
        }
        if (data.pdus) {
          setStoredPdus(data.pdus);
          console.log('[DataHallDesigner] Loaded PDUs from DB:', data.pdus.length);
        } else {
          setStoredPdus([]);
        }
        if (data.racks) {
          setStoredRacks(data.racks);
        } else {
          setStoredRacks([]);
        }
        setLastSaved(null);
      }
    } catch (error) {
      console.log('[DataHallDesigner] Failed to load hall state:', error);
    } finally {
      setIsLoading(false);
      // Small delay so the auto-save effect doesn't fire on the loaded config
      setTimeout(() => { isLoadingRef.current = false; }, 500);
    }
  }, []);

  // Refresh only the commissioned PDUs / DB racks for the current hall WITHOUT
  // overwriting the in-memory config. Used by external refresh triggers (e.g.
  // PDU assignment) so the designer's parametric config + placed scene objects
  // are never clobbered by an unrelated reload.
  const reloadPdusAndRacks = useCallback(async (id) => {
    try {
      const response = await fetch(`${API_BASE}/api/halls/${id}/state`);
      if (response.ok) {
        const data = await response.json();
        if (data.hall) setCurrentHall(data.hall);
        setStoredPdus(data.pdus || []);
        setStoredRacks(data.racks || []);
      }
    } catch (error) {
      console.log('[DataHallDesigner] Failed to reload PDUs/racks:', error);
    }
  }, []);
  
  // Create new hall
  const createHall = useCallback(async (name) => {
    try {
      const response = await fetch(`${API_BASE}/api/halls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description: `Data hall: ${name}` })
      });
      if (response.ok) {
        const data = await response.json();
        await fetchHalls();
        await loadHallState(data.id);
        return data.id;
      }
    } catch (error) {
      console.log('[DataHallDesigner] Failed to create hall:', error);
    }
    return null;
  }, [fetchHalls, loadHallState]);
  
  const renameHall = useCallback(async (id, newName) => {
    try {
      const response = await fetch(`${API_BASE}/api/halls/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
      });
      if (response.ok) {
        await fetchHalls();
        setCurrentHall(prev => prev ? { ...prev, name: newName } : prev);
      }
    } catch (error) {
      console.log('[DataHallDesigner] Failed to rename hall:', error);
    }
  }, [fetchHalls]);
  
  const deleteHall = useCallback(async (id) => {
    try {
      const response = await fetch(`${API_BASE}/api/halls/${id}`, { method: 'DELETE' });
      if (response.ok) {
        const hallsList = await fetchHalls();
        if (hallsList.length > 0) {
          await loadHallState(hallsList[0].id);
          if (onHallChange) onHallChange(hallsList[0].id);
        } else {
          setCurrentHall(null);
          setHallId(null);
        }
      }
    } catch (error) {
      console.log('[DataHallDesigner] Failed to delete hall:', error);
    }
  }, [fetchHalls, loadHallState, onHallChange]);
  
  // Load halls on mount
  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      try {
        const hallsList = await fetchHalls();
        if (hallsList.length > 0) {
          // Use external hall ID if provided, otherwise use first hall
          const targetHallId = externalHallId || hallsList[0].id;
          await loadHallState(targetHallId);
          // Notify parent of initial hall selection
          if (onHallChange && !externalHallId) {
            onHallChange(hallsList[0].id);
          }
        } else {
          // Create default hall if none exist
          const newId = await createHall('Default Hall');
          if (onHallChange && newId) {
            onHallChange(newId);
          }
        }
      } catch (error) {
        console.log('[DataHallDesigner] Init failed:', error);
      } finally {
        setIsLoading(false);
      }
    };
    init();
  }, []);
  
  // Sync with external hall selection from parent (Dashboard2 sidebar)
  useEffect(() => {
    if (externalHallId && externalHallId !== hallId && !isLoading) {
      (async () => {
        await flushSave();
        await loadHallState(externalHallId);
      })();
    }
  }, [externalHallId, hallId, isLoading, loadHallState, flushSave]);

  // Reload PDUs/racks when parent triggers refresh (e.g. demo rack assign).
  // Flush any pending config save first, then refresh ONLY the PDUs/racks so the
  // user's parametric config + placed scene objects are preserved.
  useEffect(() => {
    if (!hallId || !hallRefreshTrigger) return;
    (async () => {
      await flushSave();
      await reloadPdusAndRacks(hallId);
    })();
  }, [hallRefreshTrigger, hallId, reloadPdusAndRacks, flushSave]);
  
  // Save on page unload so closing/refreshing doesn't lose changes. A regular
  // fetch is frequently aborted during unload, so use sendBeacon which the
  // browser guarantees to deliver even as the page is tearing down.
  useEffect(() => {
    const handleBeforeUnload = () => {
      const hid = hallIdRef.current;
      const cfg = configRef.current;
      if (readOnly || !hid) return;
      try {
        const layout = generateDataHallLayout(cfg);
        const racks = layout.success ? buildRackSavePayload(layout.layout.racks) : [];
        const payload = JSON.stringify({ config: cfg, racks, pdus: [] });
        const blob = new Blob([payload], { type: 'application/json' });
        if (navigator.sendBeacon) {
          navigator.sendBeacon(`${API_BASE}/api/halls/${hid}/state`, blob);
        } else {
          flushSave();
        }
      } catch (e) {
        flushSave();
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [flushSave, readOnly, buildRackSavePayload]);

  // Flush pending edits when the designer unmounts (e.g. switching to another
  // page/tab inside the app). Without this, an in-flight debounced save is
  // cancelled by the auto-save cleanup and the change (e.g. a repositioned
  // cage entrance) is silently lost. flushSave reads the latest config/hall
  // from refs, so it persists whatever was last edited.
  useEffect(() => {
    return () => { flushSave(); };
  }, [flushSave]);
  
  // Save hall state
  const saveHallState = useCallback(async () => {
    if (!hallId || isLoadingRef.current) return;
    
    try {
      setIsSaving(true);
      const layout = generateDataHallLayout(config);
      
      const racks = layout.success ? buildRackSavePayload(layout.layout.racks) : [];
      
      const response = await fetch(`${API_BASE}/api/halls/${hallId}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, racks, pdus: [] })
      });
      
      if (response.ok) {
        setLastSaved(new Date().toLocaleTimeString());
        console.log('[DataHallDesigner] Saved hall config + racks to DB for hall', hallId);
        if (onConfigSaved) {
          onConfigSaved();
        }
      }
    } catch (error) {
      console.error('[DataHallDesigner] Failed to save hall state:', error);
    } finally {
      setIsSaving(false);
    }
  }, [hallId, config, onConfigSaved, buildRackSavePayload]);

  // Keep a stable ref to the latest saveHallState so the debounce effect does
  // NOT depend on its identity. saveHallState changes every render (its dep
  // `onConfigSaved` is an inline arrow from the parent, and the parent
  // re-renders constantly from live telemetry). If the debounce effect
  // depended on it, the 1.5s timer would be cleared and restarted on every
  // parent re-render and the save would never actually fire.
  const saveHallStateRef = useRef(saveHallState);
  useEffect(() => { saveHallStateRef.current = saveHallState; }, [saveHallState]);

  // Auto-save on config change (debounced). Depends only on `config` identity
  // (which changes solely on real edits / loads), so unrelated re-renders
  // never reset the timer. We intentionally do NOT bail when a load is in
  // flight — the debounce (1.5s) outlasts the load guard (cleared ~500ms after
  // load), and saveHallState() re-checks the guard at fire time.
  useEffect(() => {
    if (readOnly || !hallId) return;
    
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      saveHallStateRef.current?.();
    }, 1500);
    
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [config, hallId, readOnly]);
  
  // Generate layout from config
  const layoutResult = useMemo(() => generateDataHallLayout(config), [config]);
  
  // Replace layout-generated placeholder PDUs with real commissioned PDUs from DB.
  // Racks with no commissioned PDUs get an empty PDU list (empty slots).
  const mergedLayoutResult = useMemo(() => {
    if (!layoutResult.success) return layoutResult;
    
    const pdusByRack = {};
    const pdusByRackId = {};
    const makePduEntry = (pdu, rackCode) => ({
      id: pdu.label || pdu.hostname || `${rackCode || pdu.rack_code || 'rack'}/PDU-${pdu.mount_position || 'A'}`,
      hostname: pdu.hostname || pdu.label || '',
      label: pdu.label || pdu.hostname || '',
      rackId: rackCode || pdu.rack_code,
      position: pdu.mount_position || 'A',
      model: pdu.model || 'PDU',
      ip: pdu.ip_address,
      remote_host: pdu.remote_host || null,
      dbId: pdu.id,
    });

    for (const pdu of storedPdus) {
      const rackCode = pdu.rack_code;
      const entry = makePduEntry(pdu, rackCode);
      if (rackCode) {
        if (!pdusByRack[rackCode]) pdusByRack[rackCode] = [];
        pdusByRack[rackCode].push(entry);
      }
      if (pdu.rack_id) {
        if (!pdusByRackId[pdu.rack_id]) pdusByRackId[pdu.rack_id] = [];
        pdusByRackId[pdu.rack_id].push(entry);
      }
    }

    const rackCodeForLayout = (rack) => {
      const match = storedRacks.find(
        (r) => r.row_index === rack.rowIndex && r.position_index === rack.positionInRow
      );
      return match?.rack_code || rack.id;
    };
    
    const mergedRacks = layoutResult.layout.racks.map(rack => {
      const code = rackCodeForLayout(rack);
      const dbRack = storedRacks.find(
        (r) => r.row_index === rack.rowIndex && r.position_index === rack.positionInRow
      );
      const pdus =
        pdusByRack[code] ||
        pdusByRack[rack.id] ||
        (dbRack ? pdusByRackId[dbRack.id] : null) ||
        [];
      return {
        ...rack,
        rackCode: code,
        label: dbRack?.label || null,
        dbRackId: dbRack?.id || null,
        pdus,
      };
    });

    // Spread any unassigned PDUs onto empty racks (demo recovery)
    const assignedIps = new Set();
    mergedRacks.forEach((r) => r.pdus.forEach((p) => assignedIps.add(p.ip)));
    const unassigned = storedPdus.filter((p) => p.ip_address && !assignedIps.has(p.ip_address));
    if (unassigned.length > 0) {
      let ui = 0;
      for (const rack of mergedRacks) {
        if (ui >= unassigned.length) break;
        if (rack.pdus.length === 0) {
          const pdu = unassigned[ui++];
          rack.pdus.push(makePduEntry(pdu, rack.rackCode));
        }
      }
    }
    
    return {
      ...layoutResult,
      layout: {
        ...layoutResult.layout,
        racks: mergedRacks
      }
    };
  }, [layoutResult, storedPdus, storedRacks]);
  
  // Use real alerts from parent (Dashboard2) or empty array
  const alerts = externalAlerts || [];
  
  // Update config helper
  const updateConfig = useCallback((path, value) => {
    setConfig(prev => {
      const newConfig = JSON.parse(JSON.stringify(prev));
      const keys = path.split('.');
      let obj = newConfig;
      for (let i = 0; i < keys.length - 1; i++) {
        obj = obj[keys[i]];
      }
      obj[keys[keys.length - 1]] = value;
      return newConfig;
    });
  }, []);
  
  const layout = mergedLayoutResult.success ? mergedLayoutResult.layout : null;

  // Rack floor positions + labels for Cage Pulse cable-unplugged coordinates
  const rackMetaByCode = useMemo(() => {
    const map = {};
    if (!layout?.racks) return map;
    for (const rack of layout.racks) {
      const code = rack.rackCode || rack.id;
      const dbRack = storedRacks.find(
        (r) => r.row_index === rack.rowIndex && r.position_index === rack.positionInRow,
      );
      map[code] = {
        label: rack.label || dbRack?.label || null,
        x: dbRack?.x_m ?? rack.position?.x ?? 0,
        z: dbRack?.z_m ?? rack.position?.z ?? 0,
        rowIndex: rack.rowIndex,
        positionInRow: rack.positionInRow,
        heightU: rack.heightU || dbRack?.height_u || 42,
      };
    }
    return map;
  }, [layout, storedRacks]);

  // PDUs for cage metrics — prefer parent hall list, fall back to DB-stored PDUs
  const effectiveHallPDUs = useMemo(() => {
    if (hallPDUs?.length) {
      return hallPDUs.map((p) => ({
        ...p,
        rack_label: p.rack_label || rackMetaByCode[p.rack_code || p.location]?.label || null,
      }));
    }
    return (storedPdus || [])
      .filter((p) => p.ip_address)
      .map((p) => ({
        ip: p.ip_address,
        hostname: p.hostname || p.label || '',
        label: p.label || p.hostname || p.ip_address,
        mount_position: p.mount_position,
        rack_code: p.rack_code,
        rack_label: rackMetaByCode[p.rack_code]?.label || null,
      }));
  }, [hallPDUs, storedPdus, rackMetaByCode]);

  const findRackForCableEvent = useCallback((layoutRacks, { rackCode, rackId, pduIp } = {}, hallPduList = []) => {
    if (!layoutRacks?.length) return null;
    let code = rackCode || rackId;
    if ((!code || code === 'Unknown') && pduIp) {
      const pdu = hallPduList.find((p) => p.ip === pduIp);
      code = pdu?.rack_code || pdu?.location || code;
    }
    return (
      layoutRacks.find((r) => (code && code !== 'Unknown' && (r.rackCode === code || r.id === code)))
      || layoutRacks.find((r) => pduIp && r.pdus?.some((p) => p.ip === pduIp))
      || null
    );
  }, []);

  const handleCloseRackPanel = useCallback(() => {
    setSelectedRack((rack) => {
      if (rack?.id) dismissedCableRackRef.current.add(rack.id);
      return null;
    });
  }, []);

  // Auto-open rack details when a cable-unplug warning appears (same moment as amber rack).
  useEffect(() => {
    if (!layout?.racks?.length) return;

    const outletWarnings = collectOutletCableWarnings(effectiveHallPDUs, pduAlarms, rackMetaByCode);
    const rackCableAlerts = (alerts || []).filter(isCableUnplugRackAlert);

    const currentKeys = new Set([
      ...outletWarnings.map((w) => w.id),
      ...rackCableAlerts.map(cableUnplugAlertKey),
    ]);

    for (const key of [...prevCableWarningIdsRef.current]) {
      if (!currentKeys.has(key)) {
        prevCableWarningIdsRef.current.delete(key);
        openedCableWarningIdsRef.current.delete(key);
      }
    }

    const activeRackIds = new Set();
    const resolveRack = (meta) => findRackForCableEvent(layout.racks, meta, effectiveHallPDUs);
    for (const w of outletWarnings) {
      const rack = resolveRack({ rackCode: w.rackCode, pduIp: w.pduIp });
      if (rack?.id) activeRackIds.add(rack.id);
    }
    for (const a of rackCableAlerts) {
      const rack = resolveRack({ rackId: a.rackId, pduIp: a.pduIp });
      if (rack?.id) activeRackIds.add(rack.id);
    }
    for (const rackId of [...dismissedCableRackRef.current]) {
      if (!activeRackIds.has(rackId)) dismissedCableRackRef.current.delete(rackId);
    }

    const pendingKeys = [...currentKeys].filter(
      (key) => !openedCableWarningIdsRef.current.has(key),
    );
    if (pendingKeys.length === 0) {
      prevCableWarningIdsRef.current = currentKeys;
      return;
    }

    const isNewKey = (key) => !prevCableWarningIdsRef.current.has(key);
    const pickWarning = outletWarnings.find((w) => pendingKeys.includes(w.id) && isNewKey(w.id))
      || outletWarnings.find((w) => pendingKeys.includes(w.id));
    const pickAlert = rackCableAlerts.find((a) => pendingKeys.includes(cableUnplugAlertKey(a)) && isNewKey(cableUnplugAlertKey(a)))
      || rackCableAlerts.find((a) => pendingKeys.includes(cableUnplugAlertKey(a)));

    prevCableWarningIdsRef.current = currentKeys;
    if (!pickWarning && !pickAlert) return;

    const rack = pickWarning
      ? resolveRack({ rackCode: pickWarning.rackCode, pduIp: pickWarning.pduIp })
      : resolveRack({ rackId: pickAlert.rackId, pduIp: pickAlert.pduIp });
    if (!rack || dismissedCableRackRef.current.has(rack.id)) return;

    setSelectedRack(rack);
    for (const key of pendingKeys) openedCableWarningIdsRef.current.add(key);
  }, [layout, alerts, effectiveHallPDUs, pduAlarms, rackMetaByCode, findRackForCableEvent, storedPdus]);

  const showCageMetrics = cagePulseOn && effectiveHallPDUs.length > 0;

  const toggleCagePulse = useCallback(() => {
    setCagePulseOn((on) => {
      const next = !on;
      const key = neuralMode ? 'pdumind_cage_pulse_switchboard' : 'pdumind_cage_pulse';
      localStorage.setItem(key, next ? '1' : '0');
      return next;
    });
  }, [neuralMode]);

  const toggleViewPan = useCallback(() => {
    setViewPanMode((on) => {
      const next = !on;
      localStorage.setItem('pdumind_view_pan', next ? '1' : '0');
      return next;
    });
  }, []);

  const resetViewOffset = useCallback(() => {
    setViewOffset({ x: 0, z: 0 });
    cageShiftApplied.current = false;
  }, []);

  useEffect(() => {
    if (showCageMetrics && !cageShiftApplied.current) {
      setViewOffset({ x: -5, z: 0 });
      cageShiftApplied.current = true;
    }
    if (!showCageMetrics) {
      cageShiftApplied.current = false;
    }
  }, [showCageMetrics]);

  // Show the "select a data hall" landing on first load (before any hall is
  // loaded) and whenever the 3D scene has nothing to render (no layout / zero
  // racks). This guarantees a friendly screen on page landing/refresh instead
  // of an empty blue canvas, until a real hall is loaded.
  const showLanding = !isLoading && (!hallId || !layout || (layout?.stats?.totalRacks ?? 0) === 0);

  // Switch to a hall (flush pending edits first, then load + notify parent).
  const selectHall = useCallback(async (id) => {
    if (!id || id === hallId) return;
    await flushSave();
    await loadHallState(id);
    if (onHallChange) onHallChange(id);
  }, [hallId, flushSave, loadHallState, onHallChange]);

  // ---- Scene props (cage entrances etc.) -----------------------------------
  const sceneObjects = config.sceneObjects || [];
  const objectsEditable = !readOnly && !neuralMode;

  const addSceneObject = useCallback((type, position) => {
    const catalog = SCENE_OBJECT_CATALOG.find(c => c.type === type) || SCENE_OBJECT_CATALOG[0];
    // Default drop point: center of the hall floor.
    const hall = layout?.hall || { length: config.hall.length, width: config.hall.width };
    const pos = position || { x: hall.length / 2, y: 0, z: hall.width / 2 };
    const newObj = {
      id: `obj-${Date.now()}-${Math.round(Math.random() * 1000)}`,
      type: catalog.type,
      label: catalog.label,
      position: { x: pos.x, y: pos.y || 0, z: pos.z },
      rotation: { x: 0, y: 0, z: 0 },
      scale: 1,
    };
    updateConfig('sceneObjects', [...sceneObjects, newObj]);
    setSelectedObjectId(newObj.id);
  }, [sceneObjects, updateConfig, layout, config.hall.length, config.hall.width]);

  const commitSceneObject = useCallback((id, patch) => {
    updateConfig('sceneObjects', sceneObjects.map(o => o.id === id ? { ...o, ...patch } : o));
  }, [sceneObjects, updateConfig]);

  const deleteSceneObject = useCallback((id) => {
    updateConfig('sceneObjects', sceneObjects.filter(o => o.id !== id));
    setSelectedObjectId(prev => prev === id ? null : prev);
  }, [sceneObjects, updateConfig]);

  // Compute a world position on the floor (y=0) from a screen drag-drop event.
  const screenToFloor = useCallback((clientX, clientY) => {
    const api = cameraApiRef.current;
    const wrap = canvasWrapRef.current;
    if (!api || !wrap) return null;
    const rect = wrap.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1
    );
    api.raycaster.setFromCamera(ndc, api.camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    const ok = api.raycaster.ray.intersectPlane(plane, hit);
    return ok ? { x: hit.x, y: 0, z: hit.z } : null;
  }, []);

  const handleCanvasDrop = useCallback((e) => {
    if (!objectsEditable) return;
    const type = e.dataTransfer.getData('application/x-scene-object');
    if (!type) return;
    e.preventDefault();
    const pos = screenToFloor(e.clientX, e.clientY);
    addSceneObject(type, pos);
  }, [objectsEditable, screenToFloor, addSceneObject]);
  
  return (
    <div className="flex flex-1 min-h-0 h-full bg-[#0B1120] relative">
      {/* Left Panel - Parameters (Collapsible) — hidden in read-only / neural mode */}
      {!readOnly && !neuralMode && (
      <div className={`${panelCollapsed ? 'w-0' : 'w-80'} border-r ${panelCollapsed ? 'border-transparent' : 'border-[#233544]'} bg-[#0B1120] transition-all duration-300 flex-shrink-0 relative overflow-hidden flex flex-col`}>
        <div className={`${panelCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'} transition-opacity duration-200 w-80 flex flex-col h-full`}>
          <div className="sticky top-0 z-20 bg-[#0B1120] px-4 pt-4 pb-2 border-b border-[#233544]">
            <h2 className="text-lg font-bold text-[#00E5FF] flex items-center gap-2">
              <span className="material-icons-outlined">tune</span>
              Parameters
            </h2>
          </div>
          <div className="flex-1 overflow-y-auto px-4 pb-4 pt-3">
        
        {/* Hall Manager */}
        <div className="mb-6 p-3 bg-[#161E2E] border border-[#233544] rounded-lg">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">
            Data Hall
          </h3>
          
          {/* Hall Selector */}
          <div className="flex gap-1 mb-3">
            <select
              value={hallId || ''}
              onChange={async (e) => {
                const newHallId = parseInt(e.target.value);
                if (newHallId && newHallId !== hallId) {
                  await flushSave();
                  await loadHallState(newHallId);
                  if (onHallChange) onHallChange(newHallId);
                }
              }}
              className="flex-1 bg-[#0B1120] border border-[#233544] rounded px-2 py-1.5 text-xs text-slate-300 font-mono focus:outline-none focus:border-[#00E5FF] min-w-0"
            >
              {halls.map(hall => (
                <option key={hall.id} value={hall.id}>{hall.name}</option>
              ))}
            </select>
            <button
              onClick={() => setShowNewHallDialog(true)}
              className="px-1.5 py-1.5 bg-[#00E5FF]/10 border border-[#00E5FF]/30 rounded text-[#00E5FF] hover:bg-[#00E5FF]/20 transition-colors"
              title="Create New Hall"
            >
              <span className="material-icons-outlined text-sm">add</span>
            </button>
            <button
              onClick={() => { setRenameValue(currentHall?.name || ''); setShowRenameDialog(true); }}
              className="px-1.5 py-1.5 bg-amber-500/10 border border-amber-500/30 rounded text-amber-400 hover:bg-amber-500/20 transition-colors"
              title="Rename Hall"
              disabled={!hallId}
            >
              <span className="material-icons-outlined text-sm">edit</span>
            </button>
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="px-1.5 py-1.5 bg-red-500/10 border border-red-500/30 rounded text-red-400 hover:bg-red-500/20 transition-colors"
              title="Delete Hall"
              disabled={!hallId}
            >
              <span className="material-icons-outlined text-sm">delete</span>
            </button>
          </div>
          
          {/* Current Hall Info */}
          {currentHall && (
            <div className="text-[10px] text-slate-500">
              <span className="text-slate-400">ID:</span> {currentHall.id} &nbsp;|&nbsp;
              <span className="text-slate-400">Created:</span> {new Date(currentHall.created_at).toLocaleDateString()}
            </div>
          )}
          
          {/* Rename Dialog */}
          {showRenameDialog && (
            <div className="mt-2 mb-3 p-3 bg-amber-500/5 border border-amber-500/30 rounded-lg">
              <p className="text-xs font-bold text-amber-400 mb-2">Rename Hall</p>
              <input
                type="text"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                className="w-full bg-[#0B1120] border border-[#233544] rounded px-2 py-1.5 text-xs text-slate-300 font-mono mb-2 focus:outline-none focus:border-amber-500"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && renameValue.trim()) {
                    renameHall(hallId, renameValue.trim());
                    setShowRenameDialog(false);
                  } else if (e.key === 'Escape') {
                    setShowRenameDialog(false);
                  }
                }}
              />
              <div className="flex gap-2">
                <button
                  onClick={() => { renameHall(hallId, renameValue.trim()); setShowRenameDialog(false); }}
                  disabled={!renameValue.trim()}
                  className="flex-1 px-2 py-1 bg-amber-500/20 border border-amber-500/50 rounded text-xs text-amber-400 hover:bg-amber-500/30 disabled:opacity-50"
                >
                  Rename
                </button>
                <button
                  onClick={() => setShowRenameDialog(false)}
                  className="px-2 py-1 bg-slate-500/20 border border-slate-500/30 rounded text-xs text-slate-400 hover:bg-slate-500/30"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
          
          {/* Delete Confirmation */}
          {showDeleteConfirm && (
            <div className="mt-2 mb-3 p-3 bg-red-500/5 border border-red-500/30 rounded-lg">
              <p className="text-xs font-bold text-red-400 mb-1">Delete "{currentHall?.name}"?</p>
              <p className="text-[10px] text-slate-500 mb-3">
                This will permanently remove the hall, all its racks, PDU assignments, and configuration history.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => { deleteHall(hallId); setShowDeleteConfirm(false); }}
                  className="flex-1 px-2 py-1 bg-red-500/20 border border-red-500/50 rounded text-xs text-red-400 hover:bg-red-500/30 font-bold"
                >
                  Delete Forever
                </button>
                <button
                  onClick={() => setShowDeleteConfirm(false)}
                  className="px-2 py-1 bg-slate-500/20 border border-slate-500/30 rounded text-xs text-slate-400 hover:bg-slate-500/30"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
        
        {/* New Hall Dialog */}
        {showNewHallDialog && (
          <div className="mb-4 p-3 bg-[#00E5FF]/5 border border-[#00E5FF]/30 rounded-lg">
            <p className="text-xs font-bold text-[#00E5FF] mb-2">Create New Data Hall</p>
            <input
              type="text"
              value={newHallName}
              onChange={(e) => setNewHallName(e.target.value)}
              placeholder="Enter hall name..."
              className="w-full bg-[#0B1120] border border-[#233544] rounded px-2 py-1.5 text-xs text-slate-300 font-mono mb-2 focus:outline-none focus:border-[#00E5FF]"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newHallName.trim()) {
                  createHall(newHallName.trim());
                  setNewHallName('');
                  setShowNewHallDialog(false);
                } else if (e.key === 'Escape') {
                  setShowNewHallDialog(false);
                  setNewHallName('');
                }
              }}
            />
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (newHallName.trim()) {
                    createHall(newHallName.trim());
                    setNewHallName('');
                    setShowNewHallDialog(false);
                  }
                }}
                disabled={!newHallName.trim()}
                className="flex-1 px-2 py-1 bg-[#00E5FF]/20 border border-[#00E5FF]/50 rounded text-xs text-[#00E5FF] hover:bg-[#00E5FF]/30 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create
              </button>
              <button
                onClick={() => {
                  setShowNewHallDialog(false);
                  setNewHallName('');
                }}
                className="px-2 py-1 bg-slate-500/20 border border-slate-500/30 rounded text-xs text-slate-400 hover:bg-slate-500/30"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        
        {/* Validation Errors */}
        {layoutResult.errors?.length > 0 && (
          <div className="mb-4 p-3 bg-red-500/10 border border-red-500/30 rounded-lg">
            <p className="text-xs font-bold text-red-400 mb-2">Validation Errors</p>
            {layoutResult.errors.map((err, i) => (
              <p key={i} className="text-xs text-red-300">{err.message}</p>
            ))}
          </div>
        )}
        
        {/* Warnings */}
        {layoutResult.warnings?.length > 0 && (
          <div className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
            <p className="text-xs font-bold text-amber-400 mb-2">Warnings</p>
            {layoutResult.warnings.map((warn, i) => (
              <p key={i} className="text-xs text-amber-300">{warn.message}</p>
            ))}
          </div>
        )}
        
        {/* Accordion Sections */}
        {[
          { id: 'dimensions', title: 'Data Hall Dimensions', icon: 'straighten', content: (
            <>
              <ParamInput label="Length" value={config.hall.length} onChange={(v) => updateConfig('hall.length', v)} min={5} max={100} step={1} unit="m" />
              <ParamInput label="Width" value={config.hall.width} onChange={(v) => updateConfig('hall.width', v)} min={5} max={50} step={1} unit="m" />
              <ParamInput label="Height" value={config.hall.height} onChange={(v) => updateConfig('hall.height', v)} min={2.5} max={10} step={0.1} unit="m" />
              <ParamInput label="Floor Tile Size" value={config.hall.floorTileSize} onChange={(v) => updateConfig('hall.floorTileSize', v)} min={0.3} max={1} step={0.1} unit="m" />
            </>
          )},
          { id: 'layout', title: 'Layout Configuration', icon: 'grid_view', content: (
            <>
              <ParamInput label="Number of Rows" value={config.layout.numberOfRows} onChange={(v) => updateConfig('layout.numberOfRows', v)} min={1} max={20} step={1} />
              <ParamInput label="Racks per Row" value={config.layout.racksPerRow} onChange={(v) => updateConfig('layout.racksPerRow', v)} min={1} max={30} step={1} />
              <ParamSelect label="Row Orientation" value={config.layout.rowOrientation} onChange={(v) => updateConfig('layout.rowOrientation', v)} options={[{ value: 'lengthwise', label: 'Lengthwise' }, { value: 'widthwise', label: 'Widthwise' }]} />
              <ParamInput label="Aisle Width" value={config.layout.aisleWidth} onChange={(v) => updateConfig('layout.aisleWidth', v)} min={0.6} max={3} step={0.1} unit="m" />
              <ParamInput label="Wall Clearance" value={config.layout.wallClearance} onChange={(v) => updateConfig('layout.wallClearance', v)} min={0.5} max={5} step={0.1} unit="m" />
            </>
          )},
          { id: 'rack', title: 'Rack Specifications', icon: 'dns', content: (
            <>
              <ParamInput label="Width" value={config.rack.width} onChange={(v) => updateConfig('rack.width', v)} min={400} max={800} step={50} unit="mm" />
              <ParamInput label="Depth" value={config.rack.depth} onChange={(v) => updateConfig('rack.depth', v)} min={600} max={1200} step={50} unit="mm" />
              <ParamInput label="Height" value={config.rack.heightU} onChange={(v) => updateConfig('rack.heightU', v)} min={12} max={52} step={1} unit="U" />
            </>
          )},
          { id: 'pdu', title: 'PDU Configuration', icon: 'electrical_services', content: (
            <>
              <ParamInput label="PDUs per Rack" value={config.pdu.pdusPerRack} onChange={(v) => updateConfig('pdu.pdusPerRack', v)} min={0} max={4} step={1} />
              <ParamSelect label="Mounting" value={config.pdu.mounting} onChange={(v) => updateConfig('pdu.mounting', v)} options={[{ value: 'A/B', label: 'A / B' }, { value: 'Left/Right', label: 'Left / Right' }]} />
            </>
          )},
          { id: 'ip', title: 'IP Planning', icon: 'lan', content: (
            <>
              <div className="flex items-center justify-between py-2 border-b border-[#233544]">
                <label className="text-xs text-slate-400">Subnet</label>
                <input type="text" value={config.ipPlanning.subnet} onChange={(e) => updateConfig('ipPlanning.subnet', e.target.value)} className="w-32 bg-[#0B1120] border border-[#233544] rounded px-2 py-1 text-sm font-mono text-white text-right focus:border-[#00E5FF] focus:outline-none" />
              </div>
              <ParamSelect label="Assignment" value={config.ipPlanning.assignmentStrategy} onChange={(v) => updateConfig('ipPlanning.assignmentStrategy', v)} options={[{ value: 'sequential', label: 'Sequential' }, { value: 'perRowBlock', label: 'Per Row Block' }]} />
            </>
          )},
          { id: 'view', title: 'View Options', icon: 'visibility', panel: 'view', content: (
            <div className="flex items-center justify-between py-2 border-b border-[#233544]">
              <label className="text-xs text-slate-400">Show Rack Labels</label>
              <button onClick={() => setShowLabels(!showLabels)} className={`w-12 h-6 rounded-full transition-all ${showLabels ? 'bg-[#00E5FF]' : 'bg-[#233544]'} relative`}>
                <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${showLabels ? 'right-1' : 'left-1'}`}></span>
              </button>
            </div>
          )},
          ...(objectsEditable ? [{ id: 'sceneObjects', title: 'Scene Objects', icon: 'category', panel: 'view', content: (
            <>
              <div className="space-y-1.5">
                {SCENE_OBJECT_CATALOG.map(item => (
                  <div
                    key={item.type}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('application/x-scene-object', item.type);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onDoubleClick={() => addSceneObject(item.type)}
                    className="group flex items-center gap-2 px-2 py-2 bg-[#0B1120] border border-[#233544] rounded-lg cursor-grab active:cursor-grabbing hover:border-[#00E5FF]/60 hover:bg-[#00E5FF]/5 transition-all"
                    title="Drag onto the 3D floor (or double-click to add at center)"
                  >
                    <span className="material-icons-outlined text-[#00E5FF] text-lg">{item.icon}</span>
                    <span className="text-xs text-slate-300 flex-1">{item.label}</span>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); addSceneObject(item.type); }}
                      className="opacity-0 group-hover:opacity-100 text-[#00E5FF] hover:text-white transition-all"
                      title="Add to center"
                    >
                      <span className="material-icons-outlined text-sm">add_circle</span>
                    </button>
                  </div>
                ))}
                <p className="text-[9px] text-slate-600 px-1 leading-tight">
                  Drag onto the floor, or double-click. Click a placed object to move / rotate it.
                </p>
              </div>
              {sceneObjects.length > 0 && (
                <div className="mt-2 pt-2 border-t border-[#233544] max-h-40 overflow-y-auto space-y-1">
                  {sceneObjects.map(obj => (
                    <div
                      key={obj.id}
                      onClick={() => setSelectedObjectId(obj.id)}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-all ${
                        selectedObjectId === obj.id
                          ? 'bg-[#00E5FF]/15 border border-[#00E5FF]/50'
                          : 'bg-[#0B1120] border border-transparent hover:border-[#233544]'
                      }`}
                    >
                      <span className="material-icons-outlined text-slate-400 text-sm">meeting_room</span>
                      <span className="text-[11px] text-slate-300 flex-1 truncate">{obj.label}</span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); deleteSceneObject(obj.id); }}
                        className="text-red-400 hover:text-red-300"
                        title="Remove object"
                      >
                        <span className="material-icons-outlined text-sm">delete</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}] : []),
        ].map(section => (
          <AccordionSection key={section.id} id={section.id} title={section.title} icon={section.icon} defaultOpen={section.defaultOpen}>
            {section.content}
          </AccordionSection>
        ))}
        
        {/* Stats */}
        {layout && (
          <div className="mt-6 p-4 bg-[#161E2E] rounded-lg border border-[#233544]">
            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">
              Layout Statistics
            </h3>
            <div className="grid grid-cols-2 gap-3 text-xs font-mono">
              <div>
                <p className="text-slate-500">Total Racks</p>
                <p className="text-xl font-bold text-[#00E5FF]">{layout.stats.totalRacks}</p>
              </div>
              <div>
                <p className="text-slate-500">Total PDUs</p>
                <p className="text-xl font-bold text-[#00E5FF]">{layout.stats.totalPDUs}</p>
              </div>
              <div>
                <p className="text-slate-500">Rows</p>
                <p className="text-lg font-bold text-white">{layout.stats.totalRows}</p>
              </div>
              <div>
                <p className="text-slate-500">Floor Area</p>
                <p className="text-lg font-bold text-white">{layout.stats.totalFloorArea}m²</p>
              </div>
            </div>
          </div>
        )}
        
        {/* Media Section - Custom Rack Model */}
        <div className="mt-6 p-4 bg-[#161E2E] rounded-lg border border-[#233544]">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
            <span className="material-icons-outlined text-sm">view_in_ar</span>
            Custom Rack Model
          </h3>
          
          {config.rackModel?.name ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between p-2 bg-[#0B1120] rounded border border-[#233544]">
                <div className="flex items-center gap-2">
                  <span className="material-icons-outlined text-[#00E5FF] text-sm">check_circle</span>
                  <span className="text-xs text-slate-300 font-mono">{config.rackModel.name}</span>
                </div>
                <button
                  onClick={() => updateConfig('rackModel', null)}
                  className="text-red-400 hover:text-red-300 transition-colors"
                  title="Remove model"
                >
                  <span className="material-icons-outlined text-sm">delete</span>
                </button>
              </div>
              <p className="text-[9px] text-slate-500">Custom 3D model will be used for all racks</p>
            </div>
          ) : (
            <div className="space-y-3">
              <input
                type="text"
                placeholder="Model name..."
                id="rackModelName"
                className="w-full bg-[#0B1120] border border-[#233544] rounded px-3 py-2 text-xs text-slate-300 font-mono focus:outline-none focus:border-[#00E5FF]"
              />
              {/* GLB Upload (single file - recommended) */}
              <label className="flex items-center justify-center gap-2 w-full py-3 bg-[#0B1120] border border-dashed border-[#233544] rounded-lg cursor-pointer hover:border-[#00E5FF] hover:bg-[#00E5FF]/5 transition-all">
                <input
                  type="file"
                  accept=".glb"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    const nameInput = document.getElementById('rackModelName');
                    const modelName = nameInput?.value || file?.name?.replace(/\.glb$/i, '') || 'Custom Rack';
                    if (file) {
                      // Upload to server for persistent storage
                      const formData = new FormData();
                      formData.append('file', file);
                      try {
                        const response = await fetch('/api/models/upload', {
                          method: 'POST',
                          body: formData
                        });
                        const result = await response.json();
                        if (result.success) {
                          updateConfig('rackModel', {
                            name: modelName,
                            url: result.url,
                            fileName: result.fileName,
                            type: 'glb'
                          });
                        } else {
                          console.error('Upload failed:', result.error);
                          alert('Failed to upload model: ' + result.error);
                        }
                      } catch (err) {
                        console.error('Upload error:', err);
                        alert('Failed to upload model');
                      }
                    }
                  }}
                />
                <span className="material-icons-outlined text-[#00E5FF] text-lg">upload_file</span>
                <span className="text-xs text-slate-400">Upload <span className="text-[#00E5FF] font-bold">.GLB</span> file (recommended)</span>
              </label>
              
              {/* Folder Upload (gltf + bin + textures) */}
              <label className="flex items-center justify-center gap-2 w-full py-2 bg-[#0B1120] border border-dashed border-[#233544] rounded-lg cursor-pointer hover:border-slate-500 transition-all">
                <input
                  type="file"
                  webkitdirectory=""
                  directory=""
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    const gltfFile = files.find(f => f.name.endsWith('.gltf'));
                    if (!gltfFile) {
                      alert('No .gltf file found in folder. Please select a folder containing a .gltf file.');
                      return;
                    }
                    
                    const nameInput = document.getElementById('rackModelName');
                    const modelName = nameInput?.value || gltfFile.name.replace(/\.gltf$/i, '') || 'Custom Rack';
                    
                    // Create object URLs for all files, preserving folder structure
                    const fileUrls = {};
                    files.forEach(file => {
                      // Use webkitRelativePath for subfolder files (e.g., textures/image.png)
                      const relativePath = file.webkitRelativePath;
                      const pathParts = relativePath.split('/');
                      // Remove the root folder name, keep rest of path
                      const fileKey = pathParts.slice(1).join('/') || file.name;
                      fileUrls[fileKey] = URL.createObjectURL(file);
                      // Also add just the filename for direct matches
                      fileUrls[file.name] = URL.createObjectURL(file);
                    });
                    
                    updateConfig('rackModel', {
                      name: modelName,
                      url: fileUrls[gltfFile.name],
                      fileName: gltfFile.name,
                      type: 'gltf',
                      assets: fileUrls
                    });
                  }}
                />
                <span className="material-icons-outlined text-slate-600 text-sm">folder_open</span>
                <span className="text-[10px] text-slate-600">Or select entire model folder</span>
              </label>
              <p className="text-[9px] text-slate-600 text-center mt-1">
                <span className="text-[#00E5FF]">GLB recommended</span> - single file with textures bundled
              </p>
            </div>
          )}
        </div>

        {/* MIB File Upload Section */}
        <div className="border-t border-[#233544] pt-4">
          <h3 className="text-xs font-semibold text-[#00E5FF] uppercase tracking-wider mb-3 flex items-center gap-2">
            <span className="material-icons-outlined text-sm">description</span>
            MIB Configuration
          </h3>
          
          <MibDropZone hallId={hallId} />
        </div>
        </div>
        </div>
      </div>
      )}

      {/* Collapse Toggle Button */}
      {!readOnly && !neuralMode && (
      <button
        onClick={() => setPanelCollapsed(!panelCollapsed)}
        className={`flex-shrink-0 w-5 h-10 bg-[#161E2E] border-y border-r border-[#00E5FF]/30 rounded-r flex items-center justify-center hover:bg-[#233544] transition-colors self-center -ml-px`}
      >
        <span className={`material-icons-outlined text-[#00E5FF] text-sm transition-transform duration-300 ${panelCollapsed ? '' : 'rotate-180'}`}>
          chevron_right
        </span>
      </button>
      )}
      
      {/* Right Panel - 3D View + footer controls */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0 overflow-hidden" style={{ isolation: 'isolate' }}>
        <div className="relative flex-1 min-h-0 min-w-0 w-full">
        <div
          ref={canvasWrapRef}
          className="absolute inset-0 overflow-hidden"
          onDragOver={(e) => { if (objectsEditable) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } }}
          onDrop={handleCanvasDrop}
        >
        <Canvas
          // Stable key — never remount on mode/full-bleed change. Remounting
          // tears down & recreates the WebGL context ("Context Lost" → blue
          // canvas). FitCanvas resizes the GL buffer in place when the layout
          // (neural / full-bleed / ops panel) flips.
          key={`dh-canvas-${glEpoch}`}
          camera={{ position: [15, 12, 15], fov: 50 }}
          // 'default' (not 'high-performance') avoids the discrete-GPU switch on
          // dual-GPU MacBooks, which is a common trigger of spurious context loss.
          gl={{ antialias: true, powerPreference: 'default', preserveDrawingBuffer: false }}
          resize={{ scroll: false, debounce: 0, offsetSize: true }}
          style={{ background: '#0a1520', display: 'block', width: '100%', height: '100%' }}
          className="!block !h-full !w-full"
          onPointerMissed={() => { setHoveredRack(null); setSelectedObjectId(null); }}
          onCreated={({ gl, invalidate, setSize }) => {
            const canvasEl = gl.domElement;
            const wrap = canvasWrapRef.current;
            if (wrap && wrap.clientWidth > 8 && wrap.clientHeight > 8) {
              setSize(wrap.clientWidth, wrap.clientHeight);
              invalidate();
            }
            if (glRestoreTimer.current) { clearTimeout(glRestoreTimer.current); glRestoreTimer.current = null; }
            // If this context survives a few seconds, treat recovery as successful
            // and reset the retry budget for any future (unrelated) loss.
            setTimeout(() => { glAttempts.current = 0; }, 5000);
            // On context loss, give the browser a brief window to auto-restore.
            // If it doesn't, force a fresh <Canvas> (new context) so the user is
            // never stuck on a dead/blank canvas.
            canvasEl.addEventListener('webglcontextlost', (e) => {
              e.preventDefault();
              console.warn('[DataHallDesigner] WebGL context lost — attempting recovery');
              if (glRestoreTimer.current) clearTimeout(glRestoreTimer.current);
              glRestoreTimer.current = setTimeout(() => {
                if (glAttempts.current >= 5) {
                  console.error('[DataHallDesigner] WebGL context cannot be restored after repeated attempts');
                  return;
                }
                glAttempts.current += 1;
                console.warn('[DataHallDesigner] No auto-restore — remounting canvas (attempt', glAttempts.current, ')');
                setGlEpoch((n) => n + 1);
              }, 1200);
            }, false);
            canvasEl.addEventListener('webglcontextrestored', () => {
              console.info('[DataHallDesigner] WebGL context restored');
              if (glRestoreTimer.current) { clearTimeout(glRestoreTimer.current); glRestoreTimer.current = null; }
              invalidate();
            }, false);
          }}
        >
          <FitCanvas wrapRef={canvasWrapRef} layoutEpoch={`${neuralMode ? 1 : 0}-${fullBleed ? 1 : 0}-${glEpoch}`} />
          <Suspense fallback={null}>
            <DataHallScene
              layout={layout}
              selectedRack={selectedRack}
              hoveredRack={hoveredRack}
              alerts={alerts}
              showLabels={showLabels}
              onSelectRack={setSelectedRack}
              onHoverRack={setHoveredRack}
              customRackModelUrl={config.rackModel?.url}
              customRackModelAssets={config.rackModel?.assets}
              lighting={lighting}
              heatmapByRack={heatmapByRack}
              pduLiveStatus={pduLiveStatus}
              sceneObjects={sceneObjects}
              selectedObjectId={selectedObjectId}
              onSelectObject={setSelectedObjectId}
              onCommitObject={commitSceneObject}
              transformMode={transformMode}
              objectsEditable={objectsEditable}
              cameraApiRef={cameraApiRef}
              viewOffset={viewOffset}
              viewPanMode={viewPanMode}
            />
          </Suspense>
        </Canvas>

        {/* Empty-state landing — Hyperspace-style portal + data hall picker */}
        {showLanding && (
          <div
            className="absolute inset-0 z-20 flex flex-col items-center justify-center px-6 overflow-y-auto"
            style={{
              background: 'radial-gradient(circle at 50% 42%, rgba(0,229,255,0.10), rgba(10,21,32,0.96) 60%, #0a1520 100%)',
            }}
          >
            {/* Hyperspace portal emblem */}
            <div className="relative mb-7 flex items-center justify-center" style={{ width: 150, height: 150 }}>
              <div className="absolute inset-0 rounded-full" style={{ boxShadow: '0 0 80px 10px rgba(0,229,255,0.25)' }} />
              <svg viewBox="0 0 200 200" width="150" height="150" className="relative">
                <defs>
                  <radialGradient id="hsCore" cx="50%" cy="50%" r="50%">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="1" />
                    <stop offset="45%" stopColor="#9beaf6" stopOpacity="0.9" />
                    <stop offset="100%" stopColor="#00E5FF" stopOpacity="0" />
                  </radialGradient>
                </defs>
                {/* Radiating warp lines */}
                {Array.from({ length: 30 }).map((_, i) => {
                  const a = (i / 30) * Math.PI * 2;
                  const r1 = 36 + (i % 3) * 4;
                  const r2 = 92 - (i % 4) * 6;
                  const op = 0.25 + (i % 5) * 0.13;
                  return (
                    <line
                      key={i}
                      x1={100 + Math.cos(a) * r1}
                      y1={100 + Math.sin(a) * r1}
                      x2={100 + Math.cos(a) * r2}
                      y2={100 + Math.sin(a) * r2}
                      stroke="#ffffff"
                      strokeOpacity={op}
                      strokeWidth={1}
                      strokeLinecap="round"
                    />
                  );
                })}
                {/* Portal rings */}
                <circle cx="100" cy="100" r="58" fill="none" stroke="#ffffff" strokeOpacity="0.18" strokeWidth="1" />
                <circle cx="100" cy="100" r="34" fill="none" stroke="#00E5FF" strokeOpacity="0.55" strokeWidth="1.5" />
                {/* Glowing core */}
                <circle cx="100" cy="100" r="22" fill="url(#hsCore)" className="animate-pulse" />
              </svg>
            </div>

            <h2 className="text-2xl font-bold text-white tracking-tight mb-1.5 text-center">
              Select your Data Hall
            </h2>
            <p className="text-sm text-slate-400 mb-7 text-center max-w-md">
              Choose a data center below to load its 3D layout, or configure this hall's rows and racks to populate the scene.
            </p>

            {/* Hall picker */}
            <div className="w-full max-w-2xl">
              {halls.length > 0 ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {halls.map((hall) => {
                    const active = hall.id === hallId;
                    return (
                      <button
                        key={hall.id}
                        onClick={() => selectHall(hall.id)}
                        className={`group text-left rounded-xl border px-4 py-3.5 transition-all backdrop-blur-sm ${
                          active
                            ? 'border-[#00E5FF]/70 bg-[#00E5FF]/10 shadow-[0_0_24px_rgba(0,229,255,0.18)]'
                            : 'border-[#233544] bg-[#161E2E]/70 hover:border-[#00E5FF]/50 hover:bg-[#00E5FF]/5'
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <span className={`material-icons-outlined text-xl ${active ? 'text-[#00E5FF]' : 'text-slate-400 group-hover:text-[#00E5FF]'}`}>
                            dns
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-bold text-white truncate flex items-center gap-2">
                              {hall.name}
                              {active && <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-[#00E5FF]/15 text-[#00E5FF]">SELECTED</span>}
                            </div>
                            <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                              ID {hall.id}{hall.created_at ? ` • ${new Date(hall.created_at).toLocaleDateString()}` : ''}
                            </div>
                          </div>
                          <span className="material-icons-outlined text-slate-600 group-hover:text-[#00E5FF] transition-colors">chevron_right</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center text-slate-500 text-sm py-6">
                  No data halls yet.
                </div>
              )}

              {!readOnly && (
                <div className="mt-5 flex justify-center">
                  <button
                    onClick={() => { setPanelCollapsed(false); setShowNewHallDialog(true); }}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[#00E5FF]/10 border border-[#00E5FF]/40 text-[#00E5FF] text-sm font-medium hover:bg-[#00E5FF]/20 transition-all"
                  >
                    <span className="material-icons-outlined text-base">add</span>
                    New Data Hall
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Cage-level metrics dashboard (consolidated PDU telemetry) */}
        {showCageMetrics && !showLanding && (
          <CageMetricsOverlay
            hallPDUs={effectiveHallPDUs}
            pduLiveStatus={pduLiveStatus}
            pduAlarms={pduAlarms}
            pduEnv={pduEnv}
            fleetPduResults={fleetPduResults}
            rackMetaByCode={rackMetaByCode}
            hallName={currentHall?.name}
            compact={neuralMode}
          />
        )}

        {/* Rack Details Panel */}
        <RackDetailsPanel 
          rack={selectedRack} 
          alerts={alerts} 
          onClose={handleCloseRackPanel}
          onPduClick={(pdu) => onNavigateToPdu && onNavigateToPdu(pdu)}
          onSaveLabel={saveRackLabel}
          readOnly={readOnly}
        />
        
        {/* Alert / Heatmap Legend */}
        <div className="absolute z-20 top-4 left-4 bg-[#161E2E]/90 border border-[#233544] rounded-lg px-4 py-3">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">
            {readOnly ? 'Load Heatmap' : 'Status Legend'}
          </p>
          <div className="flex flex-col gap-2 text-[10px] font-mono">
            {readOnly ? (
              <>
                <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-[#22C55E]"></span><span className="text-emerald-400">Low load</span></div>
                <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-[#F59E0B]"></span><span className="text-amber-400">Medium</span></div>
                <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-[#F97316]"></span><span className="text-orange-400">High</span></div>
                <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-[#EF4444]"></span><span className="text-red-400">Critical / Alarm</span></div>
                <div className="flex items-center gap-2"><span className="w-3 h-3 rounded bg-[#475569]"></span><span className="text-slate-500">Offline</span></div>
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded bg-[#2D4A5E]"></span>
                  <span className="text-slate-400">Normal</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded bg-[#F59E0B]"></span>
                  <span className="text-amber-400">Warning</span>
                  <span className="text-slate-500">({alerts.filter(a => a.severity === 'warning').length})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded bg-[#EF4444]"></span>
                  <span className="text-red-400">Critical</span>
                  <span className="text-slate-500">({alerts.filter(a => a.severity === 'critical').length})</span>
                </div>
              </>
            )}
          </div>
        </div>
        
        {/* Save status — only while loading/saving (avoids Cage Pulse overlap) */}
        {!readOnly && (isLoading || isSaving) && (
          <div className="absolute bottom-12 left-4 z-20 bg-[#0c1018]/90 border border-white/[0.08] rounded-lg px-3 py-2 text-[10px] font-mono">
            {currentHall && (
              <div className="text-white/80 font-semibold mb-0.5 truncate max-w-[140px]">{currentHall.name}</div>
            )}
            {isLoading ? (
              <span className="text-[#8A929B] flex items-center gap-1">
                <span className="animate-pulse">●</span> Loading…
              </span>
            ) : (
              <span className="text-amber-400/90 flex items-center gap-1">
                <span className="animate-spin">⟳</span> Saving…
              </span>
            )}
          </div>
        )}
        
        {/* Sticky canvas footer — nav hints | mode toggle (center) | lighting */}
        {/* Mode toggle — centered over canvas, original pill style (no fascia) */}
        {showNeuralToggle && (
          <div className="absolute bottom-12 left-1/2 -translate-x-1/2 z-30 pointer-events-auto">
            <div className="flex items-center bg-[#161E2E]/95 border border-[#233544] rounded-full p-1 shadow-xl backdrop-blur-sm">
              <button
                type="button"
                onClick={() => onNeuralOpsChange?.(false)}
                className={`px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all whitespace-nowrap ${
                  !neuralOpsEnabled
                    ? 'bg-[#233544] text-white'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Stencil
              </button>
              <button
                type="button"
                onClick={() => onNeuralOpsChange?.(true)}
                className={`px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 whitespace-nowrap ${
                  neuralOpsEnabled
                    ? 'bg-gradient-to-r from-[#00E5FF]/30 to-purple-500/30 text-[#00E5FF] border border-[#00E5FF]/40'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <span className="material-icons-outlined text-sm">dashboard</span>
                Switchboard
              </button>
            </div>
          </div>
        )}

        {/* Enhanced Rack Telemetry Tooltip */}
        {hoveredRack && !selectedRack && (
          <RackTelemetryTooltip rack={hoveredRack} />
        )}

        {/* Selected-object transform toolbar (move / rotate / delete) */}
        {objectsEditable && selectedObjectId && (
          <div className="absolute top-1/2 left-4 -translate-y-1/2 z-30 flex flex-col gap-1 bg-[#161E2E]/95 border border-[#233544] rounded-xl p-1.5 shadow-2xl backdrop-blur-sm">
            <button
              onClick={() => setTransformMode('translate')}
              className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
                transformMode === 'translate' ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'text-slate-400 hover:bg-[#233544]'
              }`}
              title="Move (drag on floor)"
            >
              <span className="material-icons-outlined text-lg">open_with</span>
            </button>
            <button
              onClick={() => setTransformMode('rotate')}
              className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
                transformMode === 'rotate' ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'text-slate-400 hover:bg-[#233544]'
              }`}
              title="Rotate"
            >
              <span className="material-icons-outlined text-lg">rotate_right</span>
            </button>
            <button
              onClick={() => setTransformMode('scale')}
              className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all ${
                transformMode === 'scale' ? 'bg-[#00E5FF]/20 text-[#00E5FF]' : 'text-slate-400 hover:bg-[#233544]'
              }`}
              title="Resize"
            >
              <span className="material-icons-outlined text-lg">aspect_ratio</span>
            </button>
            <div className="h-px bg-[#233544] mx-1" />
            <button
              onClick={() => deleteSceneObject(selectedObjectId)}
              className="w-9 h-9 rounded-lg flex items-center justify-center text-red-400 hover:bg-red-500/20 transition-all"
              title="Delete object"
            >
              <span className="material-icons-outlined text-lg">delete</span>
            </button>
          </div>
        )}
        </div>
        </div>

        {/* Dedicated footer bar — controls only, not overlaid on toggle */}
        <div className="relative flex-shrink-0 h-10 border-t border-[#233544]/70 bg-[#0a1520] flex items-center justify-between px-4 z-20">
          <div className="flex items-center gap-4 text-[10px] font-mono text-slate-500">
            {viewPanMode ? (
              <>
                <span>↔️ Pan: Drag</span>
                <span className="hidden sm:inline">🔄 Rotate: Right-drag</span>
              </>
            ) : (
              <>
                <span>🖱️ Orbit: Drag</span>
                <span className="hidden sm:inline">⚙️ Pan: Right-drag</span>
              </>
            )}
            <span>🔍 Zoom: Scroll</span>
            {(viewOffset.x !== 0 || viewOffset.z !== 0) && (
              <button
                type="button"
                onClick={resetViewOffset}
                className="text-[#8A929B] hover:text-white transition-colors uppercase tracking-wider"
              >
                Reset view
              </button>
            )}
          </div>

          {/* Footer pill toggles — Hyperspace style (Cage Pulse, Lighting, Integrations) */}
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center bg-[#161E2E]/95 border border-[#233544] rounded-full p-1 shadow-xl backdrop-blur-sm">
            <button
              type="button"
              onClick={toggleCagePulse}
              disabled={effectiveHallPDUs.length === 0}
              className={`px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 whitespace-nowrap disabled:opacity-40 ${
                showCageMetrics
                  ? 'bg-[#233544] text-white'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
              title={effectiveHallPDUs.length === 0 ? 'Commission PDUs to enable cage metrics' : 'Cage-level PDU metrics'}
            >
              <span className="material-icons-outlined text-sm">monitoring</span>
              Cage Pulse
            </button>
            <button
              type="button"
              onClick={async () => {
                const metrics = aggregateCageMetrics(
                  effectiveHallPDUs,
                  pduLiveStatus,
                  pduAlarms,
                  pduEnv,
                  fleetPduResults,
                );
                try {
                  await downloadHallCustomerReport({
                    hallName: currentHall?.name || 'Data hall',
                    metrics,
                    cableWarnings: collectOutletCableWarnings(effectiveHallPDUs, pduAlarms, rackMetaByCode),
                  });
                } catch (err) {
                  console.error('Hall report PDF failed', err);
                }
              }}
              disabled={effectiveHallPDUs.length === 0}
              className="px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 whitespace-nowrap text-slate-500 hover:text-slate-300 disabled:opacity-40"
              title={effectiveHallPDUs.length === 0 ? 'Commission PDUs to download a hall report' : 'Download customer hall report'}
            >
              <span className="material-icons-outlined text-sm">download</span>
              Report
            </button>
            <button
              type="button"
              onClick={toggleViewPan}
              className={`px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 whitespace-nowrap ${
                viewPanMode
                  ? 'bg-[#233544] text-white'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
              title="Drag to pan the 3D view — useful when Cage Pulse covers racks"
            >
              <span className="material-icons-outlined text-sm">open_with</span>
              Shift View
            </button>
            {neuralMode && onToggleOpsPanel && (
              <button
                type="button"
                onClick={onToggleOpsPanel}
                className={`px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 whitespace-nowrap ${
                  opsPanelOpen
                    ? 'bg-[#233544] text-white'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
                title="Alerts, environment & attention queue"
              >
                <span className="material-icons-outlined text-sm">dashboard</span>
                Ops Panel
              </button>
            )}
            {!readOnly && (
              <button
                type="button"
                onClick={() => setShowLabels(!showLabels)}
                className={`px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 whitespace-nowrap ${
                  showLabels
                    ? 'bg-[#233544] text-white'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <span className="material-icons-outlined text-sm">label</span>
                Labels
              </button>
            )}
            {!readOnly && !neuralMode && (
              <button
                type="button"
                onClick={() => setShowLightingPanel(!showLightingPanel)}
                className={`px-4 py-2 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all flex items-center gap-1.5 whitespace-nowrap ${
                  showLightingPanel
                    ? 'bg-[#233544] text-white'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                <span className="material-icons-outlined text-sm">light_mode</span>
                Lighting
              </button>
            )}
          </div>

          {!readOnly && !neuralMode && showIntegrationsGear && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onOpenIntegrations?.()}
                className="flex items-center gap-1.5 px-2 py-1 rounded text-[10px] font-mono transition-all text-slate-500 hover:text-[#00E5FF]"
                title="Stencil integrations"
              >
                <span className="material-icons-outlined text-sm">settings</span>
                Integrations
              </button>
            </div>
          )}

          {/* Lighting panel — pops up from footer */}
          {!readOnly && !neuralMode && showLightingPanel && (
            <div className="absolute bottom-full right-3 mb-1 z-40 bg-[#161E2E] border border-[#00E5FF]/50 rounded-lg p-4 w-80 shadow-xl max-h-[55vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-bold text-[#00E5FF] uppercase tracking-wider">Lighting Tuner</h3>
                <button type="button" onClick={() => setShowLightingPanel(false)} className="text-slate-500 hover:text-white text-lg leading-none">×</button>
              </div>
            {/* Ambient Light */}
            <div className="mb-3">
              <div className="flex justify-between text-[10px] mb-1">
                <span className="text-slate-400">Ambient</span>
                <span className="text-[#00E5FF] font-mono">{lighting.ambient.toFixed(1)}</span>
              </div>
              <input type="range" min="0" max="3" step="0.1" value={lighting.ambient}
                onChange={(e) => setLighting(l => ({ ...l, ambient: parseFloat(e.target.value) }))}
                className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-[#00E5FF]" />
            </div>
            
            {/* Main Light - Intensity + Position */}
            <div className="mb-4 p-2 bg-[#1a2535] rounded border border-[#233544]">
              <div className="flex justify-between text-[10px] mb-2">
                <span className="text-amber-400 font-bold">Main Light</span>
                <span className="text-[#00E5FF] font-mono">{lighting.main.toFixed(1)}</span>
              </div>
              <input type="range" min="0" max="4" step="0.1" value={lighting.main}
                onChange={(e) => setLighting(l => ({ ...l, main: parseFloat(e.target.value) }))}
                className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-amber-400 mb-2" />
              <div className="grid grid-cols-3 gap-2 text-[9px]">
                <div>
                  <span className="text-slate-500">X: {lighting.mainPos.x}</span>
                  <input type="range" min="-30" max="30" step="1" value={lighting.mainPos.x}
                    onChange={(e) => setLighting(l => ({ ...l, mainPos: { ...l.mainPos, x: parseFloat(e.target.value) } }))}
                    className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-red-400" />
                </div>
                <div>
                  <span className="text-slate-500">Y: {lighting.mainPos.y}</span>
                  <input type="range" min="0" max="50" step="1" value={lighting.mainPos.y}
                    onChange={(e) => setLighting(l => ({ ...l, mainPos: { ...l.mainPos, y: parseFloat(e.target.value) } }))}
                    className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-green-400" />
                </div>
                <div>
                  <span className="text-slate-500">Z: {lighting.mainPos.z}</span>
                  <input type="range" min="-30" max="30" step="1" value={lighting.mainPos.z}
                    onChange={(e) => setLighting(l => ({ ...l, mainPos: { ...l.mainPos, z: parseFloat(e.target.value) } }))}
                    className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-blue-400" />
                </div>
              </div>
            </div>
            
            {/* Fill Light - Intensity + Position */}
            <div className="mb-4 p-2 bg-[#1a2535] rounded border border-[#233544]">
              <div className="flex justify-between text-[10px] mb-2">
                <span className="text-purple-400 font-bold">Fill Light</span>
                <span className="text-[#00E5FF] font-mono">{lighting.fill.toFixed(1)}</span>
              </div>
              <input type="range" min="0" max="3" step="0.1" value={lighting.fill}
                onChange={(e) => setLighting(l => ({ ...l, fill: parseFloat(e.target.value) }))}
                className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-purple-400 mb-2" />
              <div className="grid grid-cols-3 gap-2 text-[9px]">
                <div>
                  <span className="text-slate-500">X: {lighting.fillPos.x}</span>
                  <input type="range" min="-30" max="30" step="1" value={lighting.fillPos.x}
                    onChange={(e) => setLighting(l => ({ ...l, fillPos: { ...l.fillPos, x: parseFloat(e.target.value) } }))}
                    className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-red-400" />
                </div>
                <div>
                  <span className="text-slate-500">Y: {lighting.fillPos.y}</span>
                  <input type="range" min="0" max="50" step="1" value={lighting.fillPos.y}
                    onChange={(e) => setLighting(l => ({ ...l, fillPos: { ...l.fillPos, y: parseFloat(e.target.value) } }))}
                    className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-green-400" />
                </div>
                <div>
                  <span className="text-slate-500">Z: {lighting.fillPos.z}</span>
                  <input type="range" min="-30" max="30" step="1" value={lighting.fillPos.z}
                    onChange={(e) => setLighting(l => ({ ...l, fillPos: { ...l.fillPos, z: parseFloat(e.target.value) } }))}
                    className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-blue-400" />
                </div>
              </div>
            </div>
            
            {/* Top Light - Intensity + Position */}
            <div className="mb-3 p-2 bg-[#1a2535] rounded border border-[#233544]">
              <div className="flex justify-between text-[10px] mb-2">
                <span className="text-cyan-400 font-bold">Top Light</span>
                <span className="text-[#00E5FF] font-mono">{lighting.top.toFixed(1)}</span>
              </div>
              <input type="range" min="0" max="2" step="0.1" value={lighting.top}
                onChange={(e) => setLighting(l => ({ ...l, top: parseFloat(e.target.value) }))}
                className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-cyan-400 mb-2" />
              <div className="grid grid-cols-3 gap-2 text-[9px]">
                <div>
                  <span className="text-slate-500">X: {lighting.topPos.x}</span>
                  <input type="range" min="-30" max="30" step="1" value={lighting.topPos.x}
                    onChange={(e) => setLighting(l => ({ ...l, topPos: { ...l.topPos, x: parseFloat(e.target.value) } }))}
                    className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-red-400" />
                </div>
                <div>
                  <span className="text-slate-500">Y: {lighting.topPos.y}</span>
                  <input type="range" min="0" max="50" step="1" value={lighting.topPos.y}
                    onChange={(e) => setLighting(l => ({ ...l, topPos: { ...l.topPos, y: parseFloat(e.target.value) } }))}
                    className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-green-400" />
                </div>
                <div>
                  <span className="text-slate-500">Z: {lighting.topPos.z}</span>
                  <input type="range" min="-30" max="30" step="1" value={lighting.topPos.z}
                    onChange={(e) => setLighting(l => ({ ...l, topPos: { ...l.topPos, z: parseFloat(e.target.value) } }))}
                    className="w-full h-1 bg-[#233544] rounded-lg appearance-none cursor-pointer accent-blue-400" />
                </div>
              </div>
            </div>
            
            {/* Current Values Display */}
            <div className="mt-3 pt-3 border-t border-[#233544]">
              <p className="text-[8px] text-slate-500 leading-relaxed">
                Intensity: A:{lighting.ambient} M:{lighting.main} F:{lighting.fill} T:{lighting.top}<br/>
                MainPos: ({lighting.mainPos.x},{lighting.mainPos.y},{lighting.mainPos.z})<br/>
                FillPos: ({lighting.fillPos.x},{lighting.fillPos.y},{lighting.fillPos.z})<br/>
                TopPos: ({lighting.topPos.x},{lighting.topPos.y},{lighting.topPos.z})
              </p>
            </div>
              </div>
            )}
        </div>
      </div>
      
    </div>
  );
};

export default DataHallDesigner;
