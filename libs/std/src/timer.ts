export interface Timer {
  readonly cancel: () => void
}

export interface TimerOptions {
  readonly unref?: boolean
}

const unrefIf = (id: ReturnType<typeof setTimeout>, options: TimerOptions): void => {
  if (options.unref === true && typeof id === "object") id.unref()
}

export const after = (ms: number, run: () => void, options: TimerOptions = {}): Timer => {
  const id = setTimeout(run, ms)
  unrefIf(id, options)
  return { cancel: () => clearTimeout(id) }
}

export const every = (ms: number, run: () => void, options: TimerOptions = {}): Timer => {
  const id = setInterval(run, ms)
  unrefIf(id, options)
  return { cancel: () => clearInterval(id) }
}

export interface Deadline extends Timer {
  readonly signal: AbortSignal
}

export const abortAfter = (
  ms: number | undefined,
  reason?: (ms: number) => unknown,
  options: TimerOptions = {}
): Deadline => {
  const controller = new AbortController()
  if (ms === undefined) return { signal: controller.signal, cancel: () => undefined }
  const timer = after(
    ms,
    () => (reason === undefined ? controller.abort() : controller.abort(reason(ms))),
    options
  )
  return { signal: controller.signal, cancel: timer.cancel }
}
