import { textOwners } from "./owned-behavior-shared.mjs"

const startsWithCall = "CallExpression[callee.property.name='startsWith']"
const sepNode = ":matches(Identifier[name='sep'], MemberExpression[property.name='sep'])"
/** @type {import("./owned-behavior-shared.mjs").OwnedBehavior[]} */
export const textBehaviors = [
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
]
