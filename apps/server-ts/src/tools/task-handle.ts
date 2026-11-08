export const taskHandle = (task: {
  readonly stable_key: string
  readonly updated_at: string
  readonly history_revision: string | null
}): string =>
  `key ${task.stable_key} · updated_at ${task.updated_at} · history_revision ${task.history_revision ?? "pending baseline"}`
