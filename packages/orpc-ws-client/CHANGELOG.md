# @orpc-ws/client

## 0.4.0

### Patch Changes

- @orpc-ws/shared@0.4.0

## 0.3.0

### Patch Changes

- @orpc-ws/shared@0.3.0

## 0.2.1

### Patch Changes

- @orpc-ws/shared@0.2.1

## 0.2.0

### Patch Changes

- @orpc-ws/shared@0.2.0

## 0.1.2

### Patch Changes

- 9e44221: Fix heartbeat teardown under partysocket 1.2.0. Terminal teardown (`dispose()`, terminal auth failure, and session-replace/kick) no longer emits a spurious `auth_failure{refreshable:true}` or a transient `disconnected{willRetry:true}` frame before the terminal state, and no longer surfaces an unhandled WebSocket "not open" error during teardown. The heartbeat subscriber's stop is now split into `abort()` (open-socket) vs `drop()` (closed-socket, letting orpc's own close-listener clean up framelessly), driven by the lifecycle layer.

  Also refreshes the underlying dependencies across the `@orpc-ws/*` family: `@orpc/*` → 1.14.6 and `partysocket` → 1.2.0.

  - @orpc-ws/shared@0.1.2
