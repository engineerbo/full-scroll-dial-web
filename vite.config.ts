import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import tailwindcss from '@tailwindcss/vite';

const THIRD_PARTY_LICENSES = 'THIRD_PARTY_LICENSES.txt';

/**
 * The minifier strips dependency copyright comments, so the notices their licenses
 * require have to ship beside the bundle instead.
 */
function thirdPartyLicenses(): Plugin {
  return {
    name: 'third-party-licenses',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: THIRD_PARTY_LICENSES,
        source: readFileSync(THIRD_PARTY_LICENSES, 'utf8'),
      });
    },
  };
}

export default defineConfig({
  root: '.',
  base: './',
  publicDir: false,
  plugins: [tailwindcss(), thirdPartyLicenses()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'index.html',
      },
    },
  },
  test: {
    coverage: {
      thresholds: {
        lines: 70,
        functions: 70,
      },
    },
  },
});
