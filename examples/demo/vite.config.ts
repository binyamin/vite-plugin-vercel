import react from '@vitejs/plugin-react-swc';
import ssr from 'vike/plugin';
import vercel from 'vite-plugin-vercel';
import { UserConfig } from 'vite';

export default {
  plugins: [
    react(),
    ssr({
      prerender: true,
    }),
    vercel(),
  ],
  vercel: {
    expiration: 25,
    additionalEndpoints: [
      {
        source: 'endpoints/edge.ts',
        destination: `edge`,
        edge: true,
        addRoute: true,
      },
      {
        source: 'endpoints/og.tsx',
        destination: `og`,
        edge: true,
        addRoute: true,
      },
    ],
  },
  // We manually add a list of dependencies to be pre-bundled, in order to avoid a page reload at dev start which breaks vike's CI
  // (The 'react/jsx-runtime' entry is not needed in Vite 3 anymore.)
  optimizeDeps: { include: ['cross-fetch', 'react/jsx-runtime'] },
} as UserConfig;
