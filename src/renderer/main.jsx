import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/globals.css';

// Add error boundary
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
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '20px', fontSize: '18px' }}>
          <h1>Chyba při načítání aplikace</h1>
          <p>{this.state.error?.toString()}</p>
          <button onClick={() => window.location.reload()}>Obnovit stránku</button>
        </div>
      );
    }

    return this.props.children;
  }
}

console.log('React app starting...');
console.log('Root element:', document.getElementById('root'));
console.log('window.electronAPI:', window.electronAPI);

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


