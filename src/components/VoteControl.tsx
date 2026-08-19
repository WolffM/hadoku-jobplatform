import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { setJobFeedback, clearJobFeedback, type FeedbackReason, type VoteValue } from '../api/jobs'
import type { Auth } from '../api/auth'

interface Props {
  jobId: string
  auth: Auth
  vote: VoteValue | null
  // Called optimistically on every vote transition (and again to revert if
  // the request fails) — the parent owns the displayed value.
  onVoteChange: (jobId: string, vote: VoteValue | null) => void
  disabled?: boolean
  // Which edge the reason popover hangs from. Cards sit at the right edge of
  // the list so they anchor 'end'; the drawer control anchors 'start'.
  align?: 'start' | 'end'
}

// Reason chips are contextual to the vote direction. Both lists reuse the
// same axis keys ('domain', 'company') — the vote sign disambiguates.
const DOWN_REASONS: { reason: FeedbackReason; label: string }[] = [
  { reason: 'pay', label: 'Pay too low' },
  { reason: 'location', label: 'Wrong location' },
  { reason: 'stack', label: 'Wrong stack' },
  { reason: 'domain', label: 'Boring domain' },
  { reason: 'level', label: 'Wrong level' },
  { reason: 'company', label: 'Company' },
  { reason: 'other', label: 'Other' }
]

const UP_REASONS: { reason: FeedbackReason; label: string }[] = [
  { reason: 'domain', label: 'Exciting domain' },
  { reason: 'comp', label: 'Great comp' },
  { reason: 'fit', label: 'Great fit' },
  { reason: 'company', label: 'Dream company' },
  { reason: 'other', label: 'Other' }
]

/**
 * One-tap posting feedback: 👍/👎 plus a single reason chip. Clicking a thumb
 * opens the direction's reason chips; a chip fires the PUT and closes.
 * Clicking the already-active thumb clears the vote (DELETE). Everything is
 * optimistic — the vote flips immediately and reverts on error — so ripping
 * through a hundred postings never waits on the network.
 */
export function VoteControl({ jobId, auth, vote, onVoteChange, disabled, align = 'end' }: Props) {
  const [openFor, setOpenFor] = useState<VoteValue | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const handleThumb = (dir: VoteValue) => {
    if (vote === dir) {
      // Second tap on the active thumb clears the vote.
      setOpenFor(null)
      onVoteChange(jobId, null)
      clearJobFeedback(jobId, auth).catch(() => onVoteChange(jobId, dir))
      return
    }
    setOpenFor(prev => (prev === dir ? null : dir))
  }

  const handleReason = (dir: VoteValue, reason: FeedbackReason) => {
    const prev = vote
    setOpenFor(null)
    onVoteChange(jobId, dir)
    setJobFeedback(jobId, dir, reason, auth).catch(() => onVoteChange(jobId, prev))
  }

  // Close the popover when focus leaves the control — covers both tabbing
  // away and clicking elsewhere, without a document-level listener.
  const handleBlur = (e: FocusEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node)) setOpenFor(null)
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && openFor !== null) {
      // Swallow it so an enclosing drawer doesn't also close.
      e.stopPropagation()
      setOpenFor(null)
    }
  }

  const reasons = openFor === -1 ? DOWN_REASONS : UP_REASONS

  return (
    <div
      ref={rootRef}
      className={`jp-vote${align === 'start' ? ' jp-vote--start' : ''}`}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      // The control lives inside clickable job cards — votes must not also
      // open the drawer.
      onClick={e => e.stopPropagation()}
    >
      <button
        type="button"
        className={`jp-vote__thumb jp-vote__thumb--up${vote === 1 ? ' jp-vote__thumb--active' : ''}`}
        disabled={disabled}
        onClick={() => handleThumb(1)}
        aria-pressed={vote === 1}
        aria-label={vote === 1 ? 'Clear upvote' : 'Upvote'}
        title={vote === 1 ? 'Clear upvote' : 'Upvote'}
        data-testid="vote-up"
      >
        👍
      </button>
      <button
        type="button"
        className={`jp-vote__thumb jp-vote__thumb--down${
          vote === -1 ? ' jp-vote__thumb--active' : ''
        }`}
        disabled={disabled}
        onClick={() => handleThumb(-1)}
        aria-pressed={vote === -1}
        aria-label={vote === -1 ? 'Clear downvote' : 'Downvote'}
        title={vote === -1 ? 'Clear downvote' : 'Downvote'}
        data-testid="vote-down"
      >
        👎
      </button>
      {openFor !== null && (
        <div className="jp-vote__reasons" role="menu" aria-label="Why?" data-testid="vote-reasons">
          {reasons.map(({ reason, label }) => (
            <button
              key={reason}
              type="button"
              role="menuitem"
              className="jp-vote__reason"
              onClick={() => handleReason(openFor, reason)}
              data-testid={`vote-reason-${reason}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
