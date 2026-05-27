# VALIDATION: Part 2 — Client State Machine

**Validated against**: `src/sync-client.js`, `src/command-sync-session.js`, `src/browser-websocket-transport.js`, `src/offline-transport.js`

**Date**: 2025-05-08

**Verdict**: The proposal's direction is correct, but it contains **12 concrete discrepancies**, **4 missing state transitions**, **2 naming inconsistencies**, and **3 behavioral breaking changes** that consumers must adapt to. The core claim of "7 boolean flags" is accurate.

---

## 1. Boolean Flags Audit

### Claim: "7 boolean flags, 128 combinations"

**Verdict: ACCURATE** — there are exactly 7 boolean-ish state flags.

| # | Flag | Type | Location (sync-client.js) |
|---|------|------|--------------------------|
| 1 | `started` | `boolean` | Line 143 |
| 2 | `connected` | `boolean` | Line 144 |
| 3 | `syncInFlight` | `boolean` | Line 145 |
| 4 | `stopped` | `boolean` | Line 146 |
| 5 | `closed` | `boolean` | Line 147 |
| 6 | `reconnectInFlight` | `boolean` | Line 154 |
| 7 | `submitBatchInFlight` | `null \| object` | Line 158 |

Additional non-boolean state variables the proposal omits:

| Variable | Type | Location | Purpose |
|----------|------|----------|---------|
| `reconnectAttempts` | `number` | Line 155 | Retry counter, 0–∞ |
| `connectedServerLastCommittedId` | `null \| number` | Line 156 | Server state at connect time |
| `lastError` | `null \| object` | Line 153 | Most recent error payload |
| `inboundQueue` | `Promise` | Line 162 | Message serialization queue |
| `draftFlushQueue` | `Promise` | Line 164 | Draft flush serialization |
| `connectWaiters` | `Map` | Line 166 | Pending handshake waiters |
| `localSubmitRejections` | `Map` | Line 168 | Local validation rejection cache |

**Note**: While 2⁷ = 128 is technically the combinatorial space, most combinations are impossible because the code enforces invariants (e.g., `stopped && started` is always false after stopRuntime completes). The "116 invalid" claim is plausible but not verified.

---

## 2. Actual State Graph

Derived by tracing every mutation of the 7 primary flags through the source code:

```
┌─────────────────────────────────────────────────────────────┐
│ INITIAL STATE                                               │
│ started=false, connected=false, syncInFlight=false,         │
│ stopped=false, closed=false, reconnectInFlight=false,       │
│ submitBatchInFlight=null                                     │
└─────────────────────┬───────────────────────────────────────┘
                      │ start()
                      ▼
              ┌──────────────┐
              │  CONNECTING  │ started=T, connected=F
              │  (handshake) │ reconnectInFlight=F
              └──┬───┬───┬───┘
     success     │   │   │  error + reconnect enabled
   (onConnected) │   │   └──────────────────┐
                 │   │                      ▼
                 │   │  error, no reconnect ──► start() throws,
                 │   │                       started reset to F
                 │   │                       → back to INITIAL
                 │   │
                 ▼   │ stop()
          ┌────────┐ │
          │ SYNCING│◄┘  started=T, connected=T,
          │        │    syncInFlight=T
          └──┬──┬──┘
   hasMore   │  │ error/disconnect + reconnect
   (paging)  │  └──────────────────────┐
             │                         ▼
  sync done  │               ┌──────────────┐
             ▼               │ RECONNECTING │ reconnectInFlight=T
          ┌────────┐         │              │ reconnectAttempts=N
          │ READY  │         └──┬───┬───┬───┘
          │        │   success   │   │   │  exhausted
          └──┬──┬──┘ (onConnected┘   │   └──────┐
      submit │  │  handshake)        │          ▼
      events │  │ stop()             │   ┌─────────────┐
              │  ▼                    │   │DISCONNECTED │ started=T,
              │  INITIAL              │   │ (exhausted) │ connected=F,
              ▼                       │   │             │ reconnectInFlight=F
        ┌────────────┐                │   └──┬──────────┘
        │ SUBMITTING │                │      │ stop()
        │            │                │      ▼
        │ submitBatch │               │   INITIAL
        │ InFlight≠null              │
        └──┬──┬──┬───┘               │
   success  │  │  error/disconnect    │
            │  │  + reconnect ────────┘
            │  │
            │  │ stop()
            ▼  ▼
          INITIAL

  ANY STATE ──── close() ────► CLOSED (permanently)
```

### Key transitions the proposal omits or misrepresents:

