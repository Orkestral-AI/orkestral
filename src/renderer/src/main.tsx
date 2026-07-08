// PRIMEIRO import: fora do Electron instala window.orkestral/orkestralEvents
// falando com o gateway HTTP — precisa existir antes de stores/páginas avaliarem.
import '@renderer/lib/web-bridge';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@renderer/lib/prismLanguages';
import { App } from './App';
import './styles/global.css';

// Aplica o tema inicial. A store de UI pode trocar entre 'dark' | 'light' depois.
document.documentElement.dataset.theme = 'dark';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root não encontrado.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
