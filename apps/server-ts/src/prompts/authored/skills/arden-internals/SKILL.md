---
name: arden-internals
description: Explain Arden's internal state, automation health, recorded runs, token usage, plan limits, and available capabilities using current evidence. Use for troubleshooting or reviewing Arden itself, including all-automation reviews.
version: 1.1.0
tool_group: Internal diagnostics, run inspection, and usage
---

# Arden Internals

Use current read tools to answer questions about Arden itself. Page context identifies the user's selection and dates; it is not a live status report. Read the relevant state before giving a diagnosis.

## Choose the smallest useful investigation

- One automation: call `automation_diagnose` with its exact `automation_ref`, inspect its saved settings through `automation_list`, and read recent outcomes with `automation_list_runs`. Use `run_inspect` for a specific recorded run; inspect the associated session only when needed.
- All automations: start with `automation_list` and `automation_diagnose` without a reference. Summarize active, paused, failing, and waiting work; investigate exceptions individually. State the scope returned by each tool. `automation_list` includes personal and system Automations plus Automations whose channel belongs to the current Space; global worker diagnostics can cover other Spaces and jobs. Do not present a bounded queue sample or selected run histories as a complete audit. Follow available pagination and report remaining coverage gaps.
- For model or permission questions, read the Automation's execution and reporting Chat references separately. `model: null` is no explicit override, not proof that a run uses Background; use `effective_model` and `model_source` from `automation_list`. Its `action_mode` comes from the execution Chat when the tool can read them. Moving the reporting Chat does not move those permissions.
- For context questions, read `context_mode` from the Automation and from each recorded run. `fresh` excludes earlier Chat turns from model input but still posts into the same audit Chat; `continue` uses the available, possibly compacted Chat context. Historical runs keep the mode captured at admission.
- Recent runs: compare outcomes and recurrence, not just the last status. A completed run does not prove an external write succeeded. Distinguish errors, intentional no-change outcomes, and missing evidence.
- Token usage: use `usage_report` with the requested UTC window and grouping. Compare largest contributors before reading traces. Separate total token volume, uncached input, output, and cache-read share of input. Cache reads can make a repeated stable prefix cheaper without reducing total recorded tokens. `average_last_input` is the final model input averaged across Runs, not total usage per Run or average input across model steps. Daily rollups and retained run breakdowns have different coverage; missing receipts are not zero usage. Keep space, kind, origin, session, and automation rankings as separate lenses; do not add or rank overlapping totals together.
- Plan limits: use `usage_limits`. It reads the provider's own plan meter (percent used per window, reset time, pace) and the user's limits. The percent is shared with Codex CLI and ChatGPT on the same account, so never convert Arden's tokens into it or attribute the whole percent to Arden. A Run or Automation waiting on a limit is paused, not stuck or failed; it resumes by itself after the reset, or sooner if the user raises the limit or chooses to keep going. The limits belong to the user in Settings > Usage: suggest a change, never claim one.
- Capabilities or settings: inspect available tool and skill descriptions and the relevant settings reads. Distinguish available, configured, and observed working. Do not claim access to configuration or runtime state that no available tool exposes.

## Interpret state carefully

A job deferred on a plan limit is waiting, not overdue: check `usage_limits` before diagnosing a scheduler problem. A lease records ownership, not progress. Check live worker observations, configured capacity, queue age, retries, destination chat activity, disabled schedules, and pending questions. Missing or stale observations mean unknown, not stopped. Some due schedules are materialized only when capacity is available.

Do not reset a schedule or rerun work merely to make a warning disappear. Before recommending a retry, inspect prior outcomes and possible external effects. If the cause cannot be observed, name the missing evidence and the next useful check.

## Explain and improve

Lead with the finding, supporting evidence, and useful next action. Link the relevant Automation, Chat or Settings where possible. A request for an explanation does not authorize configuration changes. Keep facts separate from hypotheses. For portfolio reviews, prioritize a few actionable exceptions instead of dumping every run.

For improvements, inspect saved instructions, schedules, and actual outcomes. Prioritize actions the user can take now: pause work, reduce frequency, change scope, or choose a cheaper model. Present already-paused work as savings already captured, not a pending recommendation. Do not infer waste from token totals alone. Stable repeated context can be cheaper because it keeps the cache prefix; recommend a fresh chat or context reduction only when the observed uncached-input or cost tradeoff supports it. Before suggesting artifact offloading or different child-agent inheritance, verify Arden's existing offloading and isolation mode for that path. Architecture changes are out of scope unless the user asks for product improvements. An explanation or review request does not authorize edits, pauses, deletions, or reruns. Use existing action tools only when the user's request authorizes the change. Load `work-coordination` when managing Automations; this Skill provides diagnostic guidance, not a second scheduler or management system.

## Inline references

For `arden:automation/<ref>`, use the decoded public reference with automation reads. For `arden:task/<id>`, or the older `arden:work/<id>` still in history, inspect that Task. For `arden:memory/<path>`, read that Memory path and follow a reported redirect. Labels may be outdated; use tool results for current names and state. If the target is missing or inaccessible, say so instead of substituting a similarly named entity. `arden:automation` means all accessible Automations; `arden:memory` means the Memory vault (`wiki_list_pages`, `wiki_search`). A Settings tab is a read, not a page: `arden:settings/usage` means `usage_limits` plus `usage_report` for the asked window, `arden:settings/skills` means `skill_list`, `arden:settings/integrations` means `google_accounts_list` plus the connected-capability tool descriptions. A place reference names scope, never a state: answer from the read behind it, and say so when no tool exposes what was asked. Usage drafts carry the selected UTC window and grouping as editable text.
