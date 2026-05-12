import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

function gitVersion() {
  // Docker injects BUILD_VERSION via a file; use it if available
  if (existsSync('./BUILD_VERSION')) {
    return readFileSync('./BUILD_VERSION', 'utf-8').trim();
  }
  try {
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    const count = execSync('git rev-list --count HEAD', { encoding: 'utf-8' }).trim();
    return `${pkg.version}-b${count}.${hash}`;
  } catch {
    return pkg.version;
  }
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(gitVersion()),
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
