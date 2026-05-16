# RouteVN Consumer Pain Points — Insieme Integration Review

**Date:** 2026-05-08  
**Consumer:** RouteVN Creator Client (Tauri desktop + Web)  
**Reviewer:** Automated analysis of consumer integration code  
**Files analyzed:** 12 consumer files + 3 library files (~18K lines total)

---

## Executive Summary

RouteVN's integration with Insieme reveals significant friction across six categories. The consumer had to write **over 3,000 lines of adapter/defensive code** to compensate for gaps in Insieme's abstractions. The most critical pain points are:

1. **SQLite locking and WAL management** — an entire subsystem the consumer built from scratch (~300 lines)
2. **Manual operation queuing** — serialized write chains that duplicate what the library should handle
3. **Projection/materialized view complexity** — scene partitions, replay recovery, and checkpoint validation are all consumer-side
4. **No offline-first state machine** — the consumer duct-tapes disconnect handling, draft persistence, and reconnect
5. **Error handling invented from whole cloth** — replay error diagnostics, bootstrap history validation, duplicate-create tolerance

---

## 1. Boilerplate the Consumer Had to Write

### 1.1 Transport Logger Adapter (~107 lines)

**File:** `web/collab/createWebSocketTransport.js`

The consumer wraps `createBrowserWebSocketTransport` just to map internal transport events to their own logger interface:

```js
// createWebSocketTransport.js — 84-line event mapper
const mapTransportEvent = (entry = {}) => {
  const event = entry?.event;
  switch (event) {
    case "connect_attempt":
      return { level: "info", message: "connect attempt", meta: {} };
    case "connected":
      return { level: "info", message: "connected", meta: {} };
    // ... 10 more cases
  }
};
```

**Proposal:** Insieme should accept a `logger` object with standard `log/info/warn/error` methods directly, mapping internally. The transport should not require a consumer-written logging adapter.

### 1.2 Command Mapper Wrapper (~39 lines)

**File:** `shared/collab/mappers.js`

The consumer wraps Insieme's `commandToSyncEvent` and `committedSyncEventToCommand` just to:
- Normalize `schemaVersion` against their own `COMMAND_EVENT_MODEL`
- Strip unexpected envelope fields via `normalizeCommandEnvelope`

```js
export const commandToSyncEvent = (command) => {
  return mapCommandToSyncEvent(command, {
    defaultSchemaVersion:
      normalizeSchemaVersion(command?.schemaVersion) ??
      COMMAND_EVENT_MODEL.schemaVersion,
  });
};

export const committedEventToCommand = (committedEvent) => {
  const command = committedSyncEventToCommand(committedEvent);
  if (!command) return null;
  return normalizeCommandEnvelope(command);  // strips unknown fields
};
```

**Proposal:** Insieme should accept a `schemaVersion` config on the session and provide a field-filtering option or `allowedEnvelopeFields` config to avoid manual envelope normalization.

### 1.3 Collab Service Wrapper (~150 lines)

**File:** `shared/collab/createProjectCollabService.js`

Nearly all methods are pass-throughs that add minimal value:

```js
return {
  async start() { await session.start(); },
  async stop() { await session.stop(); },
  async submitCommand(command) { /* wraps submitCommands([command]) */ },
  async submitCommands(commands) { return submitValidatedCommands(commands); },
  async submitEvent(input) { return session.submitEvent(input); },
  async syncNow(options = {}) { await session.syncNow(options); },
  async flushDrafts() { await session.flushDrafts(); },
  getStatus() { return session.getStatus(); },
  getLastError() { /* merges local + session error */ },
  // ...
};
```

The only real additions are:
- Error normalization (`createSubmitErrorResult`)
- Fallback `commandIds` when the session doesn't return them
- A local `lastError` that shadows the session's

**Proposal:** Insieme should provide built-in error normalization, guarantee return of command IDs, and expose a unified error state so consumers don't need a wrapper at all.

### 1.4 IndexedDB Store Wrapper (~73 lines)

**File:** `web/collabClientStore.js`

