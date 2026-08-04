import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: './',
  // Expose the dev server on the LAN so a phone on the same Wi-Fi can reach it.
  // Pinned to 5173 (with strictPort) so it stays in step with the firewall rule
  // opened for that port — if 5173 is taken it errors loudly instead of silently
  // moving to a port the firewall would block.
  server: {
    host: true,
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dest',
    emptyOutDir: true,
    target: 'es2022',
  },
})
