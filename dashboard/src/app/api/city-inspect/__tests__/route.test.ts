/**
 * GET /api/city-inspect (Agent City phase 4): auth, refusals, and that every
 * field comes from a seeded record.
 *
 * CTX_ROOT and CTX_FRAMEWORK_ROOT point at one temp tree; CTX_INSTANCE_ID names
 * an instance with no daemon socket, so every daemon read is UNREACHABLE and
 * must render as unknown (never as stopped, never as an empty list).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'city-inspect-'));
process.env.CTX_ROOT = root;
process.env.CTX_FRAMEWORK_ROOT = root;
process.env.CTX_INSTANCE_ID = `city-inspect-test-nosock-${process.pid}`;
delete process.env.CTX_ORG;
process.env.AUTH_SECRET = 'city-inspect-test-secret-at-least-32-chars-long';

type Route = typeof import('../route');
let route: Route;
let lib: typeof import('@/lib/city-inspect');

const ORG = 'acme';
const TASK = 'task_1790000000000_00000001';
const today = new Date().toISOString().slice(0, 10);

function w(rel: string, body: string) {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, body);
}

beforeAll(async () => {
  fs.mkdirSync(path.join(root, 'orgs', ORG, 'agents', 'growth'), { recursive: true });
  w(
    `orgs/${ORG}/tasks/${TASK}.json`,
    JSON.stringify({
      id: TASK,
      title: 'Run the Tier 1 ad',
      description: 'Step 1: read billing.\n- report: agents/growth/reports/2026-09-23-sprint/ACCOUNT-STATE.md',
      status: 'in_progress',
      assigned_to: 'growth',
      created_by: 'chief',
      priority: 'high',
      created_at: '2026-09-23T01:04:12Z',
      updated_at: '2026-09-28T14:00:23Z',
      annotations: [{ ts: '2026-09-23T01:12:46Z', agent: 'growth', text: 'DONE. Screenshot: reports/x/shot.png' }],
    })
  );
  w(
    `orgs/${ORG}/tasks/audit/${TASK}.jsonl`,
    [
      { ts: '2026-09-23T01:04:12Z', event: 'create', agent: 'chief', to: 'pending' },
      { ts: '2026-09-23T01:06:34Z', event: 'update', agent: 'growth', from: 'pending', to: 'in_progress' },
    ]
      .map((e) => JSON.stringify(e))
      .join('\n') + '\nnot json\n'
  );
  /* a PTY log: "Hello" drawn, then " world" placed by an absolute cursor jump */
  w('logs/growth/stdout.log', '\x1b[2J\x1b[1;1H\x1b[38;5;174mHello\x1b[39m\x1b[1;6H world\r\n\x1b[?25lDoing step 2\x1b[K');
  w(
    `orgs/${ORG}/analytics/events/growth/${today}.jsonl`,
    JSON.stringify({ timestamp: new Date().toISOString(), category: 'action', event: 'task_annotated', severity: 'info' }) + '\n'
  );
  w('inbox/growth/1-1790000000000-from-chief-abc.json', JSON.stringify({ from: 'chief', timestamp: '2026-09-28T15:00:00Z', text: 'Please pause the ad\nmore' }));
  w(
    '.cortextOS/state/agents/growth/crons.json',
    JSON.stringify({ updated_at: 'x', crons: [{ name: 'tier1-ads-daily-read', schedule: '0 9 * * *', enabled: true, last_fired_at: '2026-09-28T14:00:05Z', fire_count: 6 }] })
  );
  /* a task file that is a symlink out of the org: must be refused, not followed */
  const outside = path.join(root, 'outside-secret.json');
  fs.writeFileSync(outside, JSON.stringify({ id: 'task_evil_1', title: 'secret' }));
  fs.symlinkSync(outside, path.join(root, 'orgs', ORG, 'tasks', 'task_evil_1.json'));

  route = await import('../route');
  lib = await import('@/lib/city-inspect');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const get = (qs: string) => route.GET(new NextRequest(new URL(`http://localhost/api/city-inspect?${qs}`)));

