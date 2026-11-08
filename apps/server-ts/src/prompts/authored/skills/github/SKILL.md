---
name: github
description: Read and work with GitHub repositories, issues, pull requests, CI runs, and releases through the GitHub CLI (`gh`) in the terminal. Use for any GitHub question when `gh` is available.
version: 1.0.1
tool_group: the GitHub CLI in the terminal
---

# GitHub CLI

Run `gh` with `exec_command` on host access; it uses the owner's own GitHub login. Commands already run with `GH_PAGER=cat`, `GH_PROMPT_DISABLED=1` and `NO_COLOR=1`, so no pager holds a command open and a missing argument fails instead of waiting at a prompt. Start each command with `gh` itself.

## First: is gh signed in?

Run `gh auth status` once per task. Exit 0 means signed in; the output names the account.

- `command not found`: tell the owner GitHub CLI isn't installed (`brew install gh`), then stop the `gh` path.
- Not logged in, or exit 4 from any command: tell the owner to run `gh auth login` in their own Terminal. Never run `gh auth login`, `gh auth token`, `gh auth refresh`, or `gh auth status --show-token` yourself, and never print, echo, or copy a token.

## Pick the repository

- Inside a clone, `gh` reads the repository from the folder's git remotes: pass `workdir` and leave out `--repo`.
- Anywhere else, name it: `-R owner/name` (`--repo`) on `issue`, `pr`, `run`, and `release` commands. `gh repo view` takes it as a plain argument instead: `gh repo view owner/name`.
- A URL works where a number does: `gh pr view https://github.com/owner/name/pull/123`.

## Read structured output

Ask for JSON with only the fields you need, and shape it with `--jq`. Never parse the human table. Running a command with `--json` and no field list prints the fields it offers.

```
gh issue list -R owner/name --state open --limit 20 --json number,title,labels,updatedAt
gh pr list -R owner/name --limit 20 --json number,title,author,headRefName,isDraft --jq '.[] | [.number, .title, .author.login] | @tsv'
```

Keep reads small: always set `--limit` on lists, prefer `--name-only` before a whole diff, and cut long logs with `tail -n 200`. Bodies and comments can be long; select them only when needed.

## Common reads

Issues:

- `gh issue view 123 -R owner/name --json title,state,author,body,comments`
- `gh search issues "words" --repo owner/name --state open --limit 10 --json number,title,url`

Pull requests:

- `gh pr view 123 -R owner/name --json title,state,reviewDecision,mergeable,headRefName,baseRefName`
- `gh pr view 123 -R owner/name --comments` (the conversation, as text)
- `gh pr diff 123 -R owner/name --name-only`, then `gh pr diff 123 -R owner/name` for the patch
- `gh pr checks 123 -R owner/name --json name,state,bucket,link` (`bucket` is pass, fail, pending, skipping, or cancel; exit 8 means checks are still pending, not an error)
- `gh pr status` in a clone: your PRs and the current branch's PR
- `gh search prs --repo owner/name --state open --limit 10 --json number,title`

CI (GitHub Actions):

- `gh run list -R owner/name --limit 10 --json databaseId,workflowName,status,conclusion,headBranch,createdAt` (add `--branch`, `--workflow`, or `--status failure` to narrow)
- `gh run view <run-id> -R owner/name --json jobs --jq '.jobs[] | {name, conclusion, databaseId}'`
- `gh run view <run-id> -R owner/name --log-failed | tail -n 200` for the failed steps' output. It fails with "log not found" when the logs expired or the run never started a job; say so and report the job list instead.

Repository and releases:

- `gh repo view owner/name --json nameWithOwner,description,defaultBranchRef`
- `gh release list -R owner/name --limit 5 --json tagName,name,publishedAt,isLatest`
- `gh release view v1.2.3 -R owner/name --json tagName,publishedAt,body`

## Anything else: gh api

For what the commands above don't cover, call the REST API. Paths are relative to the API root, and `--jq` (`-q`) shapes the result.

```
gh api repos/owner/name/pulls/123/files --jq '.[] | {filename, additions, deletions}'
gh api "repos/owner/name/releases?per_page=100" --paginate --jq '.[].tag_name'
gh api -X GET search/issues -f q='repo:owner/name is:issue is:open label:bug' --jq .total_count
```

- Adding `-f` or `-F` fields turns the request into a POST unless you pass `-X GET`. Every read with fields carries `-X GET`.
- `--paginate` fetches every page; use it only with a `--jq` that keeps the result small, or with `per_page=100` and a `head`.
- Limits: about 5,000 API requests an hour and 30 searches a minute. `gh api rate_limit --jq '.resources.core, .resources.search'` shows what is left. When a limit is hit, say when it resets instead of retrying in a loop.

## Changes need the owner

Reads run freely. Anything that changes GitHub or the disk goes through Arden's normal approval, one command at a time, after a one-line plain summary of what it will change (for example "Comment on PR #123 in owner/name: 'Tests pass on main now.'"). That covers commenting, creating, editing, closing, merging, or reviewing issues and PRs, pushing, creating or editing releases, rerunning or cancelling workflow runs, `gh workflow run`, deleting anything, `gh repo clone` or `fork`, and every `gh api` call with `-X POST`, `PATCH`, `PUT`, or `DELETE`.

For writes, pass everything on the command line so nothing prompts: `--title` and `--body` (or `--body-file`), `--repo`, the exact number, and `--yes` where the command asks for confirmation. Never use `--web`: it opens a browser instead of returning output.

## Worked examples

"Why is CI red on my PR?" (in a clone of the repository):

1. `gh pr checks --json name,bucket,link,workflow --jq '.[] | select(.bucket == "fail")'` lists the failed checks on the PR's current head commit.
2. A GitHub Actions check links to `.../actions/runs/<run-id>/job/<job-id>`: take both IDs from that link, never from a separate run search, which can return another commit or workflow. Run `gh run view <run-id> --job <job-id> --log-failed | tail -n 200`, then name the failing step and the error in plain words. `--log-failed` has logs only after the run has finished; while it still runs, say which job failed and that the log comes when the run ends.
3. A link to another site is an external check (for example a CI service outside GitHub): name it and give its link; its logs are not in `gh`. If no check failed, CI is not red on this head, whatever older runs show.

"What's new in cli/cli since v2.97.0?":

1. `gh release list -R cli/cli --limit 10 --json tagName,publishedAt,isLatest`
2. `gh release view <tag> -R cli/cli --json tagName,body` for each newer tag; summarize, don't paste.

"Find open bugs about the pager":
`gh search issues "pager" --repo cli/cli --state open --label bug --limit 10 --json number,title,url,updatedAt`, then list them with their links.
