import { defineConfig } from 'vite';

// Step-1 architecture: WebGPU renderer (auto-fallback WebGL2), Rapier WASM in a worker,
// WebRTC/WebTransport networking. Step 2 only needs the asset pipeline + showroom.
export default defineConfig({
  server: {
    host: true,
    // Same-origin proxy so the Tripo3D API key never reaches the browser.
    proxy: {
      '/api/tripo': { target: 'http://localhost:8787', changeOrigin: true },
    },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2048,
  },
  optimizeDeps: {
    exclude: ['meshoptimizer'],
  },
});