The consumer wraps `createIndexedDbClientStore` just to:
- Build a versioned DB name
- Add database deletion with retries (3 attempts, 50ms backoff)
- Log initialization

```js
const deleteDatabaseOnce = (name) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (result) => { if (settled) return; settled = true; resolve(result); };
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => finish(true);
    request.onerror = () => finish(false);
    request.onblocked = () => finish(false);  // silently gives up on blocked!
  });
```

**Proposal:** Insieme's IndexedDB store should expose a `delete()` / `reset()` method with built-in retry logic and blocked-handle handling.

---

## 2. SQLite Workarounds

### 2.1 Custom Lock Retry System (~80 lines)

**File:** `internal/sqliteLocking.js`

The consumer built an entire SQLite lock retry subsystem because Insieme's libsql store doesn't handle `SQLITE_BUSY` errors:

```js
export const SQLITE_BUSY_TIMEOUT_MS = 15000;
const SQLITE_LOCK_RETRY_DELAYS_MS = [80, 160, 320, 640, 1000, 1500];

export const isSqliteLockError = (error) => {
  if (error.code === 5 || error.code === "SQLITE_BUSY") return true;
  const message = String(error?.message ?? error).toLowerCase();
  return (
    message.includes("database is locked") ||
    message.includes("database busy") ||
    message.includes("database is busy") ||
    message.includes("sqlite_busy") ||
    message.includes("sqlite_locked") ||
    message.includes("code: 5")
  );
};

export const withSqliteLockRetry = async (operation, opts = {}) => {
  const delays = Array.isArray(opts.retryDelaysMs) ? opts.retryDelaysMs : [];
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (opts.shouldRecoverError?.(error)) return opts.recoverValue;
      if (!isSqliteLockError(error) || attempt >= delays.length) throw error;
      opts.onRetry?.({ attempt: attempt + 1, delayMs: delays[attempt], error });
      await wait(delays[attempt]);
      attempt += 1;
    }
  }
};
```

This is used everywhere in the Tauri store: `runSelect`, `runExecute`, `executeTauriSqlStatement`.

**Proposal:** Insieme's `createLibsqlClientStore` should accept a `retry` configuration (delays, max attempts, error pattern matching) and handle SQLITE_BUSY internally. The store should be resilient to concurrent access patterns out of the box.

### 2.2 "No Active Transaction" Recovery

**File:** `tauri/collabClientStore.js` lines 274-303

The consumer discovered that Tauri's `plugin-sql` doesn't guarantee a pinned connection across JS-issued `BEGIN/COMMIT` batches, causing "no transaction is active" errors on COMMIT. They built a special recovery path:

```js
const isSqliteCommitStatement = (sql) =>
  /^COMMIT\b/.test(String(sql ?? "").trim().toUpperCase());

export const executeTauriSqlStatement = async ({ db, sql, args = [], ... }) => {
  return withSqliteLockRetry(
    () => db.execute(sql, resolvedArgs),
    isSqliteCommitStatement(sql)
      ? {
          shouldRecoverError: (error) => isSqliteNoActiveTransactionError(error),
          recoverValue: { rowsAffected: 0 },  // silently swallow!
        }
      : {},
  );
};
```

**Proposal:** Insieme's libsql store should detect and handle "no active transaction" errors internally — either by using savepoints, by catching and gracefully resolving, or by not relying on multi-statement transactions across unpinned connections.

### 2.3 WAL Checkpoint Management (~120 lines)

**File:** `tauri/collabClientStore.js` lines 506-618

The consumer built an entire WAL checkpoint management system with:
- Throttled checkpoint scheduling (10s via RxJS `throttleTime`)
- Retry on busy checkpoints (10s delay)
- TRUNCATE checkpoint on close
- Dirty flag tracking
- Subscription lifecycle management

