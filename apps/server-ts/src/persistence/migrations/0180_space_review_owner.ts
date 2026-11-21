import type { Migration } from "./index.js"

export const spaceReviewOwner: Migration = {
  version: 180,
  name: "space_review_owner",
  foreignKeys: { kind: "enforced" },
  up: (database) =>
    database.exec(`CREATE TABLE space_review_settings (
      space_id TEXT PRIMARY KEY REFERENCES spaces(space_id) ON DELETE CASCADE,
      model TEXT CHECK(model IS NULL OR length(trim(model)) > 0),
      context_mode TEXT NOT NULL DEFAULT 'fresh' CHECK(context_mode IN ('fresh', 'continue', 'fork')),
      cooldown_minutes INTEGER CHECK(cooldown_minutes IS NULL OR cooldown_minutes >= 0)
    );
    CREATE TABLE space_review_chats (
      space_id TEXT PRIMARY KEY REFERENCES spaces(space_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE
    );
    INSERT INTO space_review_settings (space_id, model, context_mode, cooldown_minutes)
      SELECT legacy.owner_space_id, NULLIF(trim(legacy.model), ''), legacy.context_mode,
        CASE WHEN legacy.cooldown_minutes >= 0 THEN legacy.cooldown_minutes END
      FROM scheduled_tasks AS legacy
      JOIN spaces AS space ON space.space_id = legacy.owner_space_id
      WHERE legacy.purpose = 'space_review'
        AND legacy.task_id = 'space:' || legacy.owner_space_id
        AND (NULLIF(trim(legacy.model), '') IS NOT NULL OR legacy.context_mode != 'fresh'
          OR legacy.cooldown_minutes >= 0);
    INSERT INTO space_review_chats (space_id, session_id)
      SELECT legacy.owner_space_id, legacy.thread_id
      FROM scheduled_tasks AS legacy
      JOIN spaces AS space ON space.space_id = legacy.owner_space_id
      JOIN sessions AS chat ON chat.session_id = legacy.thread_id
      WHERE legacy.purpose = 'space_review'
        AND legacy.task_id = 'space:' || legacy.owner_space_id;
    UPDATE automation_event_queue AS queue
      SET hold_started_at = (
        SELECT legacy.job_held_since FROM scheduled_tasks AS legacy
        WHERE legacy.task_id = queue.task_id AND legacy.purpose = 'space_review'
      )
      WHERE queue.claimed_at IS NOT NULL
        AND queue.hold_started_at IS NULL
        AND substr(queue.task_id, 1, 6) = 'space:'
        AND EXISTS (
          SELECT 1 FROM spaces AS space WHERE space.space_id = substr(queue.task_id, 7)
        )
        AND EXISTS (
          SELECT 1 FROM scheduled_tasks AS legacy
          WHERE legacy.task_id = queue.task_id
            AND legacy.purpose = 'space_review'
            AND legacy.owner_space_id = substr(queue.task_id, 7)
            AND legacy.job_held_since IS NOT NULL
            AND legacy.job_held_since <= queue.claimed_at
        )
        AND EXISTS (
          SELECT 1 FROM automation_runs AS attempt
          WHERE attempt.id = json_extract(queue.context, '$.automation_run_id')
            AND attempt.task_id = queue.task_id
            AND attempt.status = 'running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM automation_event_queue AS other
          WHERE other.task_id = queue.task_id
            AND other.id != queue.id
            AND other.claimed_at IS NOT NULL
        );
    UPDATE scheduled_tasks SET job_held_since = NULL
      WHERE purpose = 'space_review' AND job_held_since IS NOT NULL;`)
}
