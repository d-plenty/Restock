import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './ui/App';
import './ui/styles.css';

// 0.9.2: on a Restock server, the sign-in screens come first (src/server-mode); then the same App.
if (import.meta.env.VITE_SERVER_MODE === '1') void import('./server-mode/main');
else
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
