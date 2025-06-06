import React, { createContext, useContext, useState, useEffect } from 'react';

const PowerHistoryContext = createContext();

export const usePowerHistory = () => {
  const context = useContext(PowerHistoryContext);
  if (!context) {
    throw new Error('usePowerHistory must be used within a PowerHistoryProvider');
  }
  return context;
};

export const PowerHistoryProvider = ({ children }) => {
  const [powerHistory, setPowerHistory] = useState([]);
  // Keep roughly 24 hours of data assuming one reading every 30 seconds (~2880 points)
  const maxDataPoints = 2880;

  const addPowerReading = (reading) => {
    setPowerHistory(prev => {
      // Check if we already have a reading within the same second
      const now = Date.now();
      const newReading = {
        ...reading,
        timestamp: now // Use exact millisecond timestamp
      };

      // Remove readings older than 24 hours
      const twentyFourHoursAgo = now - (24 * 60 * 60 * 1000);
      const filteredHistory = prev.filter(item => item.timestamp > twentyFourHoursAgo);

      return [...filteredHistory, newReading].slice(-maxDataPoints);
    });
  };

  return (
    <PowerHistoryContext.Provider value={{ powerHistory, addPowerReading }}>
      {children}
    </PowerHistoryContext.Provider>
  );
};
