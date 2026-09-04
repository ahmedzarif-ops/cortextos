import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { BusPaths } from '../types/index.js';
import { normalizeOrgName } from '../utils/org.js';

/**
 * Knowledge base integration — calls mmrag.py directly (cross-platform,
 * no bash dependency).  Previously wrapped kb-*.sh bash scripts.
 */

/**
 * Resolve the Python interpreter inside the knowledge-base venv,
 * accounting for Windows vs Unix layout.
 */
function getVenvPython(frameworkRoot: string): string {
  const isWin = process.platform === 'win32';
  const venvBin = isWin ? 'Scripts' : 'bin';
  const pythonExe = isWin ? 'python.exe' : 'python3';
  return join(frameworkRoot, 'knowledge-base', 'venv', venvBin, pythonExe);
}

/**
 * Load .env and secrets.env files the same way the bash scripts did
 * (`set -o allexport && source …`).  Returns a flat key→value map.
 */
function loadSecretsEnv(frameworkRoot: string, org: string): Record<string, string> {
  const secretsPath = join(frameworkRoot, 'orgs', org, 'secrets.env');
  const dotenvPath = join(frameworkRoot, '.env');
  const vars: Record<string, string> = {};
  for (const p of [dotenvPath, secretsPath]) {
    if (existsSync(p)) {
      for (const line of readFileSync(p, 'utf-8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          let val = trimmed.slice(idx + 1);
          // Strip surrounding quotes (single or double) that some .env files use
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          vars[trimmed.slice(0, idx)] = val;
        }
      }
    }
  }
  return vars;
}

/**
 * Check whether the knowledge base config file exists for a given env.
 *
 * The Python MMRAG tool loads its config from env.MMRAG_CONFIG
 * (`knowledge-base/config.json` under the org's state dir) and exits with
 * "Config not found. Run setup first" if the file is absent. When that
 * happens, execFileSync throws a non-zero-exit error which — if not caught
 * — produces a user-facing unhandled-throw stack dump on top of the
 * already-printed Python error. This helper lets callers detect the
 * missing-config state UP FRONT and respond gracefully (warn + return)
 * instead of relying on brittle stderr string matching after the throw.
 */
function kbConfigured(env: Record<string, string>): boolean {
  return existsSync(env.MMRAG_CONFIG);
}

/**
 * Build the full env object needed by mmrag.py calls.
 */
function buildKBEnv(
  frameworkRoot: string,
  org: string,
  instanceId: string,
  agent?: string,
): Record<string, string> {
  // Normalize org to its canonical filesystem casing BEFORE touching any
  // paths. Without this, a lowercase --org arg produces a ghost state dir
  // (~/.cortextos/<instance>/orgs/<lowercase>/knowledge-base/) with its own
  // MMRAG config.json, splitting KB state across two directories and
  // polluting dashboard sync with hits against a non-existent org.
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const secrets = loadSecretsEnv(frameworkRoot, canonicalOrg);
  return {
    ...process.env as Record<string, string>,
    ...secrets,
    CTX_ORG: canonicalOrg,
    CTX_AGENT_NAME: agent || '',
    CTX_INSTANCE_ID: instanceId,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    MMRAG_DIR: kbRoot,
    MMRAG_CHROMADB_DIR: join(kbRoot, 'chromadb'),
    MMRAG_CONFIG: join(kbRoot, 'config.json'),
  };
}

export interface KBQueryResult {
  content: string;
  source_file: string;
  agent_name?: string;
  org: string;
  score: number;
  doc_type: string;
}

export interface KBQueryResponse {
  results: KBQueryResult[];
  total: number;
  query: string;
  collection: string;
}

/**
 * Query the knowledge base.
 * Returns parsed JSON results when --json is used internally.
 */
