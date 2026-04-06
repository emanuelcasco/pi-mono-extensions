# pi-mono-loop

## 1.4.0

### Minor Changes

- Add teammate progress heartbeats and widget refresh improvements to team mode.

## 1.3.0

### Minor Changes

- ### New Extensions

  #### `loop`

  New extension that runs a prompt or slash command on a recurring interval. Useful for periodic tasks, polling, and automated repeated actions within a pi session.

  #### `simplify`

  New extension that reviews changed code for reuse, quality, and efficiency, then automatically fixes any issues found. Integrates with `git diff` to scope the review to recent changes.

  ***

  ### Bug Fixes

  #### `multi-edit`

  - **Broader unicode normalization**: `findActualString` now handles the full range of Unicode single-quote variants (`\u2018\u2019\u201A\u201B`) and double-quote variants (`\u201C\u201D\u201E\u201F`) when falling back from exact match — fixes more curly-quote mismatch cases
  - **Parallel write-access preflight**: `checkWriteAccess` calls are now issued concurrently via `Promise.all` instead of sequentially — faster batch preflight on large edit sets
  - **Removed redundant `editOrder` array**: `Map` insertion order is now relied upon directly, simplifying the grouping loop

  #### `team-mode`

  - **Stall detection hardened**: introduced `STALL_BLOCKER_MARKER` / `STALL_BLOCKER_MESSAGE` constants so the marker used to detect and record abnormal process exits stays in sync — prevents duplicate stall reports
  - **Leader cycle guard comment clarified**: `cycleRunning` guard comment now explicitly calls out the race between the poll interval and teammate-completion handlers
