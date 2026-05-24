# Critical Infrastructure Testing Harness Guidelines

Review date: May 23, 2026

This document defines the target testing standard for Insieme sync. The goal is not simply higher coverage. The goal is evidence that the protocol, client stores, server stores, transports, and recovery paths preserve their safety properties under realistic faults.

## Why Branch Coverage Lags

Branch coverage is lower than statement coverage because this codebase has many defensive branches:

- protocol validation: malformed envelopes, unsupported versions, bad payload shapes
- connection state: pre-handshake messages, close races, reconnects, expired auth
- sync state machine: paging, offline mode, duplicate broadcasts, submit retries
- storage adapters: duplicate commits, cursor monotonicity, rollback, checkpoint rebuild, closed-store behavior
- transport behavior: lost replies, half-open sockets, skipped sends, malformed JSON, ping/pong timeouts

Happy-path end-to-end tests execute many statements but only one side of most decisions. For critical infrastructure, the missing branch is often the production incident path.

Coverage should therefore be treated as a floor, not the goal. The real standard is invariant coverage under generated schedules and injected faults.

## Research Basis

The testing direction should follow proven infrastructure practices:

- Jepsen-style testing: define the system contract, execute concurrent operations, inject faults, record history, and check whether observed behavior matches the contract.
- FoundationDB-style deterministic simulation: run whole-system workloads inside a controlled scheduler so timing, network, and storage faults are reproducible from a seed.
- SQLite-style crash testing: repeatedly interrupt transactions at different points, reopen storage, and verify all-or-nothing durability plus consistency.
- Property-based testing: generate many valid and invalid operation sequences, then shrink failures to minimal reproductions.

For this project, the practical version is a deterministic in-process harness around the existing Vitest suites. It should be fast enough for CI, seedable for reproduction, and strong enough to cover client, server, store, and transport failures together.

## Required Safety Invariants

Every robust scenario must assert these invariants unless the scenario explicitly narrows scope:

- `committedId` is globally monotonic, gap behavior is intentional, and an id is never reused for a different event.
- Submitting the same event id and same canonical payload is idempotent.
- Submitting the same event id with different canonical payload is rejected and never mutates committed history.
- Server replies and broadcasts are emitted only after durable commit succeeds.
- A lost submit reply does not produce a duplicate commit after reconnect/retry.
- A client never loses a committed event after it has been observed through submit result, sync response, or broadcast.
- A matching committed event removes the local draft exactly once across all arrival paths.
- Sync cursors are monotonic and never advance past unapplied committed events.
- Paged sync uses a fixed high-water mark for the cycle and never leaks events outside the active project/partition scope.
- Unauthorized project or partition access returns an auth/authz error and does not expose event metadata.
- Validation failure rejects the bad event and marks later submitted events `not_processed`.
- Rejected drafts drain or remain retryable according to their documented status, with no silent deletion.
- Materialized views are equivalent to replaying committed history from zero.
- Store restart/reopen preserves committed history, cursors, drafts, and materialized checkpoints.
- Closing any client, store, or bridge is idempotent and prevents future mutation.

## Harness Architecture

Build a reusable scenario harness under `spec/support/` with these modules.

### `scenario-runner.js`

Owns deterministic execution:

- accepts `{ seed, clients, server, storeAdapters, faults, workload, invariants }`
- records every operation, message, store write, server commit, broadcast, close, and reconnect
- exposes `runScenario(name, config)` for Vitest
- prints the seed and minimized schedule on failure
- supports `replayScenario({ seed, schedule })`

The runner should use fake timers or a logical clock where possible. No test should depend on wall-clock sleeps except designated smoke tests.

### `model.js`

Maintains an independent reference model:

- submitted drafts by client
- committed log by canonical event key
- cursor per client/project scope
- visible event set per project and partition
- expected materialized view state

The model must not call production reducers except for explicitly shared user-defined materialized-view reducers. Protocol canonicalization should be tested both against the implementation and through independent expected cases.

### `fault-transport.js`

Wraps loopback and websocket-like transports with deterministic faults:

