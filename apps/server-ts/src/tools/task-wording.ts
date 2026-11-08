export const TASK_USER_FACING =
  "The user reads this: plain words, no tool names, ids or internal terms — write 'ask which role to apply for', never 'ask with ask_user'."

export const TASK_TEXT_DESCRIPTION = `The row the user sees, at most 80 characters: the next action in everyday words, starting with its verb. Name the concrete object and outcome, not a process: 'Draft LiveKit application answers', not 'Review LiveKit route'. When owner is user, say exactly what the user must do: 'Sign and return the lease to Anna'. Put scope, evidence and caveats in body. ${
  TASK_USER_FACING
}`

export const TASK_BODY_DESCRIPTION = `Longer Task context. When owner is user, open with one sentence naming what they must do and what Arden has already prepared, then the evidence; set due_at when a deadline is known. ${
  TASK_USER_FACING
}`

export const TASK_OWNER_DESCRIPTION =
  "Who owns the next action. worker (default): Arden can do it, including when it only needs the user's decision: keep the Task and ask with ask_user, whose answer buttons appear in Chat and the Task peek. user: only for an action the user must take outside Arden, such as signing, submitting, paying or calling, once everything Arden can prepare is done. external: waiting on someone else. Never give the user a Task to decide, read or review; ask instead."

export const TASK_SPACE_RULE =
  "File a Task on the Space whose purpose owns its outcome. Evidence seen on this Space that belongs to another Space's work is not a Task here."
