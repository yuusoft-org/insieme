# Insieme Exhaustive Review — Master Synthesis

**Date:** 2026-05-08  
**Scope:** Architecture, Protocol, Storage, Consumer DX, Projections, Scalability, Testing, Competitive Landscape  
**Method:** 8 parallel deep-dive analyses (~5,200 lines of reports across 8 documents)

---

## Executive Summary

Insieme v2.1.1 is a well-designed offline-first sync library with a clean protocol and solid crash-recovery guarantees. However, it has **three systemic weaknesses** that compound into significant pain for real consumers:

1. **Massive internal duplication** — 6 store implementations share ~70% identical code (~3,600 lines of waste)
2. **Insufficient abstraction power** — consumers must build 3,000+ lines of infrastructure that should be library-native (projections, SQLite locking, WAL management)
3. **No horizontal scaling story** — single-process server with in-memory sessions limits production deployment

These are addressable through 4 major workstreams without breaking the public API.

---

## Report Inventory

| # | Report | Lines | Key Finding |
|---|--------|-------|-------------|
| 1 | [Architecture Redesign Proposal](architecture-redesign-proposal.md) | 1,230 | 7 boolean flags → formal 8-state FSM; extract ProtocolCodec, DraftQueue, ReconnectPolicy |
| 2 | [Protocol & Sync Deep Dive](../protocol/SYNC-DEEP-DIVE-ANALYSIS.md) | 1,012 | No HTTP fallback, no backpressure signal, broadcast is fire-and-forget |
| 3 | [Storage Layer Unified Architecture](../drafts/storage-layer-unified-architecture.md) | 1,116 | 76% code reduction possible via ClientStoreCore + adapter pattern |
| 4 | [Consumer Pain Points](consumer-pain-points.md) | 757 | RouteVN built 2,000+ lines of projection replay, 350+ lines of SQLite workarounds |
| 5 | [Competitive Analysis](competitive-analysis.md) | 598 | Every competitor provides query/reactive layers; Insieme only has materialized views |
| 6 | [Materialized Views Analysis](materialized-views-analysis.md) | 1,314 | Consumer's 2,492-line projection.js should be expressible in ~200 lines of library API |
| 7 | [Scalability & Production](scalability-production.md) | 556 | Single-process server caps at ~500 concurrent connections |
| 8 | [Testing & Reliability](testing-reliability.md) | 516 | Zero fuzz/property-based/soak testing; store crash recovery is strongest area |

---

## Top 20 Findings (Ranked by Impact)

### Critical (P0) — Must Fix

| # | Finding | Source | Impact |
|---|---------|--------|--------|
| 1 | **Store duplication: 3,600 lines of ~70% identical code** | Storage | Bugs must be fixed in 5 places. New backends require 800+ lines. |
| 2 | **No projection checkpoint/replay engine** | Consumer + MV | RouteVN built 2,492 lines of replay infrastructure that every consumer will need |
| 3 | **SQLite locking not handled by library** | Consumer | Consumer built 350+ lines of SQLITE_BUSY retry, operation queuing, WAL checkpointing |
| 4 | **7 boolean flags = 128 implicit client states** | Architecture | 12+ compound boolean guards; impossible to reason about all state transitions |
| 5 | **No query/reactive layer** | Competitive | Every competitor (PowerSync, RxDB, Convex) provides this; consumers left to build it |

### High (P1) — Should Fix

| # | Finding | Source | Impact |
|---|---------|--------|--------|
| 6 | **No cross-server broadcast** | Scalability | Limits to single-process deployment; can't scale past ~500 connections |
| 7 | **No HTTP fallback for sync** | Protocol | WebSocket handshake failure blocks all sync; no bulk download path |
| 8 | **No backpressure signal** | Protocol | Rate limiting is binary (close connection or allow); no graceful degradation |
| 9 | **No lifecycle events for UI** | Consumer | No online/offline signal; consumers must poll `getStatus().connected` |
| 10 | **TypeScript is declaration-only** | DX | Store interface contract is implicit in JSDoc; no compile-time guarantees |

### Medium (P2) — Should Plan