export function queryKnowledgeBase(
  paths: BusPaths,
  question: string,
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private' | 'all';
    topK?: number;
    threshold?: number;
    frameworkRoot: string;
    instanceId: string;
  },
): KBQueryResponse {
  const { agent, scope = 'all', topK = 5, threshold = 0.5, frameworkRoot, instanceId } = options;
  // Normalize once at the top so every downstream path join, env var, and
  // ChromaDB collection name uses the canonical filesystem casing. Without
  // this, `shared-acmecorp` and `shared-AcmeCorp` become two
  // distinct ChromaDB collections and a case-drifted query silently hits
  // the wrong one.
  const org = normalizeOrgName(frameworkRoot, options.org);

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // UX safety net: if the KB is not configured for this org (no config.json
  // on disk yet), skip the python probe entirely and return empty results
  // with a visible warning. Previously the inner runQuery() try/catch would
  // swallow the Config-not-found error silently and the operator would see
  // "0 results" with no hint about WHY — indistinguishable from a legitimate
  // empty query against a configured KB. The warn-and-empty shape makes the
  // distinction obvious and actionable.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Returning empty results — run setup to enable.`,
    );
    return { results: [], total: 0, query: question, collection: `shared-${org}` };
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine which collections to query based on scope
  const collections: string[] = [];
  switch (scope) {
    case 'shared':
      collections.push(`shared-${org}`);
      break;
    case 'private':
      collections.push(agent ? `agent-${agent}` : `shared-${org}`);
      break;
    case 'all':
      collections.push(`shared-${org}`);
      if (agent) collections.push(`agent-${agent}`);
      break;
  }

  const runQuery = (col: string): string | null => {
    try {
      return execFileSync(pythonPath, [
        mmragPath, 'query', question,
        '--collection', col,
        '--top-k', String(topK),
        '--threshold', String(threshold),
        '--json',
      ], {
        encoding: 'utf-8',
        timeout: 30000,
        env,
      });
    } catch {
      return null;
    }
  };

  const parseOutput = (output: string | null): KBQueryResult[] => {
    if (!output) return [];
    // mmrag.py --json outputs pretty-printed JSON; find and parse the JSON block
    const trimmed = output.trim();
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) return [];
    try {
      const raw = JSON.parse(trimmed.slice(jsonStart)) as {
        results?: Array<{ content?: string; result?: string; similarity?: number; source?: string; type?: string }>;
        result_count?: number;
        query?: string;
        collection?: string;
      };
      return (raw.results || []).map((r) => ({
        content: r.content || r.result || '',
        source_file: r.source || '',
        org,
        agent_name: agent,
        score: r.similarity ?? 0,
        doc_type: r.type || 'markdown',
      }));
    } catch {
      return [];
    }
  };

  try {
    let allResults: KBQueryResult[] = [];
    let lastCollection = `shared-${org}`;
    for (const col of collections) {
      const output = runQuery(col);
      allResults = allResults.concat(parseOutput(output));
      lastCollection = col;
    }

    if (allResults.length > 0) {
      return {
        results: allResults,
        total: allResults.length,
        query: question,
        collection: collections.length === 1 ? lastCollection : `shared-${org}`,
      };
    }
  } catch {
    // Failed — return empty
  }

  return { results: [], total: 0, query: question, collection: `shared-${org}` };
}

/**
 * Ingest files into the knowledge base.
 */
/**
 * Outcome of an ingest. Returned rather than assumed.
 *
 * `ok:false` with `reason:'unverifiable'` is deliberately distinct from a known
 * failure: if the summary line cannot be parsed we do not know what happened,
 * and "we could not check" must never be reported as "it worked".
 */
