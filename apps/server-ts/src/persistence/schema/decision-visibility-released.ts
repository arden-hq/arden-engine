const decisionLineageSql = (sourceId: "NEW.session_id"): string => `
  WITH RECURSIVE lineage(session_id, parent_session_id, session_type, parent_run_id,
    parent_tool_call_id) AS (
    SELECT session_id, parent_session_id, session_type, parent_run_id,
      parent_tool_call_id FROM sessions WHERE session_id = ${sourceId}
    UNION
    SELECT parent.session_id, parent.parent_session_id, parent.session_type,
      parent.parent_run_id, parent.parent_tool_call_id
    FROM lineage AS child JOIN sessions AS parent
      ON parent.session_id = child.parent_session_id
    WHERE child.session_type = 'agent'
  )
  SELECT lineage.session_id, lineage.session_type,
    CASE WHEN lineage.session_type != 'agent' OR EXISTS (
      SELECT 1 FROM sessions AS parent
      JOIN chat_runs AS parent_run ON parent_run.run_id = lineage.parent_run_id
        AND parent_run.session_id = parent.session_id
      WHERE parent.session_id = lineage.parent_session_id
    ) THEN 1 ELSE 0 END AS edge_valid
  FROM lineage`

type RouteVersion = 1 | 2

const creatorRoute = (kind: "run" | "deferred") => `UNION ALL
      SELECT creator.session_id, 'automation_creator_v1'
      FROM chat_runs AS asking
      JOIN scheduled_tasks AS automation ON automation.task_id = COALESCE(
          json_extract(asking.metadata_json, '$.run_policy.automation_id'),
          json_extract(asking.metadata_json, '$.automation.task_id'))
        AND automation.purpose = 'user_automation'
      JOIN automation_instruction_revisions AS first ON first.revision_id = (
        SELECT MIN(revision_id) FROM automation_instruction_revisions
        WHERE task_id = automation.task_id)
      JOIN chat_runs AS creating ON creating.run_id = first.source_run_id
      JOIN sessions AS creator ON creator.session_id = COALESCE(
          json_extract(creating.metadata_json, '$.run_policy.authority_session_id'),
          creating.session_id)
        AND creator.session_type = 'chat'
      WHERE asking.run_id = NEW.run_id${kind === "run" ? " AND NEW.kind = 'tool_approval'" : ""}
        AND creator.session_id NOT IN (
          SELECT session_id FROM (${decisionLineageSql("NEW.session_id")}))`

const insertRecipients = (
  source: "tool_approvals" | "deferred_tool_calls",
  version: RouteVersion
) => {
  const kind = source === "tool_approvals" ? "run" : "deferred"
  const approvalRun = kind === "run" ? "NEW.run_id" : "NULL"
  const approvalCall = kind === "run" ? "NEW.tool_call_id" : "NULL"
  const deferredRun = kind === "deferred" ? "NEW.run_id" : "NULL"
  const deferredCall = kind === "deferred" ? "NEW.tool_call_id" : "NULL"
  const sideOutcome =
    kind === "run"
      ? `UNION ALL
      SELECT parent.session_id, 'side_outcome_recovery_v1'
      FROM (${decisionLineageSql("NEW.session_id")}) AS lineage
      JOIN session_fork_requests AS fork ON fork.child_session_id = lineage.session_id
        AND fork.state = 'ready'
        AND json_valid(fork.request_json)
        AND json_extract(fork.request_json, '$.disposition') = 'disposable'
      JOIN sessions AS parent ON parent.session_id = fork.source_session_id
        AND parent.session_type = 'chat'
      WHERE lineage.session_type = 'chat' AND NEW.kind = 'tool_outcome'`
      : ""
  return `INSERT INTO pending_decision_visibility (
      viewer_session_id, source_kind, run_id, tool_call_id, source_session_id,
      route_basis, approval_run_id, approval_tool_call_id,
      deferred_run_id, deferred_tool_call_id)
    SELECT routes.viewer_session_id, '${kind}', NEW.run_id, NEW.tool_call_id,
      NEW.session_id, routes.route_basis,
      ${approvalRun}, ${approvalCall}, ${deferredRun}, ${deferredCall}
    FROM (SELECT lineage.session_id AS viewer_session_id,
      CASE WHEN lineage.session_id = NEW.session_id THEN 'source_v1'
        ELSE 'agent_delegation_v1' END AS route_basis
      FROM (${decisionLineageSql("NEW.session_id")}) AS lineage
      ${sideOutcome}${
        version === 2
          ? `
      ${creatorRoute(kind)}`
          : ""
      }) AS routes
    WHERE NEW.status = 'pending'`
}

