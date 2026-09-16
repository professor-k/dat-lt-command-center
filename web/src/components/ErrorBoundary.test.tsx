import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

function Explode(): never {
  throw new Error('telemetry panel blew up');
}

describe('ErrorBoundary', () => {
  // React logs the caught error itself; the test knows about it and does not need it in
  // the output, and componentDidCatch logs one of its own.
  beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it('renders its children when nothing is wrong', () => {
    render(
      <ErrorBoundary>
        <p>Fleet telemetry</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('Fleet telemetry')).toBeInTheDocument();
  });

  it('offers a reload instead of a blank screen when a view throws', () => {
    render(
      <ErrorBoundary>
        <Explode />
      </ErrorBoundary>,
    );

    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
    expect(screen.getByText(/telemetry panel blew up/)).toBeInTheDocument();
  });
});
