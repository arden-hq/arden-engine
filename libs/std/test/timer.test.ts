import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { abortAfter, after, every } from "../src/timer.js"

describe("timer", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("runs once after the delay", () => {
    const run = vi.fn()
    after(100, run)
    vi.advanceTimersByTime(99)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it("does not run once cancelled", () => {
    const run = vi.fn()
    after(100, run).cancel()
    vi.advanceTimersByTime(500)
    expect(run).not.toHaveBeenCalled()
  })

  it("repeats until cancelled", () => {
    const run = vi.fn()
    const timer = every(10, run, { unref: true })
    vi.advanceTimersByTime(35)
    expect(run).toHaveBeenCalledTimes(3)
    timer.cancel()
    vi.advanceTimersByTime(100)
    expect(run).toHaveBeenCalledTimes(3)
  })
})

describe("abortAfter", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("aborts the signal with the given reason after the delay", () => {
    const deadline = abortAfter(50, () => new Error("late"))
    vi.advanceTimersByTime(49)
    expect(deadline.signal.aborted).toBe(false)
    vi.advanceTimersByTime(1)
    expect(deadline.signal.aborted).toBe(true)
    expect(deadline.signal.reason).toEqual(new Error("late"))
  })

  it("keeps the default abort reason when none is given", () => {
    const deadline = abortAfter(10)
    vi.advanceTimersByTime(10)
    expect(deadline.signal.reason).toBeInstanceOf(DOMException)
  })

  it("passes the delay to the reason and never aborts without one", () => {
    const reason = vi.fn((ms: number) => `after ${ms}`)
    const deadline = abortAfter(5, reason)
    vi.advanceTimersByTime(5)
    expect(deadline.signal.reason).toBe("after 5")
    const none = abortAfter(undefined, reason)
    vi.advanceTimersByTime(1_000_000)
    expect(none.signal.aborted).toBe(false)
  })

  it("never aborts once cancelled", () => {
    const deadline = abortAfter(10)
    deadline.cancel()
    vi.advanceTimersByTime(100)
    expect(deadline.signal.aborted).toBe(false)
  })
})
