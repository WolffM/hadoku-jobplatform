import { useEffect, useState } from 'react'
import {
  blockCompany,
  getApplicantProfile,
  listBlockedCompanies,
  saveApplicantProfile,
  unblockCompany,
  type ApplicantProfile,
  type Education,
  type WorkExperience
} from '../api/me'
import { JobsApiError } from '../api/jobs'
import type { Auth } from '../api/auth'
import { invalidateResource } from '../api/resource'
import { useResource } from '../api/useResource'

const errText = (err: unknown, fallback: string) =>
  err instanceof JobsApiError ? err.message : fallback

/** The single-line text fields, in form order. */
const TEXT_FIELDS: { key: keyof ApplicantProfile; label: string; type?: string; hint?: string }[] =
  [
    { key: 'name', label: 'Full name' },
    { key: 'email', label: 'Email', type: 'email' },
    { key: 'phone', label: 'Phone', type: 'tel' },
    { key: 'location', label: 'Location', hint: 'As forms should read it — "Seattle, WA"' },
    { key: 'headline', label: 'Headline', hint: '"Staff engineer, distributed systems"' },
    { key: 'linkedin', label: 'LinkedIn URL', type: 'url' },
    { key: 'github', label: 'GitHub URL', type: 'url' },
    { key: 'portfolio', label: 'Portfolio / website', type: 'url' }
  ]

const OPTIONAL_TEXT = [
  'phone',
  'location',
  'headline',
  'summary',
  'linkedin',
  'github',
  'portfolio'
]

const EMPTY: ApplicantProfile = { name: '', email: '' }

const str = (v: unknown) => (typeof v === 'string' || typeof v === 'number' ? String(v) : '')

/**
 * What gets saved: the document as it was read, with the edits laid over it.
 * Keys the editor does not show (the runner's `canned`) are carried through;
 * an emptied optional field is removed rather than stored as ''.
 */
