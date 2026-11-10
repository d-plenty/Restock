// 0.9.5: the web app's manifest (built to pwa/manifest.webmanifest by vite.server.config.ts). Icon
// addresses are relative to the manifest. Colours: the app's navy top strip and its cream page.
export const MANIFEST = {
  id: '/',
  name: 'Restock',
  short_name: 'Restock',
  description: "Your household's Shopping list, pantry and prices, from your Restock server.",
  lang: 'en-AU',
  dir: 'ltr',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'any',
  theme_color: '#012169',
  background_color: '#f6f4ea',
  categories: ['shopping', 'food', 'lifestyle'],
  icons: [
    { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: 'icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    { src: 'apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any' },
  ],
} as const;
