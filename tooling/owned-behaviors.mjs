
/**
 * @typedef {({ selector: string, pattern?: never } | { pattern: string, selector?: never }) & {
 *   message: string
 *   owners: string[]
 *   exempt?: string[]
 *   exemptDirs?: string[]
 *   nodeOnly?: boolean
 *   rendererOnly?: boolean
 *   text?: true
 *   serverOnly?: true
 * }} OwnedBehavior `selector`: an ESLint selector. `pattern`: a case-insensitive
 * regex over each string's whole text, a template's quasis joined with `${}`
 * (tooling/lint-plugin.mjs). `text`: a text cut, which frozen migrations keep.
 * `serverOnly`: a ban that holds in apps/server-ts/src alone.
 */
const rendererFiles = "apps/desktop/src/"
/** @param {string} file */
const inRenderer = (file) => file.startsWith(rendererFiles)
const serverFiles = "apps/server-ts/src/"
/** @param {OwnedBehavior} behavior @param {string} file */
const appliesTo = (behavior, file) =>
  !behavior.owners.includes(file) &&
  !(behavior.exempt?.includes(file) ?? false) &&
  !(behavior.exemptDirs?.some((dir) => file.startsWith(dir)) ?? false) &&
  !(behavior.nodeOnly === true && inRenderer(file)) &&
  !(behavior.rendererOnly === true && !inRenderer(file)) &&
  !(behavior.serverOnly === true && !file.startsWith(serverFiles))

const DECISION_WORDS =
  "Allow|Ask|Deny|Allow once|Always allow|Always deny|Always ask before|Allowed|Denied|Run commands on your Mac|Read files in|Change files in"
const RETIRED_DECISION_WORDS =
  "/(Never do|Do (this )?without asking|Ask first|Never touch|Use files in|without asking\\?|Arden never does|Arden asks you first|Arden does these|Guidance for Auto review)/"
