import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // MapLibre is intentionally lazy-loaded. Keep the stable vendor chunk cached across map feature releases.
    chunkSizeWarningLimit: 1_100,
    rolldownOptions: {
      output: {
        codeSplitting: {
          includeDependenciesRecursively: true,
          groups: [
            {
              name: 'maplibre',
              test: /node_modules[\\/]maplibre-gl(?:[\\/]|$)/,
            },
          ],
        },
      },
    },
  },
  optimizeDeps: {
    exclude: ['maplibre-gl'],
  },
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
  },
});