| # | Finding | Source | Impact |
|---|---------|--------|--------|
| 11 | **Zero fuzz/property-based testing** | Testing | Protocol parsing, batch building, store serialization are untested for edge cases |
| 12 | **No monitoring/metrics/health checks** | Scalability | No production observability; can't detect performance degradation |
| 13 | **Cross-partition projections absent** | MV | Consumer manually merges main+scene partitions; library only supports single-partition views |
| 14 | **Draft queue invisible to consumers** | Consumer | No way to query "how many drafts are pending?" from the session API |
| 15 | **No projection schema migration** | MV | Schema changes require full replay from event zero |

### Lower (P3) — Backlog

| # | Finding | Source | Impact |
|---|---------|--------|--------|
| 16 | **No snapshot+delta for large histories** | Protocol | Cold-start sync must page through entire event history linearly |
| 17 | **Error handling uses plain Error objects** | DX | No custom error hierarchy; consumers can't pattern-match reliably |
| 18 | **Double structuredClone on every committed event** | Consumer | 4 clones per event in the consumer's callback chain |
| 19 | **No graceful shutdown/drain** | Scalability | Server closes connections immediately on shutdown |
| 20 | **No multi-tenant isolation** | Scalability | Shared DB with no row-level security |

---

## Proposed Architecture (4 Workstreams)

### Workstream 1: Unified Storage Layer
**Goal:** Reduce 4,728 lines of store code to ~1,130 lines (76% reduction)

```
ClientStoreCore (business logic, ~600 lines)
├── InMemoryAdapter (~60 lines) → replaces in-memory-client-store.js (336 lines)
├── SqliteAdapter (~120 lines) → replaces sqlite-client-store.js (788 lines)
├── LibsqlAdapter (~100 lines) → replaces libsql-client-store.js (821 lines)
├── IndexedDbAdapter (~100 lines) → replaces indexeddb-client-store.js (742 lines)
└── AsyncSqliteAdapter (~80 lines) → replaces async-sqlite-client-store.js (978 lines)
```

Each adapter implements only **10-13 storage primitives** (raw read/write/delete). All business logic (dedup, cursor management, schema validation, materialized view wiring) lives in the core once.

**Key insight from analysis:** `normalizeCommittedEvent()`, `toComparisonKey()`, `parseDraft()`, `parseCommittedRow()`, `validateSchema()`, `assertCommittedInvariant()`, `runPragmas()` are all duplicated verbatim across 5 files.

See: [storage-layer-unified-architecture.md](../drafts/storage-layer-unified-architecture.md)

### Workstream 2: Client State Machine + Protocol Layering
**Goal:** Replace implicit boolean state with formal FSM; extract protocol from transport

```
ClientStateMachine (8 states: idle → connecting → connected → syncing → ready → disconnected → reconnecting → closed)
ProtocolCodec (encode/decode messages, version negotiation)
DraftQueue (batch building, size limits, flush ordering)
ReconnectPolicy (exponential backoff with jitter, extracted from client)
SyncOrchestrator (cursor management, pagination, gap detection)
```

**Key insight:** The current `sync-client.js` has 7 boolean flags creating 128 possible state combinations, of which ~116 are invalid. A formal 8-state FSM with explicit transition table makes every state reachable and every transition explicit.

See: [architecture-redesign-proposal.md](architecture-redesign-proposal.md)

### Workstream 3: Production Projection Engine
**Goal:** Make RouteVN's 2,492-line projection.js expressible in ~200 lines of library API

```typescript
// Proposed API (from analysis)
const projection = createProjection({
  name: "project-state",
  version: "1",
  
  // Cross-partition composition
  sources: {
    main: { partition: MAIN_PARTITION },
    scenes: { partitionPattern: "scene-{sceneId}" },
  },
  
  // Incremental routing
  routes: {
    "project.rename": ["main"],
    "scene.create": ["main", "scenes"],
    "dialogue.update": ["scenes"],
  },
  
  reduce: { main: mainReducer, scenes: sceneReducer },
  compose: (main, scenes) => ({ ...main, scenes }),
  
  // Checkpointing
  checkpoint: { 
    strategy: "threshold", 
    every: 1000, 
    persist: true,
    migrate: migrationChain 
  },
});
```

**Key insight:** RouteVN built a 3-tier projection architecture (main state, scene projections, scene overview) with error recovery, idempotency, batch fallback, progress reporting, and diagnostic error creation — all of which should be library primitives.

