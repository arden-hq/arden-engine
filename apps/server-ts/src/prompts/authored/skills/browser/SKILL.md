---
name: browser
description: Navigate, inspect, interact with, and verify state in the integrated browser.
version: 1.0.0
tool_group: the integrated browser
---

# Browser Skill

Use Browser only when the task depends on page state or interaction that a semantic connector cannot provide.

The integrated browser needs Arden's desktop host. Start with `browser_tabs`; if it reports unavailable and retryable, call it once more after a moment. If it is still unavailable, report its message once and keep the work. Do not repeatedly open tabs or launch another app window. Use `web_fetch` for public page text when sufficient; it does not share private browser login state or replace interaction.

## Interaction loop

1. Use `browser_tabs` when the target `tab_ref`, `profile_ref`, or current origin is unknown. Otherwise continue with the known tab.
2. Use `browser_open` to create a tab or navigate an exact tab; set `read` to get the page in the same call.
3. Take an interactive snapshot before the first `browser_act` on a tab, unless the last call already returned the page with `read=interactive`.
4. Make one action with `browser_act` and take the next action from the page it returns. Set `snapshot: "none"` on a last action or one you follow with `browser_wait`.
5. For three or more steps toward one goal on one page, hand them to `browser_task`. Act on that page yourself only after it returns; for `blocked` or `decide`, answer the question or make the blocked call directly.
6. Inspect available state before waiting for an asynchronous change. Use `browser_wait` only for a completion condition grounded in observed page state or a known site contract, not guessed status wording or a label already present. If the completion condition is unknown, read the relevant page text first. Inspect again after a wait or timeout.
7. Read the page each action returns and repeat from step 4 only when another action is necessary. Stop when the requested result is visibly verified.

## Uploading and signing in

- `browser_upload` and `browser_ask_secret` carry their own flow. If a site rejects a saved password, ask again with `replace=true`.

## Reading and visual evidence

- For layout, canvas, charts or pixels, use `browser_screenshot`; for a control with no usable snapshot ref, follow it with `browser_pointer`. Never repeat an uncertain click or drag without inspecting the outcome.
- Embedded frame refs belong to their page; prefer their returned refs to semantic selectors when targeting a frame. A page's new tab or popup opens as a tab in `browser_tabs` and keeps its opener connection. Inspect it before acting.
- To reuse a capture in a gallery, document, or project, export it with `artifact_export`; do not ask the user to save the image manually. If export fails, the capture remains saved, so retry export rather than taking another screenshot.
- Use the returned capture time when labeling fresh captures; do not confuse them with original browsing history.
- Keep the same tab for flows that depend on cookies, navigation history, or in-page state. Close a tab with `browser_close` only when the task requires it.

## Ref and recovery rules

- Interactive refs are one-use and become stale after an action, wait, navigation, or page replacement. Never reuse them; use the refs of the snapshot the last action returned.
- If a call reports a stale snapshot or requires a snapshot, take a fresh interactive snapshot and rebuild the action from its returned values.
- If an action outcome is unknown, inspect the page before deciding whether to retry; do not repeat the action blindly.
- Prefer returned refs over guessed selectors or coordinates, and avoid taking another snapshot when the page has not changed.
