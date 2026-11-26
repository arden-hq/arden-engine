import { electronDir, migrationsDir } from "./owned-behavior-shared.mjs"

const DECISION_WORDS =
  "Allow|Ask|Deny|Allow once|Always allow|Always deny|Always ask before|Allowed|Denied|Run commands on your Mac|Read files in|Change files in"
const RETIRED_DECISION_WORDS =
  "/(Never do|Do (this )?without asking|Ask first|Never touch|Use files in|without asking\\?|Arden never does|Arden asks you first|Arden does these|Guidance for Auto review)/"
/** @param {string[]} types */
const toldEventSelector = (types) => {
  const literal = `Literal[value=/^(${types.join("|")})$/]`
  return `Property[key.name='type'] > ${literal}, Property[key.name='type'] > TSAsExpression > ${literal}`
}
const ROLE_WORDS = "system|developer|user|interaction|assistant|tool"
const ROLE_WORD = `/^(${ROLE_WORDS})$/`
const SENDER = "/^(from|to)$/"
const INTERACTION_KIND_WORD = "/^(assignment|instruction|completion)$/"
const INTERACTION_OUTCOME_WORD = "/^(needs_attention)$/"
/** @type {import("./owned-behavior-shared.mjs").OwnedBehavior[]} */
export const persistenceBehaviors = [
  {
    selector: [
      "BinaryExpression[operator=/^[!=]==$/][right.value='allow']:matches([left.name=/[mM]ode$/], [left.property.name=/[mM]ode$/])",
      "SwitchStatement:has(SwitchCase > Literal[value='read_only']):has(SwitchCase > Literal[value='allow'])"
    ].join(", "),
    message:
      "What Never ask or read only makes of a card is decide()'s: ask skipsCards / waivesRequirement / personCard / boundaryReach (execution/decide.ts), not the mode.",
    owners: ["apps/server-ts/src/execution/decide.ts"],
    serverOnly: true
  },
  {
    selector:
      "Identifier[name=/^(modelTurnRunStatusList|isExecutingRunStatus|EXECUTING_RUN_STATUSES)$/]",
    message:
      "Whether a Run, or work it started, may still act is runMayActSql / runMayAct (persistence/sqlite/run-liveness.ts, persistence/runs/liveness.ts): a Run's authority outlives its model turn. The model-turn status set is only for what the turn alone does; add a file here only with that reason.",
    owners: [
      "apps/server-ts/src/persistence/sqlite/status-sets.ts",
      "apps/server-ts/src/persistence/sqlite/execution-budgets.ts",
      "apps/server-ts/src/persistence/sqlite/work-deliveries.ts",
      "apps/server-ts/src/persistence/sqlite/space-review.ts",
      "apps/server-ts/src/persistence/sqlite/automation-followup.ts",
      "apps/server-ts/src/persistence/sqlite/recovery.ts",
      "apps/server-ts/src/persistence/sqlite/relay.ts"
    ],
    serverOnly: true
  },
  {
    selector: "TemplateElement[value.raw=/'\\$\\.disposition'\\)\\s*=\\s*'disposable'/]",
    message: "A disposable Side chat's fork row is disposableForkSql(alias) (persistence/schema/fork-disposition.ts).",
    owners: ["apps/server-ts/src/persistence/schema/fork-disposition.ts"],
    exempt: ["apps/server-ts/src/persistence/schema/decision-visibility-released.ts"],
    serverOnly: true
  },
  {
    pattern: [
      String.raw`\bRECURSIVE\s+[a-z0-9_]+\b[\s\S]*\bparent_(?:session|run)_id\b`,
      String.raw`\b(?<cte>[a-z0-9_]+)\s*(?:\([a-z0-9_,\s]*\)\s*)?AS\s*\((?=[\s\S]*\bUNION\b[\s\S]*\b\k<cte>\b)(?=[\s\S]*\bUNION\b[\s\S]*\bparent_(?:session|run)_id\b)`
    ].join("|"),
    message:
      "Walk the session or run tree with sessionDescendants / sessionAncestors / runDescendants / runAncestors (persistence/sqlite/tree-walk.ts): pass the start rows as `from` and the links to follow as `where`.",
    owners: ["apps/server-ts/src/persistence/sqlite/tree-walk.ts"],
    exempt: [
      "apps/server-ts/src/persistence/schema/decision-visibility-released.ts",
      "apps/server-ts/src/persistence/schema/transitions.ts"
    ],
    exemptDirs: [migrationsDir],
    serverOnly: true
  },
  {
    selector: toldEventSelector([
      "entity_changed",
      "work_changed",
      "task_visibility_changed",
      "task_proposal_changed",
      "focus_choice_changed",
      "session_updated",
      "automation_changed"
    ]),
    message:
      "A row's change is told at commit by the tell registry (persistence/sqlite/tells): change the data, and register a new table in tells/tables.ts; do not build this event at the write site.",
    owners: ["apps/server-ts/src/persistence/sqlite/tells/tell.ts"],
    serverOnly: true
  },
  {
    selector: toldEventSelector(["approval_resolved", "connection_resolved"]),
    message:
      "A card's close is told by the commit-time ask check (persistence/sqlite/shown-asks.ts); do not build it at the write site.",
    owners: ["apps/server-ts/src/persistence/sqlite/shown-asks.ts"],
    serverOnly: true
  },
  {
    selector: `${toldEventSelector(["decision_route_changed"])}, CallExpression[callee.name='journalDecisionRouteChange']`,
    message:
      "A card's routes are journaled at commit by the ask check (persistence/sqlite/shown-asks.ts), from pending_decision_visibility; do not journal them at the write site.",
    owners: [
      "apps/server-ts/src/persistence/sqlite/shown-asks.ts",
      "apps/server-ts/src/persistence/sqlite/decision-route-journal.ts"
    ],
    serverOnly: true
  },
  {
    pattern: String.raw`\bDELETE\s+FROM\s+["\x60]?sessions["\x60]?(?![a-z0-9_])`,
    message:
      "Delete a session with deleteSessionTree (persistence/sqlite/session-tree-deletion.ts): it takes the agents and Side chats that go with it and refuses while any of them has active work.",
    owners: ["apps/server-ts/src/persistence/sqlite/session-tree-deletion.ts"],
    nodeOnly: true
  },
  {
    selector: [
      `Literal[value=/^(${DECISION_WORDS})$/]`,
      `TemplateElement[value.raw=/^(${DECISION_WORDS}) /]`,
      `JSXText[value=/^\\s*(${DECISION_WORDS})\\s*$/]`,
      `Literal[value=${RETIRED_DECISION_WORDS}]`,
      `TemplateElement[value.raw=${RETIRED_DECISION_WORDS}]`,
      `JSXText[value=${RETIRED_DECISION_WORDS}]`
    ].join(", "),
    message:
      "Permission decisions read Allow / Ask / Deny (Allow once, Always allow, Allowed, Denied): take them, and a rule's action sentence, from DECISION_WORD, RULE_DECISION_WORD, RULE_ACTION and PATH_ACTION in @arden-hq/protocol/permissions.",
    owners: ["libs/protocol/src/permissions/words.ts"],
    exemptDirs: [migrationsDir, electronDir]
  },
  {
    pattern: String.raw`^(async-result|tool-media):`,
    message:
      "A tool result is a tool message: a background call's result is the tool message after its receipt (async_tool_launch), and media is the result's model_content. An id never says what a message is.",
    owners: [],
    exemptDirs: [migrationsDir]
  },
  {
    selector: "Identifier[name='is_meta'], Literal[value='is_meta'], Literal[value=/\\$\\.is_meta/]",
    message:
      "Who wrote a message is its role: `user` is the person, `interaction` is anyone else (its `from.source` says who). There is no meta flag.",
    owners: [],
    exemptDirs: [migrationsDir]
  },
  {
    selector: [
      `BinaryExpression[operator=/^[!=]==$/][left.property.name='role'] > Literal.right[value=${ROLE_WORD}]`,
      `BinaryExpression[operator=/^[!=]==$/][right.property.name='role'] > Literal.left[value=${ROLE_WORD}]`,
      `SwitchStatement[discriminant.property.name='role'] SwitchCase > Literal.test[value=${ROLE_WORD}]`,
      `BinaryExpression[operator=/^[!=]==$/][left.property.name='source']:matches([left.object.name=${SENDER}], [left.object.property.name=${SENDER}]) > Literal.right`,
      `SwitchStatement[discriminant.property.name='source']:matches([discriminant.object.name=${SENDER}], [discriminant.object.property.name=${SENDER}]) SwitchCase > Literal.test`,
      `Property[key.name=${SENDER}] > ObjectExpression > Property[key.name='source'] > Literal.value`,
      `ObjectExpression:has(Property[key.name='from'] > ObjectExpression > Property[key.name='source']) > Property[key.name=/^(kind|outcome)$/] > Literal.value`,
      `BinaryExpression[operator=/^[!=]==$/][left.property.name='kind'] > Literal.right[value=${INTERACTION_KIND_WORD}]`,
      `BinaryExpression[operator=/^[!=]==$/][left.property.name='outcome'] > Literal.right[value=${INTERACTION_OUTCOME_WORD}]`,
      `Property[key.name='role'] > Literal.value[value=${ROLE_WORD}]`,
      `TSPropertySignature[key.name='role'] TSLiteralType > Literal[value=${ROLE_WORD}]`
    ].join(", "),
    message:
      "Roles, interaction sources, kinds and outcomes are named constants: use ROLE, INTERACTION_SOURCE, INTERACTION_KIND and INTERACTION_OUTCOME from @arden-hq/std/message-vocabulary.",
    owners: ["libs/std/src/message-vocabulary.ts"],
    exemptDirs: [migrationsDir]
  },
  {
    pattern: String.raw`role'?\)?\s*(=|<>|!=|(not\s+)?in\s*\()\s*'(${ROLE_WORDS})'`,
    message:
      "SQL reads a message role through ROLE from @arden-hq/std/message-vocabulary: interpolate the constant, never write the role.",
    owners: ["libs/std/src/message-vocabulary.ts"],
    exemptDirs: [migrationsDir]
  }
]
