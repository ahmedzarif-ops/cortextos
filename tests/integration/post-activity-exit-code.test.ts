import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// `cortextos bus post-activity` used to print "Failed to post activity" to
// stderr and EXIT 0. A shell caller reading $? therefore could not tell a
// delivered broadcast from a dropped one — and a dropped BROADCAST is worse
// than a dropped 1:1, because everyone believes they were told and nobody is
// left waiting to prompt the discovery. This suite pins the exit code and the
// content of the failure message.
//
// The old message also named "secrets.env or .env", two files postActivity has
// never opened; it reads activity-channel.env at exactly two paths. On a live
// org where ACTIVITY_CHAT_ID *was* set in secrets.env, the message sent the
// operator to a file where the setting provably does nothing.
//
// Run the real source through tsx so no build step is needed.

const ROOT = join(__dirname, '..', '..');
const TSX = join(ROOT, 'node_modules', '.bin', 'tsx');
const ENTRY = join(ROOT, 'src', 'cli', 'index.ts');

const ORG = 'testorg';
let tmp: string;
let frameworkRoot: string;
let ctxRoot: string;
let orgDir: string;
let agentDir: string;

// The child env is BUILT, never inherited: an inherited CTX_* from the seat
// shell would silently point the CLI at the real org tree, and the run would
// still look like a clean pass over the wrong paths.
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '',
    HOME: tmp,
    CTX_FRAMEWORK_ROOT: frameworkRoot,
    CTX_PROJECT_ROOT: frameworkRoot,
    CTX_AGENT_DIR: agentDir,
    CTX_ROOT: ctxRoot,
    CTX_ORG: ORG,
    CTX_AGENT_NAME: 'bot',
    ...extra,
  };
}

function runPostActivity(extraEnv: Record<string, string> = {}) {
  return spawnSync(TSX, [ENTRY, 'bus', 'post-activity', 'hello fleet'], {
    encoding: 'utf8',
    cwd: ROOT,
    env: childEnv(extraEnv),
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'post-activity-rc-'));
  frameworkRoot = join(tmp, 'framework');
  ctxRoot = join(tmp, 'ctxroot');
  orgDir = join(frameworkRoot, 'orgs', ORG);
  agentDir = join(orgDir, 'agents', 'bot');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(ctxRoot, 'orgs', ORG), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('bus post-activity — exit code and failure message', () => {
  it('no activity-channel.env anywhere → exit 1, and names the paths it actually searched', () => {
    const r = runPostActivity();

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Failed to post activity/);
    expect(r.stderr).toMatch(/activity-channel\.env/);

    // SETUP CONTROL: the searched paths must be the temp ones. If the built
    // env had not taken effect, these would name the real org tree and every
    // other assertion here would be true of the wrong run.
    expect(r.stderr).toContain(join(orgDir, 'activity-channel.env'));
    expect(r.stderr).toContain(join(ctxRoot, 'orgs', ORG, 'activity-channel.env'));

    // The old message told the operator to set ACTIVITY_CHAT_ID in secrets.env
    // or .env. secrets.env may only appear as the explicit "has no effect" note.
    expect(r.stderr).toMatch(/secrets\.env or \.env has no effect/);
    expect(r.stderr).not.toMatch(/Check that ACTIVITY_CHAT_ID is set in your org secrets\.env/);
  }, 30000);

  it('activity-channel.env present but ACTIVITY_CHAT_ID missing → exit 1', () => {
    writeFileSync(join(orgDir, 'activity-channel.env'), 'ACTIVITY_BOT_TOKEN=abc123\n');

    const r = runPostActivity();

    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ACTIVITY_CHAT_ID/);
  }, 30000);

  it('configured and the send succeeds → exit 0 (the branch the fix must NOT change)', () => {
    writeFileSync(
      join(orgDir, 'activity-channel.env'),
      'ACTIVITY_BOT_TOKEN=abc123\nACTIVITY_CHAT_ID=-100999\n',
    );

    // Stub global fetch in the child so no request leaves the machine. The stub
    // touches a marker file, which is the SETUP CONTROL for this arm: without
    // it, a green here could mean "the stub never loaded and a real request to
    // api.telegram.org happened to come back ok", which is not what is claimed.
    const marker = join(tmp, 'fetch-stub-loaded');
    const stub = join(tmp, 'fetch-stub.cjs');
    writeFileSync(
      stub,
      `require('fs').writeFileSync(${JSON.stringify(marker)}, 'loaded');\n` +
        `globalThis.fetch = async (url) => {\n` +
        `  if (!String(url).startsWith('https://api.telegram.org/')) {\n` +
        `    throw new Error('unexpected fetch: ' + url);\n` +
        `  }\n` +
        `  return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };\n` +
        `};\n`,
    );

    const r = runPostActivity({ NODE_OPTIONS: `--require ${stub}` });

    expect(existsSync(marker)).toBe(true); // the stub really loaded
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Activity posted/);
  }, 30000);
});
