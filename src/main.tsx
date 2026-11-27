import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App';
import './ui/styles.css';

// 0.18.3: the server's own web page starts at src/server-mode/admin/entry.tsx (vite.server.config.ts), not here.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