1. **SYNCING → RECONNECTING**: When transport fails mid-sync. The proposal diagram only shows disconnect from READY.
2. **SUBMITTING → RECONNECTING**: When transport fails mid-submit. Same issue.
3. **CONNECTING → back to INITIAL** (no reconnect): `start()` throws and resets `started=false`. The proposal shows `any → IDLE (via stop)` but doesn't model the start-failure-no-reconnect path.
4. **DISCONNECTED → stop() → INITIAL**: After reconnect exhaustion, the user must `stop()` then `start()` to retry. The proposal says `any → IDLE (via stop)` which covers this, but DISCONNECTED→stop→start→CONNECTING is a critical recovery path that should be explicit.

---

## 3. Proposed 8-State FSM vs Reality

### 3.1 State Coverage

| Proposed State | Maps to Actual Flags | Accurate? |
|---------------|---------------------|-----------|
| `idle` | `!started && !closed` | **MOSTLY** — conflates "never started" with "stopped after running" |
| `connecting` | `started && !connected && !reconnectInFlight` | **YES** |
| `syncing` | `connected && syncInFlight && !submitBatchInFlight` | **YES** |
| `ready` | `connected && !syncInFlight && !submitBatchInFlight` | **YES** |
| `submitting` | `connected && submitBatchInFlight !== null` | **YES** — note: implies `!syncInFlight` because flush only runs when `!syncInFlight` (line 341) |
| `reconnecting` | `started && !connected && reconnectInFlight` | **YES** |
| `disconnected` | `started && !connected && !reconnectInFlight && !stopped` | **PARTIAL** — see below |
| `closed` | `closed === true` | **YES** |

### 3.2 Missing States

**None critical**, but one nuance:

- **"Error-idle"**: When `start()` fails with `reconnect: { enabled: false }`, the client returns to `started=false`. This is "idle" in the FSM, but an `lastError` is set. The proposal's `ClientStatus` does not carry `lastError`, so consumers cannot distinguish "fresh idle" from "error-idle".

### 3.3 Incorrect Transitions in the Proposal

The proposal diagram shows:
```
READY ⇄ SUBMITTING
     ↓ disconnect
RECONNECTING → DISCONNECTED
```

**Problems:**

1. **Disconnect only shown from READY**: The `↓ disconnect` arrow should originate from **SYNCING**, **READY**, and **SUBMITTING** — all three can experience transport failure. The actual code calls `handleTransportFailure()` from sync (line 607-608), submit flush (line 396-408), and error handlers (line 524-556, 757-764).

2. **CONNECTING → RECONNECTING is missing from diagram**: The text says `IDLE → HANDSHAKE → SYNCING` but doesn't show what happens when the handshake fails with reconnect enabled. In the code, `start()` catch block (line 994-1000) calls `handleTransportFailure` with `reconnectAllowed: reconnectPolicy.enabled`, which triggers `runReconnectLoop`.

3. **Auth failure path**: When the server sends `auth_failed` or `protocolVersion_unsupported` (line 752-756), `handleTransportFailure` is called with `reconnectAllowed: false`. This transitions directly to DISCONNECTED (not RECONNECTING), bypassing the reconnect loop entirely. The proposal does not distinguish this from transport-disconnect.

4. **server_error reconnect**: When the server sends `server_error` (line 757-758), reconnect IS allowed (`reconnectPolicy.enabled && payload.code === "server_error"`). So SYNCING/READY/SUBMITTING → RECONNECTING on server_error. The proposal doesn't call out this server-initiated disconnect path.

---

## 4. ClientStatus Type Validation

### Proposed type:
```ts
type ClientStatus =
  | { state: "idle" }
  | { state: "connecting" }
  | { state: "syncing" }
  | { state: "ready" }
  | { state: "submitting" }
  | { state: "reconnecting"; attempt: number; nextRetryInMs: number }
  | { state: "disconnected" }
  | { state: "closed" };
```

### Missing from proposed ClientStatus (currently in getStatus()):

| Field | Current Location | Consumer Impact |
|-------|-----------------|-----------------|
| `connectedServerLastCommittedId` | Line 1046-1057 | Consumers use this to know server progress. **Missing from proposal.** |
| `activeProjectId` | Line 1055 | Useful for multi-project UI. **Missing from proposal.** |
| `lastError` | Line 1056 | The only way consumers currently know about auth failures, validation errors, etc. **Missing from SyncClient's proposed interface entirely** — only on CommandSyncSession. |
| `syncInFlight` | Line 1051 | Exposed in current getStatus(). Would be encoded in state="syncing" but consumers that check this directly would break. |
| `reconnectAttempts` | Line 1053 | Partially covered by `reconnecting.attempt`, but lost in all other states. |
| `stopped` | Line 1048 | Distinguishes "never started" from "stopped". Lost in proposal. |

