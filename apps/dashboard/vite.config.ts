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
      '/files': 'http://localhost:9001',
    },
  },
})
