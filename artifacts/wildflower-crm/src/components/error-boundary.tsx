import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * App-level error boundary. Without one, ANY render crash (e.g. an
 * infinite update loop React aborts with "Maximum update depth
 * exceeded") unmounts the entire React tree and leaves the user staring
 * at a blank page. With it, the crash is contained to a friendly error
 * card with a reload option.
 *
 * Class component by necessity — React has no hook equivalent of
 * componentDidCatch / getDerivedStateFromError.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // Surface the crash in the console for debugging; there is no
    // error-reporting backend to send it to.
    console.error("Unhandled render error:", error, info.componentStack);
  }

  private handleReload = () => {
    window.location.reload();
  };

  override render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[100dvh] items-center justify-center bg-background px-4">
          <div
            role="alert"
            className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-lg"
          >
            <h1 className="text-lg font-semibold text-foreground">
              Something went wrong
            </h1>
            <p className="mt-2 text-sm text-muted-foreground">
              This page hit an unexpected error. Reloading usually fixes it —
              if it keeps happening, let the team know what page you were on.
            </p>
            <button
              type="button"
              onClick={this.handleReload}
              className="mt-6 inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Reload page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
