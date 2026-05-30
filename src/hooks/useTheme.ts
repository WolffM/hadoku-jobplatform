import { useState, useEffect, useRef, type RefObject } from 'react'
import { setTheme as applyTheme } from '@wolffm/themes'
import { usePrefs } from '@wolffm/prefs-client/react'
import { logger } from '@wolffm/logger/client'
import { getThemeFamilies } from '../app/themeConfig'
import { themePrefs } from '../prefs/themePrefs'

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

  // Subscribe to the cross-device prefs row so a freshly opened tab adopts
  // the persisted theme as soon as the SDK resolves — the useState seed
  // above only sees sessionStorage / data-theme, neither of which survives
  // a browser close. Without this read, `themePrefs.save` was effectively
  // write-only and the theme appeared to reset between sessions.
  const { prefs: persistedPrefs, save: savePrefs } = usePrefs(themePrefs)
  // Track whether the user has already changed the theme this session, so a
  // late prefs resolve doesn't yank them back to the old persisted value.
  const userOverroteThemeRef = useRef(false)

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

  // When the prefs SDK resolves the persisted row, adopt that theme — but
  // only if the user hasn't already changed it this session AND it differs
  // from what we currently have. propsTheme (from the parent shell) takes
  // priority since the shell already plumbs the SDK read through.
  useEffect(() => {
    if (propsTheme) return
    if (userOverroteThemeRef.current) return
    const persisted = persistedPrefs?.theme
    if (persisted && persisted !== theme && isThemeAvailable(persisted)) {
      setThemeState(persisted)
    }
  }, [persistedPrefs?.theme, propsTheme])

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
    userOverroteThemeRef.current = true
    // Synchronous sessionStorage write preserves FOUC + same-tab behavior.
    try {
      sessionStorage.setItem('hadoku-theme', newTheme)
    } catch (err) {
      logger.error('[useTheme] Failed to save theme to sessionStorage:', {
        error: (err as Error)?.message ?? String(err)
      })
    }
    // Persist via the unified prefs store. Use the live save() returned by
    // usePrefs so the SDK can update its in-memory cache (otherwise the
    // next read could race a stale snapshot back into state). Log failures
    // instead of swallowing — silent saves were the original "my theme
    // reset" bug.
    savePrefs({ theme: newTheme }, { scope: 'device' }).catch(err => {
      logger.error('[useTheme] prefs save failed:', {
        error: (err as Error)?.message ?? String(err),
        theme: newTheme
      })
    })
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
