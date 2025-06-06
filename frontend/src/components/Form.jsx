import { useState } from 'react';
import { usePDUContext } from '../context/PDUContext';

export default function Form({ onSubmit }) {
  const { addPdu } = usePDUContext();
  const [ipInput, setIpInput] = useState('');
  const [portInput, setPortInput] = useState('161');
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!ipInput) {
      setError('IP address required');
      return;
    }
    addPdu(ipInput, portInput);
    onSubmit?.();
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="max-w-md mx-auto bg-[#1e293b] p-6 rounded-lg shadow-lg"
    >
      <div className="mb-4">
        <label className="block mb-2 text-sm font-medium">PDU IP Address</label>
        <input
          value={ipInput}
          onChange={(e) => setIpInput(e.target.value)}
          className="w-full p-2 rounded bg-[#0f172a] border border-gray-600"
          placeholder="192.168.1.100"
        />
      </div>
      <div className="mb-4">
        <label className="block mb-2 text-sm font-medium">SNMP Port</label>
        <input
          value={portInput}
          onChange={(e) => setPortInput(e.target.value)}
          className="w-full p-2 rounded bg-[#0f172a] border border-gray-600"
          placeholder="161"
        />
      </div>

      {error && <p className="text-red-400 mb-2">{error}</p>}
      <button
        type="submit"
        className="w-full py-2 bg-sky-600 rounded hover:bg-sky-700 transition"
      >
        Submit
      </button>
    </form>
  );
}
