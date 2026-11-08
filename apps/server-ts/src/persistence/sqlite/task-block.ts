import { Effect } from "effect"
import type { SqlClient, Statement } from "effect/unstable/sql"

export const BUDGET_SPENT = "Arden used the whole token budget. Raise the cap to let it go on."

export const blockTaskOnYou = (
  sql: SqlClient.SqlClient,
  input: { readonly where: Statement.Fragment; readonly at: string; readonly fence: boolean }
) => sql<{ readonly item_id: string; readonly space_id: string | null }>`
  UPDATE space_tasks SET blocked = 1, waiting_on = 'you', next_attempt_at = NULL,
    generation = generation + ${input.fence ? 1 : 0}, updated_at = MAX(updated_at, ${input.at})
  WHERE ${input.where}
  RETURNING item_id, space_id`

export const spentBudgetStop = Effect.fn("TaskBlock.spentBudgetStop")(function* (
  sql: SqlClient.SqlClient,
  itemId: string
) {
  const rows = yield* sql<{ readonly tokens_used: number }>`
    SELECT budget.tokens_used FROM space_tasks AS item
    JOIN execution_budgets AS budget ON budget.task_item_id = item.item_id
    WHERE item.item_id = ${itemId} AND item.blocked = 1 AND item.waiting_on = 'you'
      AND budget.token_limit IS NOT NULL AND budget.tokens_used >= budget.token_limit
      AND (SELECT event.summary FROM space_task_events AS event
        WHERE event.item_id = item.item_id AND event.event_type = 'blocked'
        ORDER BY event.event_id DESC LIMIT 1) = ${BUDGET_SPENT}
  `
  return rows[0]?.tokens_used
})
