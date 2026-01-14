import React, { useState, useMemo, useCallback, Suspense, useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Grid, Text, Environment } from '@react-three/drei';
import * as THREE from 'three';
import { defaultDataHallConfig, generateDataHallLayout, validateConfig } from './dataHallConfig';

// API base URL
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:5000';

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

// Rack 3D Component
const Rack3D = ({ rack, isSelected, isHovered, alertLevel, alertInfo, showLabel, onSelect, onHover }) => {
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
  
  return (
    <group position={[position.x, position.y + dimensions.height / 2, position.z]}>
      {/* Main rack body */}
      <mesh
        onClick={(e) => { e.stopPropagation(); onSelect(rack); }}
        onPointerOver={(e) => { e.stopPropagation(); onHover(rack); }}
        onPointerOut={(e) => { e.stopPropagation(); onHover(null); }}
      >
        <boxGeometry args={[dimensions.width, dimensions.height, dimensions.depth]} />
        <meshStandardMaterial 
          color={colors.color} 
          emissive={colors.emissive}
          emissiveIntensity={colors.intensity}
          transparent
          opacity={0.85}
        />
      </mesh>
      
      {/* Rack outline */}
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(dimensions.width, dimensions.height, dimensions.depth)]} />
        <lineBasicMaterial color={colors.outline} />
      </lineSegments>
      
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
const DataHallScene = ({ layout, selectedRack, hoveredRack, alerts, showLabels, onSelectRack, onHoverRack }) => {
  if (!layout) return null;
  
  const { hall, floor, racks, rows } = layout;
  
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
      {/* Lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[10, 20, 10]} intensity={0.6} />
      <directionalLight position={[-10, 20, -10]} intensity={0.3} />
      
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
              return (
                <button
                  key={pdu.id}
                  onClick={() => onPduClick && onPduClick(pdu)}
                  className={`w-full flex items-center justify-between p-2 rounded cursor-pointer hover:ring-1 hover:ring-[#00E5FF]/50 transition-all ${pduAlert ? (pduAlert.severity === 'critical' ? 'bg-red-500/10 hover:bg-red-500/20' : 'bg-amber-500/10 hover:bg-amber-500/20') : 'bg-[#0B1120] hover:bg-[#1a2535]'}`}
                >
                  <div className="flex items-center">
                    <span className="w-4 flex-shrink-0">
                      {pduAlert && <span className={`w-1.5 h-1.5 rounded-full inline-block ${pduAlert.severity === 'critical' ? 'bg-red-500' : 'bg-amber-500'}`}></span>}
                    </span>
                    <span className="text-[#00E5FF] w-4">{pdu.position}</span>
                    <span className="text-slate-500 ml-2">{pdu.model}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-emerald-400">{pdu.ip}</span>
                    <span className="material-icons-outlined text-[#00E5FF] text-xs">open_in_new</span>
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

// Main Component
const DataHallDesigner = ({ onNavigateToPdu }) => {
  const [config, setConfig] = useState(defaultDataHallConfig);
  const [selectedRack, setSelectedRack] = useState(null);
  const [hoveredRack, setHoveredRack] = useState(null);
  const [showLabels, setShowLabels] = useState(false);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [hallId, setHallId] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [lastSaved, setLastSaved] = useState(null);
  
  // Load hall state on mount
  useEffect(() => {
    const loadHallState = async () => {
      try {
        setIsLoading(true);
        const response = await fetch(`${API_BASE}/api/halls/default`);
        if (response.ok) {
          const data = await response.json();
          if (data.hall) {
            setHallId(data.hall.id);
          }
          if (data.config) {
            setConfig(data.config);
            console.log('[DataHallDesigner] Loaded config from DB:', data.config);
          }
        }
      } catch (error) {
        console.error('[DataHallDesigner] Failed to load hall state:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadHallState();
  }, []);
  
  // Save hall state
  const saveHallState = useCallback(async () => {
    if (!hallId) return;
    
    try {
      setIsSaving(true);
      const layout = generateDataHallLayout(config);
      
      // Prepare racks data
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
      
      // Prepare PDUs data
      const pdus = layout.success ? layout.layout.pdus.map(pdu => ({
        ip_address: pdu.ip,
        rack_code: pdu.rackId,
        mount_position: pdu.position,
        label: pdu.id
      })) : [];
      
      const response = await fetch(`${API_BASE}/api/halls/${hallId}/state`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config, racks, pdus })
      });
      
      if (response.ok) {
        setLastSaved(new Date().toLocaleTimeString());
        console.log('[DataHallDesigner] Saved hall state to DB');
      }
    } catch (error) {
      console.error('[DataHallDesigner] Failed to save hall state:', error);
    } finally {
      setIsSaving(false);
    }
  }, [hallId, config]);
  
  // Auto-save on config change (debounced)
  useEffect(() => {
    if (!hallId || isLoading) return;
    
    const timeoutId = setTimeout(() => {
      saveHallState();
    }, 2000); // 2 second debounce
    
    return () => clearTimeout(timeoutId);
  }, [config, hallId, isLoading, saveHallState]);
  
  // Generate layout from config
  const layoutResult = useMemo(() => generateDataHallLayout(config), [config]);
  
  // Mock alerts for demonstration - in production, these would come from real PDU monitoring
  const alerts = useMemo(() => {
    if (!layoutResult.success) return [];
    const racks = layoutResult.layout.racks;
    const mockAlerts = [];
    
    // Add a critical alert on rack 3 (Row-01/Rack-03)
    if (racks.length > 2) {
      const rack3 = racks[2];
      if (rack3.pdus.length > 0) {
        mockAlerts.push({
          id: 'alert-1',
          severity: 'critical',
          pduId: rack3.pdus[0].id,
          rackId: rack3.id,
          title: 'Over-current Detection',
          message: 'Current exceeded 15A threshold on PDU-A'
        });
      }
    }
    
    // Add a warning alert on rack 8 (Row-01/Rack-08)
    if (racks.length > 7) {
      const rack8 = racks[7];
      if (rack8.pdus.length > 0) {
        mockAlerts.push({
          id: 'alert-2',
          severity: 'warning',
          pduId: rack8.pdus[0].id,
          rackId: rack8.id,
          title: 'Temperature Warning',
          message: 'Ambient temperature above 35°C'
        });
      }
    }
    
    // Add another warning on rack 15 (Row-02/Rack-05)
    if (racks.length > 14) {
      const rack15 = racks[14];
      if (rack15.pdus.length > 0) {
        mockAlerts.push({
          id: 'alert-3',
          severity: 'warning',
          pduId: rack15.pdus[0].id,
          rackId: rack15.id,
          title: 'High Load Warning',
          message: 'Load approaching 80% capacity'
        });
      }
    }
    
    // Add a critical on rack 22
    if (racks.length > 21) {
      const rack22 = racks[21];
      if (rack22.pdus.length > 0) {
        mockAlerts.push({
          id: 'alert-4',
          severity: 'critical',
          pduId: rack22.pdus[0].id,
          rackId: rack22.id,
          title: 'Power Supply Failure',
          message: 'PDU-B not responding'
        });
      }
    }
    
    return mockAlerts;
  }, [layoutResult]);
  
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
  
  const layout = layoutResult.success ? layoutResult.layout : null;
  
  return (
    <div className="flex h-[calc(100vh-8rem)] bg-[#0B1120] relative">
      {/* Left Panel - Parameters (Collapsible) */}
      <div className={`${panelCollapsed ? 'w-0' : 'w-80'} border-r ${panelCollapsed ? 'border-transparent' : 'border-[#233544]'} bg-[#0B1120] transition-all duration-300 flex-shrink-0 relative overflow-hidden`}>
        <div className={`${panelCollapsed ? 'opacity-0 pointer-events-none' : 'opacity-100'} transition-opacity duration-200 p-4 overflow-y-auto h-full w-80`}>
          <h2 className="text-lg font-bold font-mono text-[#00E5FF] mb-6 flex items-center gap-2">
            <span className="material-icons-outlined">tune</span>
            Parameters
          </h2>
        
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
      <div className="flex-1 relative overflow-hidden">
        <Canvas
          camera={{ position: [15, 12, 15], fov: 50 }}
          gl={{ antialias: true }}
          style={{ background: '#0a1520' }}
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
        <div className="absolute top-4 left-4 bg-[#161E2E]/90 border border-[#233544] rounded-lg px-4 py-3">
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
        <div className="absolute top-4 right-4 bg-[#161E2E]/90 border border-[#233544] rounded-lg px-3 py-2 text-[10px] font-mono">
          {isLoading ? (
            <span className="text-slate-400">Loading...</span>
          ) : isSaving ? (
            <span className="text-[#00E5FF]">Saving...</span>
          ) : lastSaved ? (
            <span className="text-emerald-400">✓ Saved {lastSaved}</span>
          ) : (
            <span className="text-slate-500">Auto-save enabled</span>
          )}
        </div>
        
        {/* View Controls Legend */}
        <div className="absolute bottom-4 left-4 bg-[#161E2E]/90 border border-[#233544] rounded-lg px-3 py-2 text-[10px] font-mono text-slate-400">
          <span className="mr-4">🖱️ Orbit: Drag</span>
          <span className="mr-4">⚙️ Pan: Right-drag</span>
          <span>🔍 Zoom: Scroll</span>
        </div>
        
        {/* Hovered Rack Tooltip */}
        {hoveredRack && !selectedRack && (
          <div className="absolute top-14 right-4 bg-[#161E2E] border border-[#00E5FF]/30 rounded-lg px-3 py-2">
            <p className="text-sm font-mono text-[#00E5FF]">{hoveredRack.id}</p>
            <p className="text-xs text-slate-400">{hoveredRack.pdus.length} PDUs</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default DataHallDesigner;
