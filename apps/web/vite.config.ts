import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// During dev, the UI runs on 5173 and proxies API calls to the Nest server on 3000.
// In production the Nest server serves the built assets directly.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
