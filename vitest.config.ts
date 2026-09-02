import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Vitest resolves the same `#spec` / `#bee` / `#engine` subpath imports the
 * runtime uses, so a test imports exactly the module the server does -- no
 * parallel build, no compiled copy that can drift from source.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^#spec$/, replacement: src('./packages/drift-spec/src/index.ts') },
      { find: /^#spec\/(.*)$/, replacement: src('./packages/drift-spec/src/$1.ts') },
      { find: /^#bee$/, replacement: src('./packages/bee/src/index.ts') },
      { find: /^#bee\/(.*)$/, replacement: src('./packages/bee/src/$1.ts') },
      { find: /^#engine$/, replacement: src('./packages/engine/src/index.ts') },
      { find: /^#engine\/(.*)$/, replacement: src('./packages/engine/src/$1.ts') },
    ],
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
  },
});
