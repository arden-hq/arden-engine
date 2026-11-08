import { ToolExecutionError } from "@arden-hq/loop"
import { collapseHome, expandHome, isWithin } from "@arden-hq/std/paths"
import { randomUUID } from "node:crypto"
import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { chmod, open, readFile, realpath, rename, rm, stat } from "node:fs/promises"
import { Effect } from "effect"

import type { SpaceStore } from "../persistence/spaces/store.js"
import type { SessionQueries } from "../persistence/sessions/queries.js"
import type { RunQueries } from "../persistence/runs/queries.js"
import type { ConversationArtifacts } from "../artifacts/conversation.js"
import { sessionLineage } from "../persistence/sessions/lineage.js"
import { runPolicyOf } from "../execution/policy.js"
import { readAgentSessionMetadata } from "../sessions/agent-mode.js"
import { isErrnoCode } from "../fs/private-store.js"
import { gitMetadataRule } from "./git-metadata.js"
import { PERSISTENCE_HOME_PATHS, SECRET_HOME_PATHS } from "../fs/protected-paths.js"
import { sha256Hex } from "@arden-hq/std/hash"
import { toolFault, toolRefusal } from "../tools/tool-failure.js"
import type { PermissionRules } from "../persistence/permissions/rules.js"
import {
  pathDecision,
  readRunRules,
  type PathAccess,
  type PathTarget,
  type RunRules
} from "../execution/rules.js"

export interface LocalPathServices {
  readonly spaces: SpaceStore["Service"]
  readonly sessions: SessionQueries["Service"]
  readonly runs: Pick<RunQueries["Service"], "get" | "authority">
  readonly rules: PermissionRules["Service"]
  readonly artifacts?: Pick<ConversationArtifacts["Service"], "rootPath">
  readonly dataDir: string
}

export interface LocalPathContext {
  readonly sessionId: string
  readonly runId: string
  readonly signal: AbortSignal
}

export interface LocalPathPolicy {
  readonly cwd: string | null
  readonly readRoots: ReadonlyArray<string> | null
  readonly readOnlyRoots?: ReadonlyArray<string>
  readonly writeRoot: string | null
  readonly stateRoot: string
  readonly sandbox: "code_agent" | "approved_local" | "host_approved" | null
  readonly network?: boolean
  readonly pathRules: RunRules
}

export interface SessionPathPolicy extends LocalPathPolicy {
  readonly localRoots: ReadonlyArray<string>
  readonly usableRoots: ReadonlyArray<string>
}

/** macOS disks ignore case by default: a never rule matches any spelling there. */
const CASE_FOLDING_DISK = process.platform === "darwin"
export const caseFoldingDisk = CASE_FOLDING_DISK

export const pathRuleFor = (
  policy: LocalPathPolicy,
  target: PathTarget,
  access: PathAccess
): "allow" | "never" | undefined => {
  const decision = pathDecision(policy.pathRules, target, access, CASE_FOLDING_DISK)
  return decision === "allow" || decision === "never" ? decision : undefined
}

export const neverFoldersWithin = (policy: LocalPathPolicy, root: string): ReadonlyArray<string> =>
  policy.pathRules.rules.flatMap((rule) =>
    rule.subject.kind === "path" &&
    rule.decision === "never" &&
    rule.subject.access === "read" &&
    rule.subject.path !== root &&
    within(root, rule.subject.path)
      ? [path.relative(root, rule.subject.path).split(path.sep).join("/")]
      : []
  )

const within = (root: string, target: string): boolean =>
  CASE_FOLDING_DISK ? isWithin(root.toLowerCase(), target.toLowerCase()) : isWithin(root, target)

export const insideUsableFolder = (policy: SessionPathPolicy, target: string): boolean =>
  policy.usableRoots.some((root) => isWithin(root, target))

export const neverRuleRefusal = (target: string, access: PathAccess) =>
  toolRefusal(
    `${target}: your rule says Arden never ${access === "change" ? "changes" : "touches"} files there.`,
    "Your rule"
  )

