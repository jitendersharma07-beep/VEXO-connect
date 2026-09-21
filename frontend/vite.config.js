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
      // api.js builds every URL as `${BASE_URL}api`, so a dev server started
      // with VITE_BASE_PATH=/pos/ — which is how you reproduce production —
      // asks for /pos/api/…. Without this rule the SPA fallback answers it
      // with index.html and a 200, so the API looks broken rather than
      // unproxied. Listed first because it is the more specific prefix.
      '/pos/api': {
        target: process.env.VITE_DEV_API || 'http://localhost:5010',
        changeOrigin: false,
        rewrite: (p) => p.replace(/^\/pos/, ''),
      },
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
