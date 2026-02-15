import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  base: '/_couchmail/',
  server: {
    proxy: {
      '/_session': 'http://localhost:5984',
      '/mail': 'http://localhost:5984'
    }
  }
});