export interface IngestResult {
  ok: boolean;
  ingested: number | null;
  errors: number | null;
  reason?: 'not-configured' | 'missing-path' | 'tool-failed' | 'ingested-nothing' | 'unverifiable';
  detail?: string;
  /**
   * Per-source outcome: WHICH sources landed and which failed, by name.
   *
   * SCOPE, stated so this is not over-read. The per-file CHUNK COUNTS are not
   * independent corroboration of the total — mmrag computes `count` once per
   * file and does `total += count`, printing that same variable, so a per-file
   * count is the total with more decimal places and inherits any error in it.
   *
   * What IS independent is the NAME and the STATUS: "MEMORY.md failed,
   * 2026-09-04.md landed" is information the global count cannot express at
   * all, and it is what lets a retry target the file that failed instead of
   * redoing the whole run.
   *
   * KNOWN GAP this does NOT fix (mmrag-side, scoped separately): `count`
   * increments immediately after `collection.upsert`, so it is genuinely on the
   * write path — but when embedding raises mid-file the exception unwinds
   * `ingest_text_file` and the partially-accumulated count is DISCARDED. Chunks
   * already written are then reported as 0. So a `failed` status here can still
   * mean "some chunks landed", and only retrieval can tell you which.
   */
  files?: IngestFileOutcome[];
}

export interface IngestFileOutcome {
  name: string;
  status: 'added' | 'already-present' | 'failed' | 'missing';
  chunks: number | null;
}

