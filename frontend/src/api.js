import axios from 'axios';

// Create axios instance with base URL
const api = axios.create({
  baseURL: '',  // Base URL is empty since paths are relative to proxy
  timeout: 10000,  // 10 second timeout
  headers: {
    'Content-Type': 'application/json'
  }
});

export default api;
