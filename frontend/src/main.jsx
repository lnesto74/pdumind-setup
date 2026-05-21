import React from 'react';
import ReactDOM from 'react-dom/client';
import './api'; // patches fetch/axios with coordinator auth token
import App from './App';
import FleetCommandCenter from './components/FleetCommandCenter';
import './styles/global.css';

const isViewerRoute =
  window.location.pathname === '/view' ||
  window.location.pathname.startsWith('/view/');

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isViewerRoute ? <FleetCommandCenter /> : <App />}
  </React.StrictMode>
);
