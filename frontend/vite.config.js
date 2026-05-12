import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:5002',
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
  }
}));
