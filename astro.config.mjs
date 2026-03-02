import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://paysoncarpenteraudio.com',
  trailingSlash: 'never',
  build: {
    format: 'file',
  },
});
