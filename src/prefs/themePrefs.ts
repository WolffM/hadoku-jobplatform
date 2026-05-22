/**
 * Canonical theme-preferences client.
 *
 * Theme is platform-global: every app and the portfolio shell read/write the
 * SAME row, so it lives under the shared appId 'portfolio' (NOT this app's own
 * id) with device scope. This file is identical across every child app and the
 * portfolio shell.
 */
import { z } from 'zod'
import { createPrefsClient } from '@wolffm/prefs-client'

export const ThemePrefsSchema = z.object({
  theme: z.string().optional(),
  themeMode: z.enum(['simple', 'advanced']).optional()
})

export type ThemePrefs = z.infer<typeof ThemePrefsSchema>

export const themePrefs = createPrefsClient({
  appId: 'portfolio',
  schema: ThemePrefsSchema,
  bootstrapToSessionStorage: { theme: 'hadoku-theme' }
})
