import { useState, useEffect, type RefObject } from 'react'
import { setTheme as applyTheme } from '@wolffm/themes'
import { logger } from '@wolffm/task-ui-components'
import { getThemeFamilies } from '../app/themeConfig'

interface UseThemeOptions {
  propsTheme?: string
  experimentalThemes?: boolean
  containerRef?: RefObject<HTMLElement | null>
}

export function useTheme(options: UseThemeOptions = {}) {
  const { propsTheme, experimentalThemes = false, containerRef } = options

  const [theme, setThemeState] = useState<string>(() => {
    // Priority: props > what inline script set > sessionStorage > browser preference > 'light'
    if (propsTheme) return propsTheme

    // IMPORTANT: Read what the inline script already set on <html>
    // This prevents flashing when React takes over
    const htmlTheme = document.documentElement.getAttribute('data-theme')
    if (htmlTheme) return htmlTheme

    // Fallback: re-check sessionStorage and browser preference
    const saved = sessionStorage.getItem('hadoku-theme')
    if (saved) return saved

    if (window.matchMedia) {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      return prefersDark ? 'dark' : 'light'
    }

    return 'light'
  })

  const [isThemeReady, setIsThemeReady] = useState(false)
  const [isInitialThemeLoad, setIsInitialThemeLoad] = useState(true)

  // Get available theme families
  const THEME_FAMILIES = getThemeFamilies(experimentalThemes)

  // Validate theme is available
  function isThemeAvailable(themeName: string): boolean {
    return THEME_FAMILIES.some(f => f.lightTheme === themeName || f.darkTheme === themeName)
  }

  // Apply theme to DOM
  useEffect(() => {
    // Validate and fallback to 'light' if theme not available
    const validTheme = isThemeAvailable(theme) ? theme : 'light'

    // Apply to document root
    document.documentElement.setAttribute('data-theme', validTheme)

    // Also apply to container (microfrontend compatibility)
    if (containerRef?.current) {
      containerRef.current.setAttribute('data-theme', validTheme)
    }

    // Use @wolffm/themes utility
    applyTheme(validTheme as Parameters<typeof applyTheme>[0])

    // Delay theme ready on initial load to prevent FOUC
    if (isInitialThemeLoad) {
      const timer = setTimeout(() => {
        setIsThemeReady(true)
        setIsInitialThemeLoad(false)
      }, 50)
      return () => clearTimeout(timer)
    } else {
      setIsThemeReady(true)
    }
  }, [theme, containerRef, isInitialThemeLoad])

  // Auto-switch theme variant on system preference change
  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')

    const handleColorSchemeChange = (e: MediaQueryListEvent | MediaQueryList) => {
      const prefersDark = e.matches
      const themeFamily = theme.replace(/-light$|-dark$/, '')
      const currentMode = theme.endsWith('-dark') ? 'dark' : 'light'

      // Only auto-switch if using a theme family (not base light/dark)
      if (themeFamily !== 'light' && themeFamily !== 'dark') {
        const targetMode = prefersDark ? 'dark' : 'light'
        if (currentMode !== targetMode) {
          const newTheme = `${themeFamily}-${targetMode}`
          setTheme(newTheme)
        }
      }
    }

    mediaQuery.addEventListener('change', handleColorSchemeChange)
    return () => mediaQuery.removeEventListener('change', handleColorSchemeChange)
  }, [theme])

  const setTheme = (newTheme: string) => {
    setThemeState(newTheme)
    // Save to sessionStorage for persistence
    try {
      sessionStorage.setItem('hadoku-theme', newTheme)
    } catch (err) {
      logger.error('[useTheme] Failed to save theme:', err as Record<string, unknown>)
    }
  }

  const isDarkTheme = theme.endsWith('-dark') || theme === 'dark'

  return {
    theme,
    setTheme,
    isDarkTheme,
    isThemeReady,
    isInitialThemeLoad,
    THEME_FAMILIES
  }
}
