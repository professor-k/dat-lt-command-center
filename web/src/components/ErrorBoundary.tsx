import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches a render fault so one broken panel does not leave the command centre as a blank
 * screen with the real error only in the console. React has no hook equivalent for this —
 * an error boundary has to be a class.
 *
 * Reloading is offered rather than attempted: whoever is looking at the board decides when
 * it is a good moment, and an automatic reload on a fault that reproduces would loop.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Unhandled render error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="login-wrap">
        <div className="login-card">
          <h2 style={{ marginTop: 0 }}>Console interrupted</h2>
          <p className="muted">
            Something went wrong rendering this view. The fleet data itself is unaffected — reloading
            the page should bring the board back.
          </p>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              opacity: 0.7,
              maxHeight: 160,
              overflow: 'auto',
              margin: '16px 0',
            }}
          >
            {error.message}
          </pre>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload the console
          </button>
        </div>
      </div>
    );
  }
}
