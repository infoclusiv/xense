import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../../assets/styles.css';
import App from './App';

const container = document.getElementById('root');
if (!container) throw new Error('No se encontró el contenedor de la aplicación.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