```js
let walDirty = false;
let storeClosed = false;
const walCheckpointRequests = new Subject();
const WAL_CHECKPOINT_THROTTLE_MS = 10000;
const WAL_CHECKPOINT_RETRY_MS = 10000;

const checkpointWal = async (mode = "PASSIVE") => {
  const result = await runSelectNoRetry(`PRAGMA wal_checkpoint(${checkpointMode})`);
  return parseWalCheckpointResult(result);
};

const flushWalIfNeeded = async () => {
  if (!walDirty) return;
  const passiveCheckpoint = await checkpointWal("PASSIVE");
  if (!passiveCheckpoint.complete) {
    scheduleWalCheckpointRetry();  // retry in 10s
    return;
  }
  walDirty = false;
};

// On close:
await store.flushMaterializedViews();
const truncateCheckpoint = await checkpointWal("TRUNCATE");
if (!truncateCheckpoint.complete) {
  console.warn("SQLite WAL truncate checkpoint did not complete");
}
```

Plus 35 lines of `parseWalCheckpointResult` to interpret the PRAGMA output.

**Proposal:** Insieme's SQLite-based stores should manage WAL checkpointing internally with configurable policy (aggressive/passive/on-close). The consumer should not need to know about WAL at all.

### 2.4 Manual Operation Queue (~50 lines)

**File:** `tauri/collabClientStore.js` lines 484-600

The consumer serializes ALL store operations through a Promise chain to avoid SQLite concurrent access:

```js
let operationQueue = Promise.resolve();
const queueStoreOperation = async (labelOrOperation, maybeOperation) => {
  const operation = typeof labelOrOperation === "function" ? labelOrOperation : maybeOperation;
  const nextOperation = operationQueue.then(async () => operation());
  operationQueue = nextOperation.catch(() => {});
  return nextOperation;
};

// Every single store method is wrapped:
async loadCursor() {
  return queueStoreOperation("loadCursor", () => store.loadCursor());
},
async insertDraft(payload) {
  return queueWriteOperation("insertDraft", () => store.insertDraft(payload));
},
// ... 15 more methods
```

Every store method — `init`, `loadCursor`, `insertDraft`, `applySubmitResult`, `applyCommittedBatch`, `loadMaterializedView`, etc. — is wrapped in this queue. The consumer also wraps all materialized view checkpoint operations manually.

**Proposal:** Insieme's SQLite stores should serialize operations internally. The consumer should never need to wrap store methods in an operation queue.

### 2.5 insertDrafts Workaround — Sequential Fallback

**File:** `tauri/collabClientStore.js` lines 752-768

The consumer overrides `insertDrafts` to do sequential single inserts because of connection pinning issues:

```js
async insertDrafts(items) {
  return queueWriteOperation("insertDrafts", async () => {
    // plugin-sql does not guarantee a pinned connection across JS-issued
    // BEGIN/COMMIT batches. Sequential single inserts avoid the long
    // busy-timeout stalls we were seeing in insertDrafts().
    for (const item of normalizedItems) {
      await store.insertDraft(item);  // one at a time!
    }
    return undefined;
  });
},
```

**Proposal:** Insieme should handle batch inserts correctly with the underlying SQLite driver, potentially using `INSERT` statements without explicit transaction wrapping when the driver can't guarantee connection pinning.

---

## 3. Projection/Materialized View Complexity

### 3.1 Custom Checkpoint Envelope with Metadata

**File:** `tauri/collabClientStore.js` lines 126-177

The consumer wraps all checkpoint values in a custom envelope to carry metadata (especially `historyStats`):

```js
const ROUTEVN_CHECKPOINT_ENVELOPE_KEY = "__routevnCheckpoint";
const ROUTEVN_CHECKPOINT_ENVELOPE_VERSION = 1;

const encodeStoredCheckpointValue = ({ value, meta } = {}) => {
  return JSON.stringify({
    [ROUTEVN_CHECKPOINT_ENVELOPE_KEY]: {
      version: ROUTEVN_CHECKPOINT_ENVELOPE_VERSION,
      value: value === undefined ? null : value,
      meta: structuredClone(meta),
    },
  });
};
```

Every `saveMaterializedViewCheckpoint` call injects `historyStats` into the checkpoint metadata:

