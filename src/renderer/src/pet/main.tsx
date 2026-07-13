// Entry do DESKTOP PET (docs/DESKTOP_PET.md). Diferente do main.tsx do app,
// NÃO importa o web-bridge: o pet é desktop-only (canais pet:* respondem 403
// no gateway) e este bundle só roda dentro da janela Electron do pet.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { PetApp } from './PetApp';
import './pet.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root container #root não encontrado.');

createRoot(container).render(
  <StrictMode>
    <PetApp />
  </StrictMode>,
);
