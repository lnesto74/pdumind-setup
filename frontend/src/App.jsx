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
  const [currentView, setCurrentView] = useState('dashboard');

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
                      <button
                        onClick={() => setCurrentView('dashboard')}
                        className={`p-2.5 rounded-lg transition-all duration-200 ${
                          currentView === 'dashboard'
                            ? 'bg-cyan-500/20 text-white'
                            : 'text-white/70 hover:bg-cyan-500/10 hover:text-white'
                        }`}
                        title="Dashboard"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <rect x="3" y="3" width="7" height="7"></rect>
                          <rect x="14" y="3" width="7" height="7"></rect>
                          <rect x="14" y="14" width="7" height="7"></rect>
                          <rect x="3" y="14" width="7" height="7"></rect>
                        </svg>
                      </button>
                      <button
                        onClick={() => setCurrentView('dashboard2')}
                        className={`px-3 py-1.5 rounded-lg transition-all duration-200 flex items-center gap-2 ${
                          currentView === 'dashboard2'
                            ? 'bg-[#00E5FF]/20 text-[#00E5FF] border border-[#00E5FF]/30'
                            : 'text-white/70 hover:bg-[#00E5FF]/10 hover:text-[#00E5FF] border border-transparent'
                        }`}
                        title="Dashboard 2.0"
                      >
                        <span className="material-icons-outlined text-lg">auto_awesome</span>
                        <span className="text-xs font-bold uppercase tracking-wider">2.0</span>
                      </button>
                      <button
                        onClick={() => setCurrentView('agent')}
                        className={`p-2.5 rounded-lg transition-all duration-200 ${
                          currentView === 'agent'
                            ? 'bg-cyan-500/20 text-white'
                            : 'text-white/70 hover:bg-cyan-500/10 hover:text-white'
                        }`}
                        title="Agent Visualization"
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M12 3v19M5 8l14 8M5 16l14-8"></path>
                        </svg>
                      </button>
                    </div>
                  </nav>
                </div>
              </div>

              {/* Main content area */}
              {currentView === 'dashboard2' ? (
                <Dashboard2 />
              ) : (
                <div className="max-w-7xl mx-auto px-6 py-4">
                  {currentView === 'agent' ? (
                    <AgentVisualization />
                  ) : (
                    <Dashboard />
                  )}
                </div>
              )}
            </div>
            {currentView !== 'dashboard2' && <MaintenanceChatCard />}
          </>
        </SimulationProvider>
      </PowerHistoryProvider>
    </PDUProvider>
  );
}
