import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// VITE_BASE_PATH is "/" in dev and "/pos/" in the production image so the SPA
// works when served under https://atcworkspace.com/pos/.
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  plugins: [react()],
  server: {
    port: 5177,
    host: true,
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API || 'http://localhost:5010',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
