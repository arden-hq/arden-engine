import { existsSync, readdirSync } from "node:fs"
import { defineConfig } from "oxlint"
import { exemptDirs, ownedBans, ownerFiles } from "./tooling/owned-behaviors.mjs"


const sources = "{js,mjs,cjs,ts,tsx,mts,cts}"
const allFiles = `**/*.${sources}`
const tsFiles = "**/*.{ts,tsx,mts,cts}"
const testFiles = [`**/{test,tests}/**/*.${sources}`, `**/*.test.${sources}`]
const plugin = "./tooling/lint-plugin.mjs"

const taste = {
  "no-nested-ternary": "error",
  "prefer-template": "error",
  "no-else-return": "error"
} as const

const escapeHatches = {
  "typescript/no-explicit-any": "error",
  "typescript/no-non-null-assertion": "error",
  "typescript/consistent-type-assertions": ["error", { assertionStyle: "as", objectLiteralTypeAssertions: "never" }]
} as const

const typedChecks = {
  "typescript/no-floating-promises": "error",
  "typescript/no-misused-promises": "error",
  "typescript/no-unnecessary-type-assertion": "error",
  "typescript/switch-exhaustiveness-check": [
    "error",
    { requireDefaultForNonUnion: false, considerDefaultExhaustiveForUnions: false }
  ]
} as const

const typedWorkspaces = ["apps", "libs"].flatMap((root) =>
  readdirSync(`${import.meta.dirname}/${root}`)
    .map((name) => `${root}/${name}`)
    .filter((workspace) => existsSync(`${import.meta.dirname}/${workspace}/tsconfig.test.json`))
)

type Restriction = { selector: string; message: string }

