# Testing & Reliability Analysis

**Review date:** May 8, 2026
**Scope:** 35 test files, 10,569 lines across `spec/protocol/src/*.test.js` plus 19 sync-scenario docs and `docs/review/test-plan.md`.

---

## Executive Summary

Insieme's test suite is **strong in protocol scenario coverage, store-level correctness, and schema-version safety**. All 19 documented sync scenarios (SC-00 through SC-18) have corresponding passing tests. Store implementations across all backends (in-memory, SQLite, libsql, IndexedDB, async-sqlite) share a consistent test matrix covering migrations, crash recovery, cursor monotonicity, idempotent apply, and materialized view lifecycle.

However, the suite has **significant gaps in chaos/resilience testing, concurrent conflict simulation, network partition handling, and non-functional quality categories** (fuzzing, property-based, long-running, memory leak). These gaps represent real production risk for a distributed sync engine.

**Overall grade: B for correctness, C- for resilience/chaos.**

---

## 1. Scenario Coverage: Tested vs. Missing

### Covered (all 19 sync scenarios mapped to tests)

| Scenario | Description | Test Location | Quality |
|---|---|---|---|
| SC-00 | Handshake + empty sync | `sync-client.test.js`, `sync-server.test.js` | Thorough |
| SC-01 | Local draft commit + broadcast | `sync-client.test.js`, `sync-server.test.js` | Thorough |
| SC-02 | Local draft rejected | `sync-client.test.js` | Thorough |
| SC-03 | Duplicate submit retry (idempotent) | `sync-client.test.js`, `reliability-integration.test.js` | Thorough |
| SC-04 | Multi-partition event | `sync-server.test.js` | Adequate |
| SC-05 | Reconnect catch-up (paged) | `reliability-integration.test.js` (SC-05/16/17 reconnect storm) | Strong |
| SC-06 | Out-of-order commit arrival | `reliability-integration.test.js` | Thorough |
| SC-07 | Snapshot + prune | Materialized view tests | Adequate |
| SC-08 | Local validation gate | `reliability-integration.test.js` | Thorough |
| SC-09 | Same id, different payload | `in-memory-sync-store.test.js`, store tests | Thorough |
| SC-10 | Origin result vs peer broadcast | `sync-server.test.js` | Adequate |
| SC-11 | Reordered commit results | `reliability-integration.test.js` | Thorough |
| SC-12 | Partition added mid-session | `sync-client.test.js` | Adequate |
| SC-13 | Retry while draft pending | `sync-client.test.js` | Adequate |
| SC-14 | LWW concurrent update | `reliability-integration.test.js` (SC-14) | Adequate |
| SC-15 | Server crash after persist | `reliability-integration.test.js` (SC-13/15), `sqlite-process-crash.test.js` | Strong |
| SC-16 | Offline queue drain | `reliability-integration.test.js` (SC-16/17), `offline-transport.test.js` | Strong |
| SC-17 | Transport close + reconnect | `reliability-integration.test.js`, `browser-websocket-transport.test.js` | Strong |
| SC-18 | Error boundaries + version | `sync-server-conformance.test.js` | Thorough |

### Missing Scenarios (not covered by any test)

