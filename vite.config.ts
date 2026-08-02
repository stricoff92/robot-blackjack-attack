import { defineConfig } from 'vitest/config'

export default defineConfig({
  base: './',
  build: {
    outDir: 'dest',
    emptyOutDir: true,
    target: 'es2022',
  },
})