function merged(original: ApplicantProfile | null, draft: ApplicantProfile): ApplicantProfile {
  const out: ApplicantProfile = { ...(original ?? {}), ...draft }
  out.name = out.name.trim()
  out.email = out.email.trim()
  for (const k of OPTIONAL_TEXT) {
    const v = out[k]
    if (typeof v === 'string' && !v.trim()) delete out[k]
    else if (typeof v === 'string') out[k] = v.trim()
  }
  out.work_experience = (draft.work_experience ?? []).filter(w => w.company.trim())
  out.education = (draft.education ?? []).filter(e => e.school.trim())
  return out
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function MonthYear({
  label,
  month,
  year,
  onChange
}: {
  label: string
  month: WorkExperience['start_month']
  year: WorkExperience['start_year']
  onChange: (month: string, year: string) => void
}) {
  // Stored months come as 2, "02" or "February"; numbers match an option,
  // anything else is kept as an option of its own rather than shown as blank.
  const raw = str(month)
  const value = /^\d+$/.test(raw) ? String(Number(raw)) : raw
  const known = value === '' || /^\d+$/.test(value)
  return (
    <span className="jp-me__when">
      <select
        aria-label={`${label} month`}
        value={value}
        onChange={e => onChange(e.target.value, str(year))}
      >
        <option value="">{label}</option>
        {!known && <option value={value}>{value}</option>}
        {MONTHS.map((m, i) => (
          <option key={m} value={String(i + 1)}>
            {m}
          </option>
        ))}
      </select>
      <input
        aria-label={`${label} year`}
        placeholder="Year"
        inputMode="numeric"
        maxLength={4}
        value={str(year)}
        onChange={e => onChange(str(month), e.target.value)}
      />
    </span>
  )
}

function WorkRow({
  row,
  onChange,
  onRemove
}: {
  row: WorkExperience
  onChange: (r: WorkExperience) => void
  onRemove: () => void
}) {
  return (
    <fieldset className="jp-me__row">
      <input
        aria-label="Company"
        placeholder="Company"
        value={row.company}
        onChange={e => onChange({ ...row, company: e.target.value })}
      />
      <input
        aria-label="Title"
        placeholder="Title"
        value={str(row.title)}
        onChange={e => onChange({ ...row, title: e.target.value })}
      />
      <MonthYear
        label="Start"
        month={row.start_month}
        year={row.start_year}
        onChange={(m, y) => onChange({ ...row, start_month: m, start_year: y })}
      />
      {row.current ? (
        <span className="jp-me__present">Present</span>
      ) : (
        <MonthYear
          label="End"
          month={row.end_month}
          year={row.end_year}
          onChange={(m, y) => onChange({ ...row, end_month: m, end_year: y })}
        />
      )}
      <label className="jp-me__check">
        <input
          type="checkbox"
          checked={Boolean(row.current)}
          onChange={e => onChange({ ...row, current: e.target.checked })}
        />
        Current
      </label>
      <button type="button" className="jp-me__remove" onClick={onRemove} aria-label="Remove">
        ×
      </button>
    </fieldset>
  )
}

function EducationRow({
  row,
  onChange,
  onRemove
}: {
  row: Education
  onChange: (r: Education) => void
  onRemove: () => void
}) {
  return (
    <fieldset className="jp-me__row">
      <input
        aria-label="School"
        placeholder="School"
        value={row.school}
        onChange={e => onChange({ ...row, school: e.target.value })}
      />
      <input
        aria-label="Degree"
        placeholder="Degree"
        value={str(row.degree)}
        onChange={e => onChange({ ...row, degree: e.target.value })}
      />
      <input
        aria-label="Field of study"
        placeholder="Field of study"
        value={str(row.discipline)}
        onChange={e => onChange({ ...row, discipline: e.target.value })}
      />
      <input
        aria-label="Start year"
        placeholder="Start year"
        inputMode="numeric"
        value={str(row.start_year)}
        onChange={e => onChange({ ...row, start_year: e.target.value })}
      />
      <input
        aria-label="End year"
        placeholder="End year"
        inputMode="numeric"
        value={str(row.end_year)}
        onChange={e => onChange({ ...row, end_year: e.target.value })}
      />
      <button type="button" className="jp-me__remove" onClick={onRemove} aria-label="Remove">
        ×
      </button>
    </fieldset>
  )
}

function ApplicantProfileForm({ auth }: { auth: Auth }) {
  const {
    data,
    loading,
    error: loadError
  } = useResource('applicant-profile', () => getApplicantProfile(auth))
  const [draft, setDraft] = useState<ApplicantProfile | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Seed the form once, from the first read. A later background refresh must
  // not overwrite what the person is typing.
  useEffect(() => {
    if (data !== undefined && draft === null) setDraft(data ?? EMPTY)
  }, [data, draft])

  if (loading || draft === null) {
    if (loadError) return <p className="jp-error">{errText(loadError, 'Failed to load')}</p>
    return <p className="jp-muted">Loading your profile…</p>
  }

  const set = (patch: Partial<ApplicantProfile>) => {
    setSavedAt(null)
    setDraft(d => ({ ...(d ?? EMPTY), ...patch }))
  }
  const work = draft.work_experience ?? []
  const education = draft.education ?? []

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      const doc = merged(data ?? null, draft)
      const at = await saveApplicantProfile(doc, auth)
      // The palette and the next visit read the saved document.
      invalidateResource('applicant-profile')
      setDraft(doc)
      setSavedAt(at)
    } catch (err) {
      setSaveError(errText(err, 'Failed to save'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <form
      className="jp-me__form"
      onSubmit={e => {
        e.preventDefault()
        void save()
      }}
      data-testid="applicant-profile-form"
    >
      <p className="jp-muted">
        What an application form asks about you. The Fill extension fills from it, and the
        drawer&apos;s Quick copy reads it for the forms you fill by hand.
      </p>
      <div className="jp-me__grid">
        {TEXT_FIELDS.map(f => (
          <label key={f.key} className="jp-me__field">
            <span>
              {f.label}
              {(f.key === 'name' || f.key === 'email') && ' *'}
            </span>
            <input
              type={f.type ?? 'text'}
              value={str(draft[f.key])}
              required={f.key === 'name' || f.key === 'email'}
              placeholder={f.hint}
              onChange={e => set({ [f.key]: e.target.value })}
              data-testid={`me-${f.key}`}
            />
          </label>
        ))}
        <label className="jp-me__field jp-me__field--wide">
          <span>Summary</span>
          <textarea
            rows={4}
            value={str(draft.summary)}
            placeholder="Two or three sentences for the 'tell us about yourself' box"
            onChange={e => set({ summary: e.target.value })}
          />
        </label>
      </div>

      <h3 className="jp-me__subhead">Work history</h3>
      {work.map((row, i) => (
        <WorkRow
          key={i}
          row={row}
          onChange={r => set({ work_experience: work.map((w, j) => (j === i ? r : w)) })}
          onRemove={() => set({ work_experience: work.filter((_, j) => j !== i) })}
        />
      ))}
      <button
        type="button"
        className="jp-drawer__cta"
        onClick={() => set({ work_experience: [...work, { company: '' }] })}
      >
        Add a role
      </button>

      <h3 className="jp-me__subhead">Education</h3>
      {education.map((row, i) => (
        <EducationRow
          key={i}
          row={row}
          onChange={r => set({ education: education.map((x, j) => (j === i ? r : x)) })}
          onRemove={() => set({ education: education.filter((_, j) => j !== i) })}
        />
      ))}
      <button
        type="button"
        className="jp-drawer__cta"
        onClick={() => set({ education: [...education, { school: '' }] })}
      >
        Add a school
      </button>

      <div className="jp-me__actions">
        <button
          type="submit"
          className="jp-drawer__cta jp-drawer__cta--primary"
          disabled={saving}
          data-testid="me-save"
        >
          {saving ? 'Saving…' : 'Save profile'}
        </button>
        {savedAt && <span className="jp-muted">Saved ✓</span>}
      </div>
      {saveError && <p className="jp-error">{saveError}</p>}
    </form>
  )
}

function BlockedCompanies({ auth }: { auth: Auth }) {
  const { data, loading, error, reload } = useResource('blocked-companies', () =>
    listBlockedCompanies(auth)
  )
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setActionError(null)
    try {
      await fn()
      invalidateResource('blocked-companies')
      // Every cached feed page may now hold, or be missing, that employer.
      invalidateResource('jobs:')
      reload()
    } catch (err) {
      setActionError(errText(err, 'Request failed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="blocked-companies">
      <p className="jp-muted">
        Their postings never reach your feed. Your pipeline and the State filter still find anything
        you already track.
      </p>
      <form
        className="jp-me__block-add"
        onSubmit={e => {
          e.preventDefault()
          if (!name.trim()) return
          void run(() => blockCompany(name.trim(), auth)).then(() => setName(''))
        }}
      >
        <input
          aria-label="Company to hide"
          placeholder="Company name"
          value={name}
          onChange={e => setName(e.target.value)}
        />
        <button type="submit" className="jp-drawer__cta" disabled={busy || !name.trim()}>
          Hide
        </button>
      </form>
      {actionError && <p className="jp-error">{actionError}</p>}
      {loading && <p className="jp-muted">Loading…</p>}
      {error !== null && !loading && (
        <p className="jp-error">{errText(error, 'Failed to load hidden companies')}</p>
      )}
      {data && data.length === 0 && <p className="jp-muted">You haven&apos;t hidden anyone.</p>}
      {data && data.length > 0 && (
        <ul className="jp-me__blocked">
          {data.map(c => (
            <li key={c.company_key}>
              <span>{c.company}</span>
              <button
                type="button"
                className="jp-drawer__link"
                disabled={busy}
                onClick={() => void run(() => unblockCompany(c.company, auth))}
              >
                Show again
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * The Profile tab: the person, as opposed to a scoring profile (those stay in
 * the feed's sidebar, because they are lenses on the feed).
 */
export function ProfilePage({ auth }: { auth: Auth }) {
  if (!auth.signedIn) {
    return <p className="jp-muted">Your profile is per-account — sign in to edit it.</p>
  }
  return (
    <div className="jp-me">
      <section className="jp-me__section">
        <h2>About you</h2>
        <ApplicantProfileForm auth={auth} />
      </section>
      <section className="jp-me__section">
        <h2>Hidden companies</h2>
        <BlockedCompanies auth={auth} />
      </section>
    </div>
  )
}
