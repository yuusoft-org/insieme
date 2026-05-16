# Insieme Architecture Redesign Proposal

**Date:** May 8, 2026  
**Scope:** Deep analysis of `src/` (9,495 lines across 35 files) and `docs/`  
**Status:** Proposal — no implementation until tests exist

---

## Executive Summary

Insieme is a working offline-first sync engine with authoritative server. The protocol is well-designed and the codebase is feature-complete (all roadmap phases checked). However, the implementation suffers from five structural problems that will compound as the library matures:

1. **Implicit state machines** — 7+ boolean flags in `sync-client.js` with no formalization
2. **Monolithic factory closures** — 1,059-line client and 1,047-line server as single closures
3. **Massive store duplication** — 5 client stores (~3,700 lines total) sharing ~70% identical logic
4. **Flat event model** — no aggregate boundaries for domain modeling
5. **Mixed concerns** — transport, protocol, business logic, and reconnection interleaved

This document proposes a layered, state-machine-driven architecture that preserves the existing wire protocol while making the internals testable, composable, and dramatically smaller.

---

## Table of Contents

1. [Current Architecture Inventory](#1-current-architecture-inventory)
2. [Proposal 1: Formal State Machines](#2-proposal-1-formal-state-machines)
3. [Proposal 2: Layered Architecture](#3-proposal-2-layered-architecture)
4. [Proposal 3: Actor Model Evaluation](#4-proposal-3-actor-model-evaluation)
5. [Proposal 4: Event Sourcing with Aggregates](#5-proposal-4-event-sourcing-with-aggregates)
6. [Proposal 5: Eliminating Store Duplication](#6-proposal-5-eliminating-store-duplication)
7. [Migration Path](#7-migration-path)

---

## 1. Current Architecture Inventory

### 1.1 Module Map and Responsibility Matrix

| File | Lines | Actual Responsibilities |
|------|-------|------------------------|
| `sync-client.js` | 1,059 | Transport lifecycle, protocol encoding/decoding, reconnection policy, draft queue management, batch size enforcement, error classification, message dispatch, cursor tracking |
| `sync-server.js` | 1,047 | Session lifecycle, auth/authz, rate limiting, message validation, commit orchestration, broadcast fan-out, error mapping |
| `offline-transport.js` | 283 | Offline buffering, online transport hot-swap, local message simulation |
| `in-memory-client-store.js` | 336 | Draft CRUD, committed event dedup, cursor persistence, materialized view bridge |
| `indexeddb-client-store.js` | 742 | Schema migrations, IDB transaction management, all of above + serialization |
| `sqlite-client-store.js` | 788 | Schema migrations, prepared statements, same logic again |
| `libsql-client-store.js` | 821 | Same logic, async variant |
| `async-sqlite-client-store.js` | 978 | Same logic, different transaction model, write queue serialization |
| `materialized-view-runtime.js` | 575 | Lock management, checkpoint persistence, hydration, subscription fan-out |
| `command-sync-session.js` | 279 | Command-to-event mapping, dedup, event-to-command mapping |

### 1.2 State Flags in sync-client.js

```javascript
// Lines 143-168 — the actual state model
let started = false;           // Has start() been called?
let connected = false;         // Did we receive 'connected' message?
let syncInFlight = false;      // Is a sync request pending?
let stopped = false;           // Has stop() been called?
let closed = false;            // Has close() been called?
let reconnectInFlight = false; // Is reconnect loop running?
let submitBatchInFlight = null; // { msgId, draftIds } or null
```

**Problem:** These 7 flags define an implicit state space of 2⁷ = 128 combinations. Many are semantically impossible (e.g., `started=true, connected=true, stopped=true`) but nothing prevents them. The code guards with compound conditions like:

```javascript
while (connected && !syncInFlight && !stopped && !submitBatchInFlight) {
```

This appears **12 times** across the file with slight variations. Any new state requirement (e.g., "pause sync") requires auditing every guard.

### 1.3 Duplication Heat Map

The following logic is duplicated across all 5 client stores:

| Logic | in-memory | indexeddb | sqlite | libsql | async-sqlite |
|-------|-----------|-----------|--------|--------|-------------|
| `normalizeCommittedEvent` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `toComparisonKey` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `assertCommittedInvariant` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `parseDraft` / `parseCommittedRow` | - | ✓ | ✓ | ✓ | ✓ |
| Schema creation (4 tables) | - | ✓ | ✓ | ✓ | ✓ |
| Schema validation | - | ✓ | ✓ | ✓ | ✓ |
| `saveCursorMonotonic` | - | ✓ | ✓ | ✓ | ✓ |
| `applySubmitResult` logic | ✓ | ✓ | ✓ | ✓ | ✓ |
| `applyCommittedBatch` logic | ✓ | ✓ | ✓ | ✓ | ✓ |
| Materialized view bridge | ✓ | ✓ | ✓ | ✓ | ✓ |
| `ensureOpen` / `throwIfClosed` | ✓ | ✓ | ✓ | ✓ | ✓ |

**Total duplicated lines:** ~2,600 across stores (70% of their combined ~3,700 lines).

---

## 2. Proposal 1: Formal State Machines

### 2.1 Client State Machine

The 7 boolean flags collapse into a single state variable with 8 states:

```
                   ┌──────────┐
         start()   │  IDLE    │ ← initial state
        ──────────→│          │
                   └────┬─────┘
                        │ start()
                   ┌────▼─────┐
        connected  │HANDSHAKE │
        ◄─────────│          │
                   └────┬─────┘
                        │ onConnected
                   ┌────▼─────┐
              ┌──→│ SYNCING  │◄──┐
              │   └────┬─────┘   │
              │        │ synced  │ onBroadcast / 
              │   ┌────▼─────┐   │ flushDrafts
              │   │ READY    │───┘
              │   └────┬─────┘
              │        │ submit_batch → SUBMITTING
              │   ┌────▼──────┐
              │   │SUBMITTING │──→ READY (on result)
              │   └───────────┘
              │
              │   disconnect/error
              │   ┌────▼─────┐
              └───│RECONNECT │
                  └────┬─────┘
                       │ max attempts → DISCONNECTED
                  ┌────▼──────┐
                  │DISCONNECTED│
                  └───────────┘
                  
        close() from any state → CLOSED
        stop() from any state → IDLE
```

### 2.2 Implementation: XState-Lite (No Dependencies)

Rather than adding XState as a dependency, implement a minimal finite state machine that captures the same guarantees. The key insight: each state transition is a pure function, and illegal transitions are impossible by construction.

```javascript
// src/client-state-machine.js

const States = Object.freeze({
  IDLE: 'idle',
  HANDSHAKE: 'handshake',
  SYNCING: 'syncing',
  READY: 'ready',
  SUBMITTING: 'submitting',
  RECONNECTING: 'reconnecting',
  DISCONNECTED: 'disconnected',
  CLOSED: 'closed',
});

const Transitions = Object.freeze({
  START: 'start',
  CONNECTED: 'connected',
  SYNC_COMPLETE: 'sync_complete',
  SYNC_MORE: 'sync_more',
  SUBMIT: 'submit',
  SUBMIT_RESULT: 'submit_result',
  DISCONNECT: 'disconnect',
  RECONNECT_ATTEMPT: 'reconnect_attempt',
  RECONNECT_SUCCESS: 'reconnect_success',
  RECONNECT_EXHAUSTED: 'reconnect_exhausted',
  STOP: 'stop',
  CLOSE: 'close',
});

// { [state]: { [event]: nextState } }
const machine = {
  [States.IDLE]: {
    [Transitions.START]: States.HANDSHAKE,
    [Transitions.CLOSE]: States.CLOSED,
  },
  [States.HANDSHAKE]: {
    [Transitions.CONNECTED]: States.SYNCING,
    [Transitions.DISCONNECT]: States.RECONNECTING,
    [Transitions.STOP]: States.IDLE,
    [Transitions.CLOSE]: States.CLOSED,
  },
  [States.SYNCING]: {
    [Transitions.SYNC_COMPLETE]: States.READY,
    [Transitions.SYNC_MORE]: States.SYNCING,
    [Transitions.DISCONNECT]: States.RECONNECTING,
    [Transitions.STOP]: States.IDLE,
    [Transitions.CLOSE]: States.CLOSED,
  },
  [States.READY]: {
    [Transitions.SUBMIT]: States.SUBMITTING,
    [Transitions.DISCONNECT]: States.RECONNECTING,
    [Transitions.STOP]: States.IDLE,
    [Transitions.CLOSE]: States.CLOSED,
    // Re-sync triggers from broadcast or cursor drift
  },
  [States.SUBMITTING]: {
    [Transitions.SUBMIT_RESULT]: States.READY,
    [Transitions.DISCONNECT]: States.RECONNECTING,
    [Transitions.STOP]: States.IDLE,
    [Transitions.CLOSE]: States.CLOSED,
  },
  [States.RECONNECTING]: {
    [Transitions.RECONNECT_SUCCESS]: States.HANDSHAKE,
    [Transitions.RECONNECT_EXHAUSTED]: States.DISCONNECTED,
    [Transitions.STOP]: States.IDLE,
    [Transitions.CLOSE]: States.CLOSED,
  },
  [States.DISCONNECTED]: {
    [Transitions.START]: States.HANDSHAKE,
    [Transitions.CLOSE]: States.CLOSED,
  },
  [States.CLOSED]: {},
};

export const createClientStateMachine = (onTransition = () => {}) => {
  let current = States.IDLE;

  return {
    get state() { return current; },
    
    send(event, payload) {
      const transitions = machine[current];
      if (!transitions || !(event in transitions)) {
        return false; // illegal transition — caller can log/error
      }
      const previous = current;
      current = transitions[event];
      onTransition({ from: previous, to: current, event, payload });
      return true;
    },
    
    // Query helpers replace boolean flags
    get canSubmit() { return current === States.READY; },
    get canSync() { return current === States.READY; },
    get isConnected() { 
      return [States.SYNCING, States.READY, States.SUBMITTING].includes(current); 
    },
    get isStarted() { return current !== States.IDLE && current !== States.CLOSED; },
    get isClosed() { return current === States.CLOSED; },
  };
};
```

### 2.3 Impact on sync-client.js

The 12+ compound boolean guards collapse to single property checks:

**Before (current code):**
```javascript
// Line 341
while (connected && !syncInFlight && !stopped && !submitBatchInFlight) {
```

**After:**
```javascript
while (fsm.canSubmit) {
```

**Before (reconnect loop, line 473):**
```javascript
if (!reconnectPolicy.enabled || reconnectInFlight || stopped || !started) {
  return;
}
```

**After:**
```javascript
if (fsm.state !== States.READY && fsm.state !== States.SYNCING && fsm.state !== States.SUBMITTING) {
  // Already disconnected or not started
  return;
}
```

### 2.4 Server Session State Machine

The server already uses a state field (`session.state`) but only with 3 values. This is actually correct and should be preserved:

```javascript
// Current server states — already good
"await_connect" → "active" → "closed"
```

**Recommendation:** Keep server as-is. The server's state model is naturally simple because each WebSocket connection is a fresh session.

---

## 3. Proposal 2: Layered Architecture

### 3.1 Current vs Proposed Layers

**Current (flat):**
```
sync-client.js
├── Transport management (connect/disconnect/reconnect)
├── Protocol message construction
├── Protocol message dispatch
├── Draft queue management
├── Batch sizing logic
├── Reconnection policy
├── Error classification
└── State tracking (7 booleans)
```

**Proposed (layered):**
```
┌─────────────────────────────────────┐
│  SyncClient (public API facade)     │  ← start/stop/close/submitEvents
├─────────────────────────────────────┤
│  SyncOrchestrator                   │  ← coordinates sync flow + draft flush
│  ├─ ConnectionStateMachine          │  ← formal FSM
│  └─ ReconnectPolicy                 │  ← isolated backoff logic
├─────────────────────────────────────┤
│  ProtocolCodec                      │  ← message encode/decode/validate
├─────────────────────────────────────┤
│  DraftQueue                         │  ← insert/flush/batch management
├─────────────────────────────────────┤
│  TransportAdapter                   │  ← thin wrapper, no logic
└─────────────────────────────────────┘
```

### 3.2 Proposed Module Structure

```
src/
├── client/
│   ├── sync-client.js          ← public facade (~200 lines)
│   ├── sync-orchestrator.js    ← coordinates sync/submit/reconnect (~300 lines)
│   ├── client-state-machine.js ← formal FSM (~100 lines)
│   ├── reconnect-policy.js     ← backoff calculation, attempt tracking (~80 lines)
│   ├── draft-queue.js          ← batch building, size limits (~150 lines)
│   └── protocol-codec.js       ← message construction + dispatch (~200 lines)
├── server/
│   ├── sync-server.js          ← public facade (~200 lines)
│   ├── session.js              ← per-connection state + message handling (~300 lines)
│   ├── inbound-guards.js       ← rate limiting, size checks (~100 lines)
│   └── broadcast.js            ← fan-out logic (~80 lines)
├── protocol/
│   ├── messages.js             ← message type constants, validators
│   ├── envelope.js             ← envelope construction/parsing
│   └── errors.js               ← error code catalog
├── store/
│   ├── client-store-interface.js    ← JSDoc interface + shared logic
│   ├── client-store-base.js         ← abstract base with all domain logic
│   ├── in-memory-client-store.js    ← ~50 lines (just data structures)
│   ├── sqlite-client-store.js       ← ~100 lines (just SQL adapter)
│   ├── libsql-client-store.js       ← ~100 lines
│   ├── async-sqlite-client-store.js ← ~120 lines
│   ├── indexeddb-client-store.js    ← ~150 lines
│   ├── schema-migrations.js         ← shared DDL + validation
│   └── serialization.js             ← parse/serialize row mappings
├── views/
│   ├── materialized-view.js
│   ├── materialized-view-runtime.js
│   └── reducer.js
└── transport/
    ├── offline-transport.js
    ├── browser-websocket-transport.js
    └── ws-server-bridge.js
```

### 3.3 Concrete Example: ProtocolCodec

Extract message construction and dispatch into a pure module:

```javascript
// src/client/protocol-codec.js

export const createProtocolCodec = ({ protocolVersion = '1.0', msgId, now }) => {
  const encode = (type, payload, options = {}) => ({
    type,
    protocolVersion,
    timestamp: now(),
    msgId: options.msgId ?? msgId(),
    payload,
  });

  const encoders = {
    connect: ({ token, clientId, projectId }) =>
      encode('connect', { token, clientId, projectId }),
    
    sync: ({ projectId, sinceCommittedId, limit = 500 }) =>
      encode('sync', { projectId, sinceCommittedId, limit }),
    
    submitEvents: ({ events }) =>
      encode('submit_events', { events }),
  };

  const decoders = {
    connected: (message) => ({
      clientId: message.payload?.clientId,
      projectId: message.payload?.projectId,
      projectLastCommittedId: message.payload?.projectLastCommittedId,
    }),
    
    submitEventsResult: (message) => ({
      results: message.payload?.results ?? [],
    }),
    
    syncResponse: (message) => ({
      projectId: message.payload?.projectId,
      events: message.payload?.events ?? [],
      nextSinceCommittedId: message.payload?.nextSinceCommittedId,
      hasMore: message.payload?.hasMore ?? false,
      syncToCommittedId: message.payload?.syncToCommittedId,
    }),
    
    eventBroadcast: (message) => message.payload,
    
    error: (message) => message.payload,
  };

  return { encode, encoders, decoders };
};
```

This eliminates 80+ lines of inline message construction from `sync-client.js` and makes the protocol layer independently testable.

---

## 4. Proposal 3: Actor Model Evaluation

### 4.1 What Actor Model Would Look Like

The actor model would decompose the client into isolated message-processing units:

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  UI Actor    │────→│ Sync Actor   │────→│ Store Actor  │
│ (submit)     │     │ (coordinate) │     │ (persist)    │
└──────────────┘     └──────┬───────┘     └──────────────┘
                            │
                     ┌──────▼───────┐
                     │Network Actor │
                     │ (transport)  │
                     └──────────────┘
```

Each actor has:
- Private state (no shared mutable state)
- A message inbox (async queue)
- No direct method calls — only message passing

### 4.2 Verdict: **Not Recommended for v2**

**Reasons to reject full actor model:**

1. **JavaScript lacks built-in actor primitives.** You'd need to build an actor framework (~500 lines) or adopt one. This contradicts AD-008 ("opinionated library, not an app framework").

2. **The current promise-chain serialization (`inboundQueue`, `draftFlushQueue`) already provides actor-like message ordering.** Lines 980-984:
```javascript
inboundQueue = inboundQueue
  .catch(() => {})
  .then(() => withInboundErrorHandling(() => handleServerMessage(message)));
```
This is effectively an actor's single-threaded message processing.

3. **Debugging difficulty.** Distributed trace through actor mailboxes is significantly harder than stepping through a layered call stack.

### 4.3 Recommended Middle Ground: "Channel Pattern"

Instead of full actors, isolate the key concurrent processes as typed async queues:

```javascript
// src/client/channels.js

/**
 * Three serialized channels replace the two promise chains:
 * 1. inbound: server message processing
 * 2. outbound: draft flush + submit
 * 3. reconnect: reconnection loop
 */
export const createChannels = () => {
  const createChannel = () => {
    let tail = Promise.resolve();
    return {
      enqueue: (fn) => {
        const next = tail.catch(() => {}).then(fn);
        tail = next;
        return next;
      },
      drain: () => tail,
    };
  };

  return {
    inbound: createChannel(),
    outbound: createChannel(),
    reconnect: createChannel(),
  };
};
```

This preserves the simplicity of the current approach while making the concurrency model explicit and testable.

---

## 5. Proposal 4: Event Sourcing with Aggregates

### 5.1 Current Flat Event Model

The current model stores all events in a single flat stream, keyed only by `partition`:

```javascript
// Current: flat committed_events table
{ id, partition, type, schemaVersion, payload, committedId, ... }
```

There is no concept of aggregate boundaries. Every event is independent. This works for the current use case (RouteVN commands like `folderCreated`, `nodeMoved`) but breaks down for:

- **Entity lifecycles** (e.g., "document is published" should not be valid if "document is deleted")
- **Optimistic concurrency** on specific entities (current dedup is only by `id`)
- **Targeted projections** (materialized views scan ALL events to find relevant ones)

### 5.2 Proposed: Lightweight Aggregate Layer

Add an optional `aggregateId` concept that groups related events without changing the wire protocol:

```javascript
// New: aggregate-aware event envelope
{
  id: 'evt-uuid',
  aggregateId: 'doc-123',       // NEW: groups related events
  partition: 'workspace:ws-1',
  type: 'document.titleChanged',
  schemaVersion: 1,
  payload: { title: 'New Title' },
  // ... existing fields
}
```

### 5.3 Aggregate Enforcement on Server

The server can optionally enforce aggregate invariants:

```javascript
// server/aggregate-validator.js
export const createAggregateValidator = (rules) => async (item, { store }) => {
  const rule = rules[item.type];
  if (!rule?.aggregateId) return; // events without aggregate constraints pass through
  
  const aggregateId = item.payload?.[rule.aggregateId];
  if (!aggregateId) throw new Error(`${item.type} requires ${rule.aggregateId}`);
  
  // Check aggregate state if lifecycle rules defined
  if (rule.lifecycle) {
    const lastEvent = await store.getLastEventForAggregate({
      aggregateId,
      types: rule.lifecycle.validAfter,
    });
    if (!lastEvent && rule.lifecycle.requiresExisting) {
      throw new Error(`${item.type} requires prior ${rule.lifecycle.validAfter.join(' or ')}`);
    }
  }
};
```

### 5.4 Verdict: **Defer to v3**

The aggregate layer is valuable but not urgent. The current flat model works for RouteVN. Recommend:

1. **v2:** Extract `reducer.js` into a proper event handler registry with type-safe handlers
2. **v3:** Add aggregate awareness when entity lifecycle validation becomes a requirement

The protocol wire format should remain unchanged — aggregates are a server-side validation and client-side projection concern.

---

## 6. Proposal 5: Eliminating Store Duplication

### 6.1 The Problem in Numbers

| Store | Lines | Unique Logic | Duplicated Logic |
|-------|-------|-------------|-----------------|
| in-memory | 336 | 50 | 286 (→ base) |
| indexeddb | 742 | 180 | 562 |
| sqlite | 788 | 120 | 668 |
| libsql | 821 | 130 | 691 |
| async-sqlite | 978 | 180 | 798 |
| **Total** | **3,665** | **660** | **~3,000** |

### 6.2 Strategy: Template Method + Adapter Pattern

Extract all domain logic into an abstract base class. Each concrete store provides only the storage primitives:

```javascript
// src/store/client-store-base.js

/**
 * Abstract base containing ALL domain logic for the client store.
 * Concrete stores implement ~10 primitive operations.
 */
export const createClientStoreBase = ({
  // === Storage primitives (each store implements these) ===
  storageLoadMetaInt,        // (key) → number
  storageSaveMetaInt,        // (key, value) → void
  storageInsertDraftRow,     // (row) → void
  storageLoadDraftRows,      // () → DraftRow[]
  storageDeleteDraftById,    // (id) → void
  storageGetCommittedById,   // (id) → CommittedRow | null
  storageGetCommittedByCommittedId, // (committedId) → CommittedRow | null
  storageInsertCommittedRow, // (row) → { changes: number }
  storageLoadCommittedAfter, // (sinceCommittedId, limit) → CommittedRow[]
  storageGetMaxCommittedId,  // () → number
  
  // Materialized view primitives
  storageLoadViewCheckpoint,  // (viewName, partition) → checkpoint | null
  storageSaveViewCheckpoint,  // (checkpoint) → void
  storageDeleteViewCheckpoint, // (viewName, partition) → void
  
  // Schema management
  storageEnsureSchema,       // () → void
  storageValidateSchema,     // () → void
  storageClose,              // () → void
  
  // Configuration
  materializedViews = [],
  materializedBackfillChunkSize = 512,
}) => {
  // === All domain logic lives here, written once ===
  
  const { normalizeCommittedEvent, toComparisonKey, assertCommittedInvariant } = 
    createDomainHelpers({ canonicalizeSubmitItem, normalizeClientTs });
  
  const materializedViewDefinitions = normalizeMaterializedViewDefinitions(materializedViews);
  let materializedViewRuntime;
  let closed = false;
  
  const ensureOpen = () => throwIfClosed(closed, 'client store', 'client_store_closed');
  
  // --- Draft management (written once) ---
  
  const insertDraft = async (draft) => {
    ensureOpen();
    // ... validation logic (currently duplicated 5 times) ...
    await storageInsertDraftRow(serializeDraftRow(draft));
  };
  
  const insertDrafts = async (items) => {
    ensureOpen();
    // ... batch validation + insert ...
    for (const item of items) {
      await storageInsertDraftRow(serializeDraftRow(item));
    }
  };
  
  const loadDraftsOrdered = async () => {
    ensureOpen();
    const rows = await storageLoadDraftRows();
    return rows.map(parseDraftRow).sort(sortDrafts);
  };
  
  // --- Committed event management (written once) ---
  
  const applySubmitResult = async ({ result }) => {
    ensureOpen();
    if (result.status === 'committed') {
      const draftRows = await storageLoadDraftRows();
      const draft = draftRows.find(r => r.id === result.id);
      if (draft) {
        const parsedDraft = parseDraftRow(draft);
        const committedEvent = normalizeCommittedEvent(
          buildCommittedEventFromDraft({
            draft: parsedDraft,
            committedId: result.committedId,
            serverTs: result.serverTs,
          })
        );
        const insertResult = await storageInsertCommittedRow(
          serializeCommittedRow(committedEvent)
        );
        if (insertResult.changes === 0) {
          assertCommittedInvariant(committedEvent, {
            storageGetCommittedById, storageGetCommittedByCommittedId
          });
        } else if (materializedViewRuntime) {
          await materializedViewRuntime.onCommittedEvent(committedEvent);
        }
      }
      await storageDeleteDraftById(result.id);
      return;
    }
    if (result.status === 'rejected') {
      await storageDeleteDraftById(result.id);
    }
  };
  
  const applyCommittedBatch = async ({ events, nextCursor }) => {
    ensureOpen();
    for (const event of events) {
      const committedEvent = normalizeCommittedEvent(event);
      const insertResult = await storageInsertCommittedRow(
        serializeCommittedRow(committedEvent)
      );
      if (insertResult.changes > 0 && materializedViewRuntime) {
        await materializedViewRuntime.onCommittedEvent(committedEvent);
      }
      await storageDeleteDraftById(event.id);
    }
    if (nextCursor !== undefined) {
      await saveCursorMonotonic(nextCursor);
    }
  };
  
  const saveCursorMonotonic = async (nextCursor) => {
    const current = await storageLoadMetaInt('cursor_committed_id', 0);
    const effective = Math.max(current, nextCursor);
    await storageSaveMetaInt('cursor_committed_id', effective);
  };
  
  // --- Public interface ---
  
  return {
    init: async () => {
      ensureOpen();
      await storageEnsureSchema();
      materializedViewRuntime = createMaterializedViewRuntime({
        definitions: materializedViewDefinitions,
        chunkSize: materializedBackfillChunkSize,
        getLatestCommittedId: () => storageGetMaxCommittedId(),
        listCommittedAfter: ({ sinceCommittedId, limit }) =>
          storageLoadCommittedAfter(sinceCommittedId, limit)
            .then(rows => rows.map(parseCommittedRow)),
        loadCheckpoint: storageLoadViewCheckpoint,
        saveCheckpoint: storageSaveViewCheckpoint,
        deleteCheckpoint: storageDeleteViewCheckpoint,
      });
    },
    
    close: async () => {
      if (closed) return;
      closed = true;
      if (materializedViewRuntime) {
        await materializedViewRuntime.flushMaterializedViews();
        await materializedViewRuntime.close();
      }
      await storageClose();
    },
    
    loadCursor: () => storageLoadMetaInt('cursor_committed_id', 0),
    insertDraft,
    insertDrafts,
    loadDraftsOrdered,
    applySubmitResult,
    applyCommittedBatch,
    // ... materialized view methods delegate to runtime ...
  };
};
```

### 6.3 Concrete Store Implementation (SQLite Example)

```javascript
// src/store/sqlite-client-store.js (NEW — ~120 lines instead of 788)

import { createClientStoreBase } from './client-store-base.js';
import { serializePayload, deserializePayload } from '../payload-codec.js';

const parseIntSafe = (v) => { const n = Number.parseInt(v, 10); return Number.isNaN(n) ? 0 : n; };

export const createSqliteClientStore = (db, options = {}) => {
  let loadCursorStmt, saveCursorStmt, insertDraftStmt, /* ... */ ;
  
  const prepareStatements = () => {
    loadCursorStmt = db.prepare(`SELECT value FROM app_state WHERE key = ?`);
    saveCursorStmt = db.prepare(`INSERT INTO app_state(key, value) VALUES(?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value`);
    // ... 8 more prepared statements ...
  };
  
  const txn = (fn) => {
    if (typeof db.transaction === 'function') return db.transaction(fn);
    return (arg) => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(arg); db.exec('COMMIT'); return r; } catch(e) { db.exec('ROLLBACK'); throw e; } };
  };
  
  return createClientStoreBase({
    materializedViews: options.materializedViews,
    materializedBackfillChunkSize: options.materializedBackfillChunkSize,
    
    storageLoadMetaInt: async (key, fallback) => {
      const row = loadCursorStmt.get(key);
      return row ? parseIntSafe(row.value) : fallback;
    },
    
    storageSaveMetaInt: async (key, value) => {
      saveCursorStmt.run(key, String(value));
    },
    
    storageInsertDraftRow: async (row) => {
      insertDraftStmt.run({
        id: row.id,
        partition: row.partition,
        // ... 6 more fields ...
      });
    },
    
    storageLoadDraftRows: async () => {
      return listDraftsStmt.all().map(r => ({
        draft_clock: r.draft_clock,
        id: r.id,
        // ... parse to standard DraftRow shape ...
      }));
    },
    
    storageDeleteDraftById: async (id) => {
      deleteDraftByIdStmt.run({ id });
    },
    
    storageInsertCommittedRow: async (row) => {
      const result = insertCommittedStmt.run({
        committed_id: row.committedId,
        id: row.id,
        payload: serializePayload(row.payload),
        // ...
      });
      return { changes: result.changes };
    },
    
    storageGetCommittedById: async (id) => {
      return getCommittedByIdStmt.get({ id });
    },
    
    storageGetCommittedByCommittedId: async (committedId) => {
      return getCommittedByCommittedIdStmt.get({ committed_id: committedId });
    },
    
    storageLoadCommittedAfter: async (sinceCommittedId, limit) => {
      return listCommittedAfterStmt.all({ since_committed_id: sinceCommittedId, limit });
    },
    
    storageGetMaxCommittedId: async () => {
      const row = getLatestCommittedIdStmt.get();
      return row ? parseIntSafe(row.max_committed_id) : 0;
    },
    
    storageEnsureSchema: async () => {
      // Run pragmas, create tables, validate schema
      db.exec(`PRAGMA journal_mode=${options.journalMode ?? 'WAL'};`);
      db.exec(`CREATE TABLE IF NOT EXISTS local_drafts (...);`);
      db.exec(`CREATE TABLE IF NOT EXISTS committed_events (...);`);
      db.exec(`CREATE TABLE IF NOT EXISTS app_state (...);`);
      db.exec(`CREATE TABLE IF NOT EXISTS materialized_view_state (...);`);
      prepareStatements();
    },
    
    storageValidateSchema: async () => { /* column checks */ },
    storageClose: async () => { /* db.close() */ },
    
    // Materialized view storage
    storageLoadViewCheckpoint: async ({ viewName, partition }) => {
      const row = getViewStateStmt.get({ view_name: viewName, partition });
      return row ? { viewVersion: row.view_version, lastCommittedId: row.last_committed_id, value: JSON.parse(row.value), updatedAt: row.updated_at } : null;
    },
    storageSaveViewCheckpoint: async (checkpoint) => {
      upsertViewStateStmt.run({ ...checkpoint, value: JSON.stringify(checkpoint.value) });
    },
    storageDeleteViewCheckpoint: async ({ viewName, partition }) => {
      deleteViewStateStmt.run({ view_name: viewName, partition });
    },
  });
};
```

### 6.4 Line Count Reduction

| Component | Before | After | Reduction |
|-----------|--------|-------|-----------|
| `client-store-base.js` | 0 | ~300 | New |
| `in-memory-client-store.js` | 336 | ~60 | -82% |
| `indexeddb-client-store.js` | 742 | ~180 | -76% |
| `sqlite-client-store.js` | 788 | ~120 | -85% |
| `libsql-client-store.js` | 821 | ~130 | -84% |
| `async-sqlite-client-store.js` | 978 | ~160 | -84% |
| **Total** | **3,665** | **~950** | **-74%** |

The ~180 lines for IndexedDB remain higher because IndexedDB's transaction API requires more adapter code (request-to-promise wrapping, cursor iteration, database open/upgrade).

### 6.5 Shared Serialization Module

Extract row serialization/parsing that's currently duplicated 4 times:

```javascript
// src/store/serialization.js

export const parseCommittedRow = (row) => ({
  committedId: row.committed_id,
  id: row.id,
  projectId: row.project_id || undefined,
  userId: row.user_id || undefined,
  partition: row.partition,
  type: row.type,
  schemaVersion: row.schema_version,
  payload: row.payload, // already deserialized by adapter
  clientTs: row.client_ts,
  serverTs: row.server_ts,
  createdAt: row.created_at,
});

export const serializeCommittedRow = (event) => ({
  committed_id: event.committedId,
  id: event.id,
  project_id: event.projectId ?? null,
  user_id: event.userId ?? null,
  partition: event.partition,
  type: event.type,
  schema_version: event.schemaVersion,
  payload: event.payload, // adapter handles serialization
  client_ts: event.clientTs,
  server_ts: event.serverTs,
  created_at: event.createdAt ?? Date.now(),
});

// Same for draft rows
export const parseDraftRow = (row) => ({ /* ... */ });
export const serializeDraftRow = (draft) => ({ /* ... */ });
```

### 6.6 Shared Schema Module

The DDL and validation is identical across sqlite/libsql/async-sqlite stores:

```javascript
// src/store/schema-migrations.js

export const CLIENT_STORE_DDL = `
  CREATE TABLE IF NOT EXISTS local_drafts (
    draft_clock INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    partition TEXT NOT NULL,
    type TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    payload BLOB NOT NULL,
    payload_compression TEXT DEFAULT NULL,
    client_ts INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS committed_events (
    committed_id INTEGER PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT,
    user_id TEXT,
    partition TEXT NOT NULL,
    type TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    payload BLOB NOT NULL,
    payload_compression TEXT DEFAULT NULL,
    client_ts INTEGER NOT NULL,
    server_ts INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS materialized_view_state (
    view_name TEXT NOT NULL,
    partition TEXT NOT NULL,
    view_version TEXT NOT NULL,
    last_committed_id INTEGER NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(view_name, partition)
  );
`;

export const CLIENT_STORE_SCHEMA_VERSION = 6;

export const validateClientStoreSchema = async (adapter) => {
  const checks = await Promise.all([
    adapter.hasColumn('local_drafts', 'partition'),
    adapter.hasColumn('committed_events', 'partition'),
    adapter.hasColumn('committed_events', 'server_ts'),
    adapter.getColumnType('local_drafts', 'payload'),
    adapter.getColumnType('committed_events', 'payload'),
    // Negative checks
    adapter.hasColumn('local_drafts', 'project_id').then(v => !v),
    adapter.hasColumn('local_drafts', 'user_id').then(v => !v),
    adapter.hasColumn('local_drafts', 'meta').then(v => !v),
  ]);
  
  if (!checks.every(Boolean)) {
    throw new Error('Client store schema is incompatible; reset required');
  }
};
```

---

## 7. Migration Path

### 7.1 Phase Ordering (Respects Roadmap Phase 3: Tests First)

**Phase A: Extract store base (highest ROI, lowest risk)**

1. Create `src/store/client-store-base.js` with all domain logic
2. Create `src/store/serialization.js` with shared row parsing
3. Create `src/store/schema-migrations.js` with shared DDL
4. Refactor `in-memory-client-store.js` to use base (canary)
5. Run existing test suite — must pass identically
6. Refactor remaining stores one at a time, running tests after each

**Phase B: Extract client state machine**

1. Create `src/client/client-state-machine.js`
2. Add unit tests for all state transitions
3. Refactor `sync-client.js` to use FSM instead of boolean flags
4. Run full protocol conformance suite

**Phase C: Extract protocol codec and reconnect policy**

1. Create `src/client/protocol-codec.js`
2. Create `src/client/reconnect-policy.js`
3. Create `src/client/draft-queue.js`
4. Verify message encoding matches wire format via existing tests

**Phase D: Split monoliths into layered modules**

1. Create `src/client/sync-orchestrator.js`
2. Refactor `sync-client.js` into thin facade
3. Extract `src/server/session.js` from `sync-server.js`
4. Full regression suite

### 7.2 Compatibility Guarantees

- **Wire protocol:** Zero changes. All refactoring is internal.
- **Public API:** `createSyncClient`, `createSyncServer`, `createXxxStore` factory signatures remain identical.
- **Store interface:** The contract defined in AD-002 (`insertDraft`, `loadDraftsOrdered`, `applySubmitResult`, `applyCommittedBatch`, `loadCursor`) is the boundary that `client-store-base.js` implements.

### 7.3 Risk Mitigation

| Risk | Mitigation |
|------|-----------|
| Behavioral regression during refactor | Existing 18-scenario conformance suite + store tests run after every file change |
| Schema migration compatibility | Schema version remains 6; DDL is extracted verbatim |
| IndexedDB adapter complexity | IndexedDB adapter remains the "thickest" at ~180 lines due to IDB's async transaction model |
| Async write ordering in async-sqlite | The `writeTail` serialization pattern is preserved in the adapter layer |

---

## Appendix A: Specific Code-Level Recommendations

### A.1 sync-client.js: Replace Inbound Queue Pattern

**Current (lines 979-985):**
```javascript
unsubscribeTransport = transport.onMessage((message) => {
  inboundQueue = inboundQueue
    .catch(() => {})
    .then(() =>
      withInboundErrorHandling(() => handleServerMessage(message)),
    );
});
```

**Issue:** If `inboundQueue` rejects, `.catch(() => {})` silently swallows the error. The error is logged inside `withInboundErrorHandling`, but the queue promise chain can grow unbounded because each message appends to the chain regardless of prior failures.

**Recommendation:** Use a bounded queue or at minimum, track queue depth and warn:

```javascript
let inboundDepth = 0;
unsubscribeTransport = transport.onMessage((message) => {
  inboundDepth += 1;
  if (inboundDepth > 100) {
    log({ event: 'inbound_queue_depth_warning', depth: inboundDepth });
  }
  inboundQueue = inboundQueue
    .catch(() => {})
    .then(async () => {
      inboundDepth -= 1;
      await withInboundErrorHandling(() => handleServerMessage(message));
    });
});
```

### A.2 sync-client.js: Remove Duplicate `isTransportDisconnectedError`

This function is defined identically in both `sync-client.js` (line 95) and `command-sync-session.js` (line 11). Extract to a shared module:

```javascript
// src/transport-error.js
export const isTransportDisconnectedError = (error) => {
  const code = error?.code;
  if (code === 'transport_disconnected') return true;
  const message = String(error?.message || '').toLowerCase();
  return (
    message.includes('disconnected') ||
    message.includes('not connected') ||
    message.includes('websocket is not connected')
  );
};
```

### A.3 Server Session: Extract Rate Limiting

The `enforceInboundGuards` function (sync-server.js lines 258-320) mixes rate limiting, size checking, and guard application. Extract:

```javascript
// src/server/inbound-guards.js
export const createInboundGuards = ({ clock, limits, sendError }) => {
  return {
    check: async (session, message, msgId) => {
      // Rate limit check
      // Size check
      // Return { allowed: boolean }
    },
  };
};
```

### A.4 Materialized View Runtime: Lock Implementation

The current lock implementation (materialized-view-runtime.js lines 136-155) uses promise chaining:

```javascript
const acquireLock = async (lockKey) => {
  const previousTail = lockTails.get(lockKey) || Promise.resolve();
  let releaseCurrent;
  const currentLock = new Promise((resolve) => { releaseCurrent = resolve; });
  const currentTail = previousTail.catch(() => {}).then(() => currentLock);
  lockTails.set(lockKey, currentTail);
  await previousTail.catch(() => {});
  // ...
};
```

This is elegant and already includes cleanup (lines 151-153 delete the lock tail entry on release). However, the pattern has a subtle risk: if `release` is never called (e.g., an uncaught exception between `acquireLock` and the `finally` block), the lock tail entry remains in the Map forever, and subsequent acquisitions for the same key will await a promise that never settles. Consider adding a timeout guard:

```javascript
// Add timeout to prevent permanent lock hangs
const LOCK_TIMEOUT_MS = 30_000;
const timeoutId = setTimeout(() => {
  if (!released) {
    logger({ event: 'lock_timeout_warning', lockKey });
    release(); // Force release after timeout
  }
}, LOCK_TIMEOUT_MS);
```

### A.5 Store Close Semantics: Standardize

The 5 client stores have inconsistent close behavior:

| Store | Double-close safe? | Flushes views on close? | Awaits init on close? |
|-------|-------------------|------------------------|----------------------|
| in-memory | ✓ | ✓ | N/A |
| indexeddb | ✓ | ✓ | ✓ |
| sqlite | ✓ | ✓ | N/A (sync init) |
| libsql | ✓ | ✓ | ✗ |
| async-sqlite | ✓ | ✓ | ✗ |

**Recommendation:** The base class in Proposal 5 standardizes this:

```javascript
close: async () => {
  if (closed) return;
  closed = true;
  // Always await pending init
  if (initPromise) await initPromise.catch(() => {});
  // Always flush views
  if (materializedViewRuntime) {
    await materializedViewRuntime.flushMaterializedViews();
    await materializedViewRuntime.close();
  }
  await storageClose();
},
```

---

## Appendix B: File Dependency Graph (Current)

```
sync-client.js
├── event-record.js (normalizeSubmitEventInput, normalizeClientTs, ...)
├── id.js (generateId)
├── store-errors.js (throwIfClosed)

sync-server.js
├── event-record.js (normalizeMeta, isNonEmptyString, ...)
├── (no id.js dependency — has its own msgId counter)

in-memory-client-store.js
├── canonicalize.js
├── event-record.js
├── materialized-view.js
├── materialized-view-runtime.js
├── store-errors.js

sqlite-client-store.js  (+ libsql, async-sqlite)
├── canonicalize.js
├── event-record.js
├── materialized-view.js
├── materialized-view-runtime.js
├── payload-codec.js
├── store-errors.js
├── libsql-driver.js (libsql, async-sqlite only)

indexeddb-client-store.js
├── canonicalize.js
├── event-record.js
├── materialized-view.js
├── materialized-view-runtime.js
├── store-errors.js
(no payload-codec — IDB stores JSON directly)
```

**Note:** `indexeddb-client-store.js` does NOT use `payload-codec.js` — it stores payload as structuredClone JSON directly in IDB. This is a meaningful difference that the base class approach must accommodate (the serialization adapter point handles this).

---

## Appendix C: Summary of Proposed New Files

| File | Purpose | Est. Lines |
|------|---------|-----------|
| `src/client/client-state-machine.js` | FSM replacing 7 boolean flags | ~100 |
| `src/client/protocol-codec.js` | Message encode/decode | ~200 |
| `src/client/reconnect-policy.js` | Backoff calculation | ~80 |
| `src/client/draft-queue.js` | Batch building, size limits | ~150 |
| `src/client/sync-orchestrator.js` | Coordinates sync flow | ~300 |
| `src/server/session.js` | Per-connection state | ~300 |
| `src/server/inbound-guards.js` | Rate limiting | ~100 |
| `src/server/broadcast.js` | Fan-out logic | ~80 |
| `src/store/client-store-base.js` | All domain logic, written once | ~300 |
| `src/store/serialization.js` | Row parse/serialize | ~80 |
| `src/store/schema-migrations.js` | Shared DDL + validation | ~80 |
| `src/transport-error.js` | Shared error classification | ~15 |
| **Total new** | | **~1,785** |
| **Total removed (from dedup)** | | **~2,700** |
| **Net change** | | **-915 lines (-10%)** |

The line count reduction is modest because the goal is **clarity and testability**, not brevity. Each extracted module is independently testable, has a single responsibility, and can be understood in isolation.
