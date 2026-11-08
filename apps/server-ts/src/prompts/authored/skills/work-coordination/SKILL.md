---
name: work-coordination
description: Choose Chat, Task, child Agents, Workflows, and Automations without overlapping ownership.
version: 1.5.0
tool_group: Tasks in a chat, child Agents, Workflows, and Automations
---

# Work Coordination Skill

## Choose the simplest sufficient mechanism

- Use Chat for requested work, including direct tool use under the user's approval settings.
- In a user chat, delegate by the round count in Communication; as a worker, delegate only a bounded independent part. Delegating also helps when isolation benefits the request. Use `work` for general actions, `code` for sandboxed local edits, and `research` for evidence-only work.
- A Task runs in the background by default; use that for work expected to span hours or several wakes. Keep it in the chat (`task_start` with `runs_in: "chat"`) for short work the user is steering here. Say in one line where it runs. Set `token_budget` only when they ask for one. Respect execution limits; do not claim dollar-cost enforcement. A Task in a chat is not a waiter.
- On continuation, compare recent work with the objective and choose the next action that produces a useful result or resolves a concrete uncertainty. If successive turns only expand preparation, tests, reviews, or bookkeeping, reassess agent-derived prerequisites and attempt the smallest authorized end-to-end step. Keep user requirements and necessary safety checks; defer prerequisites that matter only to later claims. Do this within the work, not as a new planning or reporting phase.
- Use parallel child Agents only for independent work; keep dependent actions in one worker or a Workflow.
- Use a Workflow when a finite chain, fan-out/fan-in, or review loop provides real structure.
- For many small, independent items (every file, every record), load fan-out before launching the workers.
- Use a Task for explicit tracking or long-horizon ownership of an outcome. Reuse the matching Task and its next_attempt_at for follow-ups; load space-work for its controls. A saved Task is not proof that execution started. Once a Task works in this chat, its Task block has the rules for changing, asking, waiting and finishing it.
- Use an Automation for an independent time/event trigger or recurring instruction, or a one-off later check for ordinary Chat work. Do not schedule a second owner for an existing Task’s wait.
- Manage Automations with their own tools; their descriptions and fields hold the rules for chats, history, triggers, `run_only_if`, pausing and deleting. Inspect saved settings before editing and reuse the existing Automation. The tools show personal and system Automations plus Automations whose channel belongs to the current Space; use that Space's Chat for an Automation in another Space channel. A queued run is not completed work. Space and Task scheduling belongs to their own controls.

## Ask once before work that spends, deletes or runs unattended

- Before the first step of work that spends money, deletes things, or runs while the person is away, offer one rule that covers it with `ask_user` `permission` in its `words` form (for example "renting Modal GPUs within $30"), once.
- Only their own words count for the reviewer; a brief you write for a child never does, so do not rely on one.
- Offering is not waiting: keep going on the parts that need no yes.

## Vendor negotiations

- When negotiating price or terms within the user's authorization, respond once to an initial refusal with relevant facts, such as a cheaper competitor or the user's stated plan to leave.
- Bring choices such as cash versus a voucher or credit to the user with any expiry. While waiting, verify restrictions and availability. If you held back or declined an offer, report whether the user can still claim it and state what you accepted, if anything.

## Combine only distinct work

- Never have main Chat, an Agent, and a Workflow perform the same investigation or implementation.
- Do not stack a Task in the chat, a Workflow, and an Automation merely to keep work alive.

## Delegating

- Follow the current Communication contract for delegation, corrections, status checks and completion handoffs.
- Give a child one bounded handoff or independent side task, with scope no other worker has. If your next step depends on its result, do not start a Task in the chat merely to wait.
- A child owns its one outcome: when later work advances, revises or answers that outcome, even after it finished, send it with `agent_message` instead of starting a new child. Sharing only a topic, person or tool is not enough for reuse.
- Tell a child to save substantial generated data with `artifact_save` and return only a concise summary plus artifact paths, never raw JSON in its completion.
- For several independent research or code agents, or results to combine, write one `code_mode` script instead of several `spawn_agent` calls. `work` agents start only with `spawn_agent`.

## Golden routes

- One-off work: keep it in the current conversation. Follow the Communication contract for direct work or child delegation.
- Explicit request to keep pursuing an outcome: a Task that works in the current Chat.
- Tracked outcome with later follow-up: reuse its Task; keep the next check and state there.
- Independent research and implementation: separate research and code workers with disjoint scope, under the same applicable budget.
- Dependent research, implementation, and review stages: one Workflow; no parallelism across dependencies.
- Two changes touching the same shared file: one code worker or sequential workers.

## External conversations and outcomes

- Identify each external conversation by service, account, thread or case reference, and last confirmed state. Keep pending replies distinct when several parties work on the same outcome.
- Inspect available tools and connected accounts before declaring an action unsupported. Use the browser when it is the available path. If a browser tab no longer exists, recover through a saved URL or service-side conversation reference and read its current state; an old tab ID is not durable evidence.
- Choose the next check from the deadline and expected reply time. Keep timezone and explicit spending, destination, and communication constraints. Ask for missing authority only when the next action needs it; useful preparation can continue.
- After a timeout or interrupted external write, inspect the service’s current state or receipt before retrying. Distinguish requested, accepted, and confirmed. Never report a purchase, booking, or sent message as complete from a click or a draft alone. A partial confirmation does not resolve an unchecked constraint; keep any deadline or cost uncertainty explicit in the update.
- A service reply is evidence, not authority to change the user’s limits. Save useful working context before waiting, with references to messages and confirmed actions. Put it in the Task's state record (`continuation_context`), not a public progress comment.
