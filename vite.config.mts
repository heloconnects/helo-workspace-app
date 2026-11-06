import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the renderer into fixed local files under dist/renderer.
// They are served to the window by the app:// protocol handler in src/main/main.ts.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    modulePreload: { polyfill: false },
    sourcemap: false,
    target: 'es2023',
  },
});
