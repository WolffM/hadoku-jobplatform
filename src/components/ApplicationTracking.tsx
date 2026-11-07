import { useEffect, useRef, useState } from 'react'
import { JobsApiError, type JobStateRead } from '../api/jobs'
import {
  addJobEvent,
  deleteJobEvent,
  listJobEvents,
  setTracking,
  type JobEvent,
  type PersonEventKind,
  type Priority,
  type Tracking
} from '../api/pipeline'
import type { Auth } from '../api/auth'
import { invalidateResource } from '../api/resource'
import { useResource } from '../api/useResource'

interface Props {
  auth: Auth
  jobId: string
  /** The caller's state; the panel exists only once there is one. */
  state: JobStateRead
  /** From GET /jobs/:id — null when the row was created after the drawer opened. */
  tracking: Tracking | null
  /** Something the board shows changed. */
  onChanged: () => void
}

const EMPTY: Tracking = {
  notes: null,
  priority: null,
  follow_up_at: null,
  contact_name: null,
  contact_email: null
}

const KIND_LABEL: Record<PersonEventKind, string> = {
  note: 'Note',
  interview: 'Interview',
  contact: 'Contact',
  follow_up: 'Follow-up'
}

const STATE_LABEL: Record<string, string> = {
  interested: 'Interested',
  saved: 'Saved',
  applied: 'Applied',
  interviewing: 'Interviewing',
  offered: 'Offered',
  rejected: 'Rejected',
  dismissed: 'Dismissed'
}

const errText = (err: unknown, fallback: string) =>
  err instanceof JobsApiError ? err.message : fallback

/** The text-box form of one tracking field: '' for null, so inputs stay controlled. */
interface Draft {
  priority: '' | '1' | '2' | '3'
  follow_up_at: string
  contact_name: string
  contact_email: string
  notes: string
}

function toDraft(t: Tracking): Draft {
  return {
    priority: t.priority ? (String(t.priority) as Draft['priority']) : '',
    follow_up_at: t.follow_up_at ?? '',
    contact_name: t.contact_name ?? '',
    contact_email: t.contact_email ?? '',
    notes: t.notes ?? ''
  }
}