const textOwners = ["libs/std/src/text.ts"]
const migrationsDir = "apps/server-ts/src/persistence/migrations/"
const electronDir = "apps/desktop/electron/"
/** @param {string[]} types */
const toldEventSelector = (types) => {
  const literal = `Literal[value=/^(${types.join("|")})$/]`
  return `Property[key.name='type'] > ${literal}, Property[key.name='type'] > TSAsExpression > ${literal}`
}
const startsWithCall = "CallExpression[callee.property.name='startsWith']"
const replaceCall = "CallExpression[callee.property.name=/^replace(All)?$/]"
const sepNode = ":matches(Identifier[name='sep'], MemberExpression[property.name='sep'])"
/** @type {OwnedBehavior[]} */
const ownedBehaviors = [
  {
    selector: [
      `${startsWithCall}[arguments.0.value=/^\\.\\./]`,
      `${startsWithCall} > TemplateLiteral > TemplateElement[value.raw=/^\\.\\./]`,
      `${startsWithCall} > TemplateLiteral:has(> ${sepNode})`,
      `${startsWithCall} > TemplateLiteral:has(> Identifier[name=/(root|home|dir|folder)$/i])`,
      `${startsWithCall} > BinaryExpression[operator='+']:has(> ${sepNode})`,
      `BinaryExpression[operator=/^[!=]==?$/][right.value='..']:matches([left.name=/^rel/i], [left.callee.property.name='relative'], [left.callee.name='relative'])`
    ].join(", "),
    message:
      "Ask isWithin(root, target) from @arden-hq/std/paths whether a path is inside a folder; `startsWith` on a prefix or a `..` misreads siblings and folders named like `..cache`.",
    owners: ["libs/std/src/paths.ts"],
    nodeOnly: true
  },
  {
    selector: [
      "MemberExpression[property.name='ARDEN_DIR']",
      "Literal[value='ARDEN_DIR']",
      "Literal[value='.arden']"
    ].join(", "),
    message:
      "Server code takes Arden's data folder from DataRoot.dir (LocalPathServices.dataDir); the CLI and Electron main resolve it through resolveArdenDir (@arden-hq/std/paths), which expands `~` the same way everywhere.",
    owners: ["libs/std/src/paths.ts"],
    nodeOnly: true
  },
  {
    selector:
      "CallExpression[callee.property.name='replace'][arguments.0.value='T'][callee.object.callee.property.name='slice'][callee.object.arguments.1.value=16]",
    message:
      "Cut a UTC wall stamp with utcStamp(instant) from @arden-hq/std/time: it carries the \"UTC\" suffix and is empty for a bad date; a bare cut reads as local time.",
    owners: ["libs/std/src/time.ts"]
  },
  {
    selector: [
      "Property[key.name='hour12'][value.value=false]",
      "Property[key.name='hourCycle'][value.value=/^h2[34]$/]",
      "TemplateLiteral:has(CallExpression[callee.property.name=/^get(UTC)?Hours$/])",
      "ConditionalExpression:has(> Literal[value='AM']):has(> Literal[value='PM'])",
      "CallExpression[callee.property.name='toLocaleTimeString']",
      "Property[key.name='hour'][value.value=/^(numeric|2-digit)$/]"
    ].join(", "),
    message:
      "A clock reads 12-hour through formatClock / formatDayWord / formatDayClock from @arden-hq/std/time (\"7:38 AM\", \"Today 9:00 AM\"); no 24-hour option and no hand-built HH:MM from getHours.",
    owners: ["libs/std/src/time.ts"]
  },
  {
    selector: "BinaryExpression[operator='**'][left.value=2]",
    message:
      "A retry delay doubles through backoffDelayMs / ladderDelayMs from @arden-hq/std/retry, not inline `2 ** n`.",
    owners: ["libs/std/src/retry.ts"]
  },
  {
    selector: `Literal[value=/^retry-after(-ms)?$/i]`,
    message:
      "Read a server's Retry-After through retryAfterHints / parseRetryAfter (@arden-hq/std/retry): seconds, HTTP date and retry-after-ms, uncapped.",
    owners: ["libs/std/src/retry.ts"]
  },
  {
    selector: [
      "BinaryExpression[operator='===']:matches([right.value=408], [left.value=408])"
    ].join(", "),
    message:
      "Ask retryableStatus(status) from @arden-hq/std/retry whether an HTTP status is worth trying again (408, 429, 5xx).",
    owners: ["libs/std/src/retry.ts"]
  },
  {
    selector: [
      `NewExpression[callee.name='Promise'] > ArrowFunctionExpression:matches([body.callee.name='setTimeout'], [body.callee.property.name='setTimeout'])[body.arguments.0.name=/^(r|resolve|res|done)$/]`,
      `NewExpression[callee.name='Promise'] > ArrowFunctionExpression > BlockStatement[body.length=1] > ExpressionStatement > CallExpression:matches([callee.name='setTimeout'], [callee.property.name='setTimeout'])[arguments.0.name=/^(r|resolve|res|done)$/]`,
      "ImportDeclaration[source.value=/^(node:)?timers\\/promises$/]"
    ].join(", "),
    message:
      "Wait through sleep(ms, signal?) from @arden-hq/std/sleep: it rejects with signal.reason, checks a signal already aborted first, and removes its listener.",
    owners: ["libs/std/src/sleep.ts"]
  },
  {
    selector:
      "CallExpression[callee.property.name='slice'][arguments.0.value=0][arguments.1.value=10][callee.object.callee.property.name=/^(toISOString|formatIso)$/]",
    message: "Take an instant's UTC day with utcDay(instant) from @arden-hq/std/time, not a cut of its ISO text.",
    owners: ["libs/std/src/time.ts"]
  },
  {
    selector: "CallExpression[callee.property.name='resolvedOptions']",
    message:
      "The machine's zone is machineTimeZone() from @arden-hq/std/time (falls back to UTC); a bare resolvedOptions().timeZone can be empty.",
    owners: ["libs/std/src/time.ts"]
  },
  {
    selector:
      "TemplateLiteral:has(CallExpression[callee.property.name='toFixed']) > TemplateElement[value.raw=/^s\\b/]",
    message:
      "Durations are words from @arden-hq/std/time (formatDuration, formatDurationFine); a hand-built `${n.toFixed(1)}s` has no minutes and rounds after picking its unit.",
    owners: ["libs/std/src/time.ts"]
  },
  {
    selector:
      "CallExpression[callee.name='setInterval'], CallExpression[callee.object.name=/^(window|globalThis)$/][callee.property.name='setInterval']",
    message:
      "Poll through startVisiblePoll (lib/dom/visiblePoll.ts); it pauses while the window is hidden. A clock that must tick hidden says why in an oxlint-disable comment.",
    owners: [
      "apps/desktop/src/lib/dom/visiblePoll.ts",
      "apps/desktop/src/hooks/useTimeTicker.ts",
      "apps/desktop/src/dev/dot-loader-demo.tsx",
    ],
    rendererOnly: true
  },
  {
    selector: [
      "TemplateLiteral:has(CallExpression[callee.property.name='slice']):has(> TemplateElement[tail=true][value.raw=/^…/])",
      "BinaryExpression[operator='+'][right.value='…']:has(CallExpression[callee.property.name='slice'])"
    ].join(", "),
    message:
      "Cut text with cutText / clipLine from @arden-hq/std/text: the suffix counts inside the budget, the cut never splits a surrogate pair, the end is trimmed.",
    owners: [...textOwners],
    text: true
  },
  {
    selector:
      "MemberExpression[property.name='slice'] CallExpression[callee.property.name=/^replace(All)?$/][arguments.0.regex.pattern=/^\\\\s\\+$/]",
    message:
      "Fold whitespace and cut with clipLine (or foldSpace + cutText) from @arden-hq/std/text; a silent slice after a fold hides the cut.",
    owners: [...textOwners],
    text: true
  },
  {
    selector: [
      ":not(Property[key.name='suffix']) > Literal[value=/\\[[^\\]]*(truncated|… ?cut)/i]",
      ":not(Property[key.name='suffix']) > TemplateLiteral > TemplateElement[value.raw=/\\[[^\\]]*(truncated|… ?cut)/i]"
    ].join(", "),
    message:
      "A truncation notice is the `suffix` of cutText / cutBytes (@arden-hq/std/text); do not spell a new one by hand.",
    owners: [...textOwners, "libs/loop/src/tools/truncate.ts"],
    text: true
  },
  {
    selector: [
      "MemberExpression[computed=true][property.value=0] > CallExpression[callee.property.name='split'][arguments.0.value='\\n']",
      "MemberExpression[computed=true][property.value=0] > CallExpression[callee.property.name='split'][arguments.0.regex.pattern=/^\\\\r\\?\\\\n$/]"
    ].join(", "),
    message: "Take the first line of a text with firstLine from @arden-hq/std/text (it handles \\r\\n).",
    owners: [...textOwners],
    text: true
  },
  {
    selector: [
      "ConditionalExpression[test.type='BinaryExpression'][test.right.value=1][consequent.value=''][alternate.value=/^e?s$/]",
      "ConditionalExpression[test.type='BinaryExpression'][test.right.value=1][consequent.value=/^e?s$/][alternate.value='']",
      "VariableDeclarator[id.name=/^(plural|pluralize|pluralise)$/][init.type=/Function/]",
      "FunctionDeclaration[id.name=/^(plural|pluralize|pluralise)$/]"
    ].join(", "),
    message:
      "Write a counted noun with countOf(n, one, many?) (or nounFor for the word alone) from @arden-hq/std/count, not a `n === 1 ? \"\" : \"s\"` selector or a local plural helper.",
    owners: ["libs/std/src/count.ts"]
  },
  {
    selector: [
      "TemplateElement[value.raw=/“$/]",
      "VariableDeclarator[id.name=/^(quoted|quote|quotedLine|quoteName)$/][init.type=/Function/]",
      "FunctionDeclaration[id.name=/^(quoted|quote|quotedLine|quoteName)$/]"
    ].join(", "),
    message:
      "Quote a name in a sentence with quoted(name, max?) from @arden-hq/std/count: one line, one pair of curly quotes, one clip.",
    owners: ["libs/std/src/count.ts"]
  },
  {
    selector: [
      "CallExpression[callee.property.name='join'][arguments.0.value=', '] > MemberExpression.callee > CallExpression[callee.property.name='slice'][arguments.0.value=0][arguments.1.operator='-']",
      "VariableDeclarator[id.name=/^(listWords|listNames|joinedAnd|joinPaths|permissionWords)$/][init.type=/Function/]",
      "FunctionDeclaration[id.name=/^(listWords|listNames|joinedAnd|joinPaths|permissionWords)$/]"
    ].join(", "),
    message:
      "Join names as \"a, b and c\" with listWords(items, joiner?) from @arden-hq/std/count.",
    owners: ["libs/std/src/count.ts"]
  },
  {
    selector: [
      "CallExpression[callee.property.name='toLocaleString'][arguments.length=1][arguments.0.value=/^en/]",
      "NewExpression[callee.object.name='Intl'][callee.property.name='NumberFormat'][arguments.0.value=/^en/]",
      "VariableDeclarator[id.name=/^(formatBytes|formatSize|formatFileSize|sizeLabel|sizeText|formatCount|groupedCount|formatNumber)$/][init.type=/Function/]",
      "FunctionDeclaration[id.name=/^(formatBytes|formatSize|formatFileSize|sizeLabel|sizeText|formatCount|groupedCount|formatNumber)$/]"
    ].join(", "),
    message:
      "Group a count's digits with groupedCount/countOf and write a byte size with formatBytes, from @arden-hq/std/count.",
    owners: ["libs/std/src/count.ts", "libs/answer-ui/src/format.ts"]
  },
  {
    selector: [
      "TemplateLiteral:has(BinaryExpression[operator='/'][right.value=1000]) > TemplateElement[value.raw=/^[kK]/]",
      "TemplateLiteral:has(BinaryExpression[operator='/'][right.value=1000000]) > TemplateElement[value.raw=/^[mM]/]",
      "VariableDeclarator[id.name=/^(formatTokenCount|formatTokens|tokenLabel|compactNumber|abbreviateCount)$/][init.type=/Function/]",
      "FunctionDeclaration[id.name=/^(formatTokenCount|formatTokens|tokenLabel|compactNumber|abbreviateCount)$/]"
    ].join(", "),
    message:
      "Write a large count compactly with compactCount from @arden-hq/std/count (\"1.2K\", \"3.4M\", \"250B\"), not a hand-built `k` or `M` scale.",
    owners: ["libs/std/src/count.ts"]
  },
  {
    selector: "VariableDeclarator[id.name=/RETRY_DELAYS_MS$/]",
    message:
      "The waits between runs of one outage are the ladders in persistence/automations/retry-ladders.ts (one layer retries, three steps at most), read through ladderStepMs.",
    owners: ["apps/server-ts/src/persistence/automations/retry-ladders.ts"],
    nodeOnly: true
  },
  {
    selector: [
      "FunctionDeclaration[id.name=/^(errorMessage|errorText|toError)$/]",
      "VariableDeclarator[id.name=/^(errorMessage|errorText|toError)$/]"
    ].join(", "),
    message:
      "errorMessage(cause, fallback?) and toError(cause) live in @arden-hq/std/errors; Electron main keeps errorText in ./unknown.cjs.",
    owners: ["libs/std/src/errors.ts", "apps/desktop/electron/unknown.cjs"]
  },
  {
    selector: [
      "FunctionDeclaration[id.name=/^(canonical|canonicalJson|sameJson|compareCodePoints|compareCanonicalText)$/]",
      "VariableDeclarator[id.name=/^(canonicalJson|sameJson|compareCodePoints|compareCanonicalText)$/]"
    ].join(", "),
    message:
      "Canonical JSON, JSON equality and code-point order live in @arden-hq/std/json: canonicalJson(value) for a digest or identity, sameJson(a, b) for equality.",
    owners: ["libs/std/src/json.ts"]
  },
  {
    selector: [
      "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'] > :matches(ArrowFunctionExpression, FunctionExpression):nth-child(2):has(CallExpression[callee.property.name=/^(sort|toSorted)$/])",
      "CallExpression[callee.object.name='JSON'][callee.property.name='stringify'] > CallExpression:nth-child(2):matches([callee.property.name=/^(sort|toSorted)$/], :has(CallExpression[callee.property.name=/^(sort|toSorted)$/]))"
    ].join(", "),
    message:
      "A JSON.stringify that sorts keys is canonicalJson(value) from @arden-hq/std/json (engineOrderedJson for engine key order), whatever the function is called.",
    owners: ["libs/std/src/json.ts"]
  },
  {
    selector: [
      "FunctionDeclaration[id.name=/^(isRecord|isJsonRecord|isPlainObject)$/]",
      "VariableDeclarator[id.name=/^(isRecord|isJsonRecord|isPlainObject)$/]"
    ].join(", "),
    message:
      "A non-array object test is Predicate.isObject where Effect is imported, else isRecord from @arden-hq/std/json.",
    owners: ["libs/std/src/json.ts"],
    exemptDirs: [migrationsDir, electronDir]
  },
  {
    selector: "TemplateElement[value.raw=/\\bstatus\\s+(NOT\\s+)?IN\\s*\\('/i]",
    message:
      "A SQL status list is a named one from persistence/sqlite/status-sets.ts (or taskOpenSql / taskUnfinishedSql in task-status-sql.ts); add the list there instead of spelling the words in the query.",
    owners: [
      "apps/server-ts/src/persistence/sqlite/status-sets.ts",
      "apps/server-ts/src/persistence/sqlite/task-status-sql.ts"
    ],
    exemptDirs: ["apps/server-ts/src/persistence/schema/", migrationsDir],
    nodeOnly: true
  },
  {
    selector:
      "LogicalExpression[operator='||']:has(BinaryExpression[right.value='open']):has(BinaryExpression[right.value='deferred'])",
    message:
      "A Task that is not finished (open or postponed) is isTaskUnfinished(status) from @arden-hq/protocol/spaces/work; \"being worked now\" is `status === \"open\"` alone, and SQL uses taskUnfinishedSql / taskOpenSql.",
    owners: ["libs/protocol/src/spaces/work/words.ts"],
    exempt: ["apps/desktop/src/domain/work/workState.ts"]
  },
  {
    selector: [
      "CallExpression[callee.name=/^(rename|renameSync)$/]",
      "CallExpression[callee.object.name='fs'][callee.property.name=/^(rename|renameSync)$/]"
    ].join(", "),
    message:
      "Replacing a file is writeAtomic / writeAtomicSync (@arden-hq/std/atomic-file); a rename of a folder or an installed app takes an inline disable with its reason.",
    owners: ["libs/std/src/atomic-file.ts"],
    exempt: [
      "apps/server-ts/src/lib/download.ts",
      "apps/server-ts/src/computer/install.ts",
      "apps/server-ts/src/skills/marketplace.ts",
      "apps/server-ts/src/artifacts/conversation.ts",
      "apps/server-ts/src/storage/local-paths.ts",
      "apps/desktop/electron/daemon-log.cjs",
      "libs/revisions/src/storage/service.ts",
      "libs/revisions/src/storage/files.ts"
    ],
    nodeOnly: true
  },
  {
    selector: [
      "CallExpression[callee.property.name='toString'][arguments.0.value='base64url'][callee.object.callee.object.name='Buffer']",
      "CallExpression[callee.object.name='Buffer'][callee.property.name='from'][arguments.1.value='base64url']"
    ].join(", "),
    message:
      "An opaque reference the model hands back is encodeOpaque / decodeOpaque (server lib/opaque-ref.ts): strict, schema-checked, one failure shape.",
    owners: ["apps/server-ts/src/lib/opaque-ref.ts"],
    exempt: [
      "apps/server-ts/src/tools/google-gmail-mime.ts",
      "apps/server-ts/src/tools/google-gmail-attachment.ts",
      "apps/server-ts/src/mcp/vault.ts"
    ],
    exemptDirs: [electronDir],
    nodeOnly: true
  },
  {
    selector:
      "CallExpression[callee.object.name='process'][callee.property.name='kill'][arguments.0.type='UnaryExpression']",
    message:
      "A child's process group is signalled by signalProcessGroup / terminate from @arden-hq/std/process: one fallback where there are no groups and one grace before SIGKILL.",
    owners: ["libs/std/src/process.ts"],
    nodeOnly: true
  },
  {
    selector: "TSInterfaceDeclaration[id.name='SseFrame']",
    message:
      "An SSE frame is SseFrame from @arden-hq/protocol, read by decodeSseFrameStream (or the server-event decoders); a stream is framed once.",
    owners: ["libs/protocol/src/transport/contracts.ts"]
  },
  {
    selector: [
      String.raw`${replaceCall}[arguments.0.regex.pattern=/^\[(?!\^)(?=[^\]]*\*)(?=[^\]]*[_\x60])/]`,
      String.raw`${replaceCall}[arguments.0.regex.pattern=/^\(\\\*.*_/]`,
      String.raw`${replaceCall}[arguments.0.regex.pattern=/\\\]\\\(/][arguments.1.value=/^(\$[12]| )?$/]`,
      String.raw`${replaceCall}[arguments.0.regex.pattern=/#\{1,6\}/][arguments.1.value='']`
    ].join(", "),
    message:
      "Markdown becomes plain words through markdownWords (one line, not cut) or markdownLines (per line, inline markup kept) from @arden-hq/protocol/chat: it takes emphasis off in pairs and keeps `file_name`, `a|b` and code as written.",
    owners: ["libs/protocol/src/chat/preview-line.ts"],
    exemptDirs: [migrationsDir]
  },
  {
    selector:
      "CallExpression[callee.property.name='replace'][arguments.0.regex.pattern='[^a-z0-9]+'][arguments.1.value=/^[-_]$/]",
    message:
      "Words become a key through slugify(text, options) from @arden-hq/std/slug (a new Task's key: the Work store picks it); a stored key keeps the options it was made with.",
    owners: ["libs/std/src/slug.ts"],
    exemptDirs: [migrationsDir]
  },
  {
    selector: [
      "CallExpression[callee.name='slugify']:has(Property[key.name='fallback'][value.value='task'])",
      "ImportSpecifier[imported.name='taskKey']"
    ].join(", "),
    message:
      "A new Task's key is the Work store's (freeKey in persistence/sqlite/work-capture.ts): create it without `key` and the store files it under the first key free where it lands, never over a live or archived Task.",
    owners: ["apps/server-ts/src/persistence/sqlite/work-capture.ts"],
    exemptDirs: [migrationsDir]
  },
  {
    selector: "CallExpression[callee.name='createHash'][arguments.0.value='sha256']",
    message:
      "A SHA-256 digest is sha256Hex / sha256Base64Url / sha256Bytes / hashFile from @arden-hq/std/hash; only a download that hashes as it streams keeps createHash.",
    owners: ["libs/std/src/hash.ts", "apps/server-ts/src/lib/download.ts"],
    exemptDirs: [electronDir, migrationsDir],
    nodeOnly: true
  },
  {
    selector: [
      "FunctionDeclaration[id.name=/^(validateJson|requirePlainObject|cloneJson)$/]",
      "VariableDeclarator[id.name=/^(validateJson|requirePlainObject|cloneJson)$/]"
    ].join(", "),
    message:
      "The credential vault and its broker check and copy a stored value through electron/credential-vault-values.cjs, so both sides accept the same values.",
    owners: ["apps/desktop/electron/credential-vault-values.cjs"],
    nodeOnly: true
  },
  {
    selector: [
      `LogicalExpression[operator='||']:has(BinaryExpression[right.value='localhost']):has(BinaryExpression[right.value=/^(127\\.0\\.0\\.1|\\[::1\\]|::1)$/])`,
      `NewExpression[callee.name='Set']:has(Literal[value='localhost']):has(Literal[value=/^(127\\.0\\.0\\.1|\\[::1\\]|::1)$/])`
    ].join(", "),
    message:
      "Ask isLoopbackHost / isSecureServerUrl (@arden-hq/std/url) whether a host is this machine or an address is a secure server; hand-written lists disagree on `::1` and `[::1]`.",
    owners: ["libs/std/src/url.ts"]
  },
  {
    selector:
      "LogicalExpression:has(MemberExpression[property.name='username']):has(MemberExpression[property.name='password'])",
    message:
      "Credentials in a URL are judged by @arden-hq/std/url (serverUrlIssue for an address Arden connects to, publicWebUrl for a page a tool fetches or shows).",
    owners: ["libs/std/src/url.ts"]
  },
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
  }
]
export const exemptDirs = [
  ...new Set(ownedBehaviors.flatMap((behavior) => behavior.exemptDirs ?? []))
].filter((dir) => dir !== migrationsDir)
export const ownerFiles = [
  ...new Set(ownedBehaviors.flatMap((behavior) => [...behavior.owners, ...(behavior.exempt ?? [])]))
]
const rendererPathsImport = {
  selector:
    "ImportDeclaration[source.value=/^@arden-hq\\/std\\/paths$/], ImportExpression[source.value=/^@arden-hq\\/std\\/paths$/]",
  message: "@arden-hq/std/paths is node-only (node:path, node:os); the renderer cannot import it."
}
/** @param {"workspace" | "renderer" | "server" | "frozen" | string} scope */
export const ownedBans = (scope) => ({
  "arden/restricted-owner": [
    "error",
    ...ownedBehaviors
      .filter((behavior) => {
        if (behavior.serverOnly === true && scope !== "server") return appliesTo(behavior, scope)
        if (scope === "workspace" || scope === "server") return behavior.rendererOnly !== true
        if (scope === "renderer") return behavior.nodeOnly !== true
        if (scope === "frozen")
          return behavior.rendererOnly !== true && behavior.text !== true && appliesTo(behavior, `${migrationsDir}file.ts`)
        if (scope.endsWith("/"))
          return behavior.rendererOnly !== true && appliesTo(behavior, `${scope}file.ts`)
        return appliesTo(behavior, scope)
      })
      .map(({ selector, pattern, message }) =>
        pattern === undefined ? { selector, message } : { pattern, message }
      ),
    ...(scope === "renderer" || inRenderer(scope) ? [rendererPathsImport] : [])
  ]
})