```js
async saveMaterializedViewCheckpoint({ viewName, partition, ... }) {
  await queueWriteOperation("saveMaterializedViewCheckpoint", async () => {
    const checkpointMeta = {
      ...structuredClone(meta || {}),
      historyStats: await loadRepositoryHistoryStats(),
    };
    return runExecute(
      `INSERT OR REPLACE INTO ${MATERIALIZED_VIEW_TABLE} ...`,
      [viewName, partition, viewVersion, lastCommittedId,
       encodeStoredCheckpointValue({ value, meta: checkpointMeta }), updatedAt],
    );
  });
},
```

**Proposal:** Insieme should support arbitrary metadata on checkpoints natively. The `saveCheckpoint` API should accept a `meta` field that is persisted alongside the value and retrievable via `loadCheckpoint`.

### 3.2 Multi-Layer Projection Architecture (~1,300 lines)

**File:** `shared/projectRepositoryRuntime.js` + `projectRepositoryViews/` (5 files, ~2,000 lines total)

RouteVN implements a **three-tier** projection system on top of Insieme's single materialized view runtime:

1. **Main state view** — strips scene line data, keeps project structure + resources
2. **Scene projection** — per-scene line/section detail replay
3. **Scene overview** — aggregated scene metadata for navigation

The runtime manages:
- Active scene state tracking (`activeSceneId`, `activeSceneState`, `hasExplicitActiveScene`)
- Auto-adoption of scene projections from incoming events
- Pruning removed scenes and their checkpoints
- Hydration progress reporting
- Manual checkpoint flushing with scene bundles

```js
// Simplified flow for a single committed event:
async addEvent(event) {
  events.push(structuredClone(event));
  currentRevision = events.length;
  const committedEvent = toCommittedProjectEvent({ event, committedId: currentRevision, projectId });
  
  await materializedViewRuntime.onCommittedEvent(committedEvent);  // main view
  await refreshMainState();
  const adopted = await autoAdoptSceneProjection([committedEvent]);  // scene view
  if (!adopted) await updateActiveSceneProjection([committedEvent]);
  await pruneRemovedActiveScene();
  await sceneBundleRuntime.handleCommittedEvents([committedEvent]);  // overview
  notifyStateListeners();
}
```

**Proposal:** Insieme should support **multi-partition materialized views** natively — a single view definition that manages multiple hot partitions with independent hydration and checkpointing. The current API only supports a single `partition` per view load, forcing consumers to build their own partition management.

### 3.3 Replay Error Recovery System (~250 lines)

**File:** `shared/projectRepositoryRuntime.js` lines 172-454

The consumer built an elaborate replay error recovery system:

1. **Duplicate create detection** — when a `file.create` or `*.create` event fails because the ID already exists, it checks if the existing item matches the event payload exactly and skips it:

```js
const canSkipDuplicateFileCreateDuringReplay = ({ repositoryState, event, error }) => {
  const existingFile = repositoryState?.files?.items?.[fileId];
  return (
    existingFile.id === fileId &&
    existingFile.mimeType === fileData.mimeType &&
    Number(existingFile.size) === Number(fileData.size) &&
    existingFile.sha256 === fileData.sha256
  );
};
```

2. **Batch-to-sequential fallback** — when batch replay fails, falls back to sequential event-by-event replay:

```js
const replayEventsSequentially = ({ repositoryState, events, reduceEventToState }) => {
  for (let index = 0; index < events.length; index += 1) {
    try {
      const nextState = reduceEventToState({ repositoryState: state, event: events[index] });
      if (nextState !== undefined) state = nextState;
    } catch (error) {
      if (canSkipDuplicateFileCreateDuringReplay(...)) continue;
      if (canSkipDuplicateResourceCreateDuringReplay(...)) continue;
      return { valid: false, error, failedEventArrayIndex: index };
    }
  }
  return { valid: true, repositoryState: state };
};
```

3. **Rich replay error diagnostics** — captures surrounding events, offsets, and command types:

