# 0016. Features offer API calls through the kernel.api-methods slot

- Status: accepted
- Date: 2026-10-02

## Context and problem

The API may not depend on features, yet features have their own operations (⌘T's "open or
create today's note" must be one writer operation).

## Decision

A feature contributes `(name, handler)` pairs to the `kernel.api-methods` registry, named under
its own prefix (`daily.today`, `notes.create`, `notes.folders`). The composition root hands
the registry to the API, which dispatches unknown method names to it. A handler receives a
narrow context: the open library (store and writer) and the per-device settings. A
contribution may not reuse a built-in method's name.

## Consequences

The architecture report lists contributed calls with their contributors.