### Specific issues:

1. **`reconnecting.nextRetryInMs` is a static snapshot, not a live timer**: The code computes `computeReconnectDelayMs(reconnectAttempts)` (line 450-459) once per attempt and sleeps for that duration (line 495). There is no continuously-updated countdown. The proposal's `nextRetryInMs` field implies a live value that ticks down, which doesn't exist. It should be documented as a snapshot.

2. **`disconnected` state lacks exhaustion info**: When reconnect exhausts, the consumer needs to know `maxAttempts` was reached. The proposal's `{ state: "disconnected" }` is a bare type. Should include `{ reason: "reconnect_exhausted" | "auth_failed" | "transport_failed" }` and potentially the `lastError`.

3. **Naming inconsistency**: The FSM diagram uses `HANDSHAKE` (line 162 of plan) but the type uses `connecting` (line 192 of plan). Should be consistent.

---

## 5. SubmitResult Type Validation

### Proposed type:
```ts
type SubmitResult =
  | { id: string; status: "committed"; committedId: number; serverTs: number }
  | { id: string; status: "queued" }
  | { id: string; status: "rejected"; reason: string; message: string };
```

### Current behavior (lines 824-951):

- `submitEvents(inputs)` → `Promise<string[]>` (returns draft IDs synchronously)
- `submitEvent(input)` → `Promise<string>` (returns single draft ID)
- The committed/rejected result comes **asynchronously** via `emit("committed", result)` / `emit("rejected", result)` / `emit("not_processed", result)`

### Critical discrepancies:

1. **⛔ MAJOR BEHAVIORAL CHANGE — synchronous vs asynchronous results**: The proposal implies `submitEvent` returns a `SubmitResult` that includes "committed" or "rejected". Currently, the function **always returns the draft ID synchronously** and the actual server response comes later via events. Making `submitEvent` block until the server responds would fundamentally change the latency profile and error handling model.

   If the proposal intends `submitEvent` to return immediately with `{ status: "queued" }` when offline and resolve to the final status when online, that's a different model entirely — the current code never blocks on submit.

2. **Missing `not_processed` status**: The server can return `status: "not_processed"` (line 667-676) when a prior item in the batch failed. This is a distinct status that the proposal completely omits. It includes `reason` and `blockedById` fields.

3. **Missing `errors` array on rejected**: The current local rejection result (line 271-277) uses `errors: [{ message }]` (an array), but the proposal uses a single `message: string`. The server's rejection format also uses `errors` array. This is a structure mismatch.

4. **`serverTs` on committed**: The proposal adds `serverTs` which is not currently in the `committed` result from the server. The committed result includes `committedId` and `id` but no explicit `serverTs`. This would require server-side changes or be a new field.

5. **Batch atomicity mismatch**: Currently, `submitEvents` inserts all drafts then flushes. If one draft in a batch is oversized, it's rejected locally but the rest proceed (line 356-371 in `runFlushDraftQueue`). The proposal's `SubmitResult[]` return type implies per-item results, but the current behavior rejects oversized items asynchronously via `rejectDraftLocally`.

---

## 6. SyncClient Interface Validation

### Proposed interface:
```ts
interface SyncClient {
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  submitEvent(input: EventInput): Promise<SubmitResult>;
  submitEvents(inputs: EventInput[]): Promise<SubmitResult[]>;
  syncNow(options?: { sinceCommittedId?: number }): Promise<void>;
  flushDrafts(): Promise<void>;
  getStatus(): ClientStatus;
  onStatusChange(handler: (status: ClientStatus) => void): Unsubscribe;
  getPendingDraftCount(): number;
  getPendingDrafts(): Promise<DraftItem[]>;
}
```

### Current public API (lines 969-1059):

```js
{
  start(),
  stop(),
  close(),
  submitEvents(inputs),   // → Promise<string[]>
  submitEvent(input),     // → Promise<string>
  syncNow(options),
  flushDrafts(),
  getStatus(),            // → raw object
}
```

### Missing from proposed interface:

| Method/Feature | Current Location | Notes |
|---------------|-----------------|-------|
| `onEvent` callback | Constructor dep, line 50 | **The primary event delivery mechanism.** Consumers receive "committed", "rejected", "not_processed", "broadcast", "synced", "error" events via this callback. The proposal has NO replacement. `onStatusChange` only covers lifecycle, not domain events. |