export function ingestKnowledgeBase(
  paths: string[],
  options: {
    org: string;
    agent?: string;
    scope?: 'shared' | 'private';
    force?: boolean;
    frameworkRoot: string;
    instanceId: string;
  },
): IngestResult {
  const { agent, scope = 'shared', force, frameworkRoot, instanceId } = options;
  // Normalize once (see queryKnowledgeBase for rationale).
  const org = normalizeOrgName(frameworkRoot, options.org);

  const env = buildKBEnv(frameworkRoot, org, instanceId, agent);

  // Correctness fix: if the KB is not configured for this org, the underlying
  // python MMRAG tool exits with "Config not found. Run setup first" and
  // execFileSync (below, stdio ['inherit','pipe','pipe']) throws a non-zero-exit error. That
  // throw used to bubble up through the CLI action handler as an unhandled
  // exception, dumping a full Node stack trace on top of the python error
  // message — ugly and alarming for operators who were just running ingest
  // without setting up the KB first. Detect the missing-config state
  // up-front and warn-and-skip instead of letting execFileSync crash.
  if (!kbConfigured(env)) {
    console.warn(
      `[kb] Knowledge base not configured for org ${org}. Skipping ingest — ` +
      `run setup to enable (see HEARTBEAT.md step 10 for the config path).`,
    );
    return { ok: false, ingested: null, errors: null, reason: 'not-configured' };
  }

  const pythonPath = getVenvPython(frameworkRoot);
  const mmragPath = join(frameworkRoot, 'knowledge-base', 'scripts', 'mmrag.py');

  // Determine collection name (same logic as kb-ingest.sh)
  let collection: string;
  // A source that does not exist cannot be ingested, and the python tool prints
  // "NOT FOUND" and carries on. Catch it here so the caller gets a reason rather
  // than a successful-looking run over nothing.
  const missing = paths.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    console.error(`ERROR: source path(s) not found: ${missing.join(', ')}`);
    return { ok: false, ingested: null, errors: null, reason: 'missing-path', detail: missing.join(', ') };
  }

  if (scope === 'private') {
    if (!agent) throw new Error('--agent or CTX_AGENT_NAME required for --scope private');
    collection = `agent-${agent}`;
  } else {
    collection = `shared-${org}`;
  }

  // Ensure chromadb dir exists
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', org, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }

  console.log(`Ingesting into collection: ${collection}`);
  for (const p of paths) {
    console.log(`  Source: ${p}`);
  }

  const args = [mmragPath, 'ingest', ...paths, '--collection', collection];
  if (force) args.push('--force');

  // Multimodal PDF ingestion via Gemini Flash routinely takes 2–5 min for
  // documents over ~10 pages with images/tables. Two minutes was too low and
  // produced ETIMEDOUT mid-Gemini-call. Default 10 min, override via env,
  // floored at 60s so nobody accidentally sets it to 0 or a value smaller
  // than a single Gemini call needs.
  const KB_INGEST_TIMEOUT_FLOOR_MS = 60_000;
  const KB_INGEST_TIMEOUT_DEFAULT_MS = 600_000;
  // Ceiling for the captured output. Deliberately generous: on overflow spawnSync
  // KILLS the child, so an undersized buffer does not truncate a log — it aborts
  // the work. 64MB is far beyond any real ingest transcript.
  const KB_INGEST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
  const requestedTimeout = Number(process.env.KB_INGEST_TIMEOUT_MS);
  const ingestTimeoutMs = Math.max(
    KB_INGEST_TIMEOUT_FLOOR_MS,
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? requestedTimeout
      : KB_INGEST_TIMEOUT_DEFAULT_MS,
  );

  // stdio was 'inherit', which meant the output went straight past this process
  // and nothing here could tell a successful ingest from a quota error. The tool
  // printed "Done!", this printed "Ingest complete", and both were unconditional.
  // Captured and echoed instead: operators still see everything, and the result
  // is now something we can actually check.
  //
  // TRADE-OFF, stated because it is a real loss: piping means the output arrives
  // when the run ENDS, not as it goes. A long ingest now looks silent while it
  // works. That is the price of being able to read the result at all.
  //
  // maxBuffer is NOT optional here. execFileSync defaults to 1MB, and on overflow
  // spawnSync KILLS THE CHILD with ENOBUFS — so capturing the output in order to
  // check it would, on a large ingest, turn a SUCCEEDING run into a KILLED,
  // PARTIALLY-INDEXED one. Measured: 2MB of child output throws ENOBUFS with
  // stdout truncated at 1114112 bytes; the same run returns cleanly at 64MB.
  // Retry logging on this same stdout makes large outputs likelier, not rarer.
  let output = '';
  try {
    output = execFileSync(pythonPath, args, {
      encoding: 'utf-8',
      timeout: ingestTimeoutMs,
      env,
      maxBuffer: KB_INGEST_MAX_BUFFER_BYTES,
      stdio: ['inherit', 'pipe', 'pipe'],
    }) as unknown as string;
    if (output) process.stdout.write(output);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const combined = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (combined) process.stdout.write(combined);
    console.error(`ERROR: ingest failed — ${e.message ?? 'unknown error'}`);
    return { ok: false, ingested: null, errors: null, reason: 'tool-failed', detail: e.message };
  }

  const parsed = parseIngestSummary(output);

  if (parsed.ingested === null) {
    // The tool ran and exited 0, but said nothing we recognise. That is not
    // success — it is an unread result, and the whole defect this replaces was
    // an unread result being announced as success.
    console.error(
      'ERROR: could not verify the ingest — no "Done! Ingested N" line in the output. ' +
      'Treating as FAILED rather than assuming it worked.',
    );
    return { ok: false, ingested: null, errors: null, reason: 'unverifiable' };
  }

  if (parsed.errors && parsed.errors > 0) {
    console.error(`ERROR: ingest reported ${parsed.errors} error(s) — collection ${collection} may be incomplete.`);
    return { ok: false, ingested: parsed.ingested, errors: parsed.errors, reason: 'tool-failed' };
  }

  // Fail only when NOTHING was handled.
  //
  // This deliberately does NOT key on `skipped`: mmrag increments that counter only in its
  // directory branch, so a single already-present FILE leaves it at 0. Keyed on `skipped`,
  // a re-ingest of already-complete memory reports FAILURE — which would have broken a
  // fleet-wide re-ingest on every seat that was already up to date, the exact inverse of
  // the defect this fixes. `handled` counts sources that reached a real outcome.
  const handled = parsed.files.filter(
    (f) => f.status === 'added' || f.status === 'already-present',
  ).length;
  if (parsed.ingested === 0 && parsed.skipped === 0 && handled === 0 && paths.length > 0) {
    console.error(
      `ERROR: ingest indexed 0 chunks from ${paths.length} source(s) and handled none. ` +
      'A run asked to index something that indexed nothing has not succeeded.',
    );
    return { ok: false, ingested: 0, errors: parsed.errors, reason: 'ingested-nothing' };
  }

  console.log(`\nIngest complete → collection: ${collection} (${parsed.ingested} chunk(s))`);
  return { ok: true, ingested: parsed.ingested, errors: parsed.errors ?? 0 };
}