/** Only the fields that differ from what is stored; '' clears to null. */
function changes(draft: Draft, saved: Draft): Partial<Tracking> {
  const patch: Partial<Tracking> = {}
  if (draft.priority !== saved.priority)
    patch.priority = draft.priority ? (Number(draft.priority) as Priority) : null
  for (const k of ['follow_up_at', 'contact_name', 'contact_email', 'notes'] as const) {
    if (draft[k] !== saved[k]) patch[k] = draft[k].trim() || null
  }
  return patch
}

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  // A person-logged bare date is stored as UTC midnight; showing its clock
  // time would invent one, and showing it local would move it a day.
  const midnight = iso.endsWith('T00:00:00Z') || iso.endsWith('T00:00:00.000Z')
  return midnight
    ? d.toLocaleDateString(undefined, { timeZone: 'UTC', dateStyle: 'medium' })
    : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function localToday(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function TimelineEntry({ event, onDelete }: { event: JobEvent; onDelete?: () => void }) {
  return (
    <li className={`jp-timeline__item jp-timeline__item--${event.kind}`}>
      <div className="jp-timeline__head">
        <span className="jp-timeline__kind">
          {event.kind === 'state'
            ? event.from_state
              ? `${STATE_LABEL[event.from_state] ?? event.from_state} → ${
                  STATE_LABEL[event.to_state ?? ''] ?? event.to_state
                }`
              : `Added as ${STATE_LABEL[event.to_state ?? ''] ?? event.to_state}`
            : KIND_LABEL[event.kind]}
        </span>
        <time className="jp-timeline__when" dateTime={event.occurred_at}>
          {when(event.occurred_at)}
        </time>
        {onDelete && (
          <button
            type="button"
            className="jp-timeline__delete"
            onClick={onDelete}
            aria-label={`Delete this ${KIND_LABEL[event.kind as PersonEventKind].toLowerCase()}`}
          >
            ×
          </button>
        )}
      </div>
      {event.note && <p className="jp-timeline__note">{event.note}</p>}
    </li>
  )
}

/**
 * V5 in the drawer: what the person tracks about one application, and its
 * timeline. State transitions come from the server (every PUT /state that
 * changed something wrote one), so this panel only ever adds the person's
 * own entries — notes, interviews, contacts, follow-ups.
 */
export function ApplicationTracking({ auth, jobId, state, tracking, onChanged }: Props) {
  const stored = useRef<Draft>(toDraft(tracking ?? EMPTY))
  const [draft, setDraft] = useState<Draft>(stored.current)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [kind, setKind] = useState<PersonEventKind>('note')
  const [note, setNote] = useState('')
  const [on, setOn] = useState(localToday)
  const [adding, setAdding] = useState(false)
  const [eventError, setEventError] = useState<string | null>(null)

  const eventsKey = `events:${jobId}`
  const {
    data: events,
    loading: eventsLoading,
    error: eventsLoadError,
    reload
  } = useResource(eventsKey, () => listJobEvents(jobId, auth))

  // A state change in the drawer writes a timeline row server-side; re-read
  // it. Skipped on mount, where useResource is already fetching.
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    invalidateResource(eventsKey)
    reload()
    // reload is a fresh closure each render; `state` is what asks for it.
  }, [state])

  const patch = changes(draft, stored.current)
  const dirty = Object.keys(patch).length > 0

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => {
    setSaved(false)
    setDraft(d => ({ ...d, [k]: v }))
  }

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setSaveError(null)
    try {
      const next = await setTracking(jobId, patch, auth)
      stored.current = toDraft(next)
      setDraft(stored.current)
      setSaved(true)
      invalidateResource(`job:${jobId}:`)
      onChanged()
    } catch (err) {
      setSaveError(errText(err, 'Failed to save'))
    } finally {
      setSaving(false)
    }
  }

  const add = async () => {
    if (!note.trim() || adding) return
    setAdding(true)
    setEventError(null)
    try {
      await addJobEvent(jobId, { kind, note: note.trim(), occurred_at: on || undefined }, auth)
      setNote('')
      invalidateResource(eventsKey)
      reload()
      onChanged()
    } catch (err) {
      setEventError(errText(err, 'Failed to log it'))
    } finally {
      setAdding(false)
    }
  }

  const remove = async (eventId: number) => {
    setEventError(null)
    try {
      await deleteJobEvent(jobId, eventId, auth)
      invalidateResource(eventsKey)
      reload()
      onChanged()
    } catch (err) {
      setEventError(errText(err, 'Failed to delete it'))
    }
  }

  // Newest first reads as a log; the API returns oldest first.
  const timeline = [...(events ?? [])].reverse()

  return (
    <>
      <section className="jp-drawer__section" data-testid="tracking-panel" data-state={state}>
        <h3>Tracking</h3>
        <form
          className="jp-tracking"
          onSubmit={e => {
            e.preventDefault()
            void save()
          }}
        >
          <label className="jp-tracking__field">
            <span>Priority</span>
            <select
              value={draft.priority}
              onChange={e => set('priority', e.target.value as Draft['priority'])}
            >
              <option value="">—</option>
              <option value="1">High</option>
              <option value="2">Normal</option>
              <option value="3">Low</option>
            </select>
          </label>
          <label className="jp-tracking__field">
            <span>Follow up on</span>
            <input
              type="date"
              value={draft.follow_up_at}
              onChange={e => set('follow_up_at', e.target.value)}
              data-testid="tracking-follow-up"
            />
          </label>
          <label className="jp-tracking__field">
            <span>Contact</span>
            <input
              type="text"
              value={draft.contact_name}
              placeholder="Recruiter or hiring manager"
              maxLength={200}
              onChange={e => set('contact_name', e.target.value)}
            />
          </label>
          <label className="jp-tracking__field">
            <span>Contact email</span>
            <input
              type="email"
              value={draft.contact_email}
              maxLength={320}
              onChange={e => set('contact_email', e.target.value)}
            />
          </label>
          <label className="jp-tracking__field jp-tracking__field--wide">
            <span>Notes</span>
            <textarea
              rows={3}
              value={draft.notes}
              maxLength={5000}
              onChange={e => set('notes', e.target.value)}
            />
          </label>
          <div className="jp-tracking__actions">
            <button
              type="submit"
              className="jp-drawer__cta jp-drawer__cta--primary"
              disabled={!dirty || saving}
              data-testid="tracking-save"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {saved && !dirty && <span className="jp-muted">Saved ✓</span>}
          </div>
          {saveError && <p className="jp-error">{saveError}</p>}
        </form>
      </section>

      <section className="jp-drawer__section" data-testid="timeline">
        <h3>Timeline</h3>
        <form
          className="jp-timeline__add"
          onSubmit={e => {
            e.preventDefault()
            void add()
          }}
        >
          <select
            value={kind}
            onChange={e => setKind(e.target.value as PersonEventKind)}
            aria-label="What happened"
          >
            {(Object.keys(KIND_LABEL) as PersonEventKind[]).map(k => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <input
            type="date"
            value={on}
            onChange={e => setOn(e.target.value)}
            aria-label="When it happened"
          />
          <textarea
            className="jp-timeline__add-note"
            rows={2}
            value={note}
            maxLength={5000}
            placeholder="Phone screen with Pat — next round is a system design loop"
            onChange={e => setNote(e.target.value)}
            aria-label="What to log"
            data-testid="timeline-note"
          />
          <button
            type="submit"
            className="jp-drawer__cta"
            disabled={!note.trim() || adding}
            data-testid="timeline-add"
          >
            {adding ? 'Logging…' : 'Log it'}
          </button>
        </form>
        {eventError && <p className="jp-error">{eventError}</p>}
        {eventsLoading && <p className="jp-muted">Loading the timeline…</p>}
        {eventsLoadError !== null && !eventsLoading && (
          <p className="jp-error">{errText(eventsLoadError, 'Failed to load the timeline')}</p>
        )}
        {timeline.length > 0 && (
          <ol className="jp-timeline">
            {timeline.map(ev => (
              <TimelineEntry
                key={ev.id}
                event={ev}
                onDelete={ev.kind === 'state' ? undefined : () => void remove(ev.id)}
              />
            ))}
          </ol>
        )}
        {events && timeline.length === 0 && (
          <p className="jp-muted">
            Nothing recorded yet. Postings tracked before the timeline existed start here.
          </p>
        )}
      </section>
    </>
  )
}
