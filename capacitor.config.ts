import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'family.plenty.restock',
  appName: 'Restock',
  webDir: 'dist',
  // 0.9.0: no webContentsDebuggingEnabled here, so desktop Chrome can only inspect the WebView
  // (chrome://inspect) in a debug build (npm run android:apk-debug), never in a release.
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
