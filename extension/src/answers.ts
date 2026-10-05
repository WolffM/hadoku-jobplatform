/**
 * The answer for one question on the page, from the packet.
 *
 * In order, and the order is the point:
 * 1. what the APPROVED fill entered for this question — what the owner reviewed;
 * 2. a saved answer to this exact question;
 * 3. a profile fact, when the question IS a field name ("First Name").
 * Anything else is left blank for the owner, never guessed.
 */
import { normalize } from './dom'
import type { Packet, Profile } from './messages'

/** Field names a profile answers, normalised. Whole label only — never a substring. */
const PROFILE_FIELDS: Record<string, (p: Profile) => string | undefined> = {
  'first name': p => p.name.split(' ')[0],
  'legal first name': p => p.name.split(' ')[0],
  'last name': p => p.name.split(' ').slice(1).join(' ') || p.name,
  'last name surname': p => p.name.split(' ').slice(1).join(' ') || p.name,
  'legal last name': p => p.name.split(' ').slice(1).join(' ') || p.name,
  surname: p => p.name.split(' ').slice(1).join(' ') || p.name,
  name: p => p.name,
  'full name': p => p.name,
  'legal name': p => p.name,
  email: p => p.email,
  'email address': p => p.email,
  phone: p => p.phone,
  'phone number': p => p.phone,
  linkedin: p => p.linkedin,
  'linkedin profile': p => p.linkedin,
  'linkedin url': p => p.linkedin,
  'linkedin profile url': p => p.linkedin,
  github: p => p.github,
  'github url': p => p.github,
  'github profile': p => p.github
}

export function answerFor(packet: Packet, question: string): string | null {
  const key = normalize(question)
  if (!key) return null
  const approved = packet.answers[key]
  if (typeof approved === 'string' && approved) return approved
  for (const [q, a] of Object.entries(packet.standing)) {
    if (normalize(q) === key && a) return a
  }
  const field = packet.profile ? PROFILE_FIELDS[key]?.(packet.profile) : undefined
  return field?.trim() ? field.trim() : null
}

/** Whether this question takes several picks, per the fill that saw it. */
export function isMulti(packet: Packet, question: string): boolean {
  return packet.multi.includes(normalize(question))
}

/** The runner's multi-answer separator. */
export function splitAnswer(answer: string): string[] {
  return answer.includes(' | ')
    ? answer
        .split(' | ')
        .map(v => v.trim())
        .filter(Boolean)
    : [answer]
}

/** Stored answers that mean "tick this box" — the runner's AFFIRMATIVE. */
export const AFFIRMATIVE = new Set(['yes', 'y', 'true', 'agree', 'i agree', 'i consent', 'consent'])
