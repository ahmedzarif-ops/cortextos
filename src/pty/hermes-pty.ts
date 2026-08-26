import { existsSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { homedir } from 'os';
import type { AgentConfig, CtxEnv } from '../types/index.js';
import { AgentPTY } from './agent-pty.js';
import { KEYS } from './inject.js';
import { resolveHermesProfile, stripControlChars } from '../utils/validate.js';

// Hermes bootstrap signal: the prompt character that appears when Hermes is
// ready for input. The full prompt is "⚔ ❯ " but we check for "❯" as a
// substring since terminal themes may vary. Braille spinner frames and other
// output never contain "❯" so this is a clean idle signal.
const HERMES_BOOTSTRAP_PATTERN = '❯';

// Startup prompt file written to the agent dir and read by Hermes at boot.
// Using a file avoids bracketed paste (ESC[200~) which is buggy in Hermes
// (NousResearch/hermes-agent issue #7316 — leaked markers corrupt input).
const STARTUP_PROMPT_FILE = '.cortextos-startup.md';

/**
 * PTY wrapper for Hermes agents (NousResearch/hermes-agent, Python REPL).
 *
 * Key differences from Claude Code (AgentPTY):
 * - Binary: `hermes` (not `claude`)
 * - Session continuity: `--continue` when the configured profile DB exists
 * - No positional prompt arg: startup prompt written to a temp file and
 *   injected as a short read command after the `❯` prompt appears
 * - Bootstrap signal: `❯` in output (not Claude Code's "permissions" status bar)
 * - No trust-folder prompt: Hermes doesn't ask for folder trust on first run
 * - Exit: Ctrl+D (`\x04`), not `/exit\r\n`
 * - No `--dangerously-skip-permissions`; model/provider/reasoning are pinned
 *   from the per-seat cortextOS config on every launch
 */
export class HermesPTY extends AgentPTY {
  private startupPrompt: string = '';
  private agentDir: string;
  private agentName: string;

  constructor(env: CtxEnv, config: AgentConfig, logPath?: string) {
    super(env, config, logPath, HERMES_BOOTSTRAP_PATTERN);
    // Store agentDir here since AgentPTY.env is private
    this.agentDir = config.working_directory || env.agentDir;
    this.agentName = env.agentName;
  }

  /**
   * Returns the hermes binary name.
   * Hermes is a Python package installed via pip — no .cmd wrapper on Windows.
   */
  protected getBinaryName(): string {
    return 'hermes';
  }

  /**
   * Build Hermes CLI args.
   *
   * Hermes session continuity is profile-scoped. The same explicit profile,
   * model, provider, and reasoning pins are passed for fresh and continue
   * launches so a restart cannot silently change routing.
   *
   * No positional prompt: the startup prompt is injected post-boot via a
   * temp file to avoid bracketed paste issues (see class-level comment).
   */
  protected buildClaudeArgs(mode: 'fresh' | 'continue', _prompt: string): string[] {
    const profile = this.getProfile();
    const args = ['--profile', profile];

    if (this.config.model) {
      args.push('--model', this.config.model);
    }
    if (this.config.hermes_provider) {
      args.push('--provider', this.config.hermes_provider);
    }
    if (this.config.hermes_reasoning) {
      args.push('--reasoning', this.config.hermes_reasoning);
    }

    // mode='continue' means shouldContinue() returned true — Hermes DB exists.
    // We pass --continue so Hermes resumes the last session.
    if (mode === 'continue') {
      args.push('--continue');
    }
    return args;
  }

  /**
   * Keep the spawned process on the same profile directory used by
   * `--profile`. A daemon-level HERMES_HOME may relocate the Hermes root; an
   * agent-local value is intentionally overwritten so continuation checks and
   * the PTY cannot resolve different databases.
   */
  protected customizeEnv(env: Record<string, string>): void {
    const profile = this.getProfile();
    env['HERMES_HOME'] = hermesProfileHome(profile, process.env['HERMES_HOME']);
    env['HERMES_PROFILE'] = profile;
  }

  /**
   * Override spawn to write the startup prompt to a temp file and inject it
   * after Hermes boots to the `❯` prompt.
   *
   * We cannot pass the startup prompt as a CLI arg (Hermes has no such flag)
   * and bracketed paste is buggy in Hermes (issue #7316). Instead:
   *   1. Write prompt to .cortextos-startup.md in the agent dir
   *   2. Spawn Hermes normally
   *   3. After `❯` appears (isBootstrapped), inject a single-line read command
   */
  async spawn(mode: 'fresh' | 'continue', prompt: string): Promise<void> {
    // Hermes exits before argparse when --profile names a missing directory.
    // Fail once with an actionable error instead of launching a process that
    // immediately exits and looks like a runtime crash loop.
    assertHermesProfileExists(this.getProfile(), process.env['HERMES_HOME']);
    this.startupPrompt = prompt;
    // Write startup prompt to temp file BEFORE spawn so Hermes can read it
    this.writeStartupFile(prompt);
    // Spawn Hermes (base class handles PTY setup, env injection, exit handler)
    await super.spawn(mode, prompt);
    // After `❯` appears, inject the read command — base class spawn() returns
    // as soon as the PTY is set up, not when Hermes is ready. We schedule
    // the injection asynchronously so spawn() can return quickly.
    this.scheduleStartupInjection();
  }

  /**
   * Hermes's TUI corrupts bracketed paste markers, so inbound Telegram, inbox,
   * and cortextOS-owned cron messages must use raw typed input. Strip terminal
   * control sequences before bypassing bracketed paste, write in bounded
   * chunks, then submit with one deferred Enter.
   */
  override injectMessage(content: string): void {
    const safeContent = stripControlChars(content).replace(/\r\n?/g, '\n');
    const maxChunk = 4096;
    for (let i = 0; i < safeContent.length; i += maxChunk) {
      this.write(safeContent.slice(i, i + maxChunk));
    }
    setTimeout(() => {
      try {
        this.write(KEYS.ENTER);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[hermes-pty] deferred Enter failed (pty likely torn down): ${msg}`);
      }
    }, 300).unref?.();
  }

  /**
   * Write the startup prompt to a temp file in the agent directory.
   * The file is gitignored (.cortextos-startup.md is in .gitignore by convention).
   */
  private writeStartupFile(prompt: string): void {
    try {
      const filePath = join(this.agentDir, STARTUP_PROMPT_FILE);
      writeFileSync(filePath, prompt, 'utf-8');
    } catch (err) {
      // Non-fatal: if the write fails, the injection command will fail gracefully
      console.error(`[hermes-pty] Failed to write startup file: ${err}`);
    }
  }

  /**
   * Wait for Hermes's `❯` prompt, then inject the startup instruction.
   * Runs in the background — does not block spawn().
   */
  private scheduleStartupInjection(): void {
    this.waitForPromptThenInject().catch(err => {
      console.error(`[hermes-pty] Startup injection failed (non-fatal): ${err}`);
    });
  }

  private async waitForPromptThenInject(timeoutMs = 30000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.getOutputBuffer().isBootstrapped()) {
        // `❯` appeared — Hermes is ready. Inject the read command.
        this.write(`Read ${STARTUP_PROMPT_FILE} and follow the instructions there.\r`);
        return;
      }
      await sleep(500);
    }
    // Timeout: Hermes took too long to boot. Inject anyway and let it handle.
    this.write(`Read ${STARTUP_PROMPT_FILE} and follow the instructions there.\r`);
  }

  private getProfile(): string {
    return resolveHermesProfile(this.config.hermes_profile, this.agentName);
  }

}

/**
 * Return the isolated Hermes home for a named standing-agent profile.
 * Hermes itself sets HERMES_HOME to this directory after pre-parsing
 * `--profile`; resolving it here keeps daemon continuation checks aligned.
 */
export function hermesProfileHome(profile: string | undefined, hermesRoot?: string, fallbackAgentName = ''): string {
  const validProfile = resolveHermesProfile(profile, fallbackAgentName);
  const candidateRoot = hermesRoot || join(homedir(), '.hermes');
  const normalizedRoot = basename(dirname(candidateRoot)) === 'profiles'
    ? dirname(dirname(candidateRoot))
    : candidateRoot;
  return join(normalizedRoot, 'profiles', validProfile);
}

/** Check whether the configured Hermes profile has a session database. */
export function hermesDbExists(profile: string | undefined, hermesRoot?: string, fallbackAgentName = ''): boolean {
  return existsSync(join(hermesProfileHome(profile, hermesRoot, fallbackAgentName), 'state.db'));
}

/** Fail before spawn when Hermes's hidden profile parser would exit immediately. */
export function assertHermesProfileExists(profile: string, hermesRoot?: string): void {
  const profileHome = hermesProfileHome(profile, hermesRoot);
  if (!existsSync(profileHome)) {
    throw new Error(
      `Hermes profile "${profile}" does not exist at ${profileHome}. ` +
      `Create it before starting this seat: hermes profile create ${profile} --clone --no-alias`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