See: [materialized-views-analysis.md](materialized-views-analysis.md)

### Workstream 4: Server Horizontal Scaling
**Goal:** Scale from ~500 to 50K+ concurrent connections

```
Phase 1 (Week 1-2): Redis Pub/Sub broadcast bus
Phase 2 (Week 3-4): Sticky routing at load balancer
Phase 3 (Week 5-6): Session externalization (Redis/Valkey)
Phase 4 (Week 7-8): Read replicas for sync queries
```

**Key insight:** The current `broadcastCommitted()` iterates `sessions.values()` on one process. With Redis Pub/Sub, each server subscribes to project channels and forwards broadcasts to local sessions. No protocol changes required.

See: [scalability-production.md](scalability-production.md)

---

## Competitive Positioning

Insieme occupies a unique niche: **self-hostable, minimal-dependency, event-sourced offline-first sync**. 

| Competitor | Sync Model | Self-Hosted | Offline | Storage | Conflict Resolution |
|-----------|-----------|-------------|---------|---------|-------------------|
| **Insieme** | Cursor WS | ✅ | ✅ | SQLite/IndexedDB/LibSQL | Server LWW |
| PowerSync | Postgres replication | ❌ (cloud) | ✅ | SQLite | LWW + custom |
| RxDB | Reactive streams | ✅ | ✅ | IndexedDB/SQLite | CRDT plugins |
| Yjs | CRDT | ✅ | ✅ | Any | CRDT (Y.js) |
| Convex | Real-time backend | ❌ (cloud) | Partial | Convex DB | LWW |
| Triplit | Distributed SQLite | ✅ | ✅ | SQLite | CRDT merge |

**Insieme's differentiators:** Event sourcing (full audit trail), multi-backend storage, zero vendor lock-in, 2 runtime dependencies.

**Insieme's gaps:** No query engine, no reactive subscriptions, no built-in conflict resolution beyond LWW, consumer DX requires too much boilerplate.

See: [competitive-analysis.md](competitive-analysis.md)

---

## Implementation Roadmap

### Phase 1 (Weeks 1-3): Foundation
- [ ] Implement `ClientStoreCore` + adapter pattern (Workstream 1)
- [ ] Formalize client state machine (Workstream 2)
- [ ] Add projection checkpoint/replay engine (Workstream 3, core)

### Phase 2 (Weeks 4-6): Protocol & DX  
- [ ] HTTP sync fallback endpoint
- [ ] Backpressure signal in protocol
- [ ] Lifecycle events (online/offline, sync progress)
- [ ] TypeScript migration (`.js` → `.ts`)
- [ ] Custom error hierarchy

### Phase 3 (Weeks 7-10): Scale & Polish
- [ ] Redis Pub/Sub broadcast bus
- [ ] Cross-partition projection composition
- [ ] Reactive query subscriptions
- [ ] Monitoring/metrics/health checks
- [ ] Fuzz + property-based testing suite

### Phase 4 (Weeks 11-14): Advanced
- [ ] Snapshot+delta sync for large histories
- [ ] Optional CRDT conflict resolution
- [ ] Multi-tenant isolation
- [ ] Graceful shutdown/drain
- [ ] Soak testing infrastructure

---

## What Insieme Gets Right

The analysis isn't all critical. These design decisions are genuinely good:

1. **Event-sourced backbone** — Full audit trail, time-travel debugging, exactly-once processing via server dedup
2. **Offline-first from day one** — Draft queue, offline transport, cursor-based catch-up
3. **Protocol simplicity** — 5 message types (connect, submit_events, sync, broadcast, error) covers all cases
4. **Idempotent commits** — `commitOrGetExisting` prevents duplicate processing on retry
5. **Promise-chain serialization** — `inboundQueue` and `receiveQueue` prevent reordering without locks
6. **Minimal dependencies** — Only `immer` and `nanoid`; no framework lock-in
7. **Environment-split entry points** — Browser/node/server paths prevent bundling server code into clients
8. **Store crash recovery** — Subprocess kill tests, crash-after-persist tests, WAL recovery tests (strongest testing area)

---

*This synthesis was produced from 8 parallel deep-dive analyses totaling ~5,200 lines. See individual reports for detailed code, specific recommendations, and migration paths.*
