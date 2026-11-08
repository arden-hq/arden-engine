import { BUBBLEWRAP_PATH } from "../runtime/command-sandbox.js"
import type { LocalPathPolicy } from "../storage/local-paths.js"

export interface HiddenEntry {
  readonly path: string
  readonly directory: boolean
}

interface MountLayer {
  readonly name: "writable" | "hidden" | "writeProtected" | "reopened"
  readonly args: ReadonlyArray<string>
}

const mountLayers = (options: {
  readonly writable: ReadonlyArray<string>
  readonly hidden: ReadonlyArray<HiddenEntry>
  readonly writeProtected: ReadonlyArray<string>
  readonly reopened: ReadonlyArray<string>
}): ReadonlyArray<MountLayer> => [
  { name: "writable", args: options.writable.flatMap((root) => ["--bind-try", root, root]) },
  {
    name: "hidden",
    args: options.hidden.flatMap((entry) =>
      entry.directory ? ["--tmpfs", entry.path] : ["--ro-bind", "/dev/null", entry.path]
    )
  },
  {
    name: "writeProtected",
    args: options.writeProtected.flatMap((target) => ["--ro-bind", target, target])
  },
  { name: "reopened", args: options.reopened.flatMap((root) => ["--ro-bind-try", root, root]) }
]

// bubblewrap: later mounts cover earlier ones, and it mounts only over existing
// paths, so a protected file that does not exist yet (a missing ~/.zshrc) can be
// created on Linux.
export const linuxSandboxCommand = (options: {
  readonly command: string
  readonly cwd: string
  readonly policy: LocalPathPolicy
  readonly writable: ReadonlyArray<string>
  /** Existing paths only: bubblewrap cannot mount over a missing one. */
  readonly hidden: ReadonlyArray<HiddenEntry>
  readonly writeProtected: ReadonlyArray<string>
  readonly reopened: ReadonlyArray<string>
}): { readonly executable: string; readonly args: ReadonlyArray<string> } => ({
  executable: BUBBLEWRAP_PATH,
  args: [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-user",
    ...(options.policy.network === true ? [] : ["--unshare-net"]),
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    ...mountLayers(options).flatMap((layer) => layer.args),
    "--chdir",
    options.cwd,
    "--",
    "/bin/bash",
    "-c",
    options.command
  ]
})
