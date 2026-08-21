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

const apiProxy = {
  '/api': {
    target: process.env.API_PROXY_TARGET || 'http://127.0.0.1:5002',
    changeOrigin: true,
    secure: false,
    ws: true,
  },
};

export default defineConfig(({ command }) => ({
  appType: 'spa',
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(gitVersion()),
  },
  server: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: apiProxy,
  },
  // `vite preview` serves the production build (bundled, instant) and is what the
  // container runs. Same /api proxy so the backend routing (Host rewrite) is
  // identical to dev.
  preview: {
    port: 3000,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: apiProxy,
  },
  build: {
    outDir: 'dist',
  }
}));
