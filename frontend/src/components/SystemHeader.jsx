import React from 'react';
import clsx from 'clsx';
import PowerTelemetry from './PowerTelemetry';
import RotatingLogo from './RotatingLogo';
import '../styles/PowerTelemetry.css';

const MetricBadge = ({ label, value, unit = '', status = 'normal', className }) => (
  <div className={clsx('metric-badge', `status-${status}`, className)}>
    <div className="metric-badge-label">{label}</div>
    <div className="metric-badge-value">
      {value}
      {unit && <span className="metric-badge-unit">{unit}</span>}
    </div>
  </div>
);

const PhaseStatus = ({ phases }) => (
  <div className="phase-status">
    {phases.map((status, i) => (
      <div 
        key={i} 
        className={clsx(
          'phase-indicator',
          status === 'ok' && 'status-green',
          status === 'warning' && 'status-yellow',
          status === 'error' && 'status-red'
        )}
        title={`Phase ${i + 1}: ${status}`}
      />
    ))}
  </div>
);

const SystemHeader = ({ data }) => {
  // Extract and compute metrics from SNMP data
  const activePower = data?.results?.find(r => r.name === 'PowerP1')?.value?.replace(/"/g, '') || '0';
  const powerFactor = data?.results?.find(r => r.name === 'PFP1')?.value?.replace(/"/g, '') || '0';
  
  // Calculate total energy by summing all three phases
  const energy1 = parseFloat(data?.results?.find(r => r.name === 'EnergyP1')?.value?.replace(/"/g, '') || '0');
  const energy2 = parseFloat(data?.results?.find(r => r.name === 'EnergyP2')?.value?.replace(/"/g, '') || '0');
  const energy3 = parseFloat(data?.results?.find(r => r.name === 'EnergyP3')?.value?.replace(/"/g, '') || '0');
  const totalEnergy = (energy1 + energy2 + energy3).toFixed(1);
  
  // Compute power factor efficiency status
  const pfStatus = parseFloat(powerFactor) > 0.9 ? 'good' : 
                  parseFloat(powerFactor) > 0.7 ? 'warning' : 'error';

  // Mock phase status for now (will compute from actual phase metrics later)
  const phaseStatus = ['ok', 'warning', 'warning'];

  return (
    <div className="system-header glass-card">
      <div className="system-metrics">
        <MetricBadge
          label="Active Power"
          value={activePower}
          unit="W"
          className="power-badge"
        />
        
        <MetricBadge
          label="Power Factor"
          value={powerFactor}
          status={pfStatus}
          className="pf-badge"
        />
        
        <MetricBadge
          label="Total Energy"
          value={totalEnergy}
          unit="kWh"
          className="energy-badge"
        />
        
        <RotatingLogo className="rotating-logo" />

        <div className="phase-status-container">
          <div className="phase-status-label">Phase Status</div>
          <PhaseStatus phases={phaseStatus} />
        </div>
      </div>

      <PowerTelemetry data={data} className="system-telemetry" />
    </div>
  );
};

export default SystemHeader;
