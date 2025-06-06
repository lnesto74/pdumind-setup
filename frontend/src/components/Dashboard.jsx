import React, { useEffect, useState } from 'react';
import { usePDUContext } from '../context/PDUContext';
import Sidebar from './Sidebar';
import SystemHeader from './SystemHeader';
import OutletGrid from './OutletGrid';
import TelemetryCharts from './TelemetryCharts';
import LoadTrends from './LoadTrends';
import clsx from 'clsx';
import '../styles/Dashboard.css';

const MetricCard = ({ title, value, unit = '' }) => (
  <div className="metric-card">
    <h3>{title}</h3>
    <div className="value">{value} {unit}</div>
  </div>
);

const PhaseMetrics = ({ data, phase }) => {
  const metrics = [
    { key: `VoltageP${phase}`, label: 'Voltage', unit: 'V' },
    { key: `CurrentP${phase}`, label: 'Current', unit: 'A' },
    { key: `PowerP${phase}`, label: 'Power', unit: 'W' },
    { key: `PFP${phase}`, label: 'Power Factor' },
    { key: `EnergyP${phase}`, label: 'Energy', unit: 'kWh' }
  ];

  return (
    <div className="phase-metrics">
      <h2>Phase {phase}</h2>
      <div className="metrics-grid">
        {metrics.map(({ key, label, unit }) => {
          const metric = data?.results?.find(r => r.name === key);
          return (
            <MetricCard
              key={key}
              title={label}
              value={metric?.value || '--'}
              unit={unit}
            />
          );
        })}
      </div>
    </div>
  );
};

