import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';
import { api } from './api';

// Error reports for Jonáš: the error and where it happened, nothing from the emails
const describeError = (error) =>
  [`${error?.name || 'Error'}: ${error?.message || error}`, ...(error?.stack || '').split('\n').slice(1, 6)].join('\n');

window.addEventListener('error', (event) => api.reportError(describeError(event.error || event.message)));
window.addEventListener('unhandledrejection', (event) => api.reportError(describeError(event.reason)));

// If the window itself breaks, show a way out instead of a blank screen
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('React Error:', error, errorInfo);
    api.reportError(`${describeError(error)}\n${(errorInfo?.componentStack || '').trim().split('\n').slice(0, 4).join('\n')}`);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="h-screen flex flex-col items-center justify-center gap-4 p-6 text-center bg-ink-100">
          <h1 className="text-2xl font-semibold text-ink-900">Něco se pokazilo</h1>
          <p className="text-ink-600 max-w-md">Okno DadMailu se nepodařilo zobrazit. Vaše emaily jsou v pořádku.</p>
          <button onClick={() => window.location.reload()} className="btn-primary">
            Zkusit znovu
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}

console.log('React app starting...');
console.log('Root element:', document.getElementById('root'));

const rootElement = document.getElementById('root');
if (!rootElement) {
  console.error('Root element not found!');
  document.body.innerHTML = '<div style="padding: 20px; font-size: 18px;">Chyba: Root element nenalezen</div>';
} else {
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>
  );
  console.log('React app rendered');
}
