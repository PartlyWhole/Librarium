# 0005. A WorkerHost port and a system adapter crate

- Status: accepted
- Date: 2026-10-02

## Context and problem

BRIEF §4.5 runs parsers in a worker process supervised by the job host, but the port table in
§4.4 has no port for starting and talking to processes. Clock and IdGenerator have real
adapters but no adapter crate is named for them.

## Decision

- Add a `WorkerHost` port in `contracts`, with the real adapter `adapters/worker-process`
  (spawn, JSON-RPC over stdin/stdout, timeout, memory ceiling, restart) and an in-process test
  adapter in `testkit`. The kernel's job host uses the port, so worker failures can be tested
  without processes.
- Put the system Clock and the UUID v7 IdGenerator in `adapters/system`.

## Consequences

No new primitive: the worker is part of the Job primitive. The kernel stays free of process
and OS code.
