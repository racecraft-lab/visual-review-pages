import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 700,
    emptyOutDir: false,
    outDir: 'dist',
    rollupOptions: {
      input: {
        'visual-annotation-app': 'src/visual-annotation-app.jsx',
      },
      output: {
        assetFileNames: '[name][extname]',
        chunkFileNames: '[name].js',
        entryFileNames: '[name].js',
      },
    },
  },
})
