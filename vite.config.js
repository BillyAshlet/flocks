import { defineConfig } from 'vite';

// Served from the root of its own subdomain, so absolute asset paths are
// safe, and deep links like /tier/3 will not resolve assets relative to the
// current path.
export default defineConfig({
  base: '/',
  server: {
    // Honor PORT when preview tooling assigns one; default stays 5173.
    port: Number(process.env.PORT) || 5173,
  },
});
