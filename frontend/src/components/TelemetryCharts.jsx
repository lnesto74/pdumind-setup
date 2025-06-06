import React from 'react';
import { LineChart, Line, XAxis, YAxis, ResponsiveContainer, Tooltip } from 'recharts';

// Process telemetry data from SNMP results
const processTelemetryData = (data) => {
  if (!data?.results) return [];
  
  // Get the last 24 readings (if available)
  const voltage = data.results.find(r => r.name === 'VoltageP1')?.value?.replace(/"/g, '') || '0';
  const current = data.results.find(r => r.name === 'CurrentP1')?.value?.replace(/"/g, '') || '0';
  const power = data.results.find(r => r.name === 'PowerP1')?.value?.replace(/"/g, '') || '0';
  
  // For now, just return a single point since we don't have historical data
  // In the future, we could store historical data in the frontend
  return [{
    time: new Date().getHours(),
    voltage: parseFloat(voltage),
    current: parseFloat(current),
    power: parseFloat(power)
  }];
};

const TelemetryCharts = ({ data }) => {
  const telemetryData = processTelemetryData(data);
  return (
    <div className="telemetry-charts">
      <div className="chart-container">
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={telemetryData}>
            <XAxis 
              dataKey="time" 
              stroke="rgba(224, 224, 224, 0.6)"
              tickLine={false}
            />
            <YAxis 
              stroke="rgba(224, 224, 224, 0.6)"
              tickLine={false}
              axisLine={false}
            />
            <Tooltip 
              contentStyle={{
                background: 'rgba(15, 23, 42, 0.9)',
                border: '1px solid rgba(255, 255, 255, 0.1)',
                borderRadius: '8px'
              }}
            />
            <Line 
              type="monotone" 
              dataKey="voltage" 
              stroke="#00CFFF" 
              dot={false}
              strokeWidth={2}
            />
            <Line 
              type="monotone" 
              dataKey="current" 
              stroke="#10B981" 
              dot={false}
              strokeWidth={2}
            />
            <Line 
              type="monotone" 
              dataKey="power" 
              stroke="#F59E0B" 
              dot={false}
              strokeWidth={2}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      
      <div className="chart-legend">
        <div className="legend-item">
          <span className="legend-color" style={{ background: '#00CFFF' }}></span>
          Voltage
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ background: '#10B981' }}></span>
          Current
        </div>
        <div className="legend-item">
          <span className="legend-color" style={{ background: '#F59E0B' }}></span>
          Power
        </div>
      </div>
    </div>
  );
};

export default TelemetryCharts;
