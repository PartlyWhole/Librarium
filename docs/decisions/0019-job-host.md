# 0019. The job host

- Status: accepted
- Date: 2026-10-02

## Context and problem

§6 asks for resumable jobs with idempotency keys, a Jobs view, and §4.5 for a worker retried
once after a crash, a hang or the memory ceiling.

## Decision

- Jobs persist in `libraries/<id>/jobs.sqlite` (operational state), through the IndexEngine
  port.
- A job kind (slot `kernel.job-kinds`) has a title, a noun for the resume note, whether it
  resumes after a restart, its run function, and an optional trigger that turns a change into
  a request `(key, payload)`.
- Two runner threads. A `Worker` error retries the job once (attempt 2), then marks it failed
  with the error. Retry, Dismiss and Cancel are API calls.
- Non-resumable jobs left running at shutdown are cancelled at the next start (an index
  rebuild reruns anyway). Resumable ones are queued again, and the next start shows
  "Resumed N <noun>".
- The worker host exposes its process ID without taking its call lock, so a crash can be
  observed (and tested) during a call.

## Consequences

The kernel contributes `index.rebuild`; the Links feature contributes `links.repair`.
