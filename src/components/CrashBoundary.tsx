import { Component, type ErrorInfo, type ReactNode } from 'react'
import { flush, track } from '../telemetry'

interface State {
  error: Error | null
}

/**
 * A render crash used to unmount the whole app and leave a blank page with no
 * record. Now it leaves both a message for the person and a `ui.error` row.
 */
export class CrashBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    track(
      'ui.error',
      {
        message: error.message,
        name: error.name,
        component: info.componentStack?.trim().split('\n')[0] ?? null
      },
      'error'
    )
    flush()
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="jp-crash" role="alert">
        <p>Something broke while showing this page: {this.state.error.message}</p>
        <button type="button" onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    )
  }
}