describe('auth', () => {
  it('401 without a session: the middleware guards /api/city-inspect like every /api route', async () => {
    const { middleware } = await import('@/middleware');
    const res = await middleware(new NextRequest(new URL('http://localhost/api/city-inspect?type=seat&id=growth')));
    expect(res.status).toBe(401);
  });
  it('401 with a forged session cookie', async () => {
    const { middleware } = await import('@/middleware');
    const req = new NextRequest(new URL('http://localhost/api/city-inspect?type=task&id=' + TASK), {
      headers: { cookie: 'authjs.session-token=anything' },
    });
    expect((await middleware(req)).status).toBe(401);
  });
});

describe('refusals', () => {
  it('400 on an unknown type', async () => {
    expect((await get('type=file&id=growth')).status).toBe(400);
  });
  it('404 on a task id with no record', async () => {
    expect((await get('type=task&id=task_1_2')).status).toBe(404);
  });
  it('404 on a seat that is not on the roster', async () => {
    expect((await get('type=seat&id=nobody')).status).toBe(404);
  });
  it.each([
    '../../etc/passwd',
    '..%2F..%2Fetc%2Fpasswd',
    '..',
    'growth/../../x',
    '%2Fetc%2Fhosts',
    'a\\b',
    '.hidden',
  ])('rejects path traversal in id: %s', async (id) => {
    const res = await get(`type=task&id=${id}`);
    expect(res.status).toBe(400);
  });
  it('rejects a traversal org and an org that is not installed', async () => {
    expect((await get(`type=seat&id=growth&org=..%2F..`)).status).toBe(400);
    expect((await get(`type=seat&id=growth&org=other`)).status).toBe(400);
  });
  it('refuses a task file that is a symlink out of its root', async () => {
    const res = await get('type=task&id=task_evil_1');
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });
});

describe('task (a crew figure)', () => {
  it('returns the record, audit, paths and the seat strip, each with a source', async () => {
    const res = await get(`type=task&id=${TASK}`);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.title).toBe('Run the Tier 1 ad');
    expect(d.assignee).toBe('growth');
    expect(d.started_at).toBe('2026-09-23T01:06:34Z');
    expect(d.audit).toHaveLength(2); /* the malformed line is skipped, not invented */
    expect(d.notes[0].who).toBe('growth');
    expect(d.paths).toEqual(['agents/growth/reports/2026-09-23-sprint/ACCOUNT-STATE.md', 'reports/x/shot.png']);
    expect(d.now.activity_log.exists).toBe(false);
    expect(d.now.activity_log.note).toMatch(/does not exist/);
    expect(d.now.output.screen).toEqual(['Hello world', 'Doing step 2']);
    expect(d.now.events.last.event).toBe('task_annotated');
    expect(d.sources.task).toBe(`orgs/${ORG}/tasks/${TASK}.json`);
    expect(typeof d.read_at).toBe('string');
  });
});

describe('seat (a building)', () => {
  it('reads tasks, inbox, crons; daemon unreachable is unknown, never stopped', async () => {
    const d = await (await get('type=seat&id=growth')).json();
    expect(d.in_progress.map((t: { id: string }) => t.id)).toEqual([TASK]);
    expect(d.inbox.pending).toBe(1);
    expect(d.inbox.last[0]).toEqual({ from: 'chief', at: '2026-09-28T15:00:00Z', subject: 'Please pause the ad' });
    expect(d.crons[0]).toMatchObject({ name: 'tier1-ads-daily-read', last_fired_at: '2026-09-28T14:00:05Z' });
    expect(d.live.running).toBeNull();
    expect(d.live.source).toMatch(/UNREACHABLE/);
  });
});

describe('worker (a pod)', () => {
  it('503 when the daemon cannot be asked (unknown, not "no such worker")', async () => {
    const res = await get('type=worker&id=city-build');
    expect(res.status).toBe(503);
  });
});

describe('ptyScreen', () => {
  it('replays cursor moves instead of concatenating fragments', () => {
    expect(lib.ptyScreen('\x1b[3;1Habc def\x1b[3;5HXYZ\x1b[1;1Htop line', 5)).toEqual(['top line', 'abc XYZ']);
  });
  it('erase-line and clear-screen remove what they cover', () => {
    expect(lib.ptyScreen('old text here\x1b[1;4H\x1b[K', 5)).toEqual(['old']);
    expect(lib.ptyScreen('gone now\x1b[2J\x1b[1;1Hkept text', 5)).toEqual(['kept text']);
  });
});