const noEnum = {
  selector: "TSEnumDeclaration",
  message: "No enums: use a literal union, or an `as const` object with a derived union."
}
const noForTestExport = {
  selector: [
    "ExportNamedDeclaration > FunctionDeclaration[id.name=/ForTests?$/]",
    "ExportNamedDeclaration > VariableDeclaration > VariableDeclarator[id.name=/ForTests?$/]",
    "ExportSpecifier[exported.name=/ForTests?$/]"
  ].join(", "),
  message:
    "No test-only exports from implementation files: inject the state (a factory that returns a fresh instance) instead of a `*ForTest` reset."
}
const noInlineErrorMessage = {
  selector: [
    "ConditionalExpression[test.type='BinaryExpression'][test.operator='instanceof'][test.right.name='Error'][consequent.property.name='message']",
    "ConditionalExpression[test.type='BinaryExpression'][test.operator='instanceof'][test.right.name='Error'][alternate.callee.name='String']"
  ].join(", "),
  message: "Normalize a caught unknown with errorMessage(cause) from @arden-hq/std/errors."
}
const domainWords: Restriction[] = [
  {
    selector: [
      "ArrayExpression[elements.length=2]:has(> Literal[value='pending']):has(> Literal[value='running'])",
      "LogicalExpression[operator='||']:has(BinaryExpression[right.value='pending']):has(BinaryExpression[right.value='running'])",
      "TemplateElement[value.raw=/status\\s+IN\\s+\\('pending',\\s*'running'/]"
    ].join(", "),
    message:
      "Ask the run status owner: isActiveRunStatus / isForegroundRunStatus / isExecutingRunStatus (@arden-hq/protocol/runs), or the status-sets.ts lists in SQL."
  },
  {
    selector: [
      "ArrayExpression:has(> Literal[value='needs_input']):has(> Literal[value='cancelling'])",
      "SwitchCase > Literal[value='needs_input']"
    ].join(", "),
    message: "Ask the script status owner: isLiveWorkflowStatus / parseWorkflowStatus (@arden-hq/protocol/workflows)."
  },
  {
    selector: [
      "ArrayExpression:has(> Literal[value='read_only']):has(> Literal[value='allow'])",
      "LogicalExpression:has(BinaryExpression > Literal[value='read_only']):has(BinaryExpression > Literal[value='safe'])"
    ].join(", "),
    message: "Ask the approval-mode owner: APPROVAL_MODES / isApprovalMode / narrowerApprovalMode (@arden-hq/protocol/permissions)."
  },
  {
    selector:
      "BinaryExpression[right.value='user_automation']:has(MemberExpression[property.name='purpose'])",
    message: "Ask isUserAutomation(actor) (execution/authority.ts) for an actor, isUserAutomationPurpose(row.purpose) (persistence/job-classification.ts) for a row."
  },
  {
    selector: [
      "TemplateElement[value.raw=/status\\s+IN\\s+\\('open'/]",
      "TemplateElement[value.raw=/purpose\\s*=\\s*'user_automation'/]",
      "TemplateElement[value.raw=/session_type\\s*=\\s*'chat'\\s+AND\\s+(\\w+\\.)?origin_automation_id\\s+IS\\s+NULL/]"
    ].join(", "),
    message:
      "Ask the SQL fragment owner: taskOpenSql / taskUnfinishedSql (task-status-sql.ts), userAutomationSql (authority-sql.ts), userChatSql (chat-ownership.ts)."
  }
]
const noDefaultFolders: Restriction = {
  selector: [
    "Identifier[name=/^(local_folders|default_cwds|code_agent_folders|localFolders|startFolder)$/]",
    "Property[key.value=/^(local_folders|default_cwds|code_agent_folders)$/]",
    "TemplateElement[value.raw=/\\b(default_cwds|local_folders|code_agent_folders)\\b/]",
    "Literal[value=/^\\$\\.(local_folders|code_agent_folders)$/]"
  ].join(", "),
  message:
    "No folder of its own for a Space, chat or run: a folder Arden may use or change is a path rule (permission_rules, kind \"path\")."
}
const baseRestricted: Restriction[] = [noEnum, noForTestExport, noInlineErrorMessage]
const restricted: Restriction[] = [...baseRestricted, ...domainWords, noDefaultFolders]
const restrictedSyntax = (...more: Restriction[]) => ({
  "arden/restricted-syntax": ["error", ...restricted, ...more] as const
})
const persistenceRestrictions = () => [
  noEffectGenFunction,
  noSystemAutomationIdComparison,
  noSqliteNow,
  noBareDate,
  noRawCauseText,
  oneApprovalCard,
  oneQuestionSettle,
  oneRunWait
]
const restrictedSyntaxOwner = (...more: Restriction[]) => ({
  "arden/restricted-syntax": ["error", ...baseRestricted, ...more] as const
})

const noEffectGenFunction = {
  selector: [
    "ArrowFunctionExpression > CallExpression.body[callee.object.name='Effect'][callee.property.name='gen']",
    ":function > BlockStatement > ReturnStatement > CallExpression.argument[callee.object.name='Effect'][callee.property.name='gen']"
  ].join(", "),
  message: 'Use Effect.fn("Name")(function* (…) {…}) instead of a function that returns Effect.gen.'
}

const noSystemAutomationIdComparison = {
  selector: "BinaryExpression[operator=/^[!=]==?$/] > Identifier[name=/_AUTOMATION_ID$/]",
  message: "Ask the system handler registry (automations/system.ts) instead of comparing a system Automation's id."
}

const noSqliteNow = {
  selector: "TemplateElement[value.raw=/'now'/], Literal[value=/'now'/]",
  message: "Pass Arden's clock (Clock.currentTimeMillis) into the SQL instead of SQLite's 'now'."
}

const noBareDate = {
  selector:
    "CallExpression[callee.object.name='Date'][callee.property.name='now'], NewExpression[callee.name='Date'][arguments.length=0]",
  message:
    "Read time through Arden's clock: Clock.currentTimeMillis in an Effect, currentMillis()/currentIso() from runtime/clock.ts elsewhere."
}