const validateLineage = `SELECT RAISE(ABORT, 'Invalid decision agent lineage')
  FROM (SELECT COUNT(*) AS nodes,
    SUM(CASE WHEN session_type != 'agent' THEN 1 ELSE 0 END) AS roots,
    SUM(CASE WHEN edge_valid = 0 THEN 1 ELSE 0 END) AS invalid_edges
    FROM (${decisionLineageSql("NEW.session_id")}))
  WHERE nodes = 0 OR roots = 0 OR invalid_edges > 0`

const recipientTriggers = (
  source: "tool_approvals" | "deferred_tool_calls",
  version: RouteVersion
) => {
  const kind = source === "tool_approvals" ? "run" : "deferred"
  return [
    `CREATE TRIGGER pending_decision_visibility_${kind}_insert
      AFTER INSERT ON ${source} WHEN NEW.status = 'pending'
      BEGIN ${validateLineage}; ${insertRecipients(source, version)}; END`,
    `CREATE TRIGGER pending_decision_visibility_${kind}_update
      AFTER UPDATE OF status, session_id${kind === "run" ? ", kind" : ""} ON ${source}
      BEGIN
        DELETE FROM pending_decision_visibility
          WHERE source_kind = '${kind}' AND run_id = OLD.run_id
            AND tool_call_id = OLD.tool_call_id;
        DELETE FROM pending_decision_visibility_unresolved
          WHERE source_kind = '${kind}' AND run_id = OLD.run_id
            AND tool_call_id = OLD.tool_call_id;
        ${validateLineage.replace("WHERE nodes = 0 OR roots = 0 OR invalid_edges > 0", "WHERE NEW.status = 'pending' AND (nodes = 0 OR roots = 0 OR invalid_edges > 0)")};
        ${insertRecipients(source, version)};
      END`
  ] as const
}

const sourceTriggers = (source: "tool_approvals" | "deferred_tool_calls") => {
  const kind = source === "tool_approvals" ? "run" : "deferred"
  return [
    `CREATE TRIGGER pending_decision_visibility_${kind}_immutable_identity
      BEFORE UPDATE OF run_id, tool_call_id ON ${source}
      WHEN OLD.run_id IS NOT NEW.run_id OR OLD.tool_call_id IS NOT NEW.tool_call_id
      BEGIN SELECT RAISE(ABORT, 'Decision source identity is immutable'); END`
  ] as const
}

const visibilityTable = (version: RouteVersion) => `CREATE TABLE pending_decision_visibility (
    viewer_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    source_kind TEXT NOT NULL CHECK(source_kind IN ('run', 'deferred')),
    run_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    source_session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    route_basis TEXT NOT NULL CHECK(route_basis IN (
      'source_v1', 'agent_delegation_v1', 'side_outcome_recovery_v1'${version === 2 ? ", 'automation_creator_v1'" : ""})),
    approval_run_id TEXT,
    approval_tool_call_id TEXT,
    deferred_run_id TEXT,
    deferred_tool_call_id TEXT,
    PRIMARY KEY (viewer_session_id, source_kind, run_id, tool_call_id),
    FOREIGN KEY (approval_run_id, approval_tool_call_id)
      REFERENCES tool_approvals(run_id, tool_call_id) ON DELETE CASCADE,
    FOREIGN KEY (deferred_run_id, deferred_tool_call_id)
      REFERENCES deferred_tool_calls(run_id, tool_call_id) ON DELETE CASCADE,
    CHECK((source_kind = 'run' AND approval_run_id IS NOT NULL
      AND approval_tool_call_id IS NOT NULL AND approval_run_id = run_id
      AND approval_tool_call_id = tool_call_id AND deferred_run_id IS NULL
      AND deferred_tool_call_id IS NULL)
      OR (source_kind = 'deferred' AND deferred_run_id IS NOT NULL
      AND deferred_tool_call_id IS NOT NULL AND deferred_run_id = run_id
      AND deferred_tool_call_id = tool_call_id AND approval_run_id IS NULL
      AND approval_tool_call_id IS NULL)),
    CHECK(route_basis != 'side_outcome_recovery_v1' OR source_kind = 'run')
  )`

