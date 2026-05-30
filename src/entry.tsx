import { createRoot, type Root } from 'react-dom/client'
import { logger } from '@wolffm/logger/client'
import App from './App'
// REQUIRED: Import @wolffm/themes CSS - DO NOT REMOVE
import '@wolffm/themes/style.css'
// REQUIRED: Import theme picker CSS
import '@wolffm/task-ui-components/theme-picker.css'
import './styles/index.css'

// Props interface for configuration from parent app
export interface JobPlatformProps {
  theme?: string
  /**
   * Session id from the parent's `hadoku_session` cookie. Sent as
   * `X-Session-Id`; edge-router resolves it to the underlying key. Raw
   * credentials never enter the MFE.
   */
  sessionId?: string
}

interface JobPlatformElement extends HTMLElement {
  __root?: Root
}

export function mount(el: HTMLElement, props: JobPlatformProps = {}) {
  const root = createRoot(el)
  root.render(<App {...props} />)
  ;(el as JobPlatformElement).__root = root
  logger.info('[job-platform] Mounted successfully', { theme: props.theme })
}

export function unmount(el: HTMLElement) {
  ;(el as JobPlatformElement).__root?.unmount()
  logger.info('[job-platform] Unmounted successfully')
}
