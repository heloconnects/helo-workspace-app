import { createRoot } from 'react-dom/client';
import type { HeloBridge } from '../shared/api.js';
import { App } from './App.js';
import './styles.css';

declare global {
  interface Window {
    helo: HeloBridge;
  }
}

createRoot(document.getElementById('root')!).render(<App api={window.helo} />);
