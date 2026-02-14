# Insieme Protocol Roadmap (Checklist)

This roadmap is execution-oriented and checklist-first.

Order is mandatory:

1. Review design and protocol for issues.
2. Plan decisions and freeze scope.
3. Write tests first.
4. Implement against tests.

## Source of Truth

- [x] Treat `docs/protocol/*.md` and `docs/client/*.md` as normative.
- [x] Treat `docs/README.md` as navigation and model summary.
- [x] Treat `docs/drafts/*.md` as non-normative future ideas.
- [x] Keep implementation language/rules aligned with `README.md` implementation guidelines.

## Phase 1: Review Design and Protocol

Goal: identify ambiguities, contradictions, and missing constraints before planning implementation work.

### 1.1 Protocol correctness review

- [x] Review envelope rules in `docs/protocol/messages.md`.
- [x] Confirm unsupported `protocol_version` close behavior.
- [x] Confirm unknown message type handling (`bad_request`).
- [x] Confirm core mode submit cardinality (exactly one `events[0]`).
- [x] Confirm `since_committed_id` is exclusive in all docs.
- [x] Confirm paging cursor semantics are consistent (`next_since_committed_id`).
- [x] Confirm broadcast suppression during active sync cycle.
- [x] Confirm dedupe semantics (`same id + same canonical payload`).
- [x] Confirm reject semantics (`same id + different payload`).
- [x] Confirm partition auth checks on submit and sync.
- [x] Confirm connection state machine (`await_connect` -> `active`).
- [x] Confirm reconnect contract (`connect` then `sync`).

### 1.2 Client runtime review

- [x] Confirm `local_drafts` and `committed_events` model is sufficient.
- [x] Confirm draft ordering key (`draft_clock`) is durable and monotonic.
- [x] Confirm idempotent apply path requirements are explicit.
- [x] Confirm submit-result, sync, and broadcast convergence rules.
- [x] Confirm durable cursor rules on reconnect/restart.

### 1.3 Storage and interface review

- [x] Validate simplified client store API shape in `docs/reference/javascript-interface.md`.
- [x] Validate transactional invariants for store mutations.
- [x] Validate SQL schema/index expectations for required queries.
- [x] Validate backend store boundary (`commitOrGetExisting`, `listCommittedSince`).

### 1.4 Issue list output (required)

- [x] Produce one issue log file with severity tags (`critical`, `high`, `medium`, `low`).
- [x] Link each issue to exact doc file/section.
- [x] Mark each issue as `must-fix-before-implementation` or `can-defer`.
- [x] Resolve all `must-fix-before-implementation` items.

## Phase 2: Plan and Freeze Scope

Goal: turn reviewed protocol into a concrete implementation plan with explicit acceptance checks.

### 2.1 Requirement matrix

- [x] Create MUST/SHOULD matrix from protocol and client docs.
- [x] Map each rule to target module(s).
- [x] Map each rule to at least one test case.
- [x] Mark any not-yet-testable rule and define test strategy.

### 2.2 Architecture decisions

- [x] Freeze core runtime boundaries (transport, protocol handling, store adapters).
- [x] Freeze store interface methods and payload shapes.
- [x] Freeze backend commit path transaction model.
- [x] Freeze cursor durability and paging algorithm.
- [x] Freeze partition normalization and equality rules.

### 2.3 Work breakdown

- [x] Create deliverable list with owner per module.
- [x] Define dependency order (tests/harness before runtime code).
- [x] Define merge gates (tests must pass before feature merges).
- [x] Define rollback strategy for risky changes.

## Phase 3: Tests First

Goal: executable conformance before implementation.

### 3.1 Conformance harness

- [x] Add/extend Vitest suites for protocol message-flow conformance.
- [x] Add deterministic fixtures (`clock`, `uuid`, `committed_id`).
- [x] Add stable fake transport for connection/session flows.
- [x] Add fixture helpers for partition authorization scenarios.

