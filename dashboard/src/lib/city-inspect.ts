/**
 * Read-only file helpers for GET /api/city-inspect (Agent City phase 4).
 *
 * Every path this module opens is built from a fixed root plus names that
 * passed NAME_RE, then resolved with realpath and checked to still sit inside
 * that root. A name that fails the pattern never reaches the filesystem, and a
 * symlink that points out of the root is refused, not followed. Nothing here
 * spawns a process.
 */
import fs from 'fs';
import path from 'path';

/** Seat, worker, task and org names: no separators, no dots-only, bounded. */
export const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,79}$/;

export function validName(s: string | null | undefined): s is string {
  return typeof s === 'string' && NAME_RE.test(s) && !s.includes('..');
}

/**
 * Join `parts` under `root` and prove the result is still inside it after
 * symlinks are resolved. Returns null when the file is absent (ENOENT) and
 * throws `ConfinementError` when the path escapes. Callers treat null as a
 * measured absence and the error as a refusal.
 */
export class ConfinementError extends Error {}

export function confined(root: string, ...parts: string[]): string | null {
  for (const p of parts) {
    if (!validName(p) && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*\.(json|jsonl|log|md)$/.test(p)) {
      throw new ConfinementError(`refused path segment: ${JSON.stringify(p)}`);
    }
  }
  const joined = path.join(root, ...parts);
  let realRoot: string;
  let real: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return null;
  }
  try {
    real = fs.realpathSync(joined);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    throw new ConfinementError('path resolves outside its root');
  }
  return real;
}

/** The last `maxBytes` of a file as text, starting at a line boundary. */
export function readTail(file: string, maxBytes = 64 * 1024): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let s = buf.toString('utf-8');
    if (len < size) {
      const nl = s.indexOf('\n');
      s = nl >= 0 ? s.slice(nl + 1) : s;
    }
    return s;
  } finally {
    fs.closeSync(fd);
  }
}

export function lastLines(text: string, n: number): string[] {
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-n);
}

/**
 * Replay the tail of a PTY log onto a virtual screen and return what is on
 * that screen at the end: the session's current terminal, line by line.
 *
 * The daemon logs raw PTY bytes. A TUI does not print lines, it repaints cells
 * with cursor jumps, so stripping escapes gives confetti. Replaying the jumps
 * gives the frame the owner would see if he attached. Handled: CUP/HVP, CUU/
 * CUD/CUF/CUB/CNL/CPL/CHA/VPA, EL, ED, ECH, ICH, DCH, IL, DL, save/restore,
 * the alternate screen, CR/LF/BS/TAB. Everything else (colours, modes, OSC) is
 * dropped. Rows the tail never painted stay blank, so an old frame can show
 * partially; blank rows are removed from the result.
 */
