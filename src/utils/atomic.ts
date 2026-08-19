import {
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  unlinkSync,
} from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

/**
 * Atomically write data to a file by writing to a temp file first,
 * then renaming. Rename is atomic on the same filesystem.
 * Matches the bash pattern: printf > .tmp.file && mv .tmp.file file
 *
 * When `keepBak` is true (default: false), the CURRENT file is copied to
 * `<filePath>.bak` before the rename.  This gives callers a single-step
 * rollback point without the cost of maintaining a full backup chain.
 * The `.bak` write is best-effort — if it fails the main write still proceeds.
 */
export interface AtomicWriteOperations {
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
  mkdirSync: typeof mkdirSync;
  existsSync: typeof existsSync;
  copyFileSync: typeof copyFileSync;
  unlinkSync: typeof unlinkSync;
}

const DEFAULT_ATOMIC_WRITE_OPERATIONS: AtomicWriteOperations = {
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  unlinkSync,
};

export function atomicWriteSync(
  filePath: string,
  data: string,
  keepBak = false,
  operationOverrides: Partial<AtomicWriteOperations> = {},
): void {
  const operations = { ...DEFAULT_ATOMIC_WRITE_OPERATIONS, ...operationOverrides };
  const dir = dirname(filePath);
  operations.mkdirSync(dir, { recursive: true });

  // Best-effort backup of the current file before overwriting.
  if (keepBak && operations.existsSync(filePath)) {
    try {
      operations.copyFileSync(filePath, filePath + '.bak');
    } catch {
      // Ignore backup errors — do not block the main write.
    }
  }

  const tmpPath = join(dir, `.tmp.${randomBytes(6).toString('hex')}`);
  try {
    operations.writeFileSync(tmpPath, data + '\n', { encoding: 'utf-8', mode: 0o600 });
    operations.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      operations.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}
