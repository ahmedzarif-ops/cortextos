import { symlinkSync } from 'node:fs';

/**
 * Create a directory link using the native unprivileged mechanism for the
 * current host. Windows directory junctions do not require Developer Mode or
 * elevation; Unix retains normal directory symlinks.
 */
export function createDirectoryLink(
  target: string,
  linkPath: string,
  platform: NodeJS.Platform = process.platform,
): void {
  symlinkSync(target, linkPath, platform === 'win32' ? 'junction' : 'dir');
}
