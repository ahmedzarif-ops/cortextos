import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// node-pty is native; stub it so constructing AgentPTY never touches it.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

// existsSync=false → the local/*.md system-prompt block is skipped in buildClaudeArgs.
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

const { AgentPTY } = await import('../../../src/pty/agent-pty.js');

const mockEnv = {
  instanceId: 'test',
  ctxRoot: '/tmp/test-ctx',
  frameworkRoot: '/tmp/fw',
  agentName: 'alice',
  agentDir: '/tmp/fw/orgs/acme/agents/alice',
  org: 'acme',
  projectRoot: '/tmp/fw',
} as any;

function argsFor(config: any): string[] {
  const pty = new AgentPTY(mockEnv, config);
  return (pty as unknown as { buildClaudeArgs(m: 'fresh' | 'continue', p: string): string[] })
    .buildClaudeArgs('fresh', 'PROMPT');
}

describe('AgentPTY --dangerously-skip-permissions toggle', () => {
  it('includes the flag by default (back-compat: skip stays ON)', () => {
    expect(argsFor({})).toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly true', () => {
    expect(argsFor({ dangerously_skip_permissions: true })).toContain('--dangerously-skip-permissions');
  });

  it('does NOT include the flag when dangerously_skip_permissions is false (permission gate engaged)', () => {
    expect(argsFor({ dangerously_skip_permissions: false })).not.toContain('--dangerously-skip-permissions');
  });

  it('includes the flag when dangerously_skip_permissions is explicitly undefined (treated as default)', () => {
    expect(argsFor({ dangerously_skip_permissions: undefined })).toContain('--dangerously-skip-permissions');
  });

  it('fails safe (keeps the flag) and warns on a non-boolean value, e.g. the string "false"', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A typo'd string must NOT silently disable the skip flag.
      expect(argsFor({ dangerously_skip_permissions: 'false' as any })).toContain('--dangerously-skip-permissions');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

// A stub node-pty handle injected via spawnFn so spawn() never touches the native addon.
const mockPty = { pid: 7, write: vi.fn(), onData: vi.fn(), onExit: vi.fn(), kill: vi.fn(), resize: vi.fn() };

function newPty(config: any) {
  const pty = new AgentPTY(mockEnv, config);
  (pty as any).spawnFn = () => mockPty;
  return pty;
}

describe('AgentPTY working_directory validation', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('rejects a whitespace-only working_directory', async () => {
    await expect(newPty({ working_directory: '   ' }).spawn('fresh', 'P'))
      .rejects.toThrow(/whitespace-only/);
  });

  it('rejects a nonexistent working_directory (existsSync=false)', async () => {
    await expect(newPty({ working_directory: '/no/such/dir' }).spawn('fresh', 'P'))
      .rejects.toThrow(/does not exist/);
  });

  it('does NOT validate an unset working_directory (falls through to agentDir)', async () => {
    const pty = newPty({});
    await expect(pty.spawn('fresh', 'P')).resolves.toBeUndefined();
    pty.kill();
  });

  it('does NOT reject the empty-string "unset" sentinel', async () => {
    const pty = newPty({ working_directory: '' });
    await expect(pty.spawn('fresh', 'P')).resolves.toBeUndefined();
    pty.kill();
  });
});

describe('AgentPTY daemon lifecycle provenance env', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('injects CTX_DAEMON_PID as the spawning daemon pid so hooks can prove provenance', async () => {
    let captured: any = null;
    const pty = new AgentPTY(mockEnv, {});
    (pty as any).spawnFn = (_cmd: string, _args: string[], opts: any) => { captured = opts; return mockPty; };
    await pty.spawn('fresh', 'P');
    pty.kill();
    expect(captured?.env?.CTX_DAEMON_PID).toBe(String(process.pid));
  });
});

describe('AgentPTY first-run wedge detection (awaiting interactive confirmation)', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('flags awaiting when a bypass prompt is still showing at the backstop and not bootstrapped', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    // Capital-P "Permissions" is NOT the lowercase "permissions" bootstrap token.
    pty.getOutputBuffer().push('2. Yes, I accept - Bypass Permissions mode');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);
  });

  it('never flags once the session has bootstrapped', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('accept edits · permissions');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(false);
  });

  it('clears the wedge flag on late recovery (bootstrap after the backstop)', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('2. Yes, I accept - Bypass Permissions mode');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);
    pty.getOutputBuffer().push('permissions');
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(false);
  });
});

