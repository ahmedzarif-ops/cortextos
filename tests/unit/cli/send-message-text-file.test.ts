/**
 * `cortextos bus send-message --text-file <path>`
 *
 * THE DEFECT THIS EXISTS FOR
 * --------------------------
 * `send-message` takes the body as ONE POSITIONAL and `reply-to` as the NEXT. A body that
 * reaches the shell as an interpolated string can therefore be split by the SHELL, before this
 * process sees argv at all.
 *
 * Measured on zsh 5.9, 2026-09-07, with a body carrying TWO apostrophes inside a single-quoted
 * argument:
 *
 *     printargs 'guard's receipt is chief's'   ->  argc=4
 *       [1] guards  [2] receipt  [3] is  [4] chiefs
 *
 * The apostrophes are deleted and the body becomes four words. Fragment 1 is sent as the whole
 * message, fragment 2 is bound to `reply-to` as a garbage id, the rest is discarded — and the
 * command RETURNS A VALID MESSAGE ID AT EXIT 0. The sender sees complete success.
 *
 * An ODD number fails loudly at parse time ("unmatched '"), which is why that variant is the one
 * people have found. The even case is the common one and it is silent. Control, same shell: a
 * body with no apostrophes returns argc=1.
 *
 * --text-file removes the body from the command line entirely, so the shell never parses it.
 *
 * WHAT IS ASSERTED HERE: the three REFUSALS. They are the safety-critical half — each one is a
 * path where the old shape would have produced a plausible, wrong, successful-looking send. The
 * happy path is the existing send path and is unchanged by this commit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ⛔ THE BUS IS MOCKED BEFORE THE COMMAND IS IMPORTED, AND THAT IS NOT A CONVENIENCE.
//
// These arms drive the REAL `send-message` action. They pass today only because each one exits
// before reaching the send — which makes the SAFETY of the test depend on the CORRECTNESS of the
// code under test. That dependency was not theoretical: while proving these arms can detect a
// missing guard, the both-sources refusal was disabled and the run SENT THE FIXTURE BODY
// ("from the file") to a real agent on the real bus, at 2026-09-07T18:03:11Z. The recipient found
// it; the test reported four green arms either way.
//
// A test that is safe only while the code is correct is not a test, it is a tripwire pointed at
// the fleet — and it fires at exactly the moment the test is most needed. So the transport is
// removed outright: no arm can emit traffic regardless of which guard is broken.
vi.mock('../../../src/bus/message.js', () => ({
  sendMessage: vi.fn(() => {
    throw new Error('sendMessage must never be reached by these tests: every arm is a refusal');
  }),
  checkInbox: vi.fn(() => []),
  ackInbox: vi.fn(),
}));

import { busCommand } from '../../../src/cli/bus';
import { sendMessage } from '../../../src/bus/message.js';

function sendMessageCmd() {
  const cmd = busCommand.commands.find((c) => c.name() === 'send-message');
  if (!cmd) throw new Error('send-message command not found');
  return cmd;
}

describe('send-message --text-file', () => {
  let dir: string;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ctx-textfile-'));
    // process.exit must THROW here, not return: the code under test calls exit() and then
    // continues on the next line. A spy that merely records the call would let execution run
    // past the refusal and into the send path — the test would pass while the guard did not
    // actually stop anything.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`EXIT:${code}`);
    }) as never);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE ESCAPED MESSAGE. Every arm is a refusal, so the
    // transport must be untouched in ALL of them — including any future arm someone adds. Checked
    // here rather than per-test so it cannot be forgotten by the next author.
    expect(sendMessage).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('REFUSES an EMPTY file rather than sending an empty message with a valid id', async () => {
    // The dangerous case, and the reason this is not just a convenience flag. A zero-byte file
    // is what a FAILED CAPTURE looks like — a redirect that produced nothing, a command that
    // errored into an empty file. Sending it would return a message id for a message with no
    // content, which is the same false success the flag exists to remove.
    const f = join(dir, 'empty.txt');
    writeFileSync(f, '');

    await expect(
      sendMessageCmd().parseAsync(['node', 'send-message', 'chief', 'normal', '--text-file', f]),
    ).rejects.toThrow('EXIT:1');

    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/EMPTY/);
  });

  it('REFUSES an unreadable path instead of sending a message about the error', async () => {
    await expect(
      sendMessageCmd().parseAsync([
        'node', 'send-message', 'chief', 'normal', '--text-file', join(dir, 'nope.txt'),
      ]),
    ).rejects.toThrow('EXIT:1');

    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/Could not read --text-file/);
  });

  it('REFUSES both a positional body AND --text-file rather than guessing', async () => {
    // Two sources for one field is ambiguous, and silently preferring either one would make the
    // other silently ineffective — a caller who thinks the file is being sent while the
    // positional wins gets exactly the truncation this flag was built to prevent.
    const f = join(dir, 'body.txt');
    writeFileSync(f, 'from the file');

    await expect(
      sendMessageCmd().parseAsync([
        'node', 'send-message', 'chief', 'normal', 'from the command line', '--text-file', f,
      ]),
    ).rejects.toThrow('EXIT:1');

    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/not both/);
  });

  it('REFUSES when neither a body nor --text-file is given', async () => {
    // <text> became optional so --text-file could replace it. That must not turn a missing body
    // into an empty send: the argument was REQUIRED before this change and the refusal preserves
    // that contract.
    await expect(
      sendMessageCmd().parseAsync(['node', 'send-message', 'chief', 'normal']),
    ).rejects.toThrow('EXIT:1');

    expect(errSpy.mock.calls.flat().join(' ')).toMatch(/Missing message body/);
  });
});