### Methods that change signature:

| Method | Current Return | Proposed Return | Breaking? |
|--------|---------------|----------------|-----------|
| `submitEvent(input)` | `Promise<string>` | `Promise<SubmitResult>` | **YES** — consumers expecting a string ID will break |
| `submitEvents(inputs)` | `Promise<string[]>` | `Promise<SubmitResult[]>` | **YES** — same issue |
| `getStatus()` | raw object with 10 fields | `ClientStatus` discriminated union | **YES** — all consumers of individual fields break |

### New methods (not currently available):

| Method | Notes |
|--------|-------|
| `onStatusChange(handler)` | Good addition. Currently consumers must poll `getStatus()`. |
| `getPendingDraftCount()` | Currently requires direct store access. Good addition. |
| `getPendingDrafts()` | Currently requires direct store access. Good addition. |

### Constructor signature changes:

The proposal shows:
```js
const client = createSyncClient({
  transport,
  store,
  token: "jwt",
  clientId: "C1",
  projectId: "workspace-1",
  reconnect: true,  // ← just true
});
```

**Issue**: Currently, `reconnect` defaults to `{}` (line 80), and `reconnectPolicy.enabled` requires `reconnect.enabled === true` (line 109). Passing `reconnect: true` would set `reconnect.enabled` to `undefined` (since `true.enabled` is `undefined`), making the policy **disabled**. The proposal's `reconnect: true` shorthand would not work with the current code — it requires changing how `reconnect` is normalized.

---

## 7. CommandSyncSession Validation

### Current API (lines 223-278 of command-sync-session.js):

```js
{
  start(),
  stop(),
  close(),
  submitCommands(commands),
  submitEvents(inputs),
  submitEvent(input),
  syncNow(options),
  flushDrafts(),
  setOnlineTransport(transport),  // ← NOT in proposal
  getActor(),                      // ← NOT in proposal
  getStatus(),
  getLastError(),
  clearLastError(),
}
```

### Missing from the proposed CommandSyncSession:

| Method | Location | Notes |
|--------|----------|-------|
| `setOnlineTransport(transport)` | Line 260-267 | **Critical for offline-first consumers.** This delegates to the offline-transport's `setOnlineTransport()` (line 251 of offline-transport.js). The proposal has no equivalent. |
| `setOffline()` | N/A (on offline-transport) | `offline-transport.js` line 264-274 exposes `setOffline()`. Session doesn't proxy it, but it's part of the offline lifecycle. |
| `getActor()` | Line 269 | Returns the actor identity. Not in proposal. |
| `submitEvent(input)` | Line 246-250 | Direct event submission passthrough. Not in proposed interface. |
| `submitEvents(inputs)` | Line 238-244 | Batch event submission passthrough. Not in proposed interface. |
| `clearLastError()` | Line 275-277 | In proposal ✅ |

### Session-specific concerns:

1. **`swallowTransportDisconnect` behavior**: The session catches transport disconnect errors in `submitCommands` (line 212-220) and returns IDs anyway, making it appear successful when offline. The proposal's `CommandResult` with `status: "queued"` would be the proper replacement, but this behavioral change must be documented.

2. **Dedup via `appliedEventIds`**: The session maintains a 5000-entry dedup set (line 81-91, 127-128). The proposal's ViewDefinition system doesn't address this — it's orthogonal to projections. The session's dedup is for preventing duplicate `onCommittedCommand` callbacks.

3. **Error tracking**: The session tracks `lastError` from multiple sources (line 108-119, 160-176). The proposal's `getLastError()` / `clearLastError()` matches this well.

---

## 8. Transport Interface Validation

### Current transport interface (used in sync-client.js):

```ts
interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: object): Promise<void>;
  onMessage(handler: (message: object) => void): () => void;
}
```

### OfflineTransport extras (lines 116-282 of offline-transport.js):

```ts
{
  setOnlineTransport(transport): Promise<void>;
  setOffline(): Promise<void>;
  getState(): { connected, online, waitingForOnlineConnected, bufferedSubmitCount };
}
```

### Proposal's transport:
```ts
interface Transport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: unknown): Promise<void>;
  onMessage(handler: (message: unknown) => void): Unsubscribe;
  setLogger?(logger: Logger): void;
}
```

**Issue**: The proposal's transport interface does not account for `setOnlineTransport` / `setOffline` / `getState` on the offline transport. These are used by `command-sync-session.js` (line 260-267). If these are removed from the transport interface, the offline-first pattern breaks unless the proposal provides an alternative.

