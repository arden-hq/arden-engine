import type { SqlClient } from "effect/unstable/sql"
import type { Statement } from "effect/unstable/sql/Statement"
import type { Row } from "effect/unstable/sql/SqlConnection"

const citedItem = (sql: SqlClient.SqlClient) => sql`(SELECT item.item_id
  FROM (SELECT json_extract(cited.value, '$.item_id') AS item_id
    FROM json_each(offer.sources_json) AS cited
    WHERE json_extract(cited.value, '$.kind') = 'connection_item'
    ORDER BY cited.key LIMIT 1) AS first
  JOIN connection_items AS item ON item.item_id = first.item_id)`

export const homeOfferJson = (sql: SqlClient.SqlClient): Statement<Row> => sql`json_object(
  'offer_id', offer.proposal_id, 'text', offer.text,
  'why', json_extract(offer.capture_json, '$.reason'),
  'item', CASE WHEN offer.signal_json IS NULL THEN NULL ELSE json_object('item_id', ${citedItem(sql)},
    'source', json_extract(offer.signal_json, '$.source'),
    'title', json_extract(offer.signal_json, '$.title'),
    'from', json_extract(offer.signal_json, '$.from')) END,
  'status', offer.status, 'revision', offer.revision,
  'space_id', (SELECT task.space_id FROM space_tasks AS task WHERE task.item_id = offer.item_id),
  'task_item_id', offer.item_id, 'created_at', offer.created_at,
  'updated_at', offer.updated_at, 'settled_at', offer.settled_at)`
