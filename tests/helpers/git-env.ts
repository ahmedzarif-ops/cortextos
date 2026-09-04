// ONE LIST, ONE PLACE. Three test files need the same scrub, and three copies of a list is
// three chances for one of them to fall behind — which is the shape of the defect this exists
// to stop, one level up.
//
// WHY ANY OF IT: git exports these to every hook it runs, and every child inherits them.
// GIT_DIR OVERRIDES cwd-based repository discovery, so a `git` call passing
// `cwd: <a temp dir>` — correct, and correct-looking — writes into the repository being
// pushed instead. `npm test` under the pre-push hook is exactly that situation.
export const LEAKED_GIT_ENV = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_PREFIX',
  'GIT_QUARANTINE_PATH',
] as const;

/**
 * Remove them from this process for the life of the test file, and hand back a restorer.
 *
 * Call at module scope, before any test runs a git command. Vitest gives each file its own
 * process, so this is scoped; the restore exists so the file is still a good citizen if that
 * ever stops being true. Leaving a mutated environment behind is how this defect reaches the
 * next person.
 */
export function scrubLeakedGitEnv(): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of LEAKED_GIT_ENV) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
