import { electronDir, migrationsDir } from "./owned-behavior-shared.mjs"

const replaceCall = "CallExpression[callee.property.name=/^replace(All)?$/]"
/** @type {import("./owned-behavior-shared.mjs").OwnedBehavior[]} */
export const encodingBehaviors = [
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
      "apps/server-ts/src/artifacts/conversation-files.ts",
      "apps/server-ts/src/storage/local-revision.ts",
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
      "apps/server-ts/src/mcp/vault.ts",
      "libs/headless/src/chatgpt-login.ts"
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
]
