import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build` -> normal static site in dist/ (deploy to Netlify).
// `npm run build:single` -> one self-contained HTML file in dist-single/ (easy to share or preview).
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: mode === 'single'
    ? { outDir: 'dist-single', assetsInlineLimit: 100_000_000 }
    : { outDir: 'dist', chunkSizeWarningLimit: 1200 },
}));
