import type { Migration } from "./index.js"

export const taskBelongsToOneChat: Migration = {
  version: 119,
  name: "task_belongs_to_one_chat",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    database.exec(`UPDATE desk_tasks SET home_session_id = COALESCE(
        (SELECT following.session_id FROM desk_task_chats AS following
          JOIN sessions AS chat ON chat.session_id = following.session_id
          WHERE following.item_id = desk_tasks.item_id
            AND chat.session_type = 'chat' AND chat.origin_automation_id IS NULL
            AND chat.parent_session_id IS NULL AND chat.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM desk_conversations AS conversation
              WHERE conversation.session_id = chat.session_id)
          ORDER BY following.linked_at DESC, following.session_id DESC LIMIT 1),
        (SELECT chat.session_id FROM desk_task_sources AS source
          JOIN sessions AS chat ON chat.session_id = json_extract(source.source, '$.session_id')
          WHERE source.item_id = desk_tasks.item_id AND json_extract(source.source, '$.kind') = 'chat'
            AND chat.session_type = 'chat' AND chat.origin_automation_id IS NULL
            AND chat.parent_session_id IS NULL AND chat.archived_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM desk_conversations AS conversation
              WHERE conversation.session_id = chat.session_id)
          ORDER BY source.created_at, source.source_key LIMIT 1))
      WHERE desk_id IS NOT NULL AND home_session_id IS NULL`)
    database.exec("DROP TABLE desk_task_chats")
    database.exec(`UPDATE tool_settings
      SET overrides_json = json_remove(
        json_set(overrides_json, '$.task_move_here', json_extract(overrides_json, '$.task_follow')),
        '$.task_follow')
      WHERE json_valid(overrides_json)
        AND json_type(overrides_json, '$.task_follow') IS NOT NULL
        AND json_type(overrides_json, '$.task_move_here') IS NULL`)
  }
}
