# `@arden-hq/jobs`

A small worker that runs background jobs. A job is leased before it runs, so a crash does not lose it and two workers never run the same job. The host owns payloads, storage, schedules, execution and product state. `@arden-hq/server` uses it for Automations and other background work.

```ts
const worker = makeJobWorker({ driver, execute })
worker.start()
worker.wake()
await worker.stop()
```

## Driver

The driver is the durable authority. It claims, renews, completes, fails and releases jobs. Every claim and every settlement carries the opaque lease token. A call with an old token fails with `JobLeaseLostError`.

## Worker

- The worker does not poll. It admits work, then sleeps until the driver's `nextDueAt`. `idleTimeoutMs` (60 s) caps the sleep.
- `wake()` admits work at once. Call it after each enqueue and after any change that makes a job ready sooner. A wake during admission is kept.
- A failed admission retries after one second.
- The worker claims only free slots. A finished job wakes admission. A slow job does not hold up the rest of a batch.
- `concurrency` is a positive integer or an async function. The worker reads it on every admission. A lower limit lets running jobs finish first.
- `stop()` aborts active jobs and waits for their lease cleanup.
- `runOnce()` claims free slots and waits until those jobs settle.
- `snapshot()` shows the state of this process only. It has loop state, slots, the last claim query, the next wake and active job IDs. It never shows lease tokens. A live loop does not prove useful progress.

## Build

```bash
bun run build
bun run typecheck
bun run test
```
