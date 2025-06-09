import React, { useState } from 'react';
import clsx from 'clsx';
import api from '../api';

const OutletCell = ({ number, data }) => {
  const status = data?.results?.find(r => r.name === `Output${number}Status`)?.value?.replace(/"/g, '');
  const current = parseFloat(data?.results?.find(r => r.name === `Output${number}Current`)?.value?.replace(/"/g, '') || '0');
  const energy = parseFloat(data?.results?.find(r => r.name === `Output${number}Energy`)?.value?.replace(/"/g, '') || '0') / 10;
  
  // Compute status classes
  const isOn = status?.toLowerCase() === 'on';
  const isHighLoad = current > 1.2; // Threshold for high load warning (adjust as needed)
  const statusClass = !isOn ? 'status-off' :
                     isHighLoad ? 'status-alert' :
                     current > 0 ? 'status-green' : 'status-idle';

  // Local UI state for toggle action
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const toggleLabel = isOn ? 'Turn OFF' : 'Turn ON';
  const handleToggle = async () => {
    const newState = isOn ? 'off' : 'on';
    try {
      setLoading(true);
      const response = await api.put(`/api/outlet/${number}/status`, { state: newState });
      console.log('Toggle response:', response.data);
      if (response.data.error) {
        throw new Error(response.data.error);
      }
    } catch (e) {
      console.error(e);
      setErr(e.message || 'Failed to toggle outlet');
      setTimeout(() => setErr(null), 3000);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={clsx('outlet-cell', statusClass, isHighLoad && 'flash-border')}>
      {isHighLoad && <div className="outlet-alert">High load</div>}
      <div className="outlet-header">
        <div className="outlet-header-left">
          <div className={clsx('outlet-led', isOn ? 'led-on' : 'led-off')} />
          <span className="outlet-number">{number}</span>
        </div>
        <span className="outlet-status">{isOn ? 'ON' : 'OFF'}</span>
      </div>
      
      <div className="outlet-metrics">
        <div className="outlet-metric">
          <span className="metric-label">Current</span>
          <span className="metric-value">{current.toFixed(1)} A</span>
        </div>
        <div className="outlet-metric">
          <span className="metric-label">Energy</span>
          <span className="metric-value">{energy.toFixed(1)} kWh</span>
        </div>
      </div>
      
      {isHighLoad && (
        <div className="outlet-alert">
          High load
        </div>
      )}
      <button
        className="outlet-toggle-btn"
        disabled={loading}
        onClick={handleToggle}
      >
        {loading ? '...' : toggleLabel}
      </button>
      {err && (<div className="outlet-error">{err}</div>)}
    </div>
  );
};

const OutletGrid = ({ data }) => {
  // Generate 6x4 grid of outlets (24 total)
  const outlets = Array.from({ length: 24 }, (_, i) => i + 1);

  return (
    <section className="outlet-grid-section">
      <h2 className="section-title">
        <span>OUTPUTS</span>
        <div className="status-legend">
          <span className="legend-item">
            <span className="status-dot status-green"></span> Normal
          </span>
          <span className="legend-item">
            <span className="status-dot status-idle"></span> Idle
          </span>
          <span className="legend-item">
            <span className="status-dot status-alert"></span> Alert
          </span>
          <span className="legend-item">
            <span className="status-dot status-off"></span> Off
          </span>
        </div>
      </h2>
      
      <div className="outlet-grid">
        {outlets.map(number => (
          <OutletCell 
            key={number}
            number={number}
            data={data}
          />
        ))}
      </div>
    </section>
  );
};

export default OutletGrid;
