import React, { createContext, useState } from 'react';
import axios from 'axios';

export const ApiContext = createContext();

const API_BASE = import.meta.env.VITE_API_BASE || '/api';

export function ApiProvider({ children }) {
  const [config, setConfig] = useState(() => {
    const saved = localStorage.getItem('pduConfig');
    return saved ? JSON.parse(saved) : null;
  });
  const [data, setData] = useState(null);

  const submitConfig = async (ip, port, mibText) => {
    await axios.post(`${API_BASE}/config`, { ip, port, mib: mibText });
    const newConfig = { ip, port, mibText };
    setConfig(newConfig);
    localStorage.setItem('pduConfig', JSON.stringify(newConfig));
  };

  const fetchData = async () => {
    try {
      const res = await axios.get(`${API_BASE}/data`);
      setData(res.data);
    } catch (err) {
      console.error('Error fetching PDU data:', err.response?.data?.error || err.message);
      // Don't update data state on error to keep showing last valid data
    }
  };

  const value = { config, data, submitConfig, fetchData };
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}
