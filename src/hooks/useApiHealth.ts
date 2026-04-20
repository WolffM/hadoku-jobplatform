/**
 * useApiHealth Hook
 *
 * Monitors the health of a backend API and provides status for UI display.
 * Use this when your UI has a corresponding Worker API.
 *
 * @example
 * ```tsx
 * import { useApiHealth } from './hooks/useApiHealth';
 *
 * function App({ apiBaseUrl }: { apiBaseUrl?: string }) {
 *   const health = useApiHealth(apiBaseUrl || '/api/my-app');
 *
 *   return (
 *     <div>
 *       {health.loading && <span>Checking API...</span>}
 *       {health.healthy && <span>API Connected</span>}
 *       {health.error && <span>API Error: {health.error}</span>}
 *     </div>
 *   );
 * }
 * ```
 */

import { useState, useEffect, useCallback } from 'react'

export interface HealthStatus {
  /** Whether the API is responding with healthy status */
  healthy: boolean
  /** Whether a health check is in progress */
  loading: boolean
  /** Error message if health check failed */
  error: string | null
  /** When the last health check completed */
  lastChecked: Date | null
  /** The raw response from the health endpoint */
  details: HealthResponse | null
}

export interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  service: string
  timestamp: string
  [key: string]: unknown
}

/**
 * Hook to monitor API health status
 *
 * @param apiBase - Base URL of the API (e.g., '/api/my-app' or 'https://my-app-api.workers.dev')
 * @param interval - How often to check health in milliseconds (default: 30000 = 30 seconds)
 * @returns Health status object
 */
export function useApiHealth(apiBase: string, interval = 30000) {
  const [status, setStatus] = useState<HealthStatus>({
    healthy: false,
    loading: true,
    error: null,
    lastChecked: null,
    details: null
  })

  const checkHealth = useCallback(async () => {
    if (!apiBase) {
      setStatus({
        healthy: false,
        loading: false,
        error: 'No API base URL provided',
        lastChecked: new Date(),
        details: null
      })
      return
    }

    try {
      const healthUrl = apiBase.endsWith('/health') ? apiBase : `${apiBase}/health`
      const response = await fetch(healthUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/json'
        }
      })

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = (await response.json()) as HealthResponse

      setStatus({
        healthy: data.status === 'healthy',
        loading: false,
        error: data.status === 'unhealthy' ? 'API reports unhealthy status' : null,
        lastChecked: new Date(),
        details: data
      })
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error'
      console.error('[useApiHealth] Health check failed:', errorMessage)

      setStatus({
        healthy: false,
        loading: false,
        error: errorMessage,
        lastChecked: new Date(),
        details: null
      })
    }
  }, [apiBase])

  useEffect(() => {
    // Initial check
    void checkHealth()

    // Set up periodic checks
    const timer = setInterval(() => {
      void checkHealth()
    }, interval)

    return () => clearInterval(timer)
  }, [checkHealth, interval])

  return {
    ...status,
    refresh: () => {
      void checkHealth()
    }
  }
}

/**
 * Alias for useApiHealth — refresh is included in the return value of both hooks.
 */
export function useApiHealthWithRefresh(apiBase: string, interval = 30000) {
  return useApiHealth(apiBase, interval)
}
