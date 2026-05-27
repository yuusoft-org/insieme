# VALIDATION REPORT: Parts 4-6 — Error Hierarchy, Transport, Server Interface + Cross-Cutting

**Validated against:** Full src/ codebase

---

## Error Code Catalog

Every error code found in the source, organized by component:

### Server-side error codes (sync-server.js)
| Code | Where used | Context |
|---|---|---|
| `bad_request` | Lines 47, 62, 298, 326, 348, 465, 476, 489, 499, 766, 809, 888, 905, 915, 947, 976 | Malformed messages |
| `auth_failed` | Lines 235, 364, 376, 453, 754 | Authentication failures |
| `forbidden` | Lines 390, 605, 633, 646, 657, 793 | Authorization failures |
| `validation_failed` | Lines 562, 570, 578, 599, 613, 621, 640, 680, 685, 718, 723 | Event validation |
| `rate_limited` | Line 273 | Rate limit exceeded |
| `message_too_large` | Line 298 | Envelope size exceeded |
| `protocolVersion_unsupported` | Lines 931, 938 | Bad protocol version |
| `server_error` | Line 1020 | Unhandled server error |
| `submit_batch_too_large` | Not in server — only in client line 281 | Client-side limit |

### Client-side error codes (sync-client.js, command-sync-session.js)
| Code | Where used | Context |
|---|---|---|
| `transport_disconnected` | sync-client.js:96, 401; command-sync-session.js:13, 216 | Transport closed |
| `transport_connect_failed` | sync-client.js:995 | Connection failed |
| `transport_send_failed` | sync-client.js:402 | Send failed |
| `submit_batch_too_large` | sync-client.js:281 | Too many events in one submit |
| `resource_closed` | store-errors.js:3 | Operation on closed resource |

### Store error codes
| Code | Where used | Context |
|---|---|---|
| `validation_failed` | sqlite-sync-store.js:283, libsql-sync-store.js:271, in-memory-sync-store.js:47 | Store-level validation |
| `resource_closed` | store-errors.js:3 (used by all stores via throwIfClosed) | Operation on closed store |

### Error messages (plain Error, no code)
All stores throw plain `new Error(...)` with string messages for:
- Schema incompatibility: "Client store schema is incompatible; reset required"
- Invalid schema version: "expected schema version X, found Y"
- Missing table/column: Various
- Materialized view: "unknown materialized view 'X'"
- Reducer: "no handler registered for 'X'"
- IndexedDB: "draft with id X already exists"
- SQLite: "commit insert succeeded but row was not readable"
- LibSQL: Same as SQLite

---

## Validation of Proposed Error Hierarchy

### What the proposal says:

```ts
class InsiemeError extends Error { code: string; details: Record<string, unknown>; }
class TransportError extends InsiemeError { code: "transport_disconnected" | "transport_connect_failed" | "transport_send_failed" }
class AuthError extends InsiemeError { code: "auth_failed" | "forbidden" }
class ValidationError extends InsiemeError { code: "validation_failed" | "bad_request" }
class SyncError extends InsiemeError { code: "sync_failed" | "protocol_error" }
class StoreError extends InsiemeError { code: "store_closed" | "store_init_failed" | "schema_version_mismatch" | "busy_timeout" | "corrupt_history"; }
class ReplayError extends InsiemeError { code: "replay_failed"; details: {...}; }
```

### Discrepancies

| Issue | Severity | Details |
|---|---|---|
| **Missing `rate_limited`** | HIGH | Server sends `rate_limited` error code. No proposed class covers it. Should be a `RateLimitError` or under `SyncError`. |
| **Missing `message_too_large`** | HIGH | Server sends `message_too_large` error code. Not covered. Should be under `ValidationError` or a new `ResourceLimitError`. |
| **Missing `server_error`** | MEDIUM | Server sends `server_error` on unhandled exceptions. This is an important signal to consumers. |
| **`submit_batch_too_large` missing** | MEDIUM | Client uses this code. Not covered. |
| **`protocolVersion_unsupported` mapped to `SyncError.protocol_error`** | WRONG | This is actually a handshake failure, not a sync error. It's closer to `TransportError`. |
| **`sync_failed` and `protocol_error` don't exist in current code** | LOW | The proposal invents codes that don't exist yet. Not wrong, but speculative. |
| **`store_closed` vs `resource_closed`** | MEDIUM | Current code uses `resource_closed` via store-errors.js. The proposal renames to `store_closed`. Breaking change. |
| **`replay_failed` doesn't exist in current code** | OK | Good forward-looking addition for the projections feature. |
| **`busy_timeout` and `corrupt_history` don't exist** | OK | Good forward-looking additions for robustness. |
| **No `details` on most current errors** | MEDIUM | Proposal adds `details: Record<string, unknown>` but most current errors have no details. Would need to be populated retroactively. |
| **Server errors are sent over the wire as plain JSON** | CRITICAL | The error hierarchy is only useful client-side. Server errors are serialized to `{ code, message, details }` JSON — the consumer receives a plain object, NOT an Error subclass. The proposal doesn't address how to reconstruct typed errors from wire format. |

