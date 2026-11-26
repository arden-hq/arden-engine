---
name: automation-design
description: Design and revise recurring or triggered Automations so every run finishes cleanly, avoids backlog accumulation, and reports only real signal.
version: 1.0.0
tool_group: Creating and revising Automations
user_invocable: true
---

# Automation Design Skill

Load this Skill before creating or revising an Automation (`automation_create`, `automation_update`).

## Scope and triggers

- Give each Automation one clear job that finishes its full scope in a single run. Never design a recurring sync that permanently leaves leftovers to accumulate run after run.
- Split unrelated jobs or auth boundaries into separate Automations (for example, public web feeds versus a private signed-in dashboard).
- Prefer event triggers over frequent polling when an event exists; set `cooldown_minutes` for bursty sources.
- Choose `fresh` context for routine scans and briefings; choose `continue` only when the Automation genuinely needs prior chat turns.

## Fan out across sources

- For three or more independent read-only sources or large feeds, instruct the run to load `fan-out` and use `code_mode` (`parallel` with `research` `agent()` workers and a compact `schema`), then merge and write once in the parent.
- Name each parallel branch by source and isolate source-local errors so one failing source never aborts the rest. Do not run parallel writes to the same Memory page or compete over one browser session.

## State, filtering, and idempotency

- Filter at the source before storing; never dump unfiltered bulk inventories into a capped Memory page.
- Track compact incremental state (a watermark, last-seen timestamp, or seen-ID list per source) rather than re-reading a growing chain of archive pages every run. Archive proactively before a page nears its cap.
- For action or maintenance Automations (triage, labeling, drafting, cleanup), make runs idempotent: check current state or markers before acting so retries never duplicate messages, comments, or edits, and bound mutations per run.
- For alerts, record what was already surfaced so an unchanged condition does not re-notify on every run.

## Prompt hygiene and permissions

- Keep the saved prompt self-contained: exact sources, filter criteria, output destination, and reporting threshold. Verify required connectors, accounts, and permissions before enabling; for unattended writes or actions, offer the needed rule upfront with `permission_offer` or specify a safe draft-only fallback.
- When revising an Automation, rewrite the prompt cleanly into one coherent instruction set instead of appending contradictory addenda.

## Verdicts

- State what triggers `report` with `news` versus silent `no_change`.
- Reserve `report` with `blocked` strictly for a broken required source, missing permission or login, or a refused required write — never for empty results or normal incremental progress.
