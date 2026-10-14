import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  server: {
    proxy: {
      '/trpc': 'http://localhost:9001',
      '/health': 'http://localhost:9001',
      '/ca.crt': 'http://localhost:9001',
      '/files': 'http://localhost:9001',
      // Trailing slash matters: Vite's proxy matches by plain string prefix
      // (url.startsWith(key)), so a bare '/s' would also swallow '/src/*'
      // (and anything else starting with "/s"), breaking every dev module
      // request. '/s/' only matches the actual /s/:token share routes.
      '/s/': 'http://localhost:9001',
      '/containers': 'http://localhost:9001',
      '/system': 'http://localhost:9001',
    },
  },
})
