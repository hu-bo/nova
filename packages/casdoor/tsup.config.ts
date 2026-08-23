import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    types: 'src/types.ts',
    'server/index': 'src/server/index.ts',
    'client/index': 'src/client/index.ts',
    'client/core': 'src/client/core.ts',
    'client/storage': 'src/client/storage.ts',
    'client/react': 'src/client/react.ts',
    'client/vue': 'src/client/vue.ts',
  },
  format: ['esm', 'cjs'],
  bundle: false,
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: false,
  external: ['vue', 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
});
