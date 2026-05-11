import React, { useState, useMemo, useCallback, Suspense, useEffect, useRef } from 'react';
import { Canvas, useLoader, useThree } from '@react-three/fiber';
import { OrbitControls, Grid, Text, Environment, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader';
import { defaultDataHallConfig, generateDataHallLayout, validateConfig } from './dataHallConfig';
import { modelCache, cloneShared, disposeObject3D } from '../../3d';
// NetworkScanner removed — replaced by CommissioningWizard in Dashboard2

// API base URL
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5002';

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
const Rack3D = ({ rack, isSelected, isHovered, alertLevel, alertInfo, showLabel, onSelect, onHover, customModelUrl, customModelAssets, hasPdus, pduCount }) => {
  const { position, dimensions } = rack;
  
  // Determine colors based on alert level
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
    return { color: '#2D4A5E', emissive: '#000000', intensity: 0, outline: '#3D6A7E' };
  };
  
  const colors = getColors();
  const labelColor = alertLevel === 'critical' ? '#EF4444' : alertLevel === 'warning' ? '#F59E0B' : '#00E5FF';
  
  // Hologram colors based on alert level
  const holoColor = alertLevel === 'critical' ? '#EF4444' : '#F59E0B';
  const holoHeight = 0.6;
  
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
          
          {/* Status LED indicator */}
          <mesh position={[dimensions.width * 0.35, dimensions.height * 0.4, -dimensions.depth / 2 + 0.02]}>
            <sphereGeometry args={[0.03, 8, 8]} />
            <meshStandardMaterial 
              color={alertLevel === 'critical' ? '#ef4444' : alertLevel === 'warning' ? '#f59e0b' : '#22c55e'}
              emissive={alertLevel === 'critical' ? '#ef4444' : alertLevel === 'warning' ? '#f59e0b' : '#22c55e'}
              emissiveIntensity={1.5}
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
      
      {/* Flat Hologram Alert Panel - floats above rack */}
      {alertLevel && (
        <group position={[0, dimensions.height / 2 + holoHeight / 2 + 0.35, 0]}>
          {/* Flat panel with minimal depth */}
          <mesh>
            <boxGeometry args={[dimensions.width * 1.2, holoHeight, 0.02]} />
            <meshStandardMaterial 
              color={holoColor}
              emissive={holoColor}
              emissiveIntensity={0.3}
              transparent
              opacity={0.25}
            />
          </mesh>
          
          {/* Panel outline */}
          <lineSegments>
            <edgesGeometry args={[new THREE.BoxGeometry(dimensions.width * 1.2, holoHeight, 0.02)]} />
            <lineBasicMaterial color={holoColor} transparent opacity={0.8} />
          </lineSegments>
          
          {/* Alert title */}
          <Text
            position={[0, holoHeight * 0.25, 0.02]}
            fontSize={0.07}
            color={holoColor}
            anchorX="center"
            anchorY="middle"
            fontWeight="bold"
          >
            {alertLevel === 'critical' ? '⚠ CRITICAL' : '⚡ WARNING'}
          </Text>
          
          {/* Alert details */}
          <Text
            position={[0, 0, 0.02]}
            fontSize={0.05}
            color="#ffffff"
            anchorX="center"
            anchorY="middle"
            maxWidth={dimensions.width * 1.1}
          >
            {alertInfo?.title || 'PDU Alert'}
          </Text>
          
          {/* PDU info */}
          <Text
            position={[0, -holoHeight * 0.25, 0.02]}
            fontSize={0.04}
            color={holoColor}
            anchorX="center"
            anchorY="middle"
          >
            {alertInfo?.pduPosition || 'PDU-A'} | {alertInfo?.ip || '10.20.0.x'}
          </Text>
          
          {/* Connecting beam from rack to panel */}
          <mesh position={[0, -holoHeight / 2 - 0.15, 0]}>
            <cylinderGeometry args={[0.01, 0.025, 0.3, 6]} />
            <meshStandardMaterial color={holoColor} emissive={holoColor} emissiveIntensity={0.6} transparent opacity={0.4} />
          </mesh>
        </group>
      )}
      
      {/* Rack label */}
      {showLabel && !alertLevel && (
        <Text
          position={[0, dimensions.height / 2 + 0.15, 0]}
          fontSize={0.12}
          color={labelColor}
          anchorX="center"
          anchorY="bottom"
        >
          {rack.id.split('/')[1]}
        </Text>
      )}

      {/* PDU indicator — small glowing beacon on top of racks with commissioned PDUs */}
      {hasPdus && (
        <group position={[0, dimensions.height / 2 + 0.08, -dimensions.depth / 2 + 0.05]}>
          <mesh>
            <sphereGeometry args={[0.045, 12, 12]} />
            <meshStandardMaterial
              color="#00E5FF"
              emissive="#00E5FF"
              emissiveIntensity={2.5}
              transparent
              opacity={0.95}
            />
          </mesh>
          <mesh>
            <ringGeometry args={[0.06, 0.09, 16]} />
            <meshBasicMaterial color="#00E5FF" transparent opacity={0.3} side={THREE.DoubleSide} />
          </mesh>
          {pduCount > 1 && (
            <Text
              position={[0.12, 0, 0]}
              fontSize={0.07}
              color="#00E5FF"
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

// Main 3D Scene
const DataHallScene = ({ layout, selectedRack, hoveredRack, alerts, showLabels, onSelectRack, onHoverRack, customRackModelUrl, customRackModelAssets, lighting }) => {
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
      const alert = alerts.find(a => a.pduId === pdu.id || a.rackId === rack.id);
      if (alert) {
        return {
          level: alert.severity,
          title: alert.title,
          message: alert.message,
          pduPosition: pdu.position,
          ip: pdu.ip
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
            hasPdus={rack.pdus && rack.pdus.length > 0}
            pduCount={rack.pdus ? rack.pdus.length : 0}
          />
        );
      })}
      
      {/* Camera Controls */}
      <OrbitControls
        makeDefault
        minPolarAngle={0.1}
        maxPolarAngle={Math.PI / 2.1}
        minDistance={5}
        maxDistance={50}
        target={[hall.length / 2, 0, hall.width / 2]}
      />
    </>
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
      <label className="text-xs text-slate-400 font-mono">{label}</label>
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
    <label className="text-xs text-slate-400 font-mono">{label}</label>
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
const RackDetailsPanel = ({ rack, alerts = [], onClose, onPduClick }) => {
  if (!rack) return null;
  
  // Get alerts for this rack
  const rackAlerts = alerts.filter(a => a.rackId === rack.id);
  const hasAlerts = rackAlerts.length > 0;
  const hasCritical = rackAlerts.some(a => a.severity === 'critical');
  
  return (
    <div className={`absolute bottom-4 right-4 w-72 max-w-[calc(100%-2rem)] bg-[#161E2E] border ${hasCritical ? 'border-red-500' : hasAlerts ? 'border-amber-500' : 'border-[#233544]'} rounded-xl p-4 shadow-2xl z-10`}>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {hasCritical && <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>}
          {!hasCritical && hasAlerts && <span className="w-2 h-2 rounded-full bg-amber-500"></span>}
          <h3 className={`text-sm font-bold font-mono ${hasCritical ? 'text-red-400' : hasAlerts ? 'text-amber-400' : 'text-[#00E5FF]'}`}>{rack.id}</h3>
        </div>
        <button onClick={onClose} className="text-slate-400 hover:text-white">
          <span className="material-icons-outlined text-sm">close</span>
        </button>
      </div>
      
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
                  <div className="flex items-center">
                    <span className="w-4 flex-shrink-0">
                      {pduAlert ? (
                        <span className={`w-1.5 h-1.5 rounded-full inline-block ${pduAlert.severity === 'critical' ? 'bg-red-500' : 'bg-amber-500'}`}></span>
                      ) : isCommissioned ? (
                        <span className="w-1.5 h-1.5 rounded-full inline-block bg-emerald-500"></span>
                      ) : (
                        <span className="w-1.5 h-1.5 rounded-full inline-block bg-slate-600 border border-dashed border-slate-500"></span>
                      )}
                    </span>
                    <span className="text-[#00E5FF] w-4">{pdu.position}</span>
                    <span className="text-slate-500 ml-2">{pdu.model}</span>
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
  );
};

// Sparkline SVG generator - converts data points to SVG path
const generateSparklinePath = (data, width = 100, height = 20) => {
  if (!data || data.length < 2) return '';
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  
  const points = data.map((val, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((val - min) / range) * (height - 4) - 2;
    return `${x},${y}`;
  });
  
  return `M${points.join(' L')}`;
};

// Enhanced Rack Telemetry Tooltip Component
const RackTelemetryTooltip = ({ rack, onClose }) => {
  const [telemetryData, setTelemetryData] = useState({});
  const [loading, setLoading] = useState(true);
  
  useEffect(() => {
    if (!rack?.pdus?.length) return;
    
    const fetchTelemetry = async () => {
      setLoading(true);
      const results = {};
      
      for (const pdu of rack.pdus) {
        if (!pdu.ip) continue;
        try {
          // Fetch latest telemetry
          const latestRes = await fetch(`${API_BASE}/api/pdus/by-ip/${pdu.ip}/telemetry/latest`);
          const latest = latestRes.ok ? await latestRes.json() : null;
          
          // Fetch chart data for sparklines (last 30 minutes)
          const chartRes = await fetch(`${API_BASE}/api/pdus/by-ip/${pdu.ip}/telemetry/chart?minutes=30`);
          const chart = chartRes.ok ? await chartRes.json() : null;
          
          results[pdu.id] = {
            latest: latest?.telemetry || null,
            history: chart?.data || [],
            online: !!latest?.telemetry
          };
        } catch (err) {
          results[pdu.id] = { latest: null, history: [], online: false };
        }
      }
      
      setTelemetryData(results);
      setLoading(false);
    };
    
    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 10000); // Refresh every 10s
    return () => clearInterval(interval);
  }, [rack]);
  
  if (!rack) return null;
  
  const hasAnyTelemetry = Object.values(telemetryData).some(t => t.online);
  
  return (
    <div 
      className="absolute top-14 right-4 z-30 w-80 rounded-xl overflow-hidden pointer-events-auto"
      style={{
        background: 'rgba(15, 23, 42, 0.85)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: '1px solid rgba(255, 255, 255, 0.1)',
        boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.8)'
      }}
    >
      {/* Header */}
      <div className="px-4 py-3 border-b border-white/10 flex items-center justify-between">
        <div>
          <div className="text-[10px] font-bold text-slate-400 uppercase tracking-widest leading-none mb-1">
            Telemetry Overlay
          </div>
          <div className="text-sm font-bold flex items-center gap-2">
            {rack.id}
            <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
              hasAnyTelemetry 
                ? 'bg-[#00d1ff]/10 text-[#00d1ff]' 
                : 'bg-slate-500/10 text-slate-400'
            }`}>
              {loading ? 'LOADING...' : hasAnyTelemetry ? 'ONLINE' : 'OFFLINE'}
            </span>
          </div>
        </div>
        <span className="material-icons-outlined text-slate-400 text-lg">info</span>
      </div>
      
      {/* PDU Telemetry Cards */}
      <div className="p-4 space-y-4 max-h-[400px] overflow-y-auto">
        {rack.pdus.map((pdu, idx) => {
          const data = telemetryData[pdu.id] || { latest: null, history: [], online: false };
          const current = data.latest?.total_current_a ?? data.latest?.current_a ?? '--';
          const voltage = data.latest?.voltage_v ?? '--';
          const pf = data.latest?.power_factor ?? '--';
          const power = data.latest?.total_power_w ?? data.latest?.power_w ?? '--';
          
          // Extract current values from history for sparkline
          const sparkData = data.history
            .slice(-20)
            .map(h => h.total_current_a ?? h.current_a ?? 0)
            .filter(v => v > 0);
          
          return (
            <div key={pdu.id}>
              {idx > 0 && (
                <div className="h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent mb-4" />
              )}
              
              <div className="space-y-3">
                {/* PDU Header */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-1.5 h-1.5 rounded-full ${
                      data.online ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]' : 'bg-slate-500'
                    }`} />
                    <span className="text-[11px] font-bold text-slate-300 uppercase tracking-wide">
                      PDU {pdu.position}
                    </span>
                    <span className="text-[10px] text-slate-500 font-mono">{pdu.ip || 'N/A'}</span>
                  </div>
                  <div className="text-lg font-bold font-mono text-[#00d1ff]">
                    {typeof current === 'number' ? current.toFixed(2) : current}
                    <span className="text-xs ml-0.5 opacity-60">A</span>
                  </div>
                </div>
                
                {/* Sparkline */}
                <div 
                  className="h-8 w-full rounded border border-white/5 relative overflow-hidden"
                  style={{ background: 'rgba(0,0,0,0.2)' }}
                >
                  {sparkData.length > 1 ? (
                    <svg className="w-full h-full" preserveAspectRatio="none" viewBox="0 0 100 20">
                      <path 
                        d={generateSparklinePath(sparkData)} 
                        fill="none"
                        stroke="#00d1ff"
                        strokeWidth="1.5"
                        style={{ filter: 'drop-shadow(0 0 2px rgba(0, 209, 255, 0.5))' }}
                      />
                    </svg>
                  ) : (
                    <div className="flex items-center justify-center h-full text-[9px] text-slate-500">
                      No telemetry data
                    </div>
                  )}
                  <div className="absolute top-1 right-1 text-[8px] text-slate-500 font-medium uppercase tracking-tighter">
                    30m Load
                  </div>
                </div>
                
                {/* Metrics Grid */}
                <div className="grid grid-cols-3 gap-2">
                  <div className="bg-white/5 p-2 rounded-md border border-white/5 text-center">
                    <div className="text-[8px] text-slate-500 uppercase font-bold mb-0.5">Current</div>
                    <div className="text-[11px] font-mono font-semibold">
                      {typeof current === 'number' ? `${current.toFixed(2)}A` : '--'}
                    </div>
                  </div>
                  <div className="bg-white/5 p-2 rounded-md border border-white/5 text-center">
                    <div className="text-[8px] text-slate-500 uppercase font-bold mb-0.5">Voltage</div>
                    <div className="text-[11px] font-mono font-semibold">
                      {typeof voltage === 'number' ? `${voltage.toFixed(0)}V` : '--'}
                    </div>
                  </div>
                  <div className="bg-white/5 p-2 rounded-md border border-white/5 text-center">
                    <div className="text-[8px] text-slate-500 uppercase font-bold mb-0.5">Power</div>
                    <div className="text-[11px] font-mono font-semibold">
                      {typeof power === 'number' ? `${power.toFixed(0)}W` : '--'}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
        
        {rack.pdus.length === 0 && (
          <div className="text-center py-4 text-slate-500 text-xs">
            No PDUs configured in this rack
          </div>
        )}
      </div>
      
      {/* Footer */}
      <div className="bg-black/20 px-4 py-2 flex items-center justify-between">
        <span className="text-[9px] text-slate-500 uppercase tracking-tight">
          {loading ? 'Fetching telemetry...' : 'Syncing real-time...'}
        </span>
        <div className="flex gap-2">
          <span className={`w-1 h-1 rounded-full ${loading ? 'bg-amber-400' : 'bg-[#00d1ff]'} animate-pulse`} />
        </div>
      </div>
    </div>
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
const DataHallDesigner = ({ onNavigateToPdu, selectedHallId: externalHallId, onHallChange, onConfigSaved, alerts: externalAlerts }) => {
  const [config, setConfig] = useState(defaultDataHallConfig);
  const [selectedRack, setSelectedRack] = useState(null);
  const [hoveredRack, setHoveredRack] = useState(null);
  const [showLabels, setShowLabels] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  
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
      const racks = layout.success ? layout.layout.racks.map(rack => ({
        rack_code: rack.id,
        row_index: rack.rowIndex,
        position_index: rack.positionInRow,
        x_m: rack.position.x,
        y_m: rack.position.y,
        z_m: rack.position.z,
        width_mm: Math.round(rack.dimensions.width * 1000),
        depth_mm: Math.round(rack.dimensions.depth * 1000),
        height_u: rack.heightU,
        model: rack.model
      })) : [];
      await fetch(`${API_BASE}/api/halls/${hid}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: cfg, racks, pdus: [] })
      });
      console.log('[DataHallDesigner] Flushed save for hall', hid);
    } catch (e) {
      console.error('[DataHallDesigner] Flush save failed:', e);
    }
  }, []);

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
  
  // Save on page unload so closing/refreshing doesn't lose changes
  useEffect(() => {
    const handleBeforeUnload = () => { flushSave(); };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [flushSave]);
  
  // Save hall state
  const saveHallState = useCallback(async () => {
    if (!hallId || isLoadingRef.current) return;
    
    try {
      setIsSaving(true);
      const layout = generateDataHallLayout(config);
      
      const racks = layout.success ? layout.layout.racks.map(rack => ({
        rack_code: rack.id,
        row_index: rack.rowIndex,
        position_index: rack.positionInRow,
        x_m: rack.position.x,
        y_m: rack.position.y,
        z_m: rack.position.z,
        width_mm: Math.round(rack.dimensions.width * 1000),
        depth_mm: Math.round(rack.dimensions.depth * 1000),
        height_u: rack.heightU,
        model: rack.model
      })) : [];
      
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
  }, [hallId, config, onConfigSaved]);
  
  // Auto-save on config change (debounced) — uses ref guard to prevent saving during load
  useEffect(() => {
    if (!hallId || isLoadingRef.current) return;
    
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      saveHallState();
    }, 1500);
    
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [config, hallId, saveHallState]);
  
  // Generate layout from config
  const layoutResult = useMemo(() => generateDataHallLayout(config), [config]);
  
  // Replace layout-generated placeholder PDUs with real commissioned PDUs from DB.
  // Racks with no commissioned PDUs get an empty PDU list (empty slots).
  const mergedLayoutResult = useMemo(() => {
    if (!layoutResult.success) return layoutResult;
    
    const pdusByRack = {};
    for (const pdu of storedPdus) {
      const rackCode = pdu.rack_code;
      if (!rackCode) continue;
      if (!pdusByRack[rackCode]) pdusByRack[rackCode] = [];
      pdusByRack[rackCode].push({
        id: pdu.label || `${rackCode}/PDU-${pdu.mount_position || 'A'}`,
        rackId: rackCode,
        position: pdu.mount_position || 'A',
        model: pdu.model || 'PDU',
        ip: pdu.ip_address,
        dbId: pdu.id
      });
    }
    
    const mergedRacks = layoutResult.layout.racks.map(rack => ({
      ...rack,
      pdus: pdusByRack[rack.id] || []
    }));
    
    return {
      ...layoutResult,
      layout: {
        ...layoutResult.layout,
        racks: mergedRacks
      }
    };
  }, [layoutResult, storedPdus]);
  
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
  
  return (
    <div className="flex h-[calc(100vh-8rem)] bg-[#0B1120] relative">
      {/* Left Panel - Parameters (Collapsible) */}
      <div className={`${panelCollapsed ? 'w-0' : 'w-80'} border-r ${panelCollapsed ? 'border-transparent' : 'border-[#233544]'} bg-[#0B1120] transition-all duration-300 flex-shrink-0 relative overflow-hidden`}>
        <div className={`${panelCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'} transition-opacity duration-200 p-4 overflow-y-auto h-full w-80`}>
          <h2 className="text-lg font-bold font-mono text-[#00E5FF] mb-6 flex items-center gap-2">
            <span className="material-icons-outlined">tune</span>
            Parameters
          </h2>
        
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
        
        {/* Hall Dimensions */}
        <div className="mb-6">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">
            Data Hall Dimensions
          </h3>
          <ParamInput
            label="Length"
            value={config.hall.length}
            onChange={(v) => updateConfig('hall.length', v)}
            min={5} max={100} step={1}
            unit="m"
          />
          <ParamInput
            label="Width"
            value={config.hall.width}
            onChange={(v) => updateConfig('hall.width', v)}
            min={5} max={50} step={1}
            unit="m"
          />
          <ParamInput
            label="Height"
            value={config.hall.height}
            onChange={(v) => updateConfig('hall.height', v)}
            min={2.5} max={10} step={0.1}
            unit="m"
          />
          <ParamInput
            label="Floor Tile Size"
            value={config.hall.floorTileSize}
            onChange={(v) => updateConfig('hall.floorTileSize', v)}
            min={0.3} max={1} step={0.1}
            unit="m"
          />
        </div>
        
        {/* Layout */}
        <div className="mb-6">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">
            Layout Configuration
          </h3>
          <ParamInput
            label="Number of Rows"
            value={config.layout.numberOfRows}
            onChange={(v) => updateConfig('layout.numberOfRows', v)}
            min={1} max={20} step={1}
          />
          <ParamInput
            label="Racks per Row"
            value={config.layout.racksPerRow}
            onChange={(v) => updateConfig('layout.racksPerRow', v)}
            min={1} max={30} step={1}
          />
          <ParamSelect
            label="Row Orientation"
            value={config.layout.rowOrientation}
            onChange={(v) => updateConfig('layout.rowOrientation', v)}
            options={[
              { value: 'lengthwise', label: 'Lengthwise' },
              { value: 'widthwise', label: 'Widthwise' }
            ]}
          />
          <ParamInput
            label="Aisle Width"
            value={config.layout.aisleWidth}
            onChange={(v) => updateConfig('layout.aisleWidth', v)}
            min={0.6} max={3} step={0.1}
            unit="m"
          />
          <ParamInput
            label="Wall Clearance"
            value={config.layout.wallClearance}
            onChange={(v) => updateConfig('layout.wallClearance', v)}
            min={0.5} max={5} step={0.1}
            unit="m"
          />
        </div>
        
        {/* Rack Specs */}
        <div className="mb-6">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">
            Rack Specifications
          </h3>
          <ParamInput
            label="Width"
            value={config.rack.width}
            onChange={(v) => updateConfig('rack.width', v)}
            min={400} max={800} step={50}
            unit="mm"
          />
          <ParamInput
            label="Depth"
            value={config.rack.depth}
            onChange={(v) => updateConfig('rack.depth', v)}
            min={600} max={1200} step={50}
            unit="mm"
          />
          <ParamInput
            label="Height"
            value={config.rack.heightU}
            onChange={(v) => updateConfig('rack.heightU', v)}
            min={12} max={52} step={1}
            unit="U"
          />
        </div>
        
        {/* PDU Config */}
        <div className="mb-6">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">
            PDU Configuration
          </h3>
          <ParamInput
            label="PDUs per Rack"
            value={config.pdu.pdusPerRack}
            onChange={(v) => updateConfig('pdu.pdusPerRack', v)}
            min={0} max={4} step={1}
          />
          <ParamSelect
            label="Mounting"
            value={config.pdu.mounting}
            onChange={(v) => updateConfig('pdu.mounting', v)}
            options={[
              { value: 'A/B', label: 'A / B' },
              { value: 'Left/Right', label: 'Left / Right' }
            ]}
          />
        </div>
        
        {/* IP Planning */}
        <div className="mb-6">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">
            IP Planning
          </h3>
          <div className="flex items-center justify-between py-2 border-b border-[#233544]">
            <label className="text-xs text-slate-400 font-mono">Subnet</label>
            <input
              type="text"
              value={config.ipPlanning.subnet}
              onChange={(e) => updateConfig('ipPlanning.subnet', e.target.value)}
              className="w-32 bg-[#0B1120] border border-[#233544] rounded px-2 py-1 text-sm font-mono text-white text-right focus:border-[#00E5FF] focus:outline-none"
            />
          </div>
          <ParamSelect
            label="Assignment"
            value={config.ipPlanning.assignmentStrategy}
            onChange={(v) => updateConfig('ipPlanning.assignmentStrategy', v)}
            options={[
              { value: 'sequential', label: 'Sequential' },
              { value: 'perRowBlock', label: 'Per Row Block' }
            ]}
          />
        </div>
        
        {/* View Options */}
        <div className="mb-6">
          <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-3">
            View Options
          </h3>
          <div className="flex items-center justify-between py-2 border-b border-[#233544]">
            <label className="text-xs text-slate-400 font-mono">Show Rack Labels</label>
            <button
              onClick={() => setShowLabels(!showLabels)}
              className={`w-12 h-6 rounded-full transition-all ${showLabels ? 'bg-[#00E5FF]' : 'bg-[#233544]'} relative`}
            >
              <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${showLabels ? 'right-1' : 'left-1'}`}></span>
            </button>
          </div>
        </div>
        
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
      
      {/* Collapse Toggle Button */}
      <button
        onClick={() => setPanelCollapsed(!panelCollapsed)}
        className={`flex-shrink-0 w-5 h-10 bg-[#161E2E] border-y border-r border-[#00E5FF]/30 rounded-r flex items-center justify-center hover:bg-[#233544] transition-colors self-center -ml-px`}
      >
        <span className={`material-icons-outlined text-[#00E5FF] text-sm transition-transform duration-300 ${panelCollapsed ? '' : 'rotate-180'}`}>
          chevron_right
        </span>
      </button>
      
      {/* Right Panel - 3D View */}
      <div className="flex-1 relative overflow-hidden" style={{ isolation: 'isolate' }}>
        <Canvas
          camera={{ position: [15, 12, 15], fov: 50 }}
          gl={{ antialias: true }}
          style={{ background: '#0a1520' }}
          className="!absolute !inset-0"
          onPointerMissed={() => setHoveredRack(null)}
        >
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
            />
          </Suspense>
        </Canvas>
        
        {/* Rack Details Panel */}
        <RackDetailsPanel 
          rack={selectedRack} 
          alerts={alerts} 
          onClose={() => setSelectedRack(null)} 
          onPduClick={(pdu) => onNavigateToPdu && onNavigateToPdu(pdu)}
        />
        
        {/* Alert Legend */}
        <div className="absolute top-4 left-4 z-20 bg-[#161E2E]/90 border border-[#233544] rounded-lg px-4 py-3">
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-2">Status Legend</p>
          <div className="flex flex-col gap-2 text-[10px] font-mono">
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
          </div>
        </div>
        
        {/* Save Status Indicator */}
        <div className="absolute top-4 right-4 z-20 bg-[#161E2E]/90 border border-[#233544] rounded-lg px-3 py-2 text-[10px] font-mono w-36">
          {currentHall && (
            <div className="text-[#00E5FF] font-bold mb-1 truncate">{currentHall.name}</div>
          )}
          <div className="h-4">
            {isLoading ? (
              <span className="text-slate-400 flex items-center gap-1">
                <span className="animate-pulse">●</span> Loading...
              </span>
            ) : isSaving ? (
              <span className="text-amber-400 flex items-center gap-1">
                <span className="animate-spin">⟳</span> Saving...
              </span>
            ) : lastSaved ? (
              <span className="text-emerald-400">✓ Saved {lastSaved}</span>
            ) : (
              <span className="text-slate-500">Auto-save enabled</span>
            )}
          </div>
        </div>
        
        {/* View Controls Legend */}
        <div className="absolute bottom-4 left-4 z-20 bg-[#161E2E]/90 border border-[#233544] rounded-lg px-3 py-2 text-[10px] font-mono text-slate-400">
          <span className="mr-4">🖱️ Orbit: Drag</span>
          <span className="mr-4">⚙️ Pan: Right-drag</span>
          <span>🔍 Zoom: Scroll</span>
        </div>
        
        {/* Lighting Controls Toggle */}
        <button
          onClick={() => setShowLightingPanel(!showLightingPanel)}
          className="absolute bottom-4 right-4 z-20 bg-[#161E2E]/90 border border-[#233544] rounded-lg px-3 py-2 text-[10px] font-mono text-slate-400 hover:border-[#00E5FF] hover:text-[#00E5FF] transition-all"
        >
          💡 Lighting
        </button>
        
        {/* Lighting Controls Panel */}
        {showLightingPanel && (
          <div className="absolute bottom-14 right-4 z-30 bg-[#161E2E] border border-[#00E5FF]/50 rounded-lg p-4 w-80 shadow-xl max-h-[70vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-bold text-[#00E5FF] uppercase tracking-wider">Lighting Tuner</h3>
              <button onClick={() => setShowLightingPanel(false)} className="text-slate-500 hover:text-white text-lg">×</button>
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
              <p className="text-[8px] text-slate-500 font-mono leading-relaxed">
                Intensity: A:{lighting.ambient} M:{lighting.main} F:{lighting.fill} T:{lighting.top}<br/>
                MainPos: ({lighting.mainPos.x},{lighting.mainPos.y},{lighting.mainPos.z})<br/>
                FillPos: ({lighting.fillPos.x},{lighting.fillPos.y},{lighting.fillPos.z})<br/>
                TopPos: ({lighting.topPos.x},{lighting.topPos.y},{lighting.topPos.z})
              </p>
            </div>
          </div>
        )}
        
        {/* Enhanced Rack Telemetry Tooltip */}
        {hoveredRack && !selectedRack && (
          <RackTelemetryTooltip rack={hoveredRack} />
        )}
      </div>
      
    </div>
  );
};

export default DataHallDesigner;