- drop client-to-server message
- drop server-to-client message
- delay message by logical ticks
- duplicate message
- reorder messages
- close before server receive
- close after durable commit but before reply
- close during paged sync
- inject malformed envelope
- inject unsupported protocol version
- keep socket half-open until ping timeout

Every fault must be seedable and must record why it fired.

### `fault-store.js`

Wraps client and server stores with deterministic storage failures:

- fail before transaction starts
- fail after writing committed event but before cursor write
- fail after cursor write but before transaction complete, where the backend supports simulation
- fail materialized-view checkpoint save
- fail duplicate insert path
- fail close/reopen boundaries
- simulate lock contention or busy errors for SQLite/libSQL adapters

Where exact physical crash simulation is not available, the wrapper should assert transactional behavior at the adapter boundary: after an injected failure, reopening the store must show either the full transaction or no transaction.

### `adapter-conformance.js`

Runs the same contract suite against every store adapter:

- in-memory client store
- SQLite client store
- async SQLite client store
- libSQL client store
- IndexedDB client store
- in-memory sync store
- SQLite sync store
- libSQL sync store

Adapter tests should be written once and parameterized by a factory. New adapters must be added to conformance before they are exported.

### `history-checker.js`

Turns scenario traces into invariant checks:

- no duplicate committed ids
- no conflicting event ids
- no unauthorized visibility
- cursor monotonicity
- client/server convergence
- materialized-view replay equivalence
- no reply/broadcast before durable commit
- draft lifecycle correctness

The checker should report the smallest relevant operation window, not only the final assertion.

## Test Categories

### 1. Contract Tests

Scope: one module or adapter.

Examples:

- each store adapter satisfies the same draft/commit/cursor/materialized-view contract
- every transport satisfies send/close/parse/error semantics
- canonicalization is stable across key order, legacy shape, and partition normalization

Run on every PR.

### 2. Deterministic Scenario Tests

Scope: one server plus one or more clients.

Examples:

- lost submit result after durable commit, then reconnect/retry
- sync pagination while concurrent commits arrive
- local drafts drain after paged catch-up
- validation rejection in the middle of a batch
- duplicate broadcast races with sync response
- auth expiry while a client has pending drafts

Run on every PR with fixed seeds.

### 3. Property-Based Scenario Tests

Scope: generated operation schedules.

Generate:

- clients joining/leaving
- submit batches
- sync requests
- project/partition scopes
- valid and invalid payloads
- reconnects and transport faults
- store failures at allowed injection points

Assert invariants after every operation and at final convergence.

Run a small seed count on every PR and a larger seed count nightly.

### 4. Crash/Recovery Tests

Scope: durable store adapters.

For SQLite/libSQL-backed stores:

- run a transaction workload
- inject failure at each known write boundary
- close/reopen
- assert committed log and cursor are consistent
- assert materialized views rebuild from committed history

For IndexedDB:

- simulate aborted requests and version upgrades
- reopen database
- assert draft order, committed history, cursor, and checkpoint behavior

Run core cases on every PR and expanded matrix nightly.

### 5. Protocol Fuzz Tests

Scope: server protocol boundary.

Generate malformed envelopes:

- missing fields
- unknown message type
- unsupported protocol version
- wrong casing
- oversized payload
- invalid partitions/project scopes
- duplicate event ids
- invalid schema versions

Assert deterministic error codes and no state mutation.

Run on every PR.

### 6. Long-Run Stress Tests

Scope: whole system.

Run many seeds and longer schedules:

- reconnect storms
- concurrent writers
- slow sync clients
- burst rate limits
- repeated close/reopen
- materialized-view subscriptions under churn

Run nightly and before releases. Failures must emit replay commands.

## Coverage Policy

Current global threshold is useful but not sufficient. Move toward this policy:

- global: statements >= 92%, branches >= 85%, functions >= 92%, lines >= 92%
- critical modules: branches >= 85% for `sync-client.js`, `sync-server.js`, store adapters, and websocket bridge/runtime
- no new exported API without contract tests
- no new state-machine branch without a scenario or invariant test
- no new storage transaction path without a rollback/reopen test
- no new auth/authz rule without both positive and negative tests