const EnvironmentalMetrics = ({ data }) => {
  const sensors = [
    { key: 'Temperature1', label: 'Temperature 1', unit: '°C' },
    { key: 'Temperature2', label: 'Temperature 2', unit: '°C' },
    { key: 'Humidity1', label: 'Humidity 1', unit: '%' },
    { key: 'Humidity2', label: 'Humidity 2', unit: '%' },
    { key: 'Door1', label: 'Door 1 Status' },
    { key: 'Door2', label: 'Door 2 Status' },
    { key: 'Smoke', label: 'Smoke Detector' },
    { key: 'Water', label: 'Water Sensor' }
  ];

  return (
    <div className="environmental-metrics">
      <h2>Environmental Sensors</h2>
      <div className="metrics-grid">
        {sensors.map(({ key, label, unit }) => {
          const sensor = data?.results?.find(r => r.name === key);
          let value = sensor?.value || '--';
          if (value !== '--' && (key.startsWith('Temperature') || key.startsWith('Humidity'))) {
            value = (parseFloat(value.replace(/"/g, '')) / 10).toFixed(1);
          }
          return (
            <MetricCard
              key={key}
              title={label}
              value={value}
              unit={unit}
            />
          );
        })}
      </div>
    </div>
  );
};

const OutputGrid = ({ data }) => {
  const outputs = Array.from({ length: 24 }, (_, i) => i + 1);

  return (
    <div className="output-grid">
      <h2>Output Status</h2>
      <div className="outputs">
        {outputs.map(num => {
          const name = data?.results?.find(r => r.name === `Output${num}Name`);
          const status = data?.results?.find(r => r.name === `Output${num}Status`);
          const current = data?.results?.find(r => r.name === `Output${num}Current`);
          const energy = data?.results?.find(r => r.name === `Output${num}Energy`);

          return (
            <div key={num} className={`output ${status?.value === 'on' ? 'active' : ''}`}>
              <div className="output-name">{name?.value || `Output ${num}`}</div>
              <div className="output-metrics">
                <div>Status: {status?.value || '--'}</div>
                <div>Current: {current?.value || '--'} A</div>
                <div>Energy: {energy?.value || '--'} kWh</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

const Dashboard = () => {
  const [data, setData] = useState(null);
  const [activeCluster, setActiveCluster] = useState('Cluster A');
  const { activePdu } = usePDUContext();

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch('http://localhost:9000/api/data');
        const result = await response.json();
        setData(result);
      } catch (error) {
        console.error('Error fetching data:', error);
      }
    };

    if (activePdu?.ip) {
      fetchData();
      const interval = setInterval(fetchData, 5000);
      return () => clearInterval(interval);
    }
  }, [activePdu]);

  return (
    <div className="dashboard">
      <Sidebar />
      
      {!activePdu ? (
        <main className="dashboard-main">
          <div className="glass-card flex items-center justify-center p-8">
            <p className="text-lg text-gray-400">Please add a PDU using the sidebar</p>
          </div>
        </main>
      ) : !data ? (
        <main className="dashboard-main">
          <div className="glass-card flex items-center justify-center p-8">
            <p className="text-lg text-gray-400">Loading PDU data...</p>
          </div>
        </main>
      ) : (

        <main className="dashboard-main">
        <SystemHeader data={data} />
        
        <div className="dashboard-grid">
          <OutletGrid data={data} />
          
          <section className="glass-card telemetry-section">
            <h2 className="section-title">TELEMETRY</h2>
            <TelemetryCharts data={data} />
          </section>
          
          <section className="glass-card trends-section">
            <h2 className="section-title">LOAD TRENDS</h2>
            <LoadTrends />
          </section>
          
          <section className="glass-card environmental-section">
            <h2 className="section-title">ENVIRONMENTAL</h2>
            <div className="environmental-grid">
              <div className="env-metric">
                <span className="env-label">Temperature 1</span>
                <span className={clsx(
                  'env-value',
                  (parseFloat(data.results?.find(r => r.name === 'Temperature1')?.value?.replace(/"/g, '') || 0) / 10) > 40 && 'status-red',
                  (parseFloat(data.results?.find(r => r.name === 'Temperature1')?.value?.replace(/"/g, '') || 0) / 10) > 30 && 'status-yellow'
                )}>
                  {((parseFloat(data.results?.find(r => r.name === 'Temperature1')?.value?.replace(/"/g, '') || 0) / 10).toFixed(1))}°C
                </span>
              </div>
              <div className="env-metric">
                <span className="env-label">Temperature 2</span>
                <span className={clsx(
                  'env-value',
                  (parseFloat(data.results?.find(r => r.name === 'Temperature2')?.value?.replace(/"/g, '') || 0) / 10) > 40 && 'status-red',
                  (parseFloat(data.results?.find(r => r.name === 'Temperature2')?.value?.replace(/"/g, '') || 0) / 10) > 30 && 'status-yellow'
                )}>
                  {((parseFloat(data.results?.find(r => r.name === 'Temperature2')?.value?.replace(/"/g, '') || 0) / 10).toFixed(1))}°C
                </span>
              </div>
              <div className="env-metric">
                <span className="env-label">Humidity</span>
                <span className={clsx(
                  'env-value',
                  (parseFloat(data.results?.find(r => r.name === 'Humidity')?.value?.replace(/"/g, '') || 0) / 10) > 80 && 'status-red',
                  (parseFloat(data.results?.find(r => r.name === 'Humidity')?.value?.replace(/"/g, '') || 0) / 10) > 60 && 'status-yellow'
                )}>
                  {((parseFloat(data.results?.find(r => r.name === 'Humidity')?.value?.replace(/"/g, '') || 0) / 10).toFixed(1))}%
                </span>
              </div>
              <div className="env-metric">
                <span className="env-label">Door</span>
                <span className={clsx(
                  'env-value',
                  data.results?.find(r => r.name === 'DoorStatus')?.value === 'open' && 'status-red'
                )}>
                  {data.results?.find(r => r.name === 'DoorStatus')?.value || 'closed'}
                </span>
              </div>
            </div>
          </section>
          
          <section className="glass-card analysis-section">
            <h2 className="section-title">ANALYSIS</h2>
            <ul className="analysis-list">
              <li className="analysis-item">
                <span className="analysis-icon">🔧</span>
                Optimize power distribution by disabling idle outputs
              </li>
              <li className="analysis-item">
                <span className="analysis-icon">🚨</span>
                Check cooling system – abnormal temp values detected
              </li>
              <li className="analysis-item">
                <span className="analysis-icon">🔍</span>
                Unusual idle consumption detected in output 2
              </li>
            </ul>
          </section>
        </div>

        {data.errors?.length > 0 && (
          <div className="errors glass-card">
            <h3>Errors</h3>
            <ul>
              {data.errors.map((error, i) => (
                <li key={i}>{error.name}: {error.error}</li>
              ))}
            </ul>
          </div>
        )}
        </main>
      )}
    </div>
  );
};

export default Dashboard;
