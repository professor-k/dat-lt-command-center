import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { AuthProvider } from './auth';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live updates arrive over SSE; polling is the safety net.
      refetchInterval: 60_000,
      refetchOnWindowFocus: true,
      staleTime: 15_000,
      retry: (failureCount, error) =>
        !(error as { status?: number }).status || (error as { status?: number }).status! >= 500
          ? failureCount < 2
          : false,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </AuthProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