### 3.2 Scenario coverage

- [x] Map every `docs/sync-scenarios/00-18` file to executable tests.
- [x] Add tests for handshake and connect failures.
- [x] Add tests for submit commit and submit reject flows.
- [x] Add tests for dedupe retry (same payload).
- [x] Add tests for dedupe mismatch reject (different payload).
- [x] Add tests for sync pagination and cursor advancement.
- [x] Add tests for broadcast suppression during active sync.
- [x] Add tests for reconnect recovery from cursor.
- [x] Add tests for multi-partition visibility intersections.

### 3.3 Store-focused tests (SQL + adapter)

- [x] Test `insertDraft` ordering behavior.
- [x] Test `applySubmitResult` committed transaction behavior.
- [x] Test `applySubmitResult` rejected transaction behavior.
- [x] Test `applyCommittedBatch` idempotent inserts.
- [x] Test `applyCommittedBatch` draft cleanup on matching `id`.
- [x] Test `applyCommittedBatch` cursor persistence semantics.
- [x] Test crash/restart simulation across partial progress boundaries.

### 3.4 CI gates

- [x] Make conformance suites blocking in CI.
- [x] Keep Vitest-only protocol conformance stack enforced by policy checks.
- [x] Fail PRs if scenario mapping is missing coverage.

## Phase 4: Implementation

Goal: implement only after tests exist and fail appropriately.

### 4.1 Backend protocol core

- [x] Implement connect/auth/protocol version gates.
- [x] Implement submit validation and auth checks.
- [x] Implement atomic commit-or-get-existing dedupe path.
- [x] Implement monotonic `committed_id` assignment semantics.
- [x] Implement durable persist before reply/broadcast.
- [x] Implement sync paging and partition-scoped queries.
- [x] Implement error mapping to canonical codes.

### 4.2 Client sync engine

- [x] Implement startup flow (`connect` -> `sync`).
- [x] Implement sync paging loop until `has_more=false`.
- [x] Implement draft queue flush order (`draft_clock`, `id`).
- [x] Implement idempotent apply across submit/sync/broadcast paths.
- [x] Implement reconnect and cursor-based catch-up.
- [x] Implement partition scope replacement behavior on sync.

### 4.3 Store adapters

- [x] Implement simplified client store interface for SQLite adapter.
- [x] Keep all multi-step mutations transactional.
- [x] Validate indexes used by hot-path queries.
- [x] Document adapter contract and failure behavior.

### 4.4 Repository/runtime alignment

- [x] Align legacy `partition` naming to canonical `partitions` where required.
- [x] Align any `eventIndex` semantics with `committed_id` semantics at protocol boundaries.
- [x] Remove or isolate behavior that conflicts with current protocol docs.

## Phase 5: Verification and Hardening

Goal: prove behavior under failures and load.

- [x] Run full scenario suite with deterministic seeds.
- [x] Run duplicate delivery and reconnect storm tests.
- [x] Run crash recovery tests (after persist, before reply).
- [x] Validate idempotent convergence after retries.
- [x] Validate partition auth enforcement under mixed scopes.
- [x] Validate sync pagination under large result sets.
- [x] Add structured logging for `id` and `committed_id` traceability.
- [x] Add protocol-level `msg_id` correlation tracing across client and server logs.
- [x] Add SQLite lock-contention chaos tests (`SQLITE_BUSY`) with recovery assertions.
- [x] Add process-crash durability test for SQLite commit persistence and idempotent retry.
- [x] Add in-app inbound safety guardrails (rate and envelope size limits).
- [x] Enforce coverage thresholds and repeated reliability runs in CI.
- [x] Add production rollout reliability checklist.

## Exit Criteria

- [x] All `must-fix-before-implementation` review items are closed.
- [x] All protocol/client MUST rules are mapped to passing tests.
- [x] All sync scenarios pass in CI.
- [x] No known critical/high conformance gaps remain.
- [x] Docs and examples match the implemented interfaces.