| Gap | Risk | Details |
|---|---|---|
| **SC-07 snapshot prune actually exercised end-to-end** | Medium | Snapshot+prune is documented but the test only covers materialized view flush/evict. No test verifies actual pruning of committed events from the store after snapshot. |
| **Large event payload handling** | Medium | No test with payloads >100KB or >1MB. No test for payload compression/decompression roundtrip under real data. |
| **Multi-project isolation** | High | No test verifies that client connected to project-A cannot read/submit events for project-B through the sync protocol. Authz checks exist in conformance tests but full isolation verification is absent. |
| **Session resumption after auth token expiry** | Medium | No test simulates a long-lived session where the auth token expires mid-sync and needs re-authentication. |
| **Server-side validation rejection path** | Medium | `validate` hooks exist but only tested lightly. No test exercises the full server validation rejection → client receives rejection → draft removed flow. |
| **Schema migration across versions 1→4 (sync) and 1→6 (client)** | High | Tests only check that unsupported versions are rejected. No test exercises an actual incremental migration path from an older schema version. |
| **Cursor regression (decreasing cursor)** | Medium | Tests check monotonicity (cursor doesn't decrease), but only through `applyCommittedBatch`. No test covers a malicious server sending a decreasing cursor. |
| **Broadcast to multiple concurrent clients** | Medium | SC-14 tests concurrent writes from 2 clients, but no test verifies server broadcast fanout to N connected clients after one client's commit. |

---

## 2. Chaos Testing Assessment

### What Exists

| Test | Lines | What It Tests |
|---|---|---|
| `sqlite-locking-chaos.test.js` | 118 | SQLITE_BUSY under concurrent writer lock → error detection + recovery |
| `sqlite-process-crash.test.js` | 71 | Subprocess crash after durable commit → dedupe on retry |
| `reliability-integration.test.js` (SC-05/16/17 storm) | 706 | 3-client reconnect storm with 120 randomized steps × 5 seeds |
| `sqlite-end-to-end-reliability.test.js` | 215 | Full client/server restart cycle with offline draft drain |
| `libsql-sync-store.test.js` crash recovery | 205 | Crash-after-persist with same-id dedupe |

**Assessment:** The reconnect storm test (`reliability-integration.test.js`, line 607-704) is the strongest chaos test. It uses seeded RNG, 3 concurrent clients, and 120 random steps per seed across 5 seeds. This tests convergence guarantees well.

### What's Missing

| Missing Chaos Category | Risk | Impact |
|---|---|---|
| **Random transport failures mid-message** | High | No test corrupts or drops individual messages during a sync exchange |
| **Server store partial write failures** | High | Only `libsql-client-store.test.js` tests rollback on `INSERT INTO app_state` failure. No test for partial committed_events insert failure. |
| **Concurrent client connects to same server store** | High | No test with 10+ clients connecting simultaneously to the same sync server |
| **Database file corruption / WAL replay** | Medium | No test with corrupted SQLite WAL file or dirty shutdown |
| **Disk full during commit** | Medium | No test for SQLITE_FULL or SQLITE_IOERR during write operations |
| **Memory pressure during large batch apply** | Medium | No test applying 10,000+ events in a single `applyCommittedBatch` call |
| **Transport latency spikes** | Medium | No test simulates high-latency transport that could cause client-side timeouts |
| **Random event payload corruption** | Medium | No test corrupts payload bytes after canonicalization |

**Chaos testing grade: C.** The reconnect storm is good. Process crash testing is good. But there are no network-level chaos tests, no disk-level chaos tests, and no concurrent-access stress tests beyond the 3-client storm.

---

## 3. Race Condition Coverage

### What Exists

- **Concurrent `init()` calls**: `libsql-client-store.test.js` line 153 — `Promise.all([store.init(), store.init()])` verifies idempotent migration.
- **Concurrent client writes**: `reliability-integration.test.js` SC-14 — two clients submit simultaneously and converge.
- **Lock contention**: `sqlite-locking-chaos.test.js` — explicit `BEGIN IMMEDIATE` lock to force SQLITE_BUSY.
- **Reconnect storm**: `reliability-integration.test.js` SC-05/16/17 — randomized disconnect/reconnect cycles.

### What's Missing

| Race Condition | Risk | Status |
|---|---|---|
| **Concurrent `applyCommittedBatch` + `insertDraft` on same store** | High | Not tested. Could cause cursor corruption if not internally serialized. |
| **Concurrent `syncNow()` calls from different async contexts** | High | Not tested. The sync client could receive overlapping sync responses. |
| **Concurrent `submitEvent` + `stop()` on sync client** | Medium | Not tested. Submit during shutdown could leave orphaned drafts. |
| **Two sync clients sharing one IndexedDB store** | High | Not tested (and likely unsupported, but no guard documented). |
| **Read-your-writes consistency under concurrent operations** | Medium | Not tested. A `loadMaterializedView` immediately after `applyCommittedBatch` should see the new state. |
| **Event loop starvation under heavy load** | Medium | No test with rapid fire `submitEvent` calls (100+ in <10ms) to verify no event loop blocking. |

**Race condition coverage grade: C.** The existing tests are well-structured for the scenarios they cover, but they all use sequential or lightly-concurrent patterns. True concurrent stress testing is absent.

---

## 4. Network Partition Simulation

### What Exists

- **Loopback transport** in `reliability-integration.test.js` and `sqlite-end-to-end-reliability.test.js`: Simulates disconnect via `transport.disconnect()` and reconnect via `transport.connect()`.
- **Offline transport** (`offline-transport.test.js`, 288 lines): Full offline-mode transport that buffers submits and replays on reconnect.
- **Browser WebSocket transport** (`browser-websocket-transport.test.js`, 255 lines): Mock WebSocket with connect/close/error events.

### What's Missing

| Network Partition Scenario | Risk | Status |
|---|---|---|
| **Partial connectivity (client can send but not receive)** | High | Not tested. Could cause client to believe events were lost when server actually committed them. |
| **Split-brain (two servers, clients partitioned)** | High | Not applicable (single-server architecture), but no test for server restart with different store state. |
| **Slow network (messages arrive out of order)** | High | Not tested. The loopback transport delivers synchronously/in-order. |
| **Message deduplication on retransmit** | Medium | Only tested at the store level (SC-03). Not tested at the transport level where the same sync response could arrive twice. |
| **Transport close during submit_events_result delivery** | High | Not tested. If the transport closes between server commit and result delivery, the client should retry and dedupe. This is tested at the store level but not in a full E2E transport scenario. |

**Network partition simulation grade: C-.** The offline transport is well-tested, but there are no tests for partial failures, out-of-order delivery, or retransmit scenarios at the transport layer.

---

## 5. Concurrent Client Conflict Scenarios

### What Exists

- **SC-14 LWW conflict**: `reliability-integration.test.js` line 486 — two clients submit concurrently, server orders by committedId, both converge.
- **Concurrent writes convergence**: Same test verifies both clients see identical committed events after sync.
- **Reconnect storm**: 3 clients × 120 steps × 5 seeds with random submit/disconnect/sync cycles.

### What's Missing

| Conflict Scenario | Risk | Status |
|---|---|---|
| **Three+ clients editing the same entity simultaneously** | High | Only 2-client concurrent test exists. 3+ clients could expose ordering edge cases. |
| **Client offline for 1000+ events, then reconnects** | Medium | Not tested. Could expose performance issues in large catch-up sync. |
| **Conflicting materialized view state after concurrent reduce** | High | No test with concurrent `applyCommittedBatch` calls that affect the same partition's materialized view. |
| **Draft ID collision from different clients** | Medium | Not tested. Two clients generating the same UUID (extremely unlikely but possible) should be handled by server-side dedupe. |
| **Rejected event from one client affecting another's view** | Medium | Not tested. If C1's event is rejected but C2 already received it via broadcast, does C2's view stay consistent? |

**Concurrent conflict grade: B-.** The 2-client LWW test and reconnect storm are solid. But the library should have more tests with 5+ concurrent clients and higher contention patterns.

---

## 6. Store Integrity Under Crash

### What Exists

| Test | What It Verifies |
|---|---|
| `sqlite-process-crash.test.js` | Subprocess `process.exit(23)` after commit → data durable on disk → dedupe on retry |
| `libsql-sync-store.test.js` crash recovery | `crashyCommit` throws after persist → reopen store → dedupe returns original |
| `sqlite-end-to-end-reliability.test.js` | Full client+server restart cycle → offline draft drain → server/client committed events match |
| `libsql-client-store.test.js` rollback tests | Delete-draft failure → committed_events insert rolled back; cursor-save failure → entire batch rolled back |
| `async-sqlite-client-store.test.js` rollback | Committed batch write fails at cursor persistence → events not persisted, cursor stays at 0 |

**Assessment:** This is the **strongest area** of the test suite. Every store backend has crash-after-persist and rollback tests. The process-crash test using `spawnSync` is particularly rigorous.

### What's Missing

| Crash Integrity Gap | Risk | Status |
|---|---|---|
| **WAL mode crash recovery** | Medium | No explicit test for SQLite WAL mode crash (power loss during WAL checkpoint). |
| **IndexedDB transaction abort during `applyCommittedBatch`** | Medium | Not tested. If IDB transaction fails mid-batch, are partial events persisted? |
| **Crash during schema migration** | High | Not tested. If migration fails mid-DML (e.g., ALTER TABLE + data copy), is the database left in a recoverable state? |
| **Concurrent store access from two processes** | Medium | Only `sqlite-locking-chaos.test.js` tests SQLITE_BUSY. No test verifies data integrity when two processes read/write the same database file. |
| **Corrupted database file recovery** | Medium | No test with manually corrupted database file to verify error detection and graceful failure. |

**Store crash integrity grade: A-.** Very strong coverage for the happy crash paths. The gap is primarily around WAL-mode recovery and IndexedDB transaction failures.

---

## 7. Protocol Conformance Testing

### What Exists

- **`sync-server-conformance.test.js`** (380 lines): Thorough testing of:
  - Non-connect messages before handshake → `bad_request`
  - Unsupported protocol version → close
  - Auth failure → close
  - Client ID mismatch → close
  - Mismatched project sync → `forbidden`
  - Unauthorized submit → `forbidden` result
  - Validation failure → `validation_failed` result
  - Rate limiting → `rate_limited` result

- **`sync-server.test.js`** (778 lines): Full server lifecycle tests including broadcast, dedupe, pagination, and session management.

- **`sync-client.test.js`** (1,203 lines): The largest test file. Covers client state machine, connect/disconnect lifecycle, submit/sync flows, error handling, and draft queue management.

### What's Missing

| Protocol Conformance Gap | Risk | Status |
|---|---|---|
| **Malformed message envelope (missing required fields)** | Medium | Only basic validation tested. No test with extra fields, wrong types, null values, or extremely long strings. |
| **Protocol version negotiation** | Medium | Only "unsupported" is tested. No test for future version negotiation or downgrade. |
| **Message ordering guarantees** | High | No test verifies that messages arrive in order under concurrent sends. |
| **Large message handling (e.g., 10MB sync response)** | Medium | Not tested. Could cause memory issues or JSON parse failures. |
| **Concurrent session limits** | Medium | Server supports `limits` config but only basic rate limiting is tested. |
| **WebSocket frame boundary handling** | Medium | No test where a single logical message is split across WebSocket frames. |

**Protocol conformance grade: B+.** Good coverage of the defined protocol. Missing edge cases around malformed input and message ordering.

---

## 8. Missing Test Categories

### 8.1 Fuzzing — **Completely Absent (Grade: F)**

No fuzz testing exists anywhere in the suite. This is a significant gap for a protocol library.

**Recommended fuzzing targets:**
- Sync server `session.receive()` with random message types and payloads
- Store `commitOrGetExisting()` with random payload structures
- `applyCommittedBatch()` with randomly generated event arrays
- Transport layer with random message fragmentation
- Payload codec with random byte sequences

### 8.2 Property-Based Testing — **Completely Absent (Grade: F)**

No property-based (QuickCheck/fast-check style) testing exists. The reconnect storm test uses seeded RNG, which is a step in this direction, but it's hand-rolled rather than using a property-based framework.

**Recommended properties to test:**
- **Idempotency:** For any sequence of `applyCommittedBatch` calls with the same events, the final committed state is identical regardless of batching order.
- **Commutativity:** For any two non-conflicting events, applying them in either order produces the same materialized view state.
- **Cursor monotonicity:** The cursor value never decreases across any sequence of operations.
- **Convergence:** After N clients submit M events and all sync, every client has identical committed event sets.
- **Store roundtrip:** For any event, `commitOrGetExisting(event) → listCommittedSince()` returns the original event data.

### 8.3 Long-Running / Soak Tests — **Completely Absent (Grade: F)**

No test runs for more than a few seconds. The reconnect storm (120 steps × 5 seeds) is the longest but still completes in under a second.

**Recommended soak tests:**
- 10,000 events across 10 partitions with continuous sync
- 1-hour continuous sync with random disconnect/reconnect
- Materialized view rebuild after 100,000 committed events
- Memory usage stability over 10,000 sync cycles (check for leaks)

### 8.4 Memory Leak Detection — **Completely Absent (Grade: F)**

No memory profiling or leak detection tests exist.

**Recommended leak tests:**
- Repeated sync client create/start/stop cycles → RSS should stay bounded
- Repeated store init/close cycles → no file descriptor leak
- Materialized view cache growth → bounded by partition count
- Event subscription listener cleanup after unsubscribe
- IndexedDB database cleanup after test (verified in afterEach but no heap snapshot comparison)

---

## 9. Test Distribution Analysis

### Lines by Category

| Category | Files | Lines | % |
|---|---|---|---|
| Client store backends | 7 | 3,446 | 32.6% |
| Sync server + protocol | 3 | 1,911 | 18.1% |
| Sync client | 2 | 1,686 | 16.0% |
| Reliability/chaos | 4 | 1,110 | 10.5% |
| Transport | 2 | 543 | 5.1% |
| Materialized views | 4 | 1,228 | 11.6% |
| Utilities/helpers | 7 | 645 | 6.1% |

### Observations

- **Client store tests are the largest category** (32.6%), reflecting the multi-backend strategy (SQLite, libsql, IndexedDB, async-sqlite, in-memory). This is appropriate given the complexity.
- **Transport tests are underrepresented** (5.1%) relative to their production criticality.
- **Reliability tests are a decent share** (10.5%) but could be larger given the distributed nature of the system.

---

## 10. Comprehensive Reliability Testing Strategy

### Priority 1: Critical (Should add immediately)

#### P1-1: Concurrent Multi-Client Stress Test
```
File: spec/protocol/src/multi-client-stress.test.js
- 5+ clients connected to same server
- Each client submits 50 events concurrently
- Random disconnect/reconnect every 10-20 events
- After convergence: all clients have identical committed sets
- Verify no committed ID gaps
- Verify no duplicate committed IDs
```

#### P1-2: Transport Failure Simulation
```
File: spec/protocol/src/transport-failure.test.js
- Transport that randomly drops messages (configurable drop rate)
- Transport that reorders messages
- Transport that duplicates messages
- Verify client eventually converges regardless of transport behavior
- Test with drop rates: 0%, 10%, 30%, 50%
```

#### P1-3: Large Payload and Volume Tests
```
File: spec/protocol/src/volume-stress.test.js
- Single event with 1MB payload → verify roundtrip
- 10,000 events in a single sync response → verify no OOM
- 1,000 committed events before materialized view rebuild → verify correctness
- Batch of 100 drafts flushed at once → verify ordering
```

#### P1-4: IndexedDB Crash Recovery
```
File: spec/protocol/src/indexeddb-crash-recovery.test.js
- Simulate IDB transaction abort during applyCommittedBatch
- Simulate IDB transaction abort during applySubmitResult
- Verify no partial state persists after abort
- Verify cursor stays at pre-transaction value
```

### Priority 2: Important (Should add in next sprint)

#### P2-1: Property-Based Tests
```
File: spec/protocol/src/properties.test.js
Framework: fast-check (or similar)
Properties:
  - idempotent_apply: applyCommittedBatch(events) × 2 = applyCommittedBatch(events) × 1
  - cursor_monotone: cursor never decreases across arbitrary operation sequences
  - convergence: N clients × M events → all agree after sync
  - dedupe_canonical: {a:1,b:2} and {b:2,a:1} always produce same canonical hash
  - store_roundtrip: commit(event) → list(since=0) includes event with same payload
```

#### P2-2: Schema Migration Tests
```
File: spec/protocol/src/schema-migration.test.js
- Create database with schema version 1
- Open with current code → verify migration succeeds
- Verify all data preserved after migration
- Test each incremental migration step (1→2, 2→3, 3→4, etc.)
```

#### P2-3: Concurrent Store Access Tests
```
File: spec/protocol/src/concurrent-store-access.test.js
- Two async contexts calling applyCommittedBatch simultaneously
- One context calling applySubmitResult while another calls loadDraftsOrdered
- Concurrent init() + insertDraft() on fresh store
- Verify no SQLITE_BUSY under normal (non-adversarial) concurrent access
```

#### P2-4: Malformed Input Tests
```
File: spec/protocol/src/malformed-input.test.js
- null payload, undefined payload, array payload
- Extremely long string fields (1MB)
- Non-UTF8 bytes in string fields
- Missing required fields in protocol messages
- Extra unknown fields in protocol messages
- Negative committedId, zero committedId, MAX_SAFE_INTEGER committedId
```

### Priority 3: Nice-to-Have (Add when time permits)

#### P3-1: Fuzz Testing Harness
```
File: spec/protocol/src/fuzz/transport-fuzz.test.js
- Use fast-check arb to generate random message sequences
- Feed to server session.receive()
- Verify server never throws unhandled exceptions
- Verify client never enters invalid state
```

#### P3-2: Memory Leak Detection
```
File: spec/protocol/src/memory-leak.test.js
- Create/start/stop sync client 1000 times
- Snapshot process.memoryUsage() every 100 iterations
- Assert RSS growth < 10% over baseline
- Same for store init/close cycles
```

#### P3-3: Long-Running Soak Test
```
File: spec/protocol/src/soak.test.js (marked with vitest timeout override)
- Run for 60 seconds minimum
- Continuous submit/sync/disconnect cycles
- Verify no memory growth, no event loss, no cursor corruption
- Log throughput metrics
```

#### P3-4: WAL Mode Crash Test
```
File: spec/protocol/src/wal-crash.test.js
- Configure SQLite in WAL mode
- Subprocess writes + checkpoint in progress
- Kill subprocess during checkpoint
- Reopen → verify all committed data intact
```

---

## 11. Test Quality Observations

### Strengths
1. **Consistent test patterns**: Every store backend follows the same test structure (init, insert, apply, cursor, crash recovery, rollback).
2. **Deterministic test infrastructure**: `createNowFactory`, `createUuidFactory`, `createRng` make tests reproducible.
3. **Loopback transport pattern**: Clean in-process transport simulation avoids real network dependencies.
4. **Schema version safety**: Every store tests both "too old" and "too new" schema rejection.
5. **Rollback testing**: Every store backend tests transaction rollback on failure.
6. **Conformance testing**: Dedicated `sync-server-conformance.test.js` exercises protocol edge cases.

### Weaknesses
1. **No shared test harness for store backends**: Each store backend (SQLite, libsql, IDB, async-sqlite) duplicates `makeDraft`, `makeCommitted`, and similar helpers. A shared test generator would reduce duplication and ensure coverage parity.
2. **Heavy reliance on `tick()`**: Many tests use `await tick()` (setTimeout 0) to wait for async resolution. This is fragile and can lead to flaky tests. Consider using explicit event/state waiting.
3. **No test isolation markers**: Tests don't clearly indicate which sync scenario they map to (except `reliability-integration.test.js`). Adding `// SC-XX` comments would improve traceability.
4. **Missing negative path tests in some backends**: IndexedDB tests don't cover transaction failures, while SQLite tests do.
5. **No performance benchmarks**: No test measures throughput or latency of any operation.

---

## 12. Recommendations Summary

| Priority | Action | Effort | Impact |
|---|---|---|---|
| **P1** | Add concurrent multi-client stress test (5+ clients) | 2 days | High |
| **P1** | Add transport failure simulation (drop, reorder, duplicate) | 2 days | High |
| **P1** | Add large payload + volume stress tests | 1 day | High |
| **P1** | Add IndexedDB crash/abort recovery tests | 1 day | Medium |
| **P2** | Add property-based tests (fast-check) | 3 days | High |
| **P2** | Add schema migration path tests | 1 day | Medium |
| **P2** | Add concurrent store access tests | 1 day | Medium |
| **P2** | Add malformed input tests | 1 day | Medium |
| **P3** | Add fuzz testing harness | 2 days | Medium |
| **P3** | Add memory leak detection tests | 1 day | Medium |
| **P3** | Add long-running soak tests | 1 day | Low |
| **P3** | Add WAL mode crash test | 0.5 days | Low |

**Estimated total effort: ~16 days for full implementation.**

---

## Appendix A: Test File Inventory

| File | Lines | Primary Focus |
|---|---|---|
| `sync-client.test.js` | 1,203 | Client state machine, submit/sync lifecycle |
| `materialized-view-runtime.test.js` | 816 | View runtime, reduce, checkpoint, backfill |
| `sync-server.test.js` | 778 | Server lifecycle, broadcast, dedupe, pagination |
| `reliability-integration.test.js` | 706 | SC-06 through SC-17 multi-scenario integration |
| `libsql-client-store.test.js` | 656 | Libsql client store full lifecycle |
| `async-sqlite-client-store.test.js` | 623 | Async SQLite client store full lifecycle |
| `sqlite-client-store.test.js` | 616 | SQLite client store full lifecycle |
| `indexeddb-client-store.test.js` | 566 | IndexedDB client store lifecycle |
| `command-sync-session.test.js` | 483 | Command-profile sync session |
| `sync-server-conformance.test.js` | 380 | Protocol conformance (SC-18) |
| `in-memory-client-store.test.js` | 358 | In-memory store reference impl |
| `offline-transport.test.js` | 288 | Offline transport buffering + replay |
| `browser-websocket-transport.test.js` | 255 | Browser WebSocket transport |
| `command-profile.test.js` | 258 | Command envelope mapping |
| `trace-logging.test.js` | 265 | Logging infrastructure |
| `sqlite-end-to-end-reliability.test.js` | 215 | Full client+server restart E2E |
| `libsql-sync-store.test.js` | 205 | Libsql sync store |
| `sqlite-sync-store.test.js` | 205 | SQLite sync store |
| `stream-initializer.test.js` | 162 | Stream seeding |
| `persisted-cursor-client-store.test.js` | 154 | Cursor persistence wrapper |
| `reducer.test.js` | 146 | Event reducer |
| `authz-helpers.test.js` | 139 | Authorization helpers |
| `public-entrypoints.test.js` | 135 | Package exports API surface |
| `in-memory-sync-store.test.js` | 124 | In-memory sync store |
| `materialized-view.test.js` | 119 | Materialized view definitions |
| `ws-server-bridge.test.js` | 100 | WebSocket server bridge |
| `sqlite-locking-chaos.test.js` | 118 | SQLITE_BUSY contention |
| `ws-server-runtime.test.js` | 96 | WebSocket runtime |
| `libsql-driver.test.js` | 78 | Libsql driver normalization |
| `materialized-view-runtime.partition-matcher.test.js` | 69 | Partition matcher |
| `sqlite-process-crash.test.js` | 71 | Subprocess crash durability |
| `partition-scope.test.js` | 71 | Partition scope |
| `payload-codec.test.js` | 64 | Payload encoding/decoding |
| `package-exports.test.js` | 47 | Package export verification |
| **Total** | **10,569** | |

## Appendix B: Sync Scenario to Test Traceability Matrix

| Scenario | `sync-client` | `sync-server` | `reliability-integ` | `conformance` | `offline-transport` | Store Tests |
|---|---|---|---|---|---|---|
| SC-00 | ✓ | ✓ | | | | |
| SC-01 | ✓ | ✓ | | | | |
| SC-02 | ✓ | ✓ | | | | |
| SC-03 | ✓ | ✓ | ✓ | | | ✓ |
| SC-04 | | ✓ | | | | |
| SC-05 | | | ✓ | | ✓ | |
| SC-06 | | | ✓ | | | |
| SC-07 | | | | | | ✓ |
| SC-08 | | | ✓ | | | |
| SC-09 | | | | | | ✓ |
| SC-10 | ✓ | ✓ | | | | |
| SC-11 | | | ✓ | | | |
| SC-12 | ✓ | | | | | |
| SC-13 | ✓ | | | | | |
| SC-14 | | | ✓ | | | |
| SC-15 | | | ✓ | | | ✓ |
| SC-16 | | | ✓ | | ✓ | |
| SC-17 | | | ✓ | | ✓ | |
| SC-18 | | | | ✓ | | |
