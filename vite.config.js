import { resolve } from 'node:path';
import { defineConfig } from 'vite';

// Served from the root of its own subdomain, so absolute asset paths are
// safe, and deep links like /tier/3 will not resolve assets relative to the
// current path.
//
// Two pages: the tiers (index.html) and the Echo Cartography bonus page
// (echo-cartography/, a past project kept in its own folder with its own
// engine). /echo maps to it here in development and in vercel.json in
// production.
export default defineConfig({
  base: '/',
  server: {
    // Honor PORT when preview tooling assigns one; default stays 5173.
    port: Number(process.env.PORT) || 5173,
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        echo: resolve(import.meta.dirname, 'echo-cartography/index.html'),
      },
    },
  },
  plugins: [
    {
      name: 'echo-route',
      configureServer(server) {
        server.middlewares.use((request, _response, next) => {
          if (request.url === '/echo' || request.url === '/echo/') {
            request.url = '/echo-cartography/index.html';
          }
          next();
        });
      },
    },
  ],
});
