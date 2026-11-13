import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Xense',
    description: 'Recolecta y exporta los posts de tus listas de X por rango de fechas.',
    version: '0.1.0',
    minimum_chrome_version: '116',
    permissions: ['storage', 'unlimitedStorage'],
    host_permissions: ['https://x.com/*', 'https://twitter.com/*'],
    action: {
      default_title: 'Xense',
    },
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  },
});