```js
const createReplayError = ({ error, events, targetEventCount, failedEventArrayIndex, ... }) => {
  replayError.name = "ProjectRepositoryReplayError";
  replayError.code = error?.code || "history_replay_failed";
  replayError.details = {
    replay: {
      targetEventCount,
      failedEventArrayIndex: resolvedFailedIndex,
      failedEventOffset: resolvedFailedIndex + 1,
      failedEvent: summarizeReplayEvent(events[failedBatchIndex], ...),
      nearbyEvents: events.slice(startBatchIndex, endBatchIndex).map(summarizeReplayEvent),
    },
  };
};
```

4. **Scene projection obsolete event detection** — detects and skips events that reference already-deleted sections/lines:

```js
const shouldSkipObsoleteSceneReplayEvent = ({ event, repositoryState, error }) => {
  if (isMissingSectionReplayError(error)) {
    return !findSectionLocationInState(repositoryState, sectionId);
  }
  if (isDuplicateLineReplayError(error)) {
    return Boolean(findLineLocationInState(repositoryState, lineId));
  }
  // ...
};
```

**Proposal:** Insieme's materialized view runtime should support:
- **Idempotent replay** — a reducer mode where duplicate creates and missing-reference updates are handled natively
- **Replay error context** — the library should capture and report failed event context (index, surrounding events, state snapshot) without consumer code
- **Sequential fallback** — when batch reduce fails, the library should optionally retry sequentially with skip-on-idempotent logic

### 3.4 History Stats Tracking and Bootstrap Validation (~170 lines)

**File:** `tauri/collabClientStore.js` lines 637-731

The consumer tracks repository history stats separately and validates bootstrap ordering:

```js
const loadRepositoryHistoryStats = async () => {
  const committedRows = await runSelect(
    `SELECT COUNT(*) AS committedCount, COALESCE(MAX(committed_id), 0) AS latestCommittedId FROM committed_events`
  );
  const draftRows = await runSelect(
    `SELECT COUNT(*) AS draftCount, COALESCE(MAX(draft_clock), 0) AS latestDraftClock FROM local_drafts`
  );
  return normalizeRepositoryHistoryStats({ committedCount, latestCommittedId, draftCount, latestDraftClock });
};

const inspectBootstrapHistorySupport = ({ committedEvents, draftEvents }) => {
  // 50 lines checking that exactly one bootstrap event exists, at index 0
  // Returns: { supported: boolean, reason: string }
};
```

Then on every store creation, it validates and potentially refuses to open corrupted histories:

```js
await ensureSupportedProjectHistory();  // throws if bootstrap is wrong
```

**Proposal:** Insieme should expose a `getRepositoryStats()` method on the store and optionally enforce bootstrap event constraints (first event must be type X, exactly one bootstrap allowed).

---

## 4. Offline-First Experience

### 4.1 No Built-In Offline Queue Visibility

The consumer has no way to query the draft queue from the session. They must access the store directly:

```js
// Consumer has to go through store directly
const draftEvents = await loadDraftEventsFromClientStore(store);
```

**Proposal:** `createCommandSyncSession` should expose `getPendingDraftCount()` and `getPendingDrafts()` for UI to show "X unsynced changes."

### 4.2 Transport Disconnect Swallowing is Necessary but Invisible

**File:** `command-sync-session.js` line 63

```js
swallowTransportDisconnect = true,  // default!
```

When offline, `submitCommands` returns fake IDs instead of throwing. The consumer relies on this behavior heavily — but the session status doesn't clearly communicate "you are offline and your commands are queued locally."

```js
// In submitCommands:
catch (error) {
  if (!swallowTransportDisconnect || !isTransportDisconnectedError(error)) throw error;
  lastError = { code: "transport_disconnected", message: ... };
  return submitItems.map((item) => item.id);  // fake IDs!
}
```

**Proposal:** The session should distinguish between "committed" and "queued-offline" results. Currently, the consumer can't tell whether an ID represents a committed event or a locally-queued draft.

### 4.3 No Offline State Signal

The consumer's `createProjectCollabService` doesn't expose any offline/online status change callback. The `getStatus()` returns raw internals:

```js
getStatus() { return session.getStatus(); }
// Returns: { started, stopped, closed, connected, syncInFlight, reconnectInFlight, ... }
```

The consumer must poll `getStatus().connected` to determine offline state.

