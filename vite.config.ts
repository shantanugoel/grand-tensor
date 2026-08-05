import { defineConfig } from 'vite'

// Relative base so the built site can be dropped on any static host / subpath.
export default defineConfig({
  base: './',
  build: { target: 'es2022' },
})
