# 0013. The interface's tests and browser preview use an in-process mock backend

- Status: accepted
- Date: 2026-10-02

## Context and problem

Tauri has no WebDriver support on macOS, so the interface can't be driven end to end in its
real webview. The interface still needs fast tests and a way to look at it.

## Decision

`tests/mock/backend.ts` has the same exports as `src/backend.ts` and answers the API calls from
memory. Vitest and `npm run dev:mock` (a browser preview on port 1421, development only) alias
`backend` to it. In the app, `src/backend.ts` stays the only door to Tauri. Interface errors,
warnings and startup timings are written to the app's log file through `app.log`, so a run of
the real app can be checked from its log.

## Consequences

The mock must follow the API's shapes; it is typed with the generated types to keep it honest.