**Proposal:** Insieme should provide an `onStatusChange` callback and a clear `isOnline()` / `isOffline()` method. The status should be a domain type, not raw implementation details.

### 4.4 Manual Reconnect Configuration Boilerplate

Every consumer session creation must specify reconnect policy explicitly:

```js
reconnect: {
  enabled: true,
  initialDelayMs: 200,
  maxDelayMs: 5000,
  factor: 2,
  jitter: 0.2,
  maxAttempts: Number.POSITIVE_INFINITY,
  handshakeTimeoutMs: 5000,
},
```

**Proposal:** Provide sensible defaults that work for most apps. The consumer should only need `reconnect: true` for the common case.

---

## 5. Error Handling Patterns the Consumer Invented

### 5.1 Dual Error State Management

**File:** `shared/collab/createProjectCollabService.js`

The consumer maintains its own `lastError` alongside the session's:

```js
let lastError = null;  // consumer-level

// In submitValidatedCommands:
catch (error) {
  const submitResult = createSubmitErrorResult(error);
  lastError = structuredClone(submitResult.error);  // consumer copy
  return submitResult;
}

getLastError() {
  if (lastError) return structuredClone(lastError);  // prefer consumer error
  return session.getLastError();  // fall back to session error
}

clearLastError() {
  lastError = null;
  session.clearLastError();  // clear both!
}
```

This exists because the session's error handling doesn't cover submit-specific errors.

**Proposal:** Insieme should maintain a unified error state that captures both session-level and submit-level errors with a single `getLastError` / `clearLastError` API.

### 5.2 Submit Error Normalization

```js
const createSubmitErrorResult = (error) => {
  const normalizedError = {
    code: error?.code || "submit_failed",
    message: error?.message || "Failed to submit commands",
  };
  if (error?.details && typeof error.details === "object") {
    normalizedError.details = structuredClone(error.details);
  }
  return { valid: false, error: normalizedError };
};
```

**Proposal:** Insieme should normalize all errors to a consistent shape with `code`, `message`, and optional `details`.

### 5.3 Unsupported History Error with User-Facing Messages

**File:** `tauri/collabClientStore.js` lines 440-464

The consumer builds specific user-facing error messages for different bootstrap history corruption patterns:

```js
const createUnsupportedProjectHistoryError = ({ projectId, reason }) => {
  let detail = "This project uses an unsupported local history format for this RouteVN Creator build.";
  if (reason === "misordered_bootstrap_draft_event") detail = "...";
  else if (reason === "multiple_bootstrap_events") detail = "...";
  // ... etc
  error.name = "ProjectStoreFormatUnsupportedError";
  error.code = "project_store_format_unsupported";
};
```

**Proposal:** Insieme should provide structured error types that consumers can map to UI messages, rather than requiring the consumer to invent error taxonomies.

---

## 6. Command-Sync-Session Abstraction: Sufficiency Analysis

### What It Provides Well
- ✅ Command ↔ sync event mapping with configurable mappers
- ✅ Deduplication of applied events (bounded 5000-entry set)
- ✅ Transport disconnect swallowing for offline queue
- ✅ Basic reconnect policy with exponential backoff + jitter
- ✅ `onCommittedCommand` callback with source type discrimination

### What's Missing

#### 6.1 No Store-Level Queue Visibility
The session wraps the store but doesn't expose draft queue state. Consumers need `store.loadDraftsOrdered()` directly.

**Missing API:**
```js
session.getPendingDraftCount()
session.getPendingDraftIds()
```

#### 6.2 No Partition Management
Commands require a `partition` but the session provides no partition utilities. The consumer built:
- `partitions.js` (114 lines) — FNV-1a hashing, base58 encoding, partition collapsing
- Partition subscription management
- Partition-to-scene resolution

**Missing API:**
```js
session.registerPartition(key, partitionString)
session.resolvePartition(key)
```

#### 6.3 No Lifecycle Events for UI
The session emits `onCommittedCommand` and `onEvent` but doesn't emit lifecycle events that a UI needs:
- `onSyncStatusChange({ status: "connected" | "syncing" | "offline" | "error" })`
- `onQueueChange({ pendingCount, syncingCount })`
- `onError({ error, recoverable })`

