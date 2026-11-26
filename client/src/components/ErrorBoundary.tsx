import React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface ErrorBoundaryState {
  hasError: boolean;
  errorMessage: string;
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, errorMessage: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: error?.message || 'An unexpected rendering error occurred.',
    };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[Cadence ErrorBoundary]', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          style={{
            minHeight: '100dvh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            background: 'var(--bg-chrome)',
            color: 'var(--text-primary)',
          }}
        >
          <div
            style={{
              maxWidth: 440,
              width: '100%',
              padding: 24,
              borderRadius: 'var(--radius-lg)',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-strong)',
              boxShadow: 'var(--shadow-lg)',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--status-danger)' }}>
              <AlertTriangle size={20} />
              <strong style={{ fontSize: 16 }}>Something went wrong in Cadence</strong>
            </div>
            <p style={{ margin: 0, fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Your mail data and drafts remain safely stored on the server. Reload the interface to continue.
            </p>
            <pre
              style={{
                margin: 0,
                padding: 10,
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-subtle)',
                fontSize: 12,
                fontFamily: 'var(--font-mono)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {this.state.errorMessage}
            </pre>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button
                type="button"
                className="btn"
                onClick={() => this.setState({ hasError: false, errorMessage: '' })}
              >
                Try Recovering
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => window.location.reload()}
              >
                <RotateCcw size={14} /> Reload App
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
