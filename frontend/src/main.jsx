import React from 'react';
import ReactDOM from 'react-dom/client';
import './api'; // patches fetch/axios with coordinator auth token
import App from './App';
import FleetCommandCenter from './components/FleetCommandCenter';
import MobileIncidentPage from './components/MobileIncidentPage';
import SubscribeLandingPage from './components/SubscribeLandingPage';
import './styles/global.css';

const pathname = window.location.pathname;
const isViewerRoute = pathname === '/view' || pathname.startsWith('/view/');
const incidentMatch = pathname.match(/^\/incident\/([A-Za-z0-9_-]+)\/?$/);
const subscribeMatch = pathname.match(/^\/subscribe\/([A-Za-z0-9_-]+)\/?$/);

function Root() {
  if (incidentMatch) {
    return <MobileIncidentPage token={incidentMatch[1]} />;
  }
  if (subscribeMatch) {
    return <SubscribeLandingPage token={subscribeMatch[1]} />;
  }
  if (isViewerRoute) {
    return <FleetCommandCenter />;
  }
  return <App />;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
