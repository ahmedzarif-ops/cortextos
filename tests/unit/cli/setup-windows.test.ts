import { describe, expect, it } from 'vitest';
import { pm2Command, selectTelegramIdentity } from '../../../src/cli/setup.js';

describe('setup Windows portability', () => {
  it('selects the latest private Telegram message and keeps user authorization', () => {
    expect(selectTelegramIdentity({
      result: [
        { message: { chat: { id: 10, type: 'private' }, from: { id: 10 } } },
        { message: { chat: { id: 20, type: 'private' }, from: { id: 20 } } },
      ],
    })).toEqual({ chatId: '20', userId: '20' });
  });

  it('rejects group-only updates because manual setup authorizes a private user', () => {
    expect(selectTelegramIdentity({
      result: [
        { message: { chat: { id: -100123, type: 'supergroup' }, from: { id: 20 } } },
      ],
    })).toBeNull();
  });

  it('ignores a later group update when a private identity is available', () => {
    expect(selectTelegramIdentity({
      result: [
        { message: { chat: { id: 123, type: 'private' }, from: { id: 456 } } },
        { message: { chat: { id: -789, type: 'group' }, from: { id: 999 } } },
      ],
    })).toEqual({ chatId: '123', userId: '456' });
  });

  it('uses ComSpec to invoke the PM2 cmd shim on Windows', () => {
    const previous = process.env.ComSpec;
    process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';
    try {
      expect(pm2Command('win32', ['start', 'ecosystem.config.js'])).toEqual({
        command: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/d', '/s', '/c', 'pm2 start ecosystem.config.js'],
      });
    } finally {
      if (previous === undefined) delete process.env.ComSpec;
      else process.env.ComSpec = previous;
    }
  });

  it('invokes PM2 directly on Unix', () => {
    expect(pm2Command('linux', ['save'])).toEqual({ command: 'pm2', args: ['save'] });
  });
});
