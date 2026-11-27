// 0.18.3: the start of the server's web page (vite.server.config.ts puts this in place of the
// app's src/main.tsx): the shared tokens, this page's own styles, the look kept in this browser,
// the service worker (so a page saved to the home screen updates itself), the old page's copies of
// the household tidied away (tidy.ts), then AdminRoot.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../ui/tokens.css';
import './admin.css';
import { applyPrefs, watchSystemTheme } from './prefs';
import { registerServiceWorker } from '../pwa/register';
import { tidyOldCopies } from './tidy';
import { AdminRoot } from './AdminRoot';

applyPrefs();
watchSystemTheme();
document.documentElement.classList.add('server-mode');
registerServiceWorker();
void tidyOldCopies();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminRoot />
  </StrictMode>,
);