describe('AgentPTY broadened auto-accept token match (rec B)', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('injects Enter for a "directory" trust-prompt variant', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('Do you trust the files in this directory?');
    await vi.advanceTimersByTimeAsync(1300);
    expect(mockPty.write).toHaveBeenCalledWith('\r');
  });

  it('injects Down+Enter for a lowercase "bypass" prompt variant', async () => {
    // Fixture avoids the lowercase "permissions" bootstrap token so the poll's
    // top-of-tick bootstrap self-stop does not fire before the bypass branch.
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('bypass mode ... 2. Yes, I accept');
    await vi.advanceTimersByTimeAsync(1700);
    expect(mockPty.write).toHaveBeenCalledWith('\x1b[B');
  });

  it('does NOT inject on benign single-token output', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('please accept the changes and open the directory');
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockPty.write).not.toHaveBeenCalled();
  });
});

describe('AgentPTY structural no-keystroke-into-live-session invariant', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('writes NO keystroke once bootstrapped even if prompt tokens linger in the buffer', async () => {
    // The real session is up ("permissions" status bar) but the recent buffer
    // still carries first-run prompt tokens. The poll must self-stop at the top
    // of the tick BEFORE any bypass/trust branch, so no stray Down/Enter leaks
    // into the live session. Fails against the old ordering (branches first).
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    pty.getOutputBuffer().push('Bypass Permissions ... 2. Yes, I accept · permissions');
    await vi.advanceTimersByTimeAsync(2000);
    expect(mockPty.write).not.toHaveBeenCalled();
  });
});

describe('AgentPTY awaiting-confirmation must not re-assert after the buffer scrolls', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  // ⛔ THE DEFECT, MEASURED ON A LIVE SEAT: 20h38m uptime, a heartbeat 60s old, a context
  // file written that same minute and three bus messages exchanged — and `cortextos status`
  // still printed "awaiting interactive confirmation (first-run prompt not accepted)".
  // Three instruments said live, one said never bootstrapped.
  //
  // CAUSE, VERIFIED IN THE CODE RATHER THAN INFERRED FROM THE SYMPTOM: OutputBuffer.chunks
  // is a RING (push, then shift past maxChunks), and isBootstrapped() reads getRecent() over
  // that ring. It therefore answers "is the bootstrap pattern on screen NOW", not "did this
  // session ever start". The previous gate ANDed on !isBootstrapped() and its comment
  // promised a late recovery would "auto-report healthy without extra clearing" — true for
  // as long as the pattern stays in the window, false forever after it scrolls out.
  //
  // ⭐ A MOMENTARY OBSERVATION CANNOT CARRY A PERMANENT FACT. "Ever bootstrapped" is
  // monotonic; a ring buffer is not.
  //
  // NOTE: the existing 'clears the wedge flag on late recovery' test above passes under BOTH
  // implementations — it reads the flag while the pattern is still in the window. That is
  // precisely why this defect survived having a test named after it.
  it('stays healthy after the bootstrap pattern scrolls out of the ring buffer', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    const buf = pty.getOutputBuffer();

    buf.push('2. Yes, I accept - Bypass Permissions mode');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);

    buf.push('accept edits · permissions');
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(false);

    const maxChunks = (buf as any).maxChunks ?? 1000;
    for (let i = 0; i < maxChunks + 50; i++) buf.push(`ordinary agent output line ${i}\n`);

    // PRECONDITION CONTROL — without it this test could pass because the buffer stopped
    // evicting, i.e. because it no longer exercises the defect at all.
    expect(buf.searchSync('permissions')).toBe(false);

    // THE ASSERTION. Under the old gate this is `true` — the live 20h defect.
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(false);
  });

  it('still reports awaiting for a seat that never bootstrapped, however long it runs', async () => {
    // The latch must not degrade into "everything is healthy after a while".
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    const buf = pty.getOutputBuffer();
    buf.push('2. Yes, I accept - Bypass Permissions mode');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);

    const maxChunks = (buf as any).maxChunks ?? 1000;
    for (let i = 0; i < maxChunks + 50; i++) buf.push(`still wedged, no status bar ${i}\n`);

    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);
  });
});

