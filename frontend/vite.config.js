import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://backend:5000',  // Use internal Docker network port
        changeOrigin: true,
        secure: false,
        ws: true,
        configure: (proxy, options) => {
          proxy.on('error', (err, req, res) => {
            console.error('PROXY ERROR:', err);
          });
          proxy.on('proxyReq', (proxyReq, req, res) => {
            console.log('PROXY REQUEST:', {
              method: req.method,
              url: req.url,
              headers: req.headers,
              body: req.body
            });
          });
          proxy.on('proxyRes', (proxyRes, req, res) => {
            console.log('PROXY RESPONSE:', {
              statusCode: proxyRes.statusCode,
              method: req.method,
              url: req.url,
              headers: proxyRes.headers
            });
          });
        }
      }
    }
  },
  build: {
    outDir: 'dist',
  },
});