export function ptyScreen(raw: string, maxLines: number, rows = 60, cols = 240): string[] {
  const blank = () => new Array<string>(cols).fill(' ');
  let grid: string[][] = Array.from({ length: rows }, blank);
  let r = 0;
  let c = 0;
  let saved: [number, number] = [0, 0];
  const clampR = (v: number) => Math.max(0, Math.min(rows - 1, v));
  const clampC = (v: number) => Math.max(0, Math.min(cols - 1, v));
  const lf = () => {
    if (r === rows - 1) {
      grid.shift();
      grid.push(blank());
    } else r++;
  };
  const chars = Array.from(raw);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\x1b') {
      const nx = chars[i + 1];
      if (nx === '[') {
        let j = i + 2;
        let params = '';
        while (j < chars.length && /[0-9;?<>=]/.test(chars[j])) params += chars[j++];
        while (j < chars.length && /[ -/]/.test(chars[j])) j++;
        const fin = chars[j];
        i = j;
        if (params.startsWith('?')) {
          if (/^\?(1049|1047|47)[hl]?$/.test(params) || /^\?(1049|1047|47)$/.test(params)) {
            grid = Array.from({ length: rows }, blank);
            r = 0;
            c = 0;
          }
          continue;
        }
        const ps = params.split(';').map((x) => (x === '' ? NaN : parseInt(x, 10)));
        const n = Number.isNaN(ps[0]) ? 1 : Math.max(1, ps[0]);
        const z = Number.isNaN(ps[0]) ? 0 : ps[0];
        switch (fin) {
          case 'H':
          case 'f':
            r = clampR((Number.isNaN(ps[0]) ? 1 : ps[0]) - 1);
            c = clampC((Number.isNaN(ps[1]) || ps[1] === undefined ? 1 : ps[1]) - 1);
            break;
          case 'A': r = clampR(r - n); break;
          case 'B': r = clampR(r + n); break;
          case 'C': c = clampC(c + n); break;
          case 'D': c = clampC(c - n); break;
          case 'E': r = clampR(r + n); c = 0; break;
          case 'F': r = clampR(r - n); c = 0; break;
          case 'G': c = clampC(n - 1); break;
          case 'd': r = clampR(n - 1); break;
          case 'K':
            if (z === 0) for (let k = c; k < cols; k++) grid[r][k] = ' ';
            else if (z === 1) for (let k = 0; k <= c; k++) grid[r][k] = ' ';
            else grid[r] = blank();
            break;
          case 'J':
            if (z === 2 || z === 3) grid = Array.from({ length: rows }, blank);
            else if (z === 0) {
              for (let k = c; k < cols; k++) grid[r][k] = ' ';
              for (let q = r + 1; q < rows; q++) grid[q] = blank();
            } else {
              for (let k = 0; k <= c; k++) grid[r][k] = ' ';
              for (let q = 0; q < r; q++) grid[q] = blank();
            }
            break;
          case 'X': for (let k = c; k < Math.min(cols, c + n); k++) grid[r][k] = ' '; break;
          case '@': grid[r].splice(c, 0, ...new Array<string>(n).fill(' ')); grid[r].length = cols; break;
          case 'P': grid[r].splice(c, n); while (grid[r].length < cols) grid[r].push(' '); break;
          case 'L': for (let k = 0; k < n; k++) { grid.splice(r, 0, blank()); grid.pop(); } break;
          case 'M': for (let k = 0; k < n; k++) { grid.splice(r, 1); grid.push(blank()); } break;
          case 's': saved = [r, c]; break;
          case 'u': [r, c] = saved; break;
          default: break; /* colours (m), modes, scroll regions: no cell change */
        }
        continue;
      }
      if (nx === ']') {
        let j = i + 2;
        while (j < chars.length && chars[j] !== '\x07' && !(chars[j] === '\x1b' && chars[j + 1] === '\\')) j++;
        i = chars[j] === '\x07' ? j : j + 1;
        continue;
      }
      if (nx === '7') saved = [r, c];
      else if (nx === '8') [r, c] = saved;
      else if (nx === '(' || nx === ')') i++;
      i++;
      continue;
    }
    if (ch === '\r') { c = 0; continue; }
    if (ch === '\n') { lf(); continue; }
    if (ch === '\b') { c = clampC(c - 1); continue; }
    if (ch === '\t') { c = clampC((Math.floor(c / 8) + 1) * 8); continue; }
    if (ch < ' ' || ch === '\x7f') continue;
    if (c >= cols) { c = 0; lf(); }
    grid[r][c] = ch;
    c++;
  }
  const lines = grid.map((row) => row.join('').replace(/\s+$/, ''));
  const out = lines.filter((l) => (l.match(/[A-Za-z0-9]/g) || []).length >= 2);
  return out.slice(-maxLines);
}

/** File-looking paths named in free text (receipts, reports, screenshots). */
export function extractPaths(...texts: Array<string | null | undefined>): string[] {
  const re =
    /(?:~\/|\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+\.(?:md|png|jpe?g|json|jsonl|txt|html|mp4|mov|pdf|csv|log|ts|tsx|js|mjs|py|sh)\b/g;
  const seen = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const m of t.match(re) || []) {
      if (/^https?:/.test(m)) continue;
      seen.add(m);
      if (seen.size >= 40) return Array.from(seen);
    }
  }
  return Array.from(seen);
}

/** Last event lines from a seat's bus event log, newest last, spanning day files. */
export function seatEvents(eventsRoot: string, seat: string, n: number, now = Date.now()) {
  const days = [new Date(now - 86400e3), new Date(now)].map((d) => d.toISOString().slice(0, 10));
  const rows: Array<{ at: string; category: string | null; event: string | null; severity: string | null }> = [];
  for (const day of days) {
    const f = confined(eventsRoot, seat, `${day}.jsonl`);
    if (!f) continue;
    for (const line of lastLines(readTail(f, 256 * 1024), 400)) {
      try {
        const e = JSON.parse(line);
        if (typeof e.timestamp !== 'string') continue;
        rows.push({ at: e.timestamp, category: e.category ?? null, event: e.event ?? null, severity: e.severity ?? null });
      } catch {
        /* skip a malformed line rather than invent one */
      }
    }
  }
  rows.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return rows.slice(-n);
}
