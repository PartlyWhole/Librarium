# 0073. Closing the window quits, after saving; the saved library says "opening" at once

- Status: accepted
- Date: 2026-10-08
- Requests: R-071 and R-072 in `docs/REQUESTS.md`

## Context and problem

- Closing the window left the app running: the page saver's hidden window kept it alive.
- The library was closed as soon as the window was asked to close, while the interface was
  still saving its last changes.
- The system's Quit menu item ended the app without the interface saving.
- At start-up, the saved library's status could briefly read "missing" (nothing open yet, a
  folder saved). The interface shows that as "locate your folder".

## Decision

- **The main window is the app:**
  - asked to close, the app remembers the window's frame;
  - the interface saves and destroys the window;
  - then the library is closed and the app exits.
- **Quit is the app's own** (⌘Q, Librarium ▸ Quit Librarium): it saves, then calls the
  `quit` command.
- **An exit asked for while the window is open** goes through the window's closing.
- **Quit from the Dock or at log-out** ends the app without asking. The library is still
  closed properly (`RunEvent::Exit`). Unsaved typing is in its draft, offered at the next
  start.
- **The saved library is "opening" from the moment the app starts**
  (`open_saved_library_soon`). Reopening another library never passes through "none".

## Consequences

- Checked in a built test copy with a scratch library:
  - it opened its saved library at start;
  - a Dock-style quit closed the library and released its lock.
- Tests:
  - an API test: "opening" at once, then open;
  - an interface test: Quit saves before it quits;
  - the menu test now expects the app's own Quit instead of the system's (a deliberate
    change).
