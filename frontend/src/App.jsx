import { useState, useEffect, useCallback } from 'react';
import Dashboard from './components/Dashboard';
import Dashboard2 from './components/Dashboard2';
import LoginPage from './components/LoginPage';
import AdminPanel from './components/AdminPanel';
import SupportDebugTab from './components/SupportDebugTab';
import MaintenanceChatCard from './components/MaintenanceChatCard';
import AgentVisualization from './components/AgentVisualization';
import { PDUProvider } from './context/PDUContext';
import { PowerHistoryProvider } from './context/PowerHistoryContext';
import { SimulationProvider } from './context/SimulationContext';
import './styles/Dashboard2.css';

const APP_VERSION = `v${__APP_VERSION__}`;
const API_BASE = '';

export default function App() {
  const [currentView, setCurrentView] = useState('dashboard2');
  const [user, setUser] = useState(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showSupport, setShowSupport] = useState(false);

  const checkAuth = useCallback(async () => {
    const token = localStorage.getItem('pdumind_token');
    if (!token) { setAuthChecked(true); return; }
    try {
      const res = await fetch(`${API_BASE}/api/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUser(data.user);
      } else {
        localStorage.removeItem('pdumind_token');
        localStorage.removeItem('pdumind_user');
      }
    } catch {
      // Backend unreachable — keep token, will retry
    }
    setAuthChecked(true);
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  const handleLogin = (userData, token) => {
    localStorage.setItem('pdumind_token', token);
    localStorage.setItem('pdumind_user', JSON.stringify(userData));
    setUser(userData);
  };

  const handleLogout = async () => {
    const token = localStorage.getItem('pdumind_token');
    try {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
    } catch {}
    localStorage.removeItem('pdumind_token');
    localStorage.removeItem('pdumind_user');
    setUser(null);
  };

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-[#0B1120] flex items-center justify-center">
        <div className="animate-pulse text-slate-500 text-sm">Loading...</div>
      </div>
    );
  }

  if (!user) {
    return <LoginPage onLogin={handleLogin} version={APP_VERSION} />;
  }

  return (
    <PDUProvider>
      <PowerHistoryProvider>
        <SimulationProvider>
          <>
            <div className="app-container bg-[#0f172a] text-gray-200 min-h-screen flex flex-col">
              {/* Fixed top navigation bar */}
              <div className="sticky top-0 z-50 bg-[#0B1120] backdrop-blur-sm border-b border-[#233544] shadow-lg shadow-cyan-500/10 mb-6">
                <div className="w-full px-6 py-2">
                  <nav className="flex items-center justify-between w-full">
                    <div className="flex items-center">
                      <img src="/logo/pdumind-logo-2.png" alt="PDUMind Logo" className="h-10 w-auto" />
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => setShowSupport(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-amber-400/90 hover:text-amber-300 hover:bg-amber-500/10 transition-colors border border-amber-500/20 hover:border-amber-500/40"
                        title="Support Debug — copy diagnostic report"
                      >
                        <span className="material-icons-outlined text-sm">support_agent</span>
                        Support
                      </button>
                      <button
                        onClick={() => setShowAdmin(true)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-[#00E5FF] hover:bg-[#00E5FF]/10 transition-colors border border-transparent hover:border-[#00E5FF]/30"
                        title="Administration"
                      >
                        <span className="material-icons-outlined text-sm">admin_panel_settings</span>
                      </button>
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#161E2E] border border-[#233544]">
                        <span className="material-icons-outlined text-slate-500 text-sm">person</span>
                        <span className="text-xs text-slate-400">{user.display_name || user.username}</span>
                      </div>
                      <button
                        onClick={handleLogout}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-slate-400 hover:text-red-400 hover:bg-red-500/10 transition-colors border border-transparent hover:border-red-500/30"
                        title="Logout"
                      >
                        <span className="material-icons-outlined text-sm">logout</span>
                      </button>
                    </div>
                  </nav>
                </div>
              </div>

              {/* Main content area */}
              <div className="flex-1">
                {currentView === 'agent' ? (
                  <div className="max-w-7xl mx-auto px-6 py-4">
                    <AgentVisualization />
                  </div>
                ) : (
                  <Dashboard2 />
                )}
              </div>

              {/* Footer */}
              <footer className="border-t border-[#233544] bg-[#0B1120] px-6 py-2 flex items-center justify-between">
                <span className="text-[10px] text-slate-600 font-mono">Powered by Aility Pte Ltd</span>
                <span className="text-[10px] text-slate-600 font-mono">PDUMind {APP_VERSION}</span>
              </footer>
            </div>
            {currentView === 'agent' && <MaintenanceChatCard />}
            {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}
            {showSupport && (
              <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setShowSupport(false)}>
                <div className="w-full max-w-3xl max-h-[85vh] bg-[#0f172a] border border-[#233544] rounded-2xl shadow-2xl overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-between px-6 py-4 border-b border-[#233544] shrink-0">
                    <h2 className="text-sm font-bold text-white flex items-center gap-2">
                      <span className="material-icons-outlined text-amber-400">support_agent</span>
                      Support Debug
                    </h2>
                    <button onClick={() => setShowSupport(false)} className="text-slate-500 hover:text-white transition-colors">
                      <span className="material-icons-outlined">close</span>
                    </button>
                  </div>
                  <div className="p-6 overflow-y-auto">
                    <SupportDebugTab />
                  </div>
                </div>
              </div>
            )}
          </>
        </SimulationProvider>
      </PowerHistoryProvider>
    </PDUProvider>
  );
}
