import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { installPrintPageSize } from './lib/printPageSize.js';
import './index.css';

// Chromium ignores `@page { size: 80mm auto }` and silently falls back to US
// Letter, so the page size has to be supplied as a concrete per-job height.
// Installed here rather than inside the receipt component because Ctrl+P is
// available on every screen, not only the one with a Print button.
installPrintPageSize();

// Two boundaries, deliberately. The one inside Layout keeps the navigation
// alive when a single screen throws, which is the common case and the kinder
// one. This outer one exists for what that cannot reach: a throw in Layout
// itself, in the auth provider, or in the router before Layout mounts — the
// inner boundary is a child of those, so it goes down with them.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
