/**
 * "Apply for me", as one call the feed and the drawer both make.
 *
 * Handing a posting to the form runner is four requests, not one: tailor the
 * résumé, build the rest of the kit, mint the packet link, then queue. The
 * variant_slug the mint returns is what `POST /jobs/:id/apply` pins onto the
 * application row, so a later re-tailor cannot change what an in-flight
 * application sends — which is why the packet has to exist BEFORE the queue
 * call, and why this is a sequence rather than a button wired straight to the
 * queue endpoint.
 *
 * It lives here rather than in a component because two places now start it (a
 * feed card and the drawer) and both must run the same sequence. Duplicating
 * it would mean duplicating the rate-limit reasoning below, and that is exactly
 * the kind of comment that only gets fixed in one copy.
 */
import {
  generateResume,
  generateApplicationExtras,
  generateCoverLetter,
  mintPacketLink,
  queueApplication,
  JobsApiError
} from './jobs'
import type { Auth } from './auth'

/** Where one job is in the sequence. `error` carries a reason; the rest don't. */
export type ApplyPhase = 'idle' | 'waiting' | 'preparing' | 'queueing' | 'queued' | 'error'

export interface ApplyStatus {
  phase: ApplyPhase
  error?: string
}

/**
 * Run the whole sequence for one job and return the packet slug.
 *
 * The two generation calls are SEQUENCED, not concurrent. The résumé is the
 * token-heavy one (block selection + rewrite), so it runs alone; then a single
 * application-extras call returns the cover letter and the rest of the kit
 * together. Firing the cover letter and the extras as separate back-to-back
 * calls used to stack past Groq's per-minute token cap so the trailing one
 * 500'd, leaving a packet with a résumé and no kit.
 */
export async function prepareApplicationPacket(
  jobId: string,
  auth: Auth,
  onPhase?: (phase: ApplyPhase) => void
): Promise<{ slug: string; url: string; resume: string; coverLetter: string }> {
  onPhase?.('preparing')
  const resume = await generateResume(jobId, auth)

  // The kit is best-effort: a posting whose extras call fails can still be
  // queued off the résumé alone, and refusing to queue over a missing cover
  // letter would be a worse answer than queueing without one.
  let coverLetter = ''
  try {
    const kit = await generateApplicationExtras(
      jobId,
      { resume_markdown: resume.resume_markdown },
      auth
    )
    coverLetter =
      kit.cover_letter_markdown || (await generateCoverLetter(jobId, auth)).cover_letter_markdown
  } catch {
    // fall through with an empty cover letter
  }

  const { url, slug } = await mintPacketLink(
    jobId,
    {
      resume_markdown: resume.resume_markdown,
      ...(coverLetter ? { cover_letter_markdown: coverLetter } : {})
    },
    auth
  )
  return { slug, url, resume: resume.resume_markdown, coverLetter }
}

/**
 * Handing a posting to the runner is now ONE request.
 *
 * It used to be four: résumé, kit, mint, queue — about 21 seconds of LLM work
 * per posting, run in this tab behind a one-at-a-time lane so the generations
 * could not stack past the per-minute token cap. That made a click look
 * accepted while nothing durable existed. Queueing eight postings meant the
 * last began two and a half minutes later, and closing the tab, reloading, or
 * switching to Applications discarded everything the lane had not reached —
 * along with every error, so there was no record the owner had ever asked.
 *
 * `POST /jobs/:id/apply` no longer needs a minted packet. The row is written
 * immediately and the runner mints the packet just before it fills, so the
 * click is a single fast write that survives the tab. The lane is gone with
 * the work it was protecting.
 */

/** Hand one posting to the runner. One request, durable the moment it returns. */
export async function enqueueApply(
  jobId: string,
  auth: Auth,
  onStatus: (status: ApplyStatus) => void
): Promise<void> {
  onStatus({ phase: 'queueing' })
  try {
    await queueApplication(jobId, 'review', auth)
    onStatus({ phase: 'queued' })
  } catch (err) {
    onStatus({
      phase: 'error',
      error:
        err instanceof JobsApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to hand this to the runner'
    })
  }
}
