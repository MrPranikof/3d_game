import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Relative base so the build works from any sub-path (static hosting, artifact pages).
export default defineConfig({
  base: './',
  server: {
    host: true,
    // Same-origin proxy so the Tripo3D API key never reaches the browser.
    proxy: {
      '/api/tripo': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      input: {
        game: resolve(__dirname, 'index.html'),
        showroom: resolve(__dirname, 'showroom.html'),
      },
    },
  },
  optimizeDeps: {
    exclude: ['meshoptimizer'],
  },
});
