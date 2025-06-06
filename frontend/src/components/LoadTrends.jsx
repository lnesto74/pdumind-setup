import React, { useMemo } from 'react';
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
import { usePowerHistory } from '../context/PowerHistoryContext';

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

/**
 * LoadTrends component
 * Displays historical power usage over the last 24 hours and a simple forecast.
 */
const LoadTrends = () => {
  const { powerHistory } = usePowerHistory();

  // Sort readings chronologically
  const sorted = useMemo(() => [...powerHistory].sort((a, b) => a.timestamp - b.timestamp), [powerHistory]);

  // Build chart labels and values
  const labels = sorted.map(({ timestamp }) => {
    const d = new Date(timestamp);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  });

  const values = sorted.map(r => r.value);

  // Simple prediction: rolling average of last 5 points projected forward
  const predicted = (() => {
    if (values.length < 6) return [];
    const lastFiveAvg = values.slice(-5).reduce((acc, v) => acc + v, 0) / 5;
    return [...values, lastFiveAvg];
  })();

  const datasets = [
    {
      label: 'Actual',
      data: values,
      borderColor: '#00CFFF',
      backgroundColor: 'rgba(0, 207, 255, 0.10)',
      tension: 0.3,
      fill: true,
      pointRadius: 0
    }
  ];

  if (predicted.length) {
    datasets.push({
      label: 'Forecast',
      data: predicted,
      borderColor: 'rgba(0, 207, 255, 0.4)',
      borderDash: [4, 4],
      tension: 0.3,
      fill: false,
      pointRadius: 0
    });
  }

  const chartData = { labels, datasets };

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
          padding: 16
        }
      },
      tooltip: {
        mode: 'index',
        intersect: false
      }
    },
    scales: {
      x: {
        ticks: { color: '#a0a0a0' },
        grid: { display: false }
      },
      y: {
        ticks: { color: '#a0a0a0' },
        grid: {
          color: 'rgba(255,255,255,0.05)'
        }
      }
    }
  };

  // Peak demand for quick reference
  const peakDemand = useMemo(() => {
    if (!values.length) return '--';
    return Math.max(...values).toFixed(0);
  }, [values]);

  return (
    <div className="load-trends">
      <div className="chart-container" style={{ height: 220 }}>
        <Line data={chartData} options={chartOptions} />
      </div>
      <div className="peak-demand">Peak Demand: <strong>{peakDemand} W</strong></div>
    </div>
  );
};

export default LoadTrends;
