import React, { createContext, useContext, useState } from 'react';

const PDUContext = createContext();

export function PDUProvider({ children }) {
  const [ip, setIp] = useState('');
  const [port, setPort] = useState('');

  const value = {
    ip,
    setIp,
    port,
    setPort
  };

  return (
    <PDUContext.Provider value={value}>
      {children}
    </PDUContext.Provider>
  );
}

export function usePDUContext() {
  const context = useContext(PDUContext);
  if (!context) {
    throw new Error('usePDUContext must be used within a PDUProvider');
  }
  return context;
}
