import React, { createContext, useContext, useState, useCallback } from 'react';

const SimulationContext = createContext();

const generateSimulatedData = (numPoints = 30) => {
  const now = Date.now();
  const data = [];
  
  // Base power values
  const baseValues = {
    power: 900,    // Base power (approx realistic total power in watts)
    current: 1.5,  // Base current
    voltage: 230,  // Standard voltage
  };

  // Wave parameters
  const mainPeriod = 12;     // 12-second main cycle for smoother curve
  const subPeriod = 4;       // 4-second sub-cycle for higher-frequency ripple
  const mainAmplitude = 250; // Main wave amplitude (±250 W)
  const subAmplitude = 120;  // Sub wave amplitude (±120 W)
  const trendFactor = 0.15;  // Slight upward trend factor

  // Generate points
  for (let i = 0; i < numPoints; i++) {
    const timeOffset = i * 1000; // 1 second intervals
    const timestamp = now - ((numPoints - 1 - i) * 1000);
    const t = timestamp / 1000; // Time in seconds
    
    // Create a complex waveform
    const mainWave = Math.sin(2 * Math.PI * t / mainPeriod);
    const subWave = Math.sin(2 * Math.PI * t / subPeriod);
    const trend = (i / numPoints) * trendFactor; // Slight upward trend
    
    // Combine waves with different amplitudes
    const waveform = 
      (mainWave * mainAmplitude) + 
      (subWave * subAmplitude) + 
      (trend * mainAmplitude);
    
    // Add controlled random variation
    const noise = (Math.random() - 0.5) * 15;
    
    // Calculate final values
    const power = baseValues.power + waveform + noise;
    const current = power / baseValues.voltage;
    const voltage = baseValues.voltage * (1 + (Math.random() - 0.5) * 0.01);
    
    data.push({
      timestamp,
      // Use a unified "value" field so the chart can display regardless of source
      value: Math.max(0, power),
      // Keep formatted strings for other potential uses
      power: Math.max(0, power).toFixed(1),
      current: Math.max(0, current).toFixed(2),
      voltage: voltage.toFixed(1)
    });
  }
  
  return data;
};

export function SimulationProvider({ children }) {
  const [isSimulated, setIsSimulated] = useState(false);
  const [simulatedData, setSimulatedData] = useState(() => generateSimulatedData());

  const updateSimulatedData = useCallback(() => {
    setSimulatedData(generateSimulatedData());
  }, []);

  const value = {
    isSimulated,
    setIsSimulated,
    simulatedData,
    updateSimulatedData
  };

  return (
    <SimulationContext.Provider value={value}>
      {children}
    </SimulationContext.Provider>
  );
}

export function useSimulation() {
  const context = useContext(SimulationContext);
  if (!context) {
    throw new Error('useSimulation must be used within a SimulationProvider');
  }
  return context;
}