#### 6.4 No Submit Result Differentiation
When `submitCommands` succeeds, it returns IDs — but there's no way to know which are locally queued vs. server-committed. The consumer had to add:

```js
// Consumer workaround:
const commandIds = await session.submitCommands(normalizedCommands);
return {
  valid: true,
  commandIds: Array.isArray(commandIds) && commandIds.length > 0
    ? commandIds
    : normalizedCommands.map((command) => command.id),  // fallback to local IDs
};
```

**Missing API:**
```js
session.submitCommands(commands) → Promise<{
  results: Array<{ id: string, status: "queued" | "committed", committedId?: number }>,
}>
```

#### 6.5 No Validation Hook for Domain Rules
The session has `validateLocalEvent` on the lower `syncClient` but `createCommandSyncSession` doesn't expose it. The consumer can't reject commands before they're queued.

**Missing API:**
```js
createCommandSyncSession({
  validateCommand: (command) => { /* throw to reject */ },
})
```

#### 6.6 No Checkpoint/Recovery Integration
The session has no concept of materialized view checkpoints. The consumer must:
1. Listen to `onCommittedCommand`
2. Maintain their own projection state
3. Manually flush checkpoints to the store

The `materializedViewRuntime` is constructed separately and manually wired:

```js
const materializedViewRuntime = createMaterializedViewRuntime({ ... });
// In addEvent:
await materializedViewRuntime.onCommittedEvent(committedEvent);
await refreshMainState();
```

**Missing API:** The session should optionally manage materialized views internally:
```js
createCommandSyncSession({
  views: [{
    name: "main_state",
    version: "1",
    partition: MAIN_PARTITION,
    reduce: (state, event) => nextState,
    checkpoint: { mode: "debounce", debounceMs: 1000 },
  }],
  onViewUpdate: ({ viewName, partition, value }) => { /* update UI */ },
})
```

#### 6.7 Double structuredClone on Every Committed Command

**File:** `command-sync-session.js` lines 99-105

```js
const maybePromise = onCommittedCommand({
  command: structuredClone(command),        // clone #1 (inside session)
  committedEvent: structuredClone(committedEvent),  // clone #1
});
```

Then in `createProjectCollabService.js` line 83:
```js
void onCommittedCommand({
  command: structuredClone(command),        // clone #2 (consumer wrapper)
  committedEvent: structuredClone(committedEvent),  // clone #2
});
```

Every committed command is cloned **four times**. For a project with thousands of events, this is significant overhead.

**Proposal:** Insieme should document that the session already clones, so consumers don't need to. Or provide a `raw` mode that passes references.

---

## Summary of Proposed Insieme Improvements

| Priority | Pain Point | Lines of Consumer Code | Proposal |
|----------|-----------|----------------------|----------|
| 🔴 Critical | SQLite lock retry system | ~80 | Built-in SQLITE_BUSY retry in libsql store |
| 🔴 Critical | Manual operation queue | ~50 | Store-level operation serialization |
| 🔴 Critical | WAL checkpoint management | ~120 | Built-in WAL management in SQLite stores |
| 🟠 High | Replay error recovery | ~250 | Idempotent replay mode in materialized view runtime |
| 🟠 High | Multi-partition projection | ~2000 | Native multi-partition materialized views |
| 🟠 High | Offline state visibility | — | `isOnline()`, `onStatusChange`, `getPendingDraftCount()` |
| 🟡 Medium | Checkpoint metadata envelope | ~50 | Native `meta` field on checkpoints |
| 🟡 Medium | Transport logging adapter | ~107 | Accept standard logger interface |
| 🟡 Medium | Submit result differentiation | — | Return `status: "queued" | "committed"` per command |
| 🟢 Low | Command mapper wrapper | ~39 | Configurable schema version, field filtering |
| 🟢 Low | Double structuredClone | — | Document cloning contract or provide raw mode |
| 🟢 Low | Reconnect config boilerplate | — | Sensible defaults, `reconnect: true` shorthand |
