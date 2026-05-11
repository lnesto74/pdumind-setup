import { useState } from 'react';
import Dashboard from './components/Dashboard';
import Dashboard2 from './components/Dashboard2';
import MaintenanceChatCard from './components/MaintenanceChatCard';
import AgentVisualization from './components/AgentVisualization';
import { PDUProvider } from './context/PDUContext';
import { PowerHistoryProvider } from './context/PowerHistoryContext';
import { SimulationProvider } from './context/SimulationContext';
import './styles/Dashboard2.css';

export default function App() {
  const [currentView, setCurrentView] = useState('dashboard2');

  return (
    <PDUProvider>
      <PowerHistoryProvider>
        <SimulationProvider>
          <>
            <div className="app-container bg-[#0f172a] text-gray-200 min-h-screen">
              {/* Fixed top navigation bar */}
              <div className="sticky top-0 z-50 bg-[#0B1120] backdrop-blur-sm border-b border-[#233544] shadow-lg shadow-cyan-500/10 mb-6">
                <div className="w-full px-6 py-2">
                  <nav className="flex items-center justify-between w-full">
                    <div className="flex items-center">
                      <img src="/logo/pdumind-logo-2.png" alt="PDUMind Logo" className="h-10 w-auto" />
                    </div>
                    <div className="flex gap-3">
                    </div>
                  </nav>
                </div>
              </div>

              {/* Main content area */}
              {currentView === 'agent' ? (
                <div className="max-w-7xl mx-auto px-6 py-4">
                  <AgentVisualization />
                </div>
              ) : (
                <Dashboard2 />
              )}
            </div>
            {currentView === 'agent' && <MaintenanceChatCard />}
          </>
        </SimulationProvider>
      </PowerHistoryProvider>
    </PDUProvider>
  );
}
