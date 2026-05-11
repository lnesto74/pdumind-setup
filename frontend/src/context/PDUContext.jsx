import React, { createContext, useContext, useState } from 'react';

const PDUContext = createContext();

export function PDUProvider({ children }) {
  // Load saved list from localStorage
  const [pduList, setPduList] = useState(() => {
    const saved = localStorage.getItem('pduList');
    if (saved) {
      const parsed = JSON.parse(saved);
      const cleaned = parsed.filter(p => p.ip !== '192.168.10.106');
      if (cleaned.length !== parsed.length) {
        localStorage.setItem('pduList', JSON.stringify(cleaned));
      }
      return cleaned;
    }
    return [];
  });

  // Index of active PDU in list
  const [activeIndex, setActiveIndex] = useState(0);

  const addPdu = (ip, port) => {
    if (!ip) return;
    setPduList(prev => {
      const newList = [...prev, { ip, port }];
      localStorage.setItem('pduList', JSON.stringify(newList));
      return newList;
    });
    setActiveIndex(pduList.length); // select the newly added PDU
  };

  const setActivePdu = (index) => {
    setActiveIndex(index);
  };

  const activePdu = pduList[activeIndex] || null;

  const value = {
    pduList,
    activePdu,
    addPdu,
    setActivePdu
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
