import React, { useEffect, useRef } from 'react';
import { Network } from 'vis-network/standalone';

const AgentVisualization = () => {
  const networkRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    // Create nodes for our network
    const nodes = [
      { 
        id: 1, 
        label: 'PDUMind-AI\nMaintenance Assistant',
        group: 'agent',
        x: 0,
        y: 0
      },
      { 
        id: 2, 
        label: 'get_pdu_status()\nReal-time PDU State',
        group: 'tool',
        x: -200,
        y: -150
      },
      { 
        id: 3, 
        label: 'query_sql()\nHistorical Data',
        group: 'tool',
        x: -200,
        y: 50
      },
      { 
        id: 4, 
        label: 'feature_frame()\nTime Series Analysis',
        group: 'tool',
        x: 200,
        y: -150
      },
      { 
        id: 5, 
        label: 'inference()\nAnomaly Detection',
        group: 'tool',
        x: 200,
        y: 50
      },
      {
        id: 6,
        label: 'SQLite\nTelemetry DB',
        group: 'database',
        x: -400,
        y: -50
      },
      {
        id: 7,
        label: 'IsolationForest\nModel',
        group: 'model',
        x: 400,
        y: 50
      }
    ];

    // Create edges
    const edges = [
      { from: 1, to: 2, arrows: 'to', label: 'status query' },
      { from: 1, to: 3, arrows: 'to', label: 'historical query' },
      { from: 1, to: 4, arrows: 'to', label: 'pattern analysis' },
      { from: 1, to: 5, arrows: 'to', label: 'anomaly check' },
      { from: 6, to: 2, arrows: 'to', dashes: true },
      { from: 6, to: 3, arrows: 'to', dashes: true },
      { from: 6, to: 4, arrows: 'to', dashes: true },
      { from: 7, to: 5, arrows: 'to', dashes: true }
    ];

    // Configuration options
    const options = {
      nodes: {
        shape: 'box',
        margin: 10,
        borderWidth: 2,
        shadow: true,
        color: {
          background: '#1a1a1a',
          border: '#0ff',
          highlight: {
            background: '#222',
            border: '#0ff'
          }
        },
        font: {
          color: '#fff',
          size: 14,
          face: 'Space Grotesk, Roboto Mono, monospace'
        }
      },
      edges: {
        color: {
          color: '#0ff',
          highlight: '#fff'
        },
        font: {
          color: '#0ff',
          size: 12,
          face: 'Space Grotesk, Roboto Mono, monospace'
        },
        width: 2,
        selectionWidth: 3,
        smooth: {
          type: 'continuous'
        }
      },
      groups: {
        agent: {
          color: {
            background: 'rgba(15, 20, 25, 0.95)',
            border: '#0ff'
          },
          borderWidth: 3,
          shape: 'box',
          font: { size: 16, color: '#0ff' }
        },
        tool: {
          color: {
            background: 'rgba(15, 20, 25, 0.8)',
            border: '#00ff88'
          },
          shape: 'box'
        },
        database: {
          color: {
            background: 'rgba(15, 20, 25, 0.8)',
            border: '#ff00ff'
          },
          shape: 'database'
        },
        model: {
          color: {
            background: 'rgba(15, 20, 25, 0.8)',
            border: '#ffff00'
          },
          shape: 'diamond'
        }
      },
      physics: {
        enabled: true,
        barnesHut: {
          gravitationalConstant: -2000,
          centralGravity: 0.1,
          springLength: 200,
          springConstant: 0.04
        }
      },
      interaction: {
        hover: true,
        tooltipDelay: 200
      }
    };

    // Create the network
    networkRef.current = new Network(
      containerRef.current,
      { nodes, edges },
      options
    );

    // Cleanup
    return () => {
      if (networkRef.current) {
        networkRef.current.destroy();
      }
    };
  }, []);

  return (
    <>
      <div className="kpi-widget-root" style={{ 
        position: 'fixed',
        top: '20px',
        right: '20px',
        width: '340px'
      }}>
        <div style={{ padding: '15px' }}>
          <h3 style={{ 
            color: '#0ff',
            margin: '0 0 10px 0',
            fontSize: '16px'
          }}>Latest Agent Activity</h3>
          <div id="agentActivity" style={{
            color: '#fff',
            fontSize: '14px',
            maxHeight: '200px',
            overflowY: 'auto'
          }}>
            Monitoring PDU status and analyzing patterns...
          </div>
        </div>
      </div>

      <div className="kpi-widget-root" style={{
        position: 'fixed',
        bottom: '20px',
        right: '20px',
        width: '340px'
      }}>
        <div style={{ padding: '15px' }}>
          <h3 style={{
            color: '#0ff',
            margin: '0 0 10px 0',
            fontSize: '16px'
          }}>System Status</h3>
          <div style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '10px'
          }}>
            <div className="kpi-box" style={{
              background: 'rgba(0, 255, 136, 0.1)',
              border: '1px solid rgba(0, 255, 136, 0.2)',
              padding: '10px',
              borderRadius: '8px'
            }}>
              <div className="kpi-label">Active Tools</div>
              <div className="kpi-value" style={{ color: '#00ff88' }}>4</div>
            </div>
            <div className="kpi-box" style={{
              background: 'rgba(0, 255, 136, 0.1)',
              border: '1px solid rgba(0, 255, 136, 0.2)',
              padding: '10px',
              borderRadius: '8px'
            }}>
              <div className="kpi-label">Response Time</div>
              <div className="kpi-value" style={{ color: '#00ff88' }}>2.4s</div>
            </div>
          </div>
        </div>
      </div>

      <div
        ref={containerRef}
        style={{
          width: '100%',
          height: '600px',
          background: '#1a1a1a',
          border: '1px solid #333',
          borderRadius: '8px'
        }}
      />
    </>
  );
};

export default AgentVisualization;
