import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev serves at /, GitHub Pages serves at /sunberry-kpi/.
// When you switch to a custom domain, change `build` base back to '/'.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  base: command === 'build' ? '/sunberry-kpi/' : '/',
  server: { port: 5173 },
}));
