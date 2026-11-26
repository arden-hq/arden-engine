const GITHUB_SUBJECT = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/u

export const githubItemUrl = (threadKey: string): string | undefined => {
  const match = GITHUB_SUBJECT.exec(threadKey)
  return match === null ? undefined : `https://github.com/${match[1]}/issues/${match[2]}`
}