const noRederivedAuthority = {
  selector: [
    "MemberExpression[property.name='mode'][object.type='MemberExpression'][object.property.name='execution']",
    "MemberExpression[property.name='originAutomationId']"
  ].join(", "),
  message:
    "Read what a run may do from ctx.run.authority (execution/authority.ts), not execution.mode or the chat's originAutomationId."
}

const noInlineRetryable = {
  selector: "Property[key.name='retryable']:has(MemberExpression[property.name='reason'])",
  message: "Derive retryable from the reason: toolFailure in tools/tool-failure.ts."
}
const noRetryableLiteral = {
  selector: "Property[key.name='retryable'][value.value=true]",
  message: "A store failure's retryable comes from toolFailure; a refusal is toolRefusal (tools/tool-failure.ts)."
}
const noToolErrorWrapper = {
  selector:
    "VariableDeclarator[id.name=/^(toolError|fetchError|fileToolError|gmailError|commandError|localError)$/]",
  message: "Use toolRefusal / toolFault from tools/tool-failure.ts instead of a local failure wrapper."
}

const noRawCauseText = {
  selector: "CallExpression[callee.name='String'][arguments.0.name=/^(cause|defect|error)$/]",
  message: "Persist a caught cause through serializeOperationalCause (runtime/operational-events.ts)."
}

const noReasonPassthrough = {
  selector: "SwitchCase > ReturnStatement > CallExpression[callee.name=/^(storeErrorToHttp|wikiErrorToHttp)$/]",
  message: "Do not switch over shared store reasons: return storeErrorToHttp(…) after the route-specific reasons (http/errors.ts)."
}

const noStatusLadder = {
  selector: "BinaryExpression[operator='==='][left.name='status'][right.value=429]",
  message: "Classify a provider status with statusFailureCode (libs/loop openai-responses)."
}

const noFailedResultLiteral = {
  selector: "Property[key.name='is_error'][value.value=true]",
  message: "Throw a ToolExecutionError (tools/tool-failure.ts); failedToolResult in @arden-hq/loop makes the result."
}

const oneApprovalCard = {
  selector: "NewExpression[callee.name='PauseRequested'][arguments.0.value='approval']",
  message:
    "Only the approval gate pauses for approval: return the card from approvalRequirement or approvalPrompt."
}

const oneQuestionSettle = {
  selector: "TemplateElement[value.raw=/UPDATE run_questions SET (resolution|closed_at)/]",
  message:
    "Settle a question through answerQuestionInTransaction or closeQuestionInTransaction (question-settle.ts), not a hand-written UPDATE."
}

const oneRunWait = {
  selector: "TemplateElement[value.raw=/quota_pause\\.until/]",
  message:
    "Read a pending Run's wait through run-wait.ts (quotaPauseUntil, quotaPaused, parkedOnQuota, awaitingApproval), not a hand-written $.quota_pause.until."
}

const serverToolRules = [
  oneApprovalCard,
  noEffectGenFunction,
  noSystemAutomationIdComparison,
  noRederivedAuthority,
  noSqliteNow,
  noBareDate,
  noInlineRetryable,
  noToolErrorWrapper,
  noFailedResultLiteral
]

const restrictedImports = (options: object) => ({ "no-restricted-imports": ["error", options] as const })

const destructiveCommandsImport = {
  regex: "/destructive-commands(\\.js)?$",
  message: "Declare `shellCommand` on the tool; the approval gate judges it (commandFacts)."
}

const serverImportPatterns = [destructiveCommandsImport]

const ownedScope = [
  `{apps,libs}/*/src/**/*.${sources}`
]
const ardenDirImport = {
  name: "@arden-hq/std/paths",
  importNames: ["resolveArdenDir", "ARDEN_DIR_VARIABLE"],
  message: "Take Arden's data folder from DataRoot.dir (LocalPathServices.dataDir); only config/service.ts resolves it."
}
const serverImports = ({ ardenDir = true, destructive = true } = {}) =>
  restrictedImports({
    paths: ardenDir ? [ardenDirImport] : [],
    patterns: serverImportPatterns.filter((pattern) => destructive || pattern !== destructiveCommandsImport)
  })
