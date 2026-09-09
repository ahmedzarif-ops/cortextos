import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Render an agent-supplied display field (role, description, tagline) safely.
 *
 * Agent bootstrap files ship as TEMPLATES whose unfilled fields are HTML
 * COMMENTS — e.g. IDENTITY.md carries
 *   <!-- What this agent does (e.g., content creator, dev ops, researcher) -->
 * until onboarding replaces it. The dashboard was printing that raw string into
 * the Agent Fleet card, so a not-yet-onboarded agent advertised the instructions
 * for filling itself in. Reported by the owner from his phone, 2026-08-26.
 *
 * This fixes the CLASS, not one agent: any display field that is empty, a bare
 * HTML comment, or an obvious placeholder falls back to the agent's slug.
 *
 * NOTE the ordering — test the ORIGINAL string for a comment BEFORE any
 * splitting or trimming. Splitting on hyphens first tears "<!--" apart at its
 * own characters and the placeholder stops being detectable. (Learned the hard
 * way in the Agent City builder, same bug class, same night.)
 */
export function displayField(raw: string | null | undefined, fallback: string): string {
  if (!raw) return fallback;
  const original = raw.trim();
  if (!original) return fallback;

  // Unfilled template field: an HTML comment, whole or partial.
  if (original.startsWith('<!--') || original.startsWith('<!')) return fallback;

  // Strip any embedded comments, then re-check that anything real survives.
  const stripped = original.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!stripped) return fallback;

  // Common placeholder spellings left by templates.
  if (/^(tbd|todo|xxx+|placeholder|set during onboarding|n\/a|none)$/i.test(stripped)) {
    return fallback;
  }
  return stripped;
}
