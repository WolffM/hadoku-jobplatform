import { useRef, useState, type FocusEvent, type KeyboardEvent } from 'react'
import { setJobFeedback, clearJobFeedback, type FeedbackReason, type VoteValue } from '../api/jobs'
import type { Auth } from '../api/auth'

interface Props {
  jobId: string
  auth: Auth
  vote: VoteValue | null
  reasons: FeedbackReason[]
  // Called optimistically on every transition (and again to revert if the
  // request fails) — the parent owns the displayed value.
  onVoteChange: (jobId: string, vote: VoteValue | null, reasons: FeedbackReason[]) => void
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
 * One-tap posting feedback: 👍/👎 plus MULTI-select reason chips. Tapping a
 * thumb saves the vote immediately and opens the direction's chips; each chip
 * toggles and saves (idempotent upsert) with the popover staying open until
 * blur/Escape, so several reasons can be stacked. Tapping the active thumb
 * clears the vote (DELETE). Everything is optimistic — values flip
 * immediately and revert on error — so ripping through a hundred postings
 * never waits on the network.
 */
export function VoteControl({
  jobId,
  auth,
  vote,
  reasons,
  onVoteChange,
  disabled,
  align = 'end'
}: Props) {
  const [openFor, setOpenFor] = useState<VoteValue | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const handleThumb = (dir: VoteValue) => {
    if (vote === dir) {
      // Second tap on the active thumb clears the vote.
      const prevReasons = reasons
      setOpenFor(null)
      onVoteChange(jobId, null, [])
      clearJobFeedback(jobId, auth).catch(() => onVoteChange(jobId, dir, prevReasons))
      return
    }
    // The vote saves immediately — reasons are optional garnish on top.
    const prevVote = vote
    const prevReasons = reasons
    onVoteChange(jobId, dir, [])
    setJobFeedback(jobId, dir, [], auth).catch(() => onVoteChange(jobId, prevVote, prevReasons))
    setOpenFor(dir)
  }

  const handleReasonToggle = (dir: VoteValue, reason: FeedbackReason) => {
    const prevReasons = reasons
    const next = prevReasons.includes(reason)
      ? prevReasons.filter(r => r !== reason)
      : [...prevReasons, reason]
    onVoteChange(jobId, dir, next)
    setJobFeedback(jobId, dir, next, auth).catch(() => onVoteChange(jobId, dir, prevReasons))
    // Popover stays open — multi-select until blur/Escape/thumb.
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

  const chipSet = openFor === -1 ? DOWN_REASONS : UP_REASONS

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
          {chipSet.map(({ reason, label }) => (
            <button
              key={reason}
              type="button"
              role="menuitemcheckbox"
              aria-checked={reasons.includes(reason)}
              className={`jp-vote__reason${reasons.includes(reason) ? ' jp-vote__reason--active' : ''}`}
              onClick={() => handleReasonToggle(openFor, reason)}
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