---

## 9. Complete List of Discrepancies

### 🔴 Critical (would break consumers)

| # | Issue | Location |
|---|-------|----------|
| C1 | `submitEvent` / `submitEvents` return type changes from `string`/`string[]` to `SubmitResult`/`SubmitResult[]` | sync-client.js:1030-1034 |
| C2 | No replacement for `onEvent` callback — consumers lose "committed", "rejected", "broadcast", "synced", "not_processed" events | sync-client.js:50, 172 |
| C3 | Missing `not_processed` status in `SubmitResult` — server returns this (line 667) | sync-client.js:667-676 |
| C4 | `setOnlineTransport()` missing from proposed CommandSyncSession — breaks offline-first consumers | command-sync-session.js:260-267 |
| C5 | `reconnect: true` shorthand won't work — code requires `reconnect: { enabled: true }` | sync-client.js:80, 109 |

### 🟡 Significant (missing information or wrong assumptions)

| # | Issue | Location |
|---|-------|----------|
| S1 | `lastError` not available on SyncClient (only on CommandSyncSession) | sync-client.js:1056 |
| S2 | `connectedServerLastCommittedId` missing from proposed ClientStatus | sync-client.js:1046-1057 |
| S3 | `activeProjectId` missing from proposed ClientStatus | sync-client.js:1055 |
| S4 | FSM diagram shows disconnect only from READY — should include SYNCING and SUBMITTING | sync-client.js:607, 396-408 |
| S5 | Auth failure / protocolVersion_unsupported path bypasses RECONNECTING → goes straight to DISCONNECTED | sync-client.js:752-756 |
| S6 | `reconnecting.nextRetryInMs` is a static snapshot, not a live countdown | sync-client.js:450-459 |
| S7 | Proposal rejects use `message: string` but actual code uses `errors: [{ message }]` array | sync-client.js:271-277 |
| S8 | `disconnected` state lacks reason (exhausted vs auth_failed vs transport_failed) | sync-client.js:480-485, 752-756 |

### 🟢 Minor (naming, documentation, or cosmetic)

| # | Issue | Location |
|---|-------|----------|
| M1 | FSM diagram says `HANDSHAKE`, type says `connecting` — inconsistent naming | Plan lines 162 vs 192 |
| M2 | `getActor()` missing from proposed CommandSyncSession | command-sync-session.js:269 |
| M3 | `submitEvent` / `submitEvents` passthrough missing from proposed CommandSyncSession | command-sync-session.js:238-250 |
| M4 | Offline transport's `getState()` / `setOffline()` not addressed in proposal | offline-transport.js:264-282 |
| M5 | `stopped` flag distinguishability lost in proposal's `idle` state | sync-client.js:1048 |

---

## 10. Recommendations

1. **Add `onEvent` or equivalent event system to the SyncClient interface.** The proposed `onStatusChange` covers lifecycle but not domain events. Options:
   - Keep `onEvent` callback
   - Add specific listeners: `onCommitted`, `onRejected`, `onBroadcast`, `onSynced`
   - Or make `submitEvent` truly async (blocking until server responds) — but this changes the fundamental model

2. **Add `not_processed` to `SubmitResult`**:
   ```ts
   | { id: string; status: "not_processed"; reason: string; blockedById: string }
   ```

3. **Add `lastError` to `ClientStatus`** or add `getLastError()` / `clearLastError()` to SyncClient (not just CommandSyncSession).

4. **Add `reason` to the `disconnected` state**:
   ```ts
   | { state: "disconnected"; reason: "reconnect_exhausted" | "auth_failed" | "transport_failed" | "protocol_error" }
   ```

5. **Fix the FSM diagram** to show disconnect transitions from SYNCING, READY, and SUBMITTING, and show the auth-failure bypass path.

6. **Document whether `submitEvent` is synchronous or asynchronous** — this is the single biggest behavioral ambiguity in the proposal.

7. **Preserve `setOnlineTransport`** in the CommandSyncSession or provide an equivalent mechanism for offline-first workflows.

8. **Fix `reconnect: true` handling** — the code needs to accept `boolean | object`:
   ```js
   const resolvedReconnect = reconnect === true ? { enabled: true } : reconnect;
   ```

9. **Add `connectedServerLastCommittedId` and `activeProjectId`** to `ClientStatus` (or document that they're intentionally omitted and explain the alternative).

10. **Unify the `rejected` error shape** — decide between `message: string` and `errors: Array<{ message: string }>`.
