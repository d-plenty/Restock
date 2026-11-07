import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'family.plenty.restock',
  appName: 'Restock',
  webDir: 'dist',
  android: {
    // Lets testers debug the WebView from desktop Chrome (chrome://inspect).
    webContentsDebuggingEnabled: true,
  },
  plugins: {
    SystemBars: {
      insetsHandling: 'css',
      initialViewportFitValueHint: 'cover',
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_restock',
      iconColor: '#17643F',
    },
  },
};

export default config;
