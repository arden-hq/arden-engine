export type GitConfigEntry = readonly [key: string, value: string]

// Honored only from protected config: https://git-scm.com/docs/git-config#Documentation/git-config.txt-safebareRepository
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
