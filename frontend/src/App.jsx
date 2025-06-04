import { useState } from 'react';
import Dashboard from './components/Dashboard';
import Form from './components/Form';
import { PDUProvider } from './context/PDUContext';

export default function App() {
  const [submitted, setSubmitted] = useState(false);

  return (
    <PDUProvider>
      <div className="app-container bg-[#0f172a] text-gray-200 min-h-screen p-6">
        <h1 className="text-3xl font-semibold text-center mb-8 tracking-widest text-sky-400">
          POWER INTELLIGENCE
        </h1>
        {!submitted ? (
          <Form onSubmit={() => setSubmitted(true)} />
        ) : (
          <Dashboard />
        )}
      </div>
    </PDUProvider>
  );
}