Do not write tests only to hit coverage counters. If a branch is unreachable or purely defensive, document why and consider isolating it behind a smaller helper that can be tested directly.

## CI Strategy

Use tiers so robustness does not make normal PRs too slow.

### PR Required

- lint
- typecheck
- unit and contract tests
- fixed-seed deterministic scenarios
- coverage with global thresholds
- scenario coverage validator
- `git diff --check`

Target runtime: under 2 minutes.

### PR Extended

Triggered for protocol/store/transport changes:

- adapter conformance matrix
- crash/recovery core matrix
- property tests with 50 to 100 seeds
- reliability stress repeat

Target runtime: under 10 minutes.

### Nightly

- property tests with 1,000+ seeds
- long-run stress schedules
- crash/recovery expanded matrix
- randomized transport fault matrix
- coverage report with per-module trend

### Release Gate

- all nightly suites green on the release candidate
- no skipped critical-invariant tests
- all newly discovered seeds either fixed or explicitly accepted with a documented reason
- requirements matrix reviewed against protocol docs

## Failure Output Standard

Every generated or fault-injected test failure must print:

- scenario name
- seed
- logical tick
- client id and project scope
- fault that fired
- last 20 trace events
- violated invariant
- replay command

Example:

```text
SCENARIO lost-submit-result
SEED 184901
TICK 37
FAULT drop server_to_client submit_events_result after durable_commit
INVARIANT duplicate committed event id evt-12
REPLAY bun run test:scenario -- --scenario lost-submit-result --seed 184901
```

## Implementation Roadmap

### Phase 1: Harness Foundation

- Add `spec/support/scenario-runner.js`.
- Add `spec/support/fault-transport.js`.
- Add `spec/support/history-checker.js`.
- Port the existing end-to-end robustness tests to the runner.
- Require every scenario to emit a trace and seed.

### Phase 2: Adapter Conformance

- Add parameterized client-store conformance.
- Add parameterized sync-store conformance.
- Move duplicate draft, committed invariant, cursor, and materialized-view lifecycle tests into shared contracts.
- Keep adapter-specific tests only for backend-specific behavior.

### Phase 3: Property-Based Workloads

- Add a property-test dependency such as `fast-check`.
- Generate operation schedules for submit, sync, reconnect, close, auth expiry, and partition changes.
- Check invariants after every operation.
- Add seed replay scripts.

### Phase 4: Crash and Fault Matrix

- Add storage failure wrappers.
- Add crash/reopen tests for SQLite and libSQL adapters.
- Add IndexedDB abort/version-upgrade simulations.
- Add CI jobs for PR extended and nightly matrices.

### Phase 5: Per-Module Gates and Reporting

- Add per-module coverage gates for critical files.
- Emit coverage trend summaries in CI.
- Fail PRs that reduce branch coverage in critical modules without an approved test-plan note.

## Test Authoring Rules

- Prefer invariant assertions over exact incidental message ordering.
- Assert every durable mutation through a reopen when testing storage.
- Use deterministic seeds for generated tests committed to the suite.
- When fixing a bug found by a seed, add the seed as a named regression.
- Avoid sleeps; use logical ticks or fake timers.
- Test both sides of authz: allowed and forbidden.
- Test both sides of pagination: `hasMore=true` and final page.
- Test both sides of submit batches: all committed and partial rejection with `not_processed`.
- For materialized views, compare hot state, checkpointed state, and replay-from-zero state.
- For transports, assert close is idempotent and sends after close do not mutate peer state.
- For stores, assert operations after close fail with the documented error code.

## Definition of Done for Critical Sync Changes

A protocol, storage, transport, or sync-engine change is done only when:

- contract tests cover the changed API
- at least one end-to-end scenario covers the changed behavior
- failure/retry behavior is tested
- authorization boundaries are tested when scope is involved
- storage behavior is tested across close/reopen when durability is involved
- branch coverage for the touched critical module does not regress
- the requirements matrix is updated if the behavior changes

