import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  base: './',
  publicDir: false,
  plugins: [vue(), viteSingleFile()],
  build: { outDir: 'standalone', chunkSizeWarningLimit: 6000, assetsInlineLimit: 10000000 },
})
