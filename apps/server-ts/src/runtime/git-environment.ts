export type GitConfigEntry = readonly [key: string, value: string]

/**
 * Git refuses a bare repository it finds by walking up from the working
 * directory; one named by `--git-dir` or `GIT_DIR` still works. A bare
 * repository planted inside a cloned project (its own `config` with
 * `core.fsmonitor`, `core.pager` or hooks) would otherwise run that config for
 * any `git` a process runs once it is inside it. Git 2.38+ reads the setting
 * only from protected config, which includes this command scope; older Git
 * ignores it. As Codex runs its own Git (`git-utils/src/lib.rs`
 * `SAFE_BARE_REPOSITORY_CONFIG`).
 */
export const SAFE_BARE_REPOSITORY: GitConfigEntry = ["safe.bareRepository", "explicit"]

export const withGitConfig = <E extends Readonly<Record<string, string | undefined>>>(
  environment: E,
  entries: ReadonlyArray<GitConfigEntry>
): E & Record<string, string> => {
  const existing = environment["GIT_CONFIG_COUNT"]
  const start = existing !== undefined && /^\d+$/.test(existing) ? Number(existing) : 0
  const appended: Record<string, string> = { GIT_CONFIG_COUNT: String(start + entries.length) }
  entries.forEach(([key, value], offset) => {
    appended[`GIT_CONFIG_KEY_${start + offset}`] = key
    appended[`GIT_CONFIG_VALUE_${start + offset}`] = value
  })
  return { ...environment, ...appended }
}

export const withSafeGit = <E extends Readonly<Record<string, string | undefined>>>(
  environment: E
): E & Record<string, string> => withGitConfig(environment, [SAFE_BARE_REPOSITORY])
