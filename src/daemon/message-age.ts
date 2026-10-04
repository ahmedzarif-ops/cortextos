/**
 * Age label for delivered messages.
 *
 * A restart can re-deliver a message that was sent long ago, and it arrives
 * looking exactly like a new one. An agent that answers it as current replies
 * days late to something already handled. Messages older than the threshold
 * carry their age in front, so the reader sees it before acting.
 */

export const MESSAGE_AGE_THRESHOLD_MS = 60 * 60_000;

/** "[AGE: 2d 3h] " for a message older than the threshold, else "". Never throws. */
export function ageLabel(sentAtMs: number | null | undefined, nowMs: number = Date.now()): string {
  if (typeof sentAtMs !== 'number' || !Number.isFinite(sentAtMs)) return '';
  const age = nowMs - sentAtMs;
  if (age < MESSAGE_AGE_THRESHOLD_MS) return '';
  const totalMin = Math.floor(age / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  const parts = d > 0 ? [`${d}d`, `${h}h`] : [`${h}h`, `${m}m`];
  return `[AGE: ${parts.join(' ')}] `;
}

/**
 * Insert the age as its own line directly AFTER the header line. The header
 * must stay first: runtime adapters recognise a delivery by an anchored match
 * on it (e.g. /^=== TELEGRAM/), and a prefix would hide the message from them.
 */
export function withAgeLine(formatted: string, label: string): string {
  if (!label) return formatted;
  const line = label.trim();
  const nl = formatted.indexOf('\n');
  if (nl < 0) return `${formatted}\n${line}`;
  return `${formatted.slice(0, nl + 1)}${line}\n${formatted.slice(nl + 1)}`;
}

/** ageLabel for an ISO 8601 timestamp; unparseable or missing gives "". */
export function ageLabelFromIso(iso: string | null | undefined, nowMs: number = Date.now()): string {
  return ageLabel(iso ? Date.parse(iso) : null, nowMs);
}
