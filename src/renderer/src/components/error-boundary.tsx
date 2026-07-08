import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

/**
 * Error boundary global — captura erros de renderização e mostra UI ao
 * invés de tela preta. Em produção também loga pro main process pra
 * facilitar diagnóstico.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });

    console.error('[ErrorBoundary] caught', error, info);
  }

  reset = (): void => {
    this.setState({ error: null, info: null });
  };

  reload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 999999,
            background: '#0E0F10',
            color: '#E5E5E5',
            padding: 32,
            overflow: 'auto',
            fontFamily:
              'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
          }}
        >
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
              <AlertTriangle style={{ width: 24, height: 24, color: '#FCA5A5' }} />
              <h1 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>
                Algo quebrou na interface
              </h1>
            </div>
            <p style={{ color: '#A3A3A3', fontSize: 13, marginBottom: 20 }}>
              O Orkestral teve um erro de renderização. Recarregue ou tente fechar e abrir o app. Se
              persistir, copie os detalhes abaixo.
            </p>
            <pre
              style={{
                background: '#1B1C1E',
                border: '1px solid rgba(255,255,255,0.06)',
                borderRadius: 8,
                padding: 16,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 11.5,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: '#FCA5A5',
                marginBottom: 20,
              }}
            >
              {this.state.error.name}: {this.state.error.message}
              {this.state.error.stack && '\n\n' + this.state.error.stack}
              {this.state.info?.componentStack &&
                '\n\nComponent stack:' + this.state.info.componentStack}
            </pre>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                onClick={this.reload}
                style={{
                  background: '#FFFFFF',
                  color: '#000',
                  borderRadius: 6,
                  padding: '8px 14px',
                  fontSize: 13,
                  fontWeight: 500,
                  border: 'none',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
              >
                <RefreshCw style={{ width: 14, height: 14 }} />
                Recarregar app
              </button>
              <button
                onClick={this.reset}
                style={{
                  background: 'rgba(255,255,255,0.04)',
                  color: '#E5E5E5',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: 6,
                  padding: '8px 14px',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                Tentar continuar
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
