import Dashboard from './components/Dashboard';
import { PDUProvider } from './context/PDUContext';
import { PowerHistoryProvider } from './context/PowerHistoryContext';
import { SimulationProvider } from './context/SimulationContext';

export default function App() {
  return (
    <PDUProvider>
      <PowerHistoryProvider>
        <SimulationProvider>
        <div className="app-container bg-[#0f172a] text-gray-200 min-h-screen p-6">
          <Dashboard />
        </div>
        </SimulationProvider>
      </PowerHistoryProvider>
    </PDUProvider>
  );
}