export const insideLocalFolder = (policy: SessionPathPolicy, target: string): boolean => {
  const roots = [...policy.localRoots, ...(policy.writeRoot === null ? [] : [policy.writeRoot])]
  return roots.some((root) => isWithin(root, target))
}

export class LocalRevisionConflict extends Error {
  constructor() {
    super("The file changed after it was reviewed")
    this.name = "LocalRevisionConflict"
  }
}

const asDirectory = async (value: string): Promise<string> => {
  const expanded = expandHome(value)
  if (!path.isAbsolute(expanded)) {
    throw toolRefusal(
      "The Local folder must be an absolute path or start with '~'.",
      "Invalid Local folder"
    )
  }
  try {
    const resolved = await realpath(expanded)
    if (!(await stat(resolved)).isDirectory()) {
      throw toolRefusal(`${resolved} is not a directory.`, "Not a directory")
    }
    return resolved
  } catch (cause) {
    if (cause instanceof ToolExecutionError) throw cause
    throw toolFault(`The Local folder is unavailable: ${expanded}.`, "Local folder unavailable")
  }
}

const asPinnedDirectory = async (value: string): Promise<string> => {
  const expected = path.resolve(expandHome(value))
  const resolved = await asDirectory(value)
  if (resolved !== expected) {
    throw toolRefusal(
      `The pinned Local folder now resolves somewhere else: ${expected}.`,
      "Local folder changed"
    )
  }
  return resolved
}

const PROTECTED_ROOT_METADATA = [".agents", ".codex"] as const

/**
 * Directories a protected path hangs from inside the writable root, the root
 * included. A path deny does not stop renaming a parent, so these cannot be
 * renamed or removed: otherwise `mv Library L2` would free L2/LaunchAgents to
 * be written and moved back (Codex denies the same unlink on its roots and on
 * the ancestors of protected globs).
 */
const anchorsWithin = (
  writeRoot: string,
  protectedPaths: ReadonlyArray<string>
): ReadonlyArray<string> => {
  const anchors = new Set<string>([writeRoot])
  for (const target of protectedPaths) {
    for (
      let parent = path.dirname(target);
      parent !== path.dirname(parent) && isWithin(writeRoot, parent);
      parent = path.dirname(parent)
    )
      anchors.add(parent)
  }
  return [...anchors]
}

export interface SandboxRule {
  readonly hidden: ReadonlyArray<string>
  readonly writeProtected: ReadonlyArray<string>
  readonly writeProtectedPatterns: ReadonlyArray<string>
  readonly anchors: ReadonlyArray<string>
  readonly reopened: ReadonlyArray<string>
  readonly extraWriteRoots: ReadonlyArray<string>
}

export const sandboxRule = (
  policy: LocalPathPolicy,
  homeDirectory: string = realHome(),
  platform: NodeJS.Platform = process.platform
): SandboxRule | undefined => {
  if (policy.sandbox !== "code_agent" && policy.sandbox !== "approved_local") return undefined
  const secrets = SECRET_HOME_PATHS.map((relative) => path.join(homeDirectory, relative))
  const state = [policy.stateRoot]
  const writeRoot = policy.writeRoot
  const git =
    writeRoot === null
      ? { writeProtected: [], writeProtectedPatterns: [], writeRoots: [] }
      : gitMetadataRule(writeRoot, platform)
  const nevers = (access: PathAccess) =>
    policy.pathRules.rules.flatMap((rule) =>
      rule.subject.kind === "path" && rule.decision === "never" && rule.subject.access === access
        ? [rule.subject.path]
        : []
    )
  const writeProtected = [
    ...new Set([
      ...nevers("change"),
      ...nevers("read"),
      ...PERSISTENCE_HOME_PATHS.map((relative) => path.join(homeDirectory, relative)),
      ...(writeRoot === null
        ? []
        : PROTECTED_ROOT_METADATA.map((relative) => path.join(writeRoot, relative))),
      ...git.writeProtected
    ])
  ]
  const hidden = [...secrets, ...state, ...nevers("read")]
  const guarded = [...hidden, ...writeProtected]
  return {
    hidden,
    writeProtected,
    writeProtectedPatterns: git.writeProtectedPatterns,
    anchors: [
      ...new Set(
        [...(writeRoot === null ? [] : [writeRoot]), ...git.writeRoots].flatMap((root) =>
          anchorsWithin(root, guarded)
        )
      )
    ],
    extraWriteRoots: git.writeRoots,
    reopened: (policy.readOnlyRoots ?? []).filter(
      (root) =>
        state.some((stateRoot) => isWithin(stateRoot, root)) &&
        !secrets.some((secret) => isWithin(root, secret))
    )
  }
}

