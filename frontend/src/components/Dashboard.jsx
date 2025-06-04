import React, { useEffect, useState } from 'react';
import { usePDUContext } from '../context/PDUContext';
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
          return (
            <MetricCard
              key={key}
              title={label}
              value={sensor?.value || '--'}
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
  const { ip } = usePDUContext();

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

    if (ip) {
      fetchData();
      const interval = setInterval(fetchData, 5000);
      return () => clearInterval(interval);
    }
  }, [ip]);

  if (!data) return <div className="loading">Loading...</div>;

  const deviceInfo = {
    name: data.results?.find(r => r.name === 'DeviceName')?.value,
    type: data.results?.find(r => r.name === 'DeviceType')?.value,
    mac: data.results?.find(r => r.name === 'DeviceMac')?.value
  };

  return (
    <div className="dashboard">
      <div className="device-info">
        <h1>{deviceInfo.name || 'PDU Device'}</h1>
        <div className="device-details">
          <span>Type: {deviceInfo.type || '--'}</span>
          <span>MAC: {deviceInfo.mac || '--'}</span>
        </div>
      </div>

      <div className="phases">
        <PhaseMetrics data={data} phase={1} />
        <PhaseMetrics data={data} phase={2} />
        <PhaseMetrics data={data} phase={3} />
      </div>

      <EnvironmentalMetrics data={data} />
      <OutputGrid data={data} />

      {data.errors?.length > 0 && (
        <div className="errors">
          <h3>Errors</h3>
          <ul>
            {data.errors.map((error, i) => (
              <li key={i}>{error.name}: {error.error}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default Dashboard;

