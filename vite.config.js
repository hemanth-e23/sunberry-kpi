import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Custom domain serves from root, so base = '/' for both dev and prod.
export default defineConfig({
  plugins: [react()],
  base: '/',
  server: { port: 5173 },
});