const sandboxMayWrite = (rule: SandboxRule, target: string): boolean =>
  ![...rule.hidden, ...rule.writeProtected].some((root) => isWithin(root, target)) &&
  !rule.writeProtectedPatterns.some((pattern) => new RegExp(pattern).test(target))

const sandboxMayRead = (rule: SandboxRule, target: string): boolean =>
  rule.reopened.some((root) => isWithin(root, target)) ||
  !rule.hidden.some((root) => isWithin(root, target))

export const realHome = (): string => {
  try {
    return realpathSync(homedir())
  } catch {
    return homedir()
  }
}

export const policyPathOptions = (policy: LocalPathPolicy) => ({
  pathRules: policy.pathRules,
  readRoots: policy.readRoots,
  writeRoot: policy.writeRoot,
  stateRoot: policy.stateRoot,
  sandboxRule: sandboxRule(policy)
})

export const resolveLocalDirectory = async (
  rawPath: string,
  cwd: string | null,
  stateRoot: string | null,
  pathRules?: RunRules
): Promise<string> => {
  const resolved = await resolveLocalPath(rawPath, cwd, {
    mutation: true,
    stateRoot,
    ...(pathRules === undefined ? {} : { pathRules })
  })
  try {
    if (!(await stat(resolved)).isDirectory()) {
      throw toolRefusal(`${resolved} is not a directory.`, "Not a directory")
    }
    return resolved
  } catch (cause) {
    if (cause instanceof ToolExecutionError) throw cause
    throw toolFault(`Local folder is unavailable: ${resolved}.`, "Local folder unavailable")
  }
}

const allowedFolders = (rules: RunRules, access: PathAccess): ReadonlyArray<string> =>
  rules.rules.flatMap((rule) =>
    rule.subject.kind === "path" && rule.decision === "allow" && rule.subject.access === access
      ? [rule.subject.path]
      : []
  )

export const sessionPathPolicy = async (
  services: LocalPathServices,
  context: LocalPathContext
): Promise<SessionPathPolicy> => {
  const authority = await Effect.runPromise(services.runs.authority(context.runId), {
    signal: context.signal
  }).catch(() => undefined)
  if (authority === undefined)
    throw toolRefusal("The Run's filesystem authority is unavailable.", "Run authority unavailable")
  const [base, pathRules] = await Promise.all([
    startPathPolicy(services, context),
    Effect.runPromise(readRunRules(services.rules, authority), { signal: context.signal }).catch(
      () => {
        throw toolFault("The permission rules could not be read.", "Rules unavailable")
      }
    )
  ])
  if (base.sandbox === "code_agent") return { ...base, usableRoots: base.localRoots, pathRules }
  const localRoots = [...new Set([...base.localRoots, ...allowedFolders(pathRules, "change")])]
  const usableRoots = [...new Set([...localRoots, ...allowedFolders(pathRules, "read")])]
  return { ...base, localRoots, usableRoots, pathRules }
}

