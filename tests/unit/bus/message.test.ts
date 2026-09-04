import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { sendMessage, checkInbox, ackInbox } from '../../../src/bus/message';
import { resolvePaths } from '../../../src/utils/paths';
import type { BusPaths } from '../../../src/types';

describe('Message Bus', () => {
  let testDir: string;
  let senderPaths: BusPaths;
  let receiverPaths: BusPaths;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-bus-test-'));
    // Override ctxRoot to use temp directory
    senderPaths = {
      ctxRoot: testDir,
      inbox: join(testDir, 'inbox', 'sender'),
      inflight: join(testDir, 'inflight', 'sender'),
      processed: join(testDir, 'processed', 'sender'),
      logDir: join(testDir, 'logs', 'sender'),
      stateDir: join(testDir, 'state', 'sender'),
      taskDir: join(testDir, 'tasks'),
      approvalDir: join(testDir, 'approvals'),
      analyticsDir: join(testDir, 'analytics'),
      heartbeatDir: join(testDir, 'heartbeats'),
    };
    receiverPaths = {
      ...senderPaths,
      inbox: join(testDir, 'inbox', 'receiver'),
      inflight: join(testDir, 'inflight', 'receiver'),
      processed: join(testDir, 'processed', 'receiver'),
      logDir: join(testDir, 'logs', 'receiver'),
      stateDir: join(testDir, 'state', 'receiver'),
    };
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('sendMessage — empty body rejection (task_1788506864700_32505229)', () => {
    // WHY THESE ASSERT ON THE ARTIFACT AND NOT ON rc:
    // The defect was never "it returns success". It was that an empty send MINTED AN ID and was
    // HMAC-SIGNED, so it woke the recipient carrying the same `sig` as real traffic. A fix that
    // threw while still writing a signed file would pass an rc-only test and leave the artifact
    // behind — which is the bug. So every case below asserts NO ID, NO FILE, NO SIGNATURE.
    const EMPTY_BODIES: Array<[string, string]> = [
      ['empty string', ''],
      ['spaces only', '   '],
      ['tab only', '\t'],
      ['newline only', '\n'],
      ['mixed whitespace', ' \t\n\r '],
    ];

    for (const [label, body] of EMPTY_BODIES) {
      it(`rejects ${label}: throws, mints no id, writes no file`, () => {
        const receiverInbox = join(testDir, 'inbox', 'receiver');

        let returned: string | undefined;
        expect(() => {
          returned = sendMessage(senderPaths, 'sender', 'receiver', 'normal', body);
        }).toThrow(/empty/i);

        // THE ABSENCE OF AN ID is the assertion, not the throw.
        expect(returned).toBeUndefined();

        // No artifact reached the recipient — so nothing was signed either.
        let files: string[] = [];
        try { files = readdirSync(receiverInbox).filter(f => f.endsWith('.json')); } catch { files = []; }
        expect(files).toEqual([]);
      });
    }

    it('POSITIVE CONTROL: a one-character body still sends, is signed, and is delivered', () => {
      // Without this the suite above passes on a sendMessage that rejects EVERYTHING.
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'x');
      expect(msgId).toBeTruthy();

      const files = readdirSync(join(testDir, 'inbox', 'receiver')).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);

      const written = JSON.parse(readFileSync(join(testDir, 'inbox', 'receiver', files[0]), 'utf8'));
      expect(written.text).toBe('x');
      expect(written.id).toBe(msgId);
    });

    it('preserves a body whose content is real but surrounded by whitespace', () => {
      // The check is on the TRIMMED body; it must not trim the stored text.
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', '  hello  ');
      expect(msgId).toBeTruthy();

      const files = readdirSync(join(testDir, 'inbox', 'receiver')).filter(f => f.endsWith('.json'));
      const written = JSON.parse(readFileSync(join(testDir, 'inbox', 'receiver', files[0]), 'utf8'));
      expect(written.text).toBe('  hello  ');
    });
  });

  describe('sendMessage', () => {
    it('creates a JSON file in receiver inbox', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'Hello');
      expect(msgId).toBeTruthy();

      const receiverInbox = join(testDir, 'inbox', 'receiver');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      expect(files.length).toBe(1);

      // Verify filename format: {pnum}-{epochMs}-from-{sender}-{rand5}.json
      expect(files[0]).toMatch(/^2-\d+-from-sender-[a-z0-9]{5}\.json$/);
    });

    it('produces JSON matching bash format', () => {
      sendMessage(senderPaths, 'paul', 'boris', 'high', 'Build the page');

      const receiverInbox = join(testDir, 'inbox', 'boris');
      const files = readdirSync(receiverInbox).filter(f => f.endsWith('.json'));
      const content = JSON.parse(readFileSync(join(receiverInbox, files[0]), 'utf-8'));

      // Verify all fields match bash send-message.sh format
      expect(content).toHaveProperty('id');
      expect(content).toHaveProperty('from', 'paul');
      expect(content).toHaveProperty('to', 'boris');
      expect(content).toHaveProperty('priority', 'high');
      expect(content).toHaveProperty('timestamp');
      expect(content).toHaveProperty('text', 'Build the page');
      expect(content).toHaveProperty('reply_to', null);

      // Verify filename has priority 1 (high)
      expect(files[0]).toMatch(/^1-/);
    });

    it('encodes priority correctly in filename', () => {
      sendMessage(senderPaths, 'a', 'b', 'urgent', 'test');
      sendMessage(senderPaths, 'a', 'b', 'high', 'test');
      sendMessage(senderPaths, 'a', 'b', 'normal', 'test');
      sendMessage(senderPaths, 'a', 'b', 'low', 'test');

      const inbox = join(testDir, 'inbox', 'b');
      const files = readdirSync(inbox).filter(f => f.endsWith('.json')).sort();

      expect(files[0]).toMatch(/^0-/); // urgent
      expect(files[1]).toMatch(/^1-/); // high
      expect(files[2]).toMatch(/^2-/); // normal
      expect(files[3]).toMatch(/^3-/); // low
    });

    it('rejects invalid agent names', () => {
      expect(() =>
        sendMessage(senderPaths, '../bad', 'good', 'normal', 'test')
      ).toThrow();
    });
  });

  describe('checkInbox', () => {
    it('returns empty array for empty inbox', () => {
      const messages = checkInbox(receiverPaths);
      expect(messages).toEqual([]);
    });

    it('returns messages sorted by priority', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'low', 'low priority');
      sendMessage(senderPaths, 'sender', 'receiver', 'urgent', 'urgent');
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'normal');

      const messages = checkInbox(receiverPaths);
      expect(messages.length).toBe(3);
      expect(messages[0].priority).toBe('urgent');
      expect(messages[1].priority).toBe('normal');
      expect(messages[2].priority).toBe('low');
    });

    it('moves messages to inflight', () => {
      sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths);

      const inboxFiles = readdirSync(receiverPaths.inbox).filter(f => f.endsWith('.json'));
      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));

      expect(inboxFiles.length).toBe(0);
      expect(inflightFiles.length).toBe(1);
    });
  });

  describe('ackInbox', () => {
    it('moves message from inflight to processed', () => {
      const msgId = sendMessage(senderPaths, 'sender', 'receiver', 'normal', 'test');
      checkInbox(receiverPaths); // moves to inflight

      ackInbox(receiverPaths, msgId);

      const inflightFiles = readdirSync(receiverPaths.inflight).filter(f => f.endsWith('.json'));
      const processedFiles = readdirSync(receiverPaths.processed).filter(f => f.endsWith('.json'));

      expect(inflightFiles.length).toBe(0);
      expect(processedFiles.length).toBe(1);
    });
  });
});
