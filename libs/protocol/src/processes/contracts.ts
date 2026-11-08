export type ProcessOwner =
  | {
      readonly kind: "command"
      readonly terminal_id: number
      readonly session_id: string
      readonly run_id: string
      readonly name: string
      readonly command: string
      readonly cwd: string
      readonly root_key: string
    }
  | { readonly kind: "browser"; readonly session_id: string; readonly name: string }
  | { readonly kind: "shared"; readonly name: string }

export interface MonitoredProcess {
  readonly key: string
  readonly pid: number
  readonly parent_pid: number
  readonly name: string
  readonly owner: ProcessOwner
  readonly cpu_percent: number | null
  readonly memory_bytes: number
  readonly can_stop: boolean
}

export interface ProcessSnapshot {
  readonly state: "ready" | "unavailable"
  readonly sampled_at: string
  readonly host: string
  readonly cpu_count: number
  readonly processes: ReadonlyArray<MonitoredProcess>
  readonly detail: string | null
}

export interface StopProcessRequest {
  readonly key: string
}

export interface ProcessOutput {
  readonly output: string
  readonly state: "running" | "exited" | "unavailable"
}
