import { defineConfig } from 'vite';

// Served from https://<user>.github.io/mobile-hamilpath/, so all asset URLs
// need this prefix — kept the same in dev/build/preview to avoid surprises.
export default defineConfig({
  base: '/mobile-hamilpath/',
});