/**
 * Read the tool's own summary rather than trusting its exit code alone.
 *
 * Returns `ingested: null` when the summary line is absent — "could not parse"
 * is a distinct answer from "parsed as zero", and collapsing the two is how an
 * unverifiable run gets reported as a clean one.
 */
export function parseIngestSummary(output: string): {
  ingested: number | null;
  skipped: number;
  errors: number | null;
  files: IngestFileOutcome[];
} {
  // Per-source outcome, recovered from lines the tool already prints:
  //   Ingesting: <name>      then  "  Added N chunk(s)"  or  "  ERROR: ..."
  //   Ingesting directory: X then  "  Processing: <rel>" then indented Added/ERROR
  //   NOT FOUND: <path>
  // The information was always there; only the totals were being read.
  const files: IngestFileOutcome[] = [];
  let pending: string | null = null;
  for (const raw of output.split('\n')) {
    const notFound = raw.match(/^NOT FOUND:\s*(.+?)\s*$/);
    if (notFound) {
      files.push({ name: notFound[1], status: 'missing', chunks: null });
      pending = null;
      continue;
    }
    const start = raw.match(/^(?:Ingesting|\s+Processing):\s*(.+?)\s*$/);
    if (start && !/^Ingesting directory:/.test(raw)) {
      if (pending !== null) files.push({ name: pending, status: 'failed', chunks: null });
      pending = start[1];
      continue;
    }
    const added = raw.match(/^\s+Added\s+(\d+)\s+chunk/);
    if (added && pending !== null) {
      files.push({ name: pending, status: 'added', chunks: Number(added[1]) });
      pending = null;
      continue;
    }
    // A file already fully indexed adds nothing and that is a CORRECT outcome, not a
    // failure. Without this it fell through to "announced but never resolved" below and
    // was reported as failed — which would have called every already-complete source in
    // a fleet re-ingest broken.
    if (/^\s+Already present/.test(raw) && pending !== null) {
      files.push({ name: pending, status: 'already-present', chunks: 0 });
      pending = null;
      continue;
    }
    if (/^\s+ERROR:/.test(raw) && pending !== null) {
      files.push({ name: pending, status: 'failed', chunks: null });
      pending = null;
    }
  }
  // A source announced but never resolved is a failure, not a silent success.
  if (pending !== null) files.push({ name: pending, status: 'failed', chunks: null });

  const ingestedMatch = output.match(/Done!\s+Ingested\s+(\d+)\s+new chunk/);
  const skippedMatch = output.match(/^\s*Skipped:\s*(\d+)/m);
  const errorsMatch = output.match(/^\s*Errors:\s*(\d+)/m);
  const missingMatch = output.match(/^\s*Missing:\s*(\d+)/m);

  const errorsFromLines = (errorsMatch ? Number(errorsMatch[1]) : 0)
    + (missingMatch ? Number(missingMatch[1]) : 0);

  return {
    ingested: ingestedMatch ? Number(ingestedMatch[1]) : null,
    skipped: skippedMatch ? Number(skippedMatch[1]) : 0,
    errors: ingestedMatch ? errorsFromLines : null,
    files,
  };
}

/**
 * Ensure the knowledge base directories exist for an org.
 *
 * `frameworkRoot` is required so the org name can be normalized to its
 * canonical filesystem casing — without that, a caller passing a drifted
 * name (e.g. "acmecorp") would create a ghost state dir identical
 * to the one this module was written to prevent.
 */
export function ensureKBDirs(instanceId: string, frameworkRoot: string, org: string): void {
  const canonicalOrg = normalizeOrgName(frameworkRoot, org);
  const kbRoot = join(homedir(), '.cortextos', instanceId, 'orgs', canonicalOrg, 'knowledge-base');
  const chromaDir = join(kbRoot, 'chromadb');
  if (!existsSync(chromaDir)) {
    mkdirSync(chromaDir, { recursive: true });
  }
}
