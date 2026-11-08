import { useEffect, useRef, useState } from 'react'
import { getApplicantProfile, type ApplicantProfile } from '../api/me'
import type { Auth } from '../api/auth'
import { useResource } from '../api/useResource'

/** What a hand-filled application form asks for, in roughly the order it asks. */
function entries(p: ApplicantProfile): { label: string; value: string }[] {
  const current = p.work_experience?.find(w => w.current) ?? p.work_experience?.[0]
  const list: [string, string | undefined][] = [
    ['Name', p.name],
    ['Email', p.email],
    ['Phone', p.phone],
    ['Location', p.location],
    ['LinkedIn', p.linkedin],
    ['GitHub', p.github],
    ['Portfolio', p.portfolio],
    ['Current role', current ? [current.title, current.company].filter(Boolean).join(' at ') : ''],
    ['Headline', p.headline],
    ['Summary', p.summary]
  ]
  return list.flatMap(([label, value]) => (value?.trim() ? [{ label, value: value.trim() }] : []))
}

/**
 * One-click copies of the applicant profile, for the forms the Fill extension
 * cannot reach. Reads the same document the extension does (GET
 * /applicant-profile); the Profile tab is where it is edited.
 */
export function ClipboardPalette({ auth }: { auth: Auth }) {
  const { data: profile, error } = useResource('applicant-profile', () => getApplicantProfile(auth))
  const [copied, setCopied] = useState<string | null>(null)
  const [copyError, setCopyError] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  if (error || profile === undefined) return null
  if (profile === null) {
    return (
      <p className="jp-muted jp-palette__empty">
        Fill in the Profile tab and your contact details appear here as one-click copies.
      </p>
    )
  }

  const copy = (label: string, value: string) => {
    if (!navigator.clipboard) {
      setCopyError(true)
      return
    }
    navigator.clipboard.writeText(value).then(
      () => {
        setCopyError(false)
        setCopied(label)
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(null), 1500)
      },
      () => setCopyError(true)
    )
  }

  return (
    <div className="jp-palette" data-testid="clipboard-palette">
      <span className="jp-palette__label">Quick copy</span>
      <div className="jp-palette__chips">
        {entries(profile).map(({ label, value }) => (
          <button
            key={label}
            type="button"
            className={`jp-palette__chip${copied === label ? ' jp-palette__chip--copied' : ''}`}
            title={value}
            onClick={() => copy(label, value)}
          >
            {copied === label ? 'Copied ✓' : label}
          </button>
        ))}
      </div>
      {copyError && (
        <p className="jp-error">The browser refused the clipboard — copy from the Profile tab.</p>
      )}
    </div>
  )
}