const ownedBehaviorOverrides = [
  { files: ["apps/server-ts/src/**/*.ts"], rules: serverImports() },
  {
    files: ["apps/server-ts/src/config/service.ts"],
    rules: serverImports({ ardenDir: false })
  },
  {
    files: ["apps/server-ts/src/tools/approval-decision.ts"],
    rules: serverImports({ destructive: false })
  },
  { files: ownedScope, rules: ownedBans("workspace") },
  { files: ["apps/server-ts/src/**/*"], rules: ownedBans("server") },
  { files: ["apps/server-ts/src/persistence/migrations/**/*.ts"], rules: ownedBans("frozen") },
  ...exemptDirs.map((dir) => ({ files: [`${dir}**/*`], rules: ownedBans(dir) })),
  ...ownerFiles.map((file) => ({ files: [file], rules: ownedBans(file) }))
]


export default defineConfig({
  categories: { correctness: "off" },
  plugins: [],
  options: { typeAware: true },
  ignorePatterns: [],
  overrides: [
    {
      files: [allFiles],
      rules: {
        ...taste,
        ...restrictedSyntax(),
        "max-lines": ["error", { max: 800, skipBlankLines: true, skipComments: true }]
      },
      jsPlugins: [plugin]
    },
    {
      files: [tsFiles],
      plugins: ["typescript"],
      rules: {
        "typescript/ban-ts-comment": "error",
        ...escapeHatches
      }
    },
    {
      files: typedWorkspaces.map((workspace) => `${workspace}/{src,test,tests}/**/*.{ts,tsx}`),
      plugins: ["typescript"],
      rules: typedChecks
    },
    {
      files: ["apps/server-ts/src/**/*.ts", "libs/{revisions,journal,protocol}/src/**/*.ts"],
      rules: restrictedSyntax(noEffectGenFunction)
    },
    {
      files: ["libs/protocol/src/spaces/work/contracts.ts"],
      rules: restrictedSyntax(noEffectGenFunction, {
        selector: "Literal[value='blocker']",
        message: 'No "blocker" kind on the Work contract: a task says it is blocked with `blocked` + `waiting_on`.'
      })
    },
    {
      files: ["libs/loop/src/**/*.ts"],
      rules: restrictedImports({
        patterns: [
          {
            regex: "^(effect|@effect/[^/]+)(/|$)",
            message: "@arden-hq/loop is Effect-free (D-123); take the shape as a plain type or callback instead."
          }
        ]
      })
    },
    {
      files: ["apps/server-ts/src/**/*.ts"],
      rules: restrictedSyntax(
        noEffectGenFunction,
        noSystemAutomationIdComparison,
        noSqliteNow,
        noBareDate,
        oneApprovalCard
      )
    },
    {
      files: ["apps/server-ts/src/mcp/tool.ts", "apps/server-ts/src/chat/durable-tools.ts"],
      rules: restrictedSyntax(
        noEffectGenFunction,
        noSystemAutomationIdComparison,
        noSqliteNow,
        noBareDate,
        noInlineRetryable,
        oneApprovalCard
      )
    },
    {
      files: ["apps/server-ts/src/runtime/clock.ts"],
      rules: restrictedSyntax(noEffectGenFunction, noSystemAutomationIdComparison, noSqliteNow)
    },
    {
      files: ["apps/server-ts/src/http/**/*.ts"],
      rules: restrictedSyntax(
        noEffectGenFunction,
        noSystemAutomationIdComparison,
        noSqliteNow,
        noBareDate,
        noReasonPassthrough,
        oneApprovalCard
      )
    },
    {
      files: ["apps/server-ts/src/providers/**/*.ts"],
      rules: restrictedSyntax(
        noEffectGenFunction,
        noSystemAutomationIdComparison,
        noSqliteNow,
        noBareDate,
        noStatusLadder,
        oneApprovalCard
      )
    },
    {
      files: ["apps/server-ts/src/persistence/**/*.ts"],
      rules: restrictedSyntax(...persistenceRestrictions())
    },
    {
      files: ["apps/server-ts/src/persistence/browser-procedures/snapshot-line.ts"],
      rules: restrictedSyntax(...persistenceRestrictions(), {
        selector: [
          "ImportDeclaration",
          "ExportAllDeclaration",
          "ExportNamedDeclaration[source]",
          "Program > VariableDeclaration",
          "Program > FunctionDeclaration",
          "Program > ExportNamedDeclaration > VariableDeclaration"
        ].join(", "),
        message:
          "The procedure wrapper embeds parseSnapshotNode in pages with toString(): it takes no imports and no outside names."
      })
    },
    {
      files: ["apps/server-ts/src/persistence/sqlite/run-wait.ts"],
      rules: restrictedSyntax(
        noEffectGenFunction,
        noSystemAutomationIdComparison,
        noSqliteNow,
        noBareDate,
        noRawCauseText,
        oneApprovalCard,
        oneQuestionSettle
      )
    },
    {
      files: ["apps/server-ts/src/persistence/sqlite/question-settle.ts"],
      rules: restrictedSyntax(
        noEffectGenFunction,
        noSystemAutomationIdComparison,
        noSqliteNow,
        noBareDate,
        noRawCauseText,
        oneApprovalCard
      )
    },
    {
      files: ["apps/server-ts/src/persistence/{migrations,schema}/**/*.ts"],
      rules: restrictedSyntaxOwner(noEffectGenFunction, noSystemAutomationIdComparison)
    },
    {
      files: ["apps/server-ts/src/automations/handlers/**/*"],
      rules: restrictedSyntax(noEffectGenFunction, noSqliteNow, noBareDate, oneApprovalCard)
    },
    {
      files: ["apps/server-ts/src/tools/**/*.ts"],
      rules: restrictedSyntax(...serverToolRules)
    },
    {
      files: [
        "apps/server-ts/src/tools/{space-controls,task-inference,connection-items,skill,automation-limits}.ts",
        "apps/server-ts/src/mcp/tool.ts"
      ],
      rules: restrictedSyntax(...serverToolRules, noRetryableLiteral)
    },
    {
      files: ["apps/server-ts/src/tools/approval-gate.ts"],
      rules: restrictedSyntax(...serverToolRules.filter((rule) => rule !== oneApprovalCard))
    },
    {
      files: testFiles,
      rules: { "max-lines": "off" }
    },
    {
      files: ["apps/server-ts/src/persistence/migrations/0001_baseline.ts"],
      rules: { "max-lines": "off" }
    },
    {
      files: [
        "libs/protocol/src/{runs/status,workflows/status,permissions/modes,mcp/status}.ts",
        "libs/protocol/src/common/schema.ts",
        "libs/protocol/src/spaces/work/words.ts"
      ],
      rules: restrictedSyntaxOwner(noEffectGenFunction)
    },
    {
      files: [
        "apps/server-ts/src/execution/authority.ts",
        "apps/server-ts/src/persistence/job-classification.ts",
        "apps/server-ts/src/workflows/script-runner.ts",
        "apps/server-ts/src/persistence/sqlite/{task-status-sql,authority-sql,chat-ownership}.ts"
      ],
      rules: restrictedSyntaxOwner(noEffectGenFunction, noSystemAutomationIdComparison, noSqliteNow, noBareDate)
    },
    {
      files: ["**/scripts/**/*.{mjs,cjs,js}", ...testFiles],
      rules: restrictedSyntaxOwner()
    },
    ...ownedBehaviorOverrides
  ]
})
