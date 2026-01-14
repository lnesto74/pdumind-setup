import axios from 'axios';

// Create axios instance with base URL
const api = axios.create({
  baseURL: '',  // Base URL is empty since paths are relative to proxy
  timeout: 180000,  // 180 second timeout
  headers: {
    'Content-Type': 'application/json'
  }
});

export default api;