describe('AgentPTY bootstrap latch lives at OUTPUT INGRESS, not at an observation site', () => {
  beforeEach(() => { vi.useFakeTimers(); mockPty.write.mockClear(); mockPty.onData.mockClear(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  // ⛔ THE FIRST FIX MOVED THIS DEFECT; IT DID NOT REMOVE IT. That version latched at the
  // three places that ALREADY looked at the buffer — the prompt poll, the 45s backstop, and
  // the status getter. All three are OBSERVATION SITES, and an observation site only ever
  // latches what it happens to be looking at.
  //
  // ⭐ OBSERVATION SITES ARE SAMPLED; INGRESS IS CONTINUOUS. A fact that must be captured
  // cannot be captured by a sampler, because between any two samples the evidence expires.
  //
  // ⭐ AND THE FIRST ROUND OF TESTS HID IT: they call the getter BETWEEN the bootstrap and
  // the eviction. A TEST THAT SAMPLES AT THE CONVENIENT MOMENT CANNOT SEE A DEFECT ABOUT
  // SAMPLING. These tests deliver through the REGISTERED onData callback — the real path
  // bytes take — and deliberately do not call the getter until after the eviction.

  /** Deliver output the way the live process does: through the callback AgentPTY registered. */
  function deliver(data: string): void {
    const cb = mockPty.onData.mock.calls[0][0] as (d: string) => void;
    cb(data);
  }

  it('CONTROL: output delivered through the registered onData callback reaches the ring', async () => {
    // Without this, every "0 occurrences" assertion below is satisfiable by a harness that
    // delivers nothing at all. Proves the delivery path works before anything relies on it.
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    deliver('a distinctive marker line');
    expect(pty.getOutputBuffer().getRecent()).toContain('a distinctive marker line');
  });

  it('⛔ THE FINDING: late bootstrap survives eviction even when NOTHING observes it in between', async () => {
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    const buf = pty.getOutputBuffer();

    deliver('2. Yes, I accept - Bypass Permissions mode');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);

    // Bootstrap arrives LATE — after the backstop has already raised the flag.
    deliver('accept edits · permissions');

    // ⛔ THE WHOLE POINT: NOTHING LOOKS HERE. No getter call, no poll — the poll has already
    // been cleared by the backstop. Under a getter-site latch this is where the fact is lost.
    const maxChunks = (buf as any).maxChunks ?? 1000;
    for (let i = 0; i < maxChunks + 50; i++) deliver(`ordinary agent output line ${i}\n`);

    // PRECONDITION CONTROL — the pattern really has left the window, so this test cannot
    // pass by no longer exercising the defect.
    expect(buf.searchSync('permissions')).toBe(false);
    expect(buf.isBootstrapped()).toBe(false);

    // THE ASSERTION. True against a latch set at any observation site.
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(false);
  });

  it('OVER-CORRECTION CONTROL: a seat that never bootstrapped still reports awaiting, via the same path', async () => {
    // Same delivery path and same volume as the test above, so the two differ ONLY in
    // whether the bootstrap pattern was ever delivered. The latch must not degrade into
    // "healthy after enough output".
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    const buf = pty.getOutputBuffer();

    deliver('2. Yes, I accept - Bypass Permissions mode');
    await vi.advanceTimersByTimeAsync(46000);
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);

    const maxChunks = (buf as any).maxChunks ?? 1000;
    for (let i = 0; i < maxChunks + 50; i++) deliver(`still wedged, no status bar ${i}\n`);

    expect(pty.isAwaitingInteractiveConfirmation()).toBe(true);
  });

  it('the latch is monotonic: clearing the ring discards the EVIDENCE, not the EVENT', async () => {
    // clear() empties the buffer. If it reset the latch, the whole defect would come back
    // through a second door — a live session would report as never-started.
    const pty = newPty({});
    await pty.spawn('fresh', 'P');
    const buf = pty.getOutputBuffer();

    deliver('2. Yes, I accept - Bypass Permissions mode');
    await vi.advanceTimersByTimeAsync(46000);
    deliver('accept edits · permissions');

    buf.clear();
    expect(buf.isBootstrapped()).toBe(false);        // evidence gone
    expect(buf.hasEverBootstrapped()).toBe(true);    // event remembered
    expect(pty.isAwaitingInteractiveConfirmation()).toBe(false);
  });
});
