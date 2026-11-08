---
name: space-work
description: Keep Space and Task work current while progressing, coordinating, and reporting it.
version: 1.8.0
tool_group: Spaces and Work items
---

# Space and Work Skill

Keep the Space board, Task state, and attached page current.

## Resolve the target

- Use `space_list` only when the Space is not already known. Reuse the exact `space_id` it returns.
- Use `space_board_read` before creating or updating Work. It returns the exact `item_id` for Task links or `app_open`, plus `stable_key` and `updated_at` for mutations and recent comments.
- Use `space_page_read` for durable Space context. Continue by `offset` when `content_truncated` is true.

## Work loop

1. Read the board and find an existing Task with the same outcome before using `task_start`.
2. Create from Chat only when the user explicitly asks to create/track a Task, or the request requires long-horizon ownership, such as later follow-up or an ongoing outcome. An ordinary "fix this" request, complexity, tool count, or elapsed time is not a reason to create a Task. Supply `capture.basis` and one concrete `capture.reason`, a durable lowercase `key`, short outcome `text`, useful `body`, and next-action `owner`. Write the title as a clear 3–10 word action someone would say aloud. Put scope, proof, caveats and rationale in the body. For example, write “Review LiveKit and Elicit roles”, not “Combine LiveKit and Elicit evidence into the canonical first-wave review.” Creation records the objective; it does not grant execution permission. Only the user's own chats and their Automations start Tasks: a Space review, Task worker or built-in Automation proposes one with `task_propose` on its Space while the Space suggests tasks (with no Space, to Home), or names it in its report.
3. End each wake by saving the Task's state record as `continuation_context` in the call that ends it (`task_wait` or `task_update`). Confirm the save briefly; do not repeat the record unless asked.
4. To change a Task, pass its key and the latest `updated_at` as `expected_updated_at`: `task_update` for its text, details, owner, where it runs or whether it is open; `task_wait` to wait on someone or book a later check; `task_finish` to finish or cancel it. On a conflict, read it again (`task_get`) and rebuild the change from current state.
5. In a Task job, change only what a run may: finish or cancel that Task (`task_finish`), wait on an external dependency or set the next check (`task_wait`), or save its state record (`continuation_context`). Use `ask_user` when the user must decide or perform an action the run cannot perform. It already waits for their answer; no `task_wait` is needed afterward. An Automation whose job is done ends itself (`automation_followup` stop, or its one time ran) and is removed; do not pause it as cleanup.
6. Use `task_comment` for a durable progress note. A note is never the Task's outcome: a Task run's outcome is its final response, and a completed Task's is `completion_result`. Save longer detail with `task_save_result` and link it. When `ask_user` links prepared content, keep that link in the state record (`continuation_context`) so a later reminder can still open it. Comments never resolve questions or wake work.
7. Write a progress comment only for a real change, decision, or blocker. Use one or two short sentences: what changed, then what it means or happens next. Add a useful link when available. Keep detailed evidence in the existing artifact; do not narrate the proof or repeat unchanged comments.
8. In a Task run, the final response is already recorded in the timeline. Do not repeat that same outcome with a comment.

## Read signals in context

- Compare the latest user intent and corrections with the board, relevant source Chat, Space instructions, and Memory page. Keep the objective unless the user changes it.
- Separate dated facts from standing permissions. Correct facts only from current evidence; a stale fact never cancels a restriction, hold or snooze. If standing instructions need amendment, name the exact source and proposed change once. Keep changing technical context in linked Memory rather than copying it into every brief.
- Distinguish a new obligation from context, a preference, an idea, or an external update. Name the concrete outcome a signal affects and verify what actually changed.
- Review open proposals and current Chat activity alongside Tasks. Work already running or queued in Chat stays there.
- To check an older proposal, read its exact action evidence with `session_read` and `view: "actions"`. Read every payload part, then compare the arguments and result with the requested outcome and with newer user direction.
- An exact applied action can complete a proposal while unrelated work continues. An applied action or a completed run alone does not prove the outcome succeeded. Drafts, partial work, queued work and different outcomes are not completion. If queued or unread direction makes completion uncertain, keep the proposal. Ordinary Chat evidence still needs the latest completed turn.
- Retire an obsolete proposal through `task_propose` with decision `retire`, its exact revision, and evidence of completion or coverage from any Chat, Space, Memory page, Task, or mail or GitHub item (search all Spaces with `session_search_transcripts` scope `all_spaces`). Only a record showing the outcome done counts: a finished Chat turn, an applied action, a CI-green or merged item, a Memory page recording the result. A mention, draft, plan or run with no clear result is not proof. This is not a user Skip. Finish the Space review as `reconciled` and list every proposal you created or retired.
- Resolve Space inference with the tool's typed decision. Choose `reuse` with the exact `item_id` when a matching Task owns the outcome; choose `create` only for distinct work. Evidence or progress already owned by a Task belongs on that Task, not a new merged Task or cleanup Task. Respect rejections: skipped proposals and accepted Tasks the user stopped. When evidence is weak, keep a suggestion in Chat instead of creating or scheduling work.
- A Task belongs to the Space whose purpose owns its outcome, not the Space where the evidence surfaced. A decision the user must make is a question, not a Task handed to them: keep the Task, call `ask_user` with the decision and its choices (for example Apply or Leave as is; the card brings its own Skip), and end the Run until they answer. A Task owned by the user is only for an action they take outside Arden (sign, submit, pay, call); its title says that action and its body opens with what Arden already prepared.
- Use `ask_user` for a required decision, the Task fields for state and scheduling, and Memory for durable context. A comment does not answer a question, complete a Task, or schedule a retry.
- In prose, link Tasks as `[readable title](arden:task/<item_id>)` and Space pages with the returned Memory path. Any request for the user to inspect or act on a Task must include that exact Task link. `stable_key` is a mutation handle, not the Task link target. Reuse the named links and `task_url` returned by Work tools; keep exact mutation handles in tool arguments.

## Follow work in Chat

- When the user asks for an existing Task's updates, questions or results in this Chat instead of where it is, use `task_move_here` with its `item_id`. The Task then belongs to this Chat; it does not create another Task. To have it work here rather than in the background, `task_update` with `runs_in: "chat"`.

## Space page edits

- Use `space_page_patch` for one exact replacement after `space_page_read` proves the old block.
- Use `space_page_write` only when the whole Markdown body must be replaced and the current page was read first.
- Keep Task progress on the Task and durable Space knowledge on the attached page; do not duplicate the same text in both.

## Completion rules

- Before marking Done, check each requested deliverable against the original objective. A successful run or a failed write's draft is not proof of delivery.
- Save complete reports with `task_save_result`, with official source links and important limitations; then finish with `task_finish`, whose fields say what `completion_result`, `completion_evidence` and `completion_note` need.

- Treat the latest board state as the truth when earlier conversation text disagrees.
- On a tool error, use the returned reason to refresh only the stale state and make one focused correction; never retry a write blindly.
- Keep progress, questions, and outcomes attached to the Task they concern.
- Report the shortest useful outcome and next implication.

Use space_board_read with task_key to recover one Task’s internal working context when returning from another Chat. Read current state before relying on old notes.