const visibilityIndexes = [
  `CREATE INDEX idx_pending_decision_visibility_source
    ON pending_decision_visibility(source_kind, run_id, tool_call_id)`,
  `CREATE INDEX idx_pending_decision_visibility_run_fk
    ON pending_decision_visibility(approval_run_id, approval_tool_call_id)`,
  `CREATE INDEX idx_pending_decision_visibility_deferred_fk
    ON pending_decision_visibility(deferred_run_id, deferred_tool_call_id)`,
  `CREATE INDEX idx_pending_decision_visibility_source_session
    ON pending_decision_visibility(source_session_id)`
] as const

const statements = (version: RouteVersion) =>
  [
    `CREATE INDEX idx_tool_approvals_pending_backfill
    ON tool_approvals(status) WHERE status = 'pending'`,
    `CREATE INDEX idx_deferred_tool_calls_pending_backfill
    ON deferred_tool_calls(status) WHERE status = 'pending'`,
    visibilityTable(version),
    ...visibilityIndexes,
    `CREATE TABLE pending_decision_visibility_unresolved (
    source_kind TEXT NOT NULL CHECK(source_kind IN ('run', 'deferred')),
    run_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    approval_run_id TEXT,
    approval_tool_call_id TEXT,
    deferred_run_id TEXT,
    deferred_tool_call_id TEXT,
    PRIMARY KEY (source_kind, run_id, tool_call_id),
    FOREIGN KEY (approval_run_id, approval_tool_call_id)
      REFERENCES tool_approvals(run_id, tool_call_id) ON DELETE CASCADE,
    FOREIGN KEY (deferred_run_id, deferred_tool_call_id)
      REFERENCES deferred_tool_calls(run_id, tool_call_id) ON DELETE CASCADE,
    CHECK((source_kind = 'run' AND approval_run_id IS NOT NULL
      AND approval_tool_call_id IS NOT NULL AND approval_run_id = run_id
      AND approval_tool_call_id = tool_call_id AND deferred_run_id IS NULL
      AND deferred_tool_call_id IS NULL)
      OR (source_kind = 'deferred' AND deferred_run_id IS NOT NULL
      AND deferred_tool_call_id IS NOT NULL AND deferred_run_id = run_id
      AND deferred_tool_call_id = tool_call_id AND approval_run_id IS NULL
      AND approval_tool_call_id IS NULL))
  )`,
    `CREATE INDEX idx_pending_decision_visibility_unresolved_run_fk
    ON pending_decision_visibility_unresolved(approval_run_id, approval_tool_call_id)`,
    `CREATE INDEX idx_pending_decision_visibility_unresolved_deferred_fk
    ON pending_decision_visibility_unresolved(deferred_run_id, deferred_tool_call_id)`,
    `CREATE TRIGGER pending_decision_visibility_immutable_agent_edge
    BEFORE UPDATE OF session_type, parent_session_id, parent_run_id,
      parent_tool_call_id ON sessions
    WHEN OLD.session_type IS NOT NEW.session_type OR
      (OLD.session_type = 'agent' AND (
        OLD.parent_session_id IS NOT NEW.parent_session_id OR
        OLD.parent_run_id IS NOT NEW.parent_run_id OR
        OLD.parent_tool_call_id IS NOT NEW.parent_tool_call_id))
    BEGIN SELECT RAISE(ABORT, 'Agent delegation is immutable'); END`,
    ...recipientTriggers("tool_approvals", version),
    ...sourceTriggers("tool_approvals"),
    ...recipientTriggers("deferred_tool_calls", version),
    ...sourceTriggers("deferred_tool_calls")
  ] as const

export const decisionVisibilityStatementsV1 = statements(1)

export const decisionCreatorRouteRebuild = {
  table: visibilityTable(2),
  indexes: visibilityIndexes,
  triggers: [
    ...recipientTriggers("tool_approvals", 2),
    ...recipientTriggers("deferred_tool_calls", 2)
  ]
} as const
