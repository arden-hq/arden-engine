import { Schema } from "effect"

import { PermissionRules } from "../persistence/permissions/rules.js"
import { ConversationArtifacts } from "../artifacts/conversation.js"
import { ShellAccessSchema } from "./shell-policy.js"
import type { LocalPathServices } from "../storage/local-paths.js"
import type { TerminalStore } from "../terminals/store.js"
import { type VaultKeysService } from "../credentials/vault-keys.js"

export const DEFAULT_YIELD_MS = 10_000
export const MAX_EXEC_YIELD_MS = 30_000
export const DEFAULT_WRITE_YIELD_MS = 1_000
export const MIN_POLL_YIELD_MS = 5_000
const MAX_YIELD_INPUT_MS = 300_000
const MIN_YIELD_MS = 250

const yieldTime = (description: string) =>
  Schema.optionalKey(
    Schema.Number.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(MIN_YIELD_MS),
      Schema.isLessThanOrEqualTo(MAX_YIELD_INPUT_MS)
    ).annotate({ description })
  )

// Linux caps one argument at MAX_ARG_STRLEN, 32 pages: https://man7.org/linux/man-pages/man2/execve.2.html
const MAX_COMMAND_LENGTH = 128_000

export const ExecParametersSchema = Schema.Struct({
  cmd: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MAX_COMMAND_LENGTH)).annotate({
    description:
      "Bash source passed to /bin/bash -c (1-128,000 characters). Each call starts a fresh process: quote paths and include all shell state the command needs."
  }),
  workdir: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096)).annotate({
      description:
        "Directory to run in. Defaults to the current Local folder, must be inside allowed roots, and is required when no Local folder is set."
    })
  ),
  access: Schema.optionalKey(
    ShellAccessSchema.annotate({
      description:
        'Where the command runs. "sandbox" (the code-agent default): reads everything except secret folders, writes only the Local folder and temp, no network. "network": the same sandbox plus connections to other machines (not localhost or local sockets), for downloads, package installs, git over https and remote APIs; it follows the approval mode. "host" (the ordinary-Chat default): no sandbox, as the user would, behind approval; use it for ssh, saved logins or keys, and changes outside the Local folder.'
    })
  ),
  tty: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Run the command in a terminal with its input open, so write_stdin can answer its prompts and interactive tools behave as they would for a person. Defaults to false: input is closed, and a command that asks a question reads an empty answer."
    })
  ),
  yield_time_ms: yieldTime(
    "How long to wait for the command to finish before returning its session ID, in ms. Defaults to 10,000; waits at least 250 and at most 30,000, and larger values are cut to 30,000. The command keeps running after that."
  )
})

export const WriteParametersSchema = Schema.Struct({
  session_id: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The session ID exec_command returned for a command that was still running."
  }),
  chars: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(8_000)).annotate({
      description:
        'Characters to type, such as "y\\n". "\\u0003" sends Ctrl-C. Empty or omitted only reads new output.'
    })
  ),
  yield_time_ms: yieldTime(
    "How long to wait for output. Defaults to 1,000 after typing and 5,000 for a read; waits at most 30,000, and a read at least 5,000. Returns early when the process ends."
  )
})

export interface ShellToolServices extends LocalPathServices {
  readonly rules: PermissionRules["Service"]
  readonly vault: VaultKeysService
  readonly artifacts?: ConversationArtifacts["Service"]
  readonly terminals: TerminalStore
  readonly commandSandbox?: boolean
}