const startPathPolicy = async (
  services: LocalPathServices,
  context: LocalPathContext
): Promise<Omit<SessionPathPolicy, "usableRoots" | "pathRules">> => {
  const stateRoot = ardenStateRoot(services.dataDir)
  try {
    const run = await Effect.runPromise(services.runs.get(context.runId), {
      signal: context.signal
    })
    if (run === null || run.sessionId !== context.sessionId) {
      throw toolRefusal(
        "The Run's filesystem authority is unavailable.",
        "Run authority unavailable"
      )
    }
    const captured = await Effect.runPromise(runPolicyOf(run))
    const snapshot = await Effect.runPromise(
      services.sessions.loadHeaderSnapshot(context.sessionId),
      {
        signal: context.signal
      }
    )
    const header = snapshot?.header
    const isAgent = header?.sessionType === "agent"
    const agent = isAgent && snapshot !== null ? readAgentSessionMetadata(snapshot.metadata) : null
    if (isAgent && agent === null) {
      throw toolRefusal(
        "This agent Session has invalid sandbox metadata.",
        "Agent sandbox unavailable"
      )
    }
    if (agent?.mode === "code") {
      if (agent.workspace === null) {
        throw toolRefusal("This code agent has no pinned Local folder.", "Local folder required")
      }
      const root = await asPinnedDirectory(agent.workspace.root)
      const cwd =
        agent.workspace.cwd === agent.workspace.root
          ? root
          : await asPinnedDirectory(agent.workspace.cwd)
      if (!isWithin(root, cwd)) {
        throw toolRefusal(
          "This code agent's working directory is outside its sandbox root.",
          "Agent sandbox unavailable"
        )
      }
      const artifacts = services.artifacts
      const artifactReadRoots =
        artifacts === undefined
          ? []
          : await Effect.runPromise(
              Effect.gen(function* () {
                const lineage = yield* sessionLineage(services.sessions, context.sessionId)
                const owner = lineage.at(-1)
                return owner === undefined ? [] : [yield* artifacts.rootPath(owner.sessionId)]
              }),
              { signal: context.signal }
            )
      return {
        cwd,
        localRoots: [root],
        readRoots: null,
        readOnlyRoots: [path.join(stateRoot, "skills"), ...artifactReadRoots],
        writeRoot: root,
        stateRoot,
        sandbox: "code_agent"
      }
    }
    if (header?.spaceId !== null && header?.spaceId !== undefined) {
      if (captured.space?.space_id !== header.spaceId) {
        throw toolRefusal(
          "The Session moved outside this Run's captured Space.",
          "Run authority changed"
        )
      }
      if (captured.execution.mode === "inline") {
        const space = await Effect.runPromise(services.spaces.get(header.spaceId), {
          signal: context.signal
        })
        if (space === null || space.archived_at != null)
          throw toolRefusal("The Space is unavailable.", "Run authority changed")
      }
    }
    return {
      cwd: null,
      localRoots: [],
      readRoots: null,
      writeRoot: null,
      stateRoot,
      sandbox: null
    }
  } catch (cause) {
    if (cause instanceof ToolExecutionError) throw cause
    throw toolFault(
      "The current Session's Local folder could not be read.",
      "Local folder unavailable"
    )
  }
}

export const ardenStateRoot = (dataDir: string): string => {
  const configured = path.resolve(dataDir)
  try {
    return realpathSync(configured)
  } catch {
    return configured
  }
}

