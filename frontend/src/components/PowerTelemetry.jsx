import React, { useEffect, useRef } from 'react';
import { usePowerHistory } from '../context/PowerHistoryContext';
import { useSimulation } from '../context/SimulationContext';
import { Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
} from 'chart.js';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler
);

const PowerTelemetry = ({ data, className }) => {
  const { powerHistory, addPowerReading } = usePowerHistory();
  const { isSimulated, simulatedData, setIsSimulated, updateSimulatedData } = useSimulation();

  // Update power history when data changes
  // Update simulated data periodically
  useEffect(() => {
    if (isSimulated) {
      const interval = setInterval(updateSimulatedData, 1000);
      return () => clearInterval(interval);
    }
  }, [isSimulated, updateSimulatedData]);

  // Use ref to track last power value to prevent duplicate updates
  const lastPowerRef = useRef(null);

  useEffect(() => {
    if (data?.results) {
      // Sum power from all three phases
      const power1 = parseFloat(data.results.find(r => r.name === 'PowerP1')?.value?.replace(/"/g, '') || '0');
      const power2 = parseFloat(data.results.find(r => r.name === 'PowerP2')?.value?.replace(/"/g, '') || '0');
      const power3 = parseFloat(data.results.find(r => r.name === 'PowerP3')?.value?.replace(/"/g, '') || '0');
      const totalPower = power1 + power2 + power3;
      
      // Only add power reading if the value has changed
      if (lastPowerRef.current !== totalPower) {
        lastPowerRef.current = totalPower;
        addPowerReading({
          timestamp: new Date(),
          value: totalPower
        });
      }
    }
  }, [data, addPowerReading]);

  // Format timestamp for display
  const formatTimestamp = (timestamp) => {
    const date = new Date(timestamp);
    const hours = date.getHours().toString().padStart(2, '0');
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const seconds = date.getSeconds().toString().padStart(2, '0');
    const ms = date.getMilliseconds().toString().padStart(3, '0');
    return {
      full: `${hours}:${minutes}:${seconds}.${ms}`,
      short: `${minutes}:${seconds}`,
      veryShort: `${seconds}s`,
      seconds,
      raw: date
    };
  };

  // Sort power history by timestamp to ensure correct order
  const currentData = isSimulated ? simulatedData : powerHistory;
  const sortedHistory = [...currentData].sort((a, b) => a.timestamp - b.timestamp);
  
  // Calculate relative time labels
  const timeLabels = sortedHistory.map(reading => {
    const now = Date.now();
    const secondsAgo = Math.floor((now - reading.timestamp) / 1000);
    return `-${secondsAgo}s`;
  });

  // Calculate time differences for tooltip
  const getTimeAgo = (timestamp) => {
    const diff = Date.now() - timestamp;
    if (diff < 1000) return 'just now';
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
  };

  // Calculate predicted values (simple projection) only in real-time mode
  const predictedValues = (() => {
    if (isSimulated || currentData.length < 2) return [];
    return currentData.map((reading, index) => {
      if (index < currentData.length - 1) {
        const currentValue = reading.value;
        const nextValue = currentData[index + 1].value;
        return currentValue + (nextValue - currentValue); // linear projection
      }
      return reading.value;
    });
  })();

  const actualValues = sortedHistory.map(r => r.value);

  const datasets = [
    {
      label: 'Power',
      data: actualValues,
      borderColor: '#00CFFF',
      backgroundColor: 'rgba(0, 207, 255, 0.15)',
      tension: 0.4,
      fill: true,
    }
  ];

  if (!isSimulated && predictedValues.length) {
    datasets.push({
      label: 'Predicted',
      data: predictedValues,
      borderColor: 'rgba(0, 207, 255, 0.4)',
      borderDash: [5, 5],
      tension: 0.4,
      fill: false,
    });
  }

  const chartData = {
    labels: timeLabels,
    datasets,
  };

  const chartOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: true,
        position: 'bottom',
        labels: {
          color: '#e0e0e0',
          usePointStyle: true,
          padding: 20,
        }
      },
      tooltip: {
        mode: 'index',
        intersect: false,
        callbacks: {
          title: (context) => {
            const index = context[0].dataIndex;
            const reading = sortedHistory[index];
            if (reading) {
              const time = formatTimestamp(reading.timestamp);
              const now = Date.now();
              const secondsAgo = Math.floor((now - reading.timestamp) / 1000);
              return `${time.full}\n${secondsAgo} seconds ago`;
            }
            return '';
          },
        },
      }
    },
    scales: {
      x: {
        grid: {
          color: 'rgba(255, 255, 255, 0.1)',
          display: true,
        },
        ticks: {
          color: '#e0e0e0',
          maxRotation: 45,
          minRotation: 45,
          autoSkip: false,
          callback: function(value, index) {
            return timeLabels[value] || '';
          }
        }
      },
      y: {
        grid: {
          color: 'rgba(255, 255, 255, 0.1)',
        },
        ticks: {
          color: '#e0e0e0',
        }
      }
    },
    interaction: {
      intersect: false,
    },
  };

  const telemetryMetrics = [
    { 
      label: 'Voltage', 
      value: data?.results?.find(r => r.name === 'VoltageP1')?.value?.replace(/"/g, '') || '0',
      unit: 'V' 
    },
    { 
      label: 'Current', 
      value: data?.results?.find(r => r.name === 'CurrentP1')?.value?.replace(/"/g, '') || '0',
      unit: 'A' 
    },
    { 
      label: 'Power Factor', 
      value: data?.results?.find(r => r.name === 'PFP1')?.value?.replace(/"/g, '') || '0',
      unit: '' 
    }
  ];

  return (
    <div className={`power-telemetry ${className}`}>
      <div className="telemetry-grid">
        <div className="chart-section">
          <h3>OUTLET POWER</h3>
          <p className="chart-description">
            Real-time power readings taken every 5 seconds. Timeline shows last 2 minutes of data.
            <br />
            A predictive model indicates power consumption will increase
          </p>
          <div className="flex items-center justify-between mb-4">
            <h2 className="section-title">POWER TELEMETRY</h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsSimulated(!isSimulated)}
                className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${isSimulated ? 'bg-sky-600 text-white' : 'bg-gray-700 text-gray-300'}`}
              >
                {isSimulated ? 'Simulated' : 'Real-time'}
              </button>
              <span className="text-xs text-gray-400">{isSimulated ? 'Using simulated power data' : 'Using real-time PDU data'}</span>
            </div>
          </div>
          <div className="chart-container">
            <Line data={chartData} options={chartOptions} />
          </div>
        </div>
        <div className="metrics-section">
          <div className="telemetry-metrics">
            {telemetryMetrics.map((metric, index) => (
              <div key={index} className="telemetry-metric">
                <div className="metric-label">{metric.label}</div>
                <div className="metric-value">
                  {metric.value}
                  {metric.unit && <span className="metric-unit">{metric.unit}</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PowerTelemetry;
