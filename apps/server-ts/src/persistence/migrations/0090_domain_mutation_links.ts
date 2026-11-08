import type { Migration } from "./index.js"

const statements = [
  `CREATE TABLE desk_task_mutation_links (
      item_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      PRIMARY KEY (item_id, version),
      FOREIGN KEY (item_id, version) REFERENCES desk_task_revisions(item_id, version) ON DELETE CASCADE,
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`,
  `CREATE INDEX idx_desk_task_mutation_links_call ON desk_task_mutation_links(run_id, tool_call_id)`,
  `CREATE TRIGGER desk_task_mutation_links_immutable BEFORE UPDATE ON desk_task_mutation_links BEGIN SELECT RAISE(ABORT, 'Mutation links are immutable'); END`,
  `CREATE TABLE task_proposal_mutation_links (
      proposal_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      PRIMARY KEY (proposal_id, version),
      FOREIGN KEY (proposal_id, version) REFERENCES task_proposal_revisions(proposal_id, version) ON DELETE CASCADE,
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`,
  `CREATE INDEX idx_task_proposal_mutation_links_call ON task_proposal_mutation_links(run_id, tool_call_id)`,
  `CREATE TRIGGER task_proposal_mutation_links_immutable BEFORE UPDATE ON task_proposal_mutation_links BEGIN SELECT RAISE(ABORT, 'Mutation links are immutable'); END`,
  `CREATE TABLE desk_mutation_links (
      desk_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      PRIMARY KEY (desk_id, version),
      FOREIGN KEY (desk_id, version) REFERENCES desk_revisions(desk_id, version) ON DELETE CASCADE,
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`,
  `CREATE INDEX idx_desk_mutation_links_call ON desk_mutation_links(run_id, tool_call_id)`,
  `CREATE TRIGGER desk_mutation_links_immutable BEFORE UPDATE ON desk_mutation_links BEGIN SELECT RAISE(ABORT, 'Mutation links are immutable'); END`,
  `CREATE TABLE session_mutation_links (
      session_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      PRIMARY KEY (session_id, version),
      FOREIGN KEY (session_id, version) REFERENCES session_revisions(session_id, version) ON DELETE CASCADE,
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`,
  `CREATE INDEX idx_session_mutation_links_call ON session_mutation_links(run_id, tool_call_id)`,
  `CREATE TRIGGER session_mutation_links_immutable BEFORE UPDATE ON session_mutation_links BEGIN SELECT RAISE(ABORT, 'Mutation links are immutable'); END`,
  `CREATE TABLE automation_configuration_mutation_links (
      task_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      PRIMARY KEY (task_id, version),
      FOREIGN KEY (task_id, version) REFERENCES automation_configuration_revisions(task_id, version) ON DELETE CASCADE,
      FOREIGN KEY (run_id, tool_call_id) REFERENCES tool_calls(run_id, tool_call_id) ON DELETE CASCADE
    )`,
  `CREATE INDEX idx_automation_configuration_mutation_links_call ON automation_configuration_mutation_links(run_id, tool_call_id)`,
  `CREATE TRIGGER automation_configuration_mutation_links_immutable BEFORE UPDATE ON automation_configuration_mutation_links BEGIN SELECT RAISE(ABORT, 'Mutation links are immutable'); END`
]

export const domainMutationLinks: Migration = {
  version: 90,
  name: "domain_mutation_links",
  foreignKeys: { kind: "enforced" },
  up: (database) => {
    for (const statement of statements) database.exec(statement)
  }
}