export const resolveLocalPath = async (
  rawPath: string,
  cwd: string | null,
  options: {
    readonly allowMissing?: boolean
    readonly mutation?: boolean
    readonly readRoots?: ReadonlyArray<string> | null
    readonly writeRoot?: string | null
    readonly stateRoot: string | null
    readonly sandboxRule?: SandboxRule | undefined
    readonly pathRules?: RunRules
  }
): Promise<string> => {
  const expanded = expandHome(rawPath)
  if (expanded.length === 0) throw toolRefusal("A path is required.", "Invalid path")
  const relativeTo = path.isAbsolute(expanded) ? undefined : cwd
  if (relativeTo === null) {
    throw toolRefusal(
      "Relative paths have no folder to start from. Use an absolute or ~ path.",
      "Local folder required"
    )
  }
  const candidate = path.resolve(
    relativeTo === undefined ? expanded : path.join(relativeTo, expanded)
  )
  const guard = (resolved: string): string => {
    if (
      options.mutation === true &&
      options.stateRoot !== null &&
      isWithin(options.stateRoot, resolved)
    ) {
      throw toolRefusal(
        `${resolved} is inside Arden's own state directory, which tools may read but never write.`,
        "Protected path"
      )
    }
    const roots =
      options.mutation === true && options.writeRoot !== null && options.writeRoot !== undefined
        ? [options.writeRoot]
        : (options.readRoots ?? null)
    if (
      options.mutation === true &&
      options.sandboxRule !== undefined &&
      !sandboxMayWrite(options.sandboxRule, resolved)
    ) {
      throw toolRefusal(
        `${resolved} runs or steers later work outside the sandbox (shell startup, login agents, Git hooks, config or pointers), so sandboxed sessions cannot change it.`,
        "Protected path"
      )
    }
    if (options.sandboxRule !== undefined && !sandboxMayRead(options.sandboxRule, resolved)) {
      throw toolRefusal(
        `${resolved} is in a secret location (keys, logins, browser data or Arden's state) that sandboxed sessions cannot read.`,
        "Protected path"
      )
    }
    const access = options.mutation === true ? "change" : "read"
    if (
      options.pathRules !== undefined &&
      pathDecision(
        options.pathRules,
        { lexical: candidate, real: resolved },
        access,
        CASE_FOLDING_DISK
      ) === "never"
    )
      throw neverRuleRefusal(resolved, access)
    if (roots !== null && !roots.some((root) => isWithin(root, resolved))) {
      throw toolRefusal(
        `${resolved} is outside this code agent's sandbox root.`,
        "Path outside Local folder"
      )
    }
    return resolved
  }
  try {
    return guard(await realpath(candidate))
  } catch (cause) {
    if (cause instanceof ToolExecutionError) throw cause
    if (!isErrnoCode(cause, "ENOENT") && !isErrnoCode(cause, "ENOTDIR")) {
      throw toolFault(`Could not inspect ${candidate}.`, "Path unavailable")
    }
    if (options.allowMissing !== true) {
      throw toolRefusal(`Path not found: ${candidate}.`, "Not found")
    }
    try {
      const parent = await realpath(path.dirname(candidate))
      if (!(await stat(parent)).isDirectory()) {
        throw toolRefusal(`${parent} is not a directory.`, "No parent directory")
      }
      return guard(path.join(parent, path.basename(candidate)))
    } catch (parentCause) {
      if (parentCause instanceof ToolExecutionError) throw parentCause
      throw toolRefusal(
        `Parent directory not found: ${path.dirname(candidate)}.`,
        "No parent directory"
      )
    }
  }
}

export const displayLocalPath = (target: string, cwd: string | null): string => {
  if (cwd === null) return collapseHome(target)
  const relative = path.relative(cwd, target)
  return relative.length > 0 && isWithin(cwd, target)
    ? relative.split(path.sep).join("/")
    : collapseHome(target)
}

export const revisionOrAbsent = async (target: string): Promise<string> => {
  try {
    return sha256Hex(await readFile(target))
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT")) return "absent"
    throw cause
  }
}

export const atomicCompareAndSwap = async (
  target: string,
  content: string,
  expectedRevision: string
): Promise<{ readonly revision: string; readonly bytes: number }> => {
  if ((await revisionOrAbsent(target)) !== expectedRevision) throw new LocalRevisionConflict()
  const encoded = Buffer.from(content, "utf8")
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.arden-${randomUUID()}.tmp`
  )
  let mode: number | null = null
  try {
    mode = (await stat(target)).mode & 0o777
  } catch (cause) {
    if (!isErrnoCode(cause, "ENOENT")) throw cause
  }
  try {
    const handle = await open(temporary, "wx", mode ?? 0o666)
    try {
      await handle.writeFile(encoded)
      await handle.sync()
    } finally {
      await handle.close()
    }
    if ((await revisionOrAbsent(target)) !== expectedRevision) throw new LocalRevisionConflict()
    await rename(temporary, target)
    if (mode !== null) await chmod(target, mode)
  } finally {
    await rm(temporary, { force: true })
  }
  return { revision: sha256Hex(encoded), bytes: encoded.byteLength }
}