### Verdict

The hierarchy direction is correct. But:
1. **Missing 4 existing error codes** (rate_limited, message_too_large, server_error, submit_batch_too_large)
2. **Wire reconstruction is unaddressed** — this is the hardest part and the proposal skips it
3. **`resource_closed` → `store_closed` rename** is an unnecessary breaking change for consumers who check `.code`

---

## Validation of Transport Interface (Part 5)

The proposal adds `setLogger?(logger: Logger): void` to the Transport interface.

**Current transport methods** (from browser-websocket-transport.js, offline-transport.js):
- `connect()` ✅
- `disconnect()` ✅  
- `send(message)` ✅
- `onMessage(handler)` ✅
- `setLogger(logger)` — **Already exists** in browser-websocket-transport.js (line ~50)!

**Verdict:** The `setLogger` proposal is correct but redundant — it already exists in at least one transport. Should verify all transports.

---

## Validation of Server Interface (Part 6)

The proposal adds `getStats()` returning `{ activeConnections, activeProjects, totalCommittedEvents }`.

**Current server interface:**
- `attachConnection(transport)` → `{ receive, close }`
- `shutdown()` → void

**ws-server-runtime already has:**
- `getActiveConnections()` — returns number
- `closeAllConnections(reason)` 
- `detach()`

**Verdict:**
- `activeConnections` is already tracked in runtime. Don't duplicate.
- `activeProjects` would need to be tracked in sync-server (the projectSessions index from P1 would give this for free).
- `totalCommittedEvents` is expensive to compute (requires COUNT query). Should be a gauge that increments, not a query.
- The proposal should clarify: this goes on `createSyncServer` return, NOT on runtime. They're different objects.

---

## Validation of Implementation Phase Ordering

The proposal says:
1. Phase 1: Storage unification
2. Phase 2: State machine + errors
3. Phase 3: Projections
4. Phase 4: Server observability
5. Phase 5: TypeScript

### Hidden Dependencies Found

| Dependency | Impact |
|---|---|
| **Phase 2 depends on Phase 1** | The FSM needs the new store's `applySubmitResult` to return `SubmitResult` with "queued"/"committed". Currently the old stores don't return this. Phase 2 CAN'T be done first. |
| **Phase 3 depends on Phase 1** | The projection engine needs the new store's checkpoint methods. Currently checkpoints are store-specific. Phase 3 requires unified checkpoint interface. |
| **Phase 3 also depends on Phase 2** | `CommandSyncSession.getView()` needs the FSM to know if we're synced. The session proxies status from the client FSM. |
| **Phase 5 should be Phase 1** | TypeScript should come FIRST, not last. Writing interfaces in `.ts` first would catch type errors in all subsequent phases. Converting to TS at the end means all intermediate code is untyped. |
| **Server fixes (backend plan) are independent** | The 4 fatal bugs and 6 perf killers can be done at any point. They don't depend on client-side changes. They SHOULD be done first because they fix actual bugs. |

### Recommended Order

```
Phase 0: Fix fatal server bugs (F1-F4) — 1-2 days, immediate production fix
Phase 1: TypeScript conversion — 2-3 days, foundation for everything else
Phase 2: Storage unification — 5-7 days, biggest code reduction
Phase 3: Server performance (P1-P6) — 3-5 days, needs storage done for batch commit
Phase 4: Client FSM + error hierarchy — 3-5 days, needs new store interface
Phase 5: Projections — 5-7 days, needs FSM + unified store
Phase 6: Scalability (Redis, sharding) — 10-15 days, optional, for scale
```

---

## Summary of All Validation Findings Across All 5 Reports

### Critical Issues in Proposals (must fix before implementing)

1. **`onEvent` callback missing from client FSM proposal** — consumers rely on it for ALL event notifications (VALIDATION-2)
2. **P3 backpressure fix is wrong** — `ws` library doesn't emit `drain` event (VALIDATION-3)
3. **P5 canonicalization fix breaks correctness** — dedup comparison requires canonical form (VALIDATION-3)
4. **Wire error reconstruction unaddressed** — server errors are JSON, not Error subclasses (this report)
5. **`reduce` signature wrong in projection proposal** — uses object args, not positional (VALIDATION-4)
6. **`blockedById` blocks all subsequent events after store error** — F2 fix introduces new bug (VALIDATION-3)

### Significant Issues (should fix)

7. 5 public store methods missing from proposed ClientStore interface (VALIDATION-1)
8. Schema management completely unaddressed in adapter interface (VALIDATION-1)
9. Persisted cursor store should stay as decorator, not absorbed (VALIDATION-1)
10. Checkpoint modes wrong in projection proposal (VALIDATION-4)
11. Line count estimates consistently optimistic by 10-20% (VALIDATION-1)
12. `submitEvent` return type change would break consumers (VALIDATION-2)
13. `resource_closed` → `store_closed` rename is unnecessary breakage (this report)
14. `syncInProgress` stuck forever on error should be F5 (VALIDATION-3)
15. No maximum batch size on server — DoS vector (VALIDATION-3)
