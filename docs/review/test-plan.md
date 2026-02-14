# Tests-First Plan and Scenario Mapping

Review date: February 13, 2026
Execution order: harness -> scenarios -> focused unit tests -> implementation.

## 1) Harness Setup (First)

- [x] Add deterministic fixtures (`clock`, `uuid`, `committed_id`).
- [x] Add fake transport harness for connection/session tests.
- [x] Add reusable auth/authz fixtures.
- [x] Add reusable in-memory committed-log + dedupe fixtures.
- [x] Add reusable client store fixture with transactional semantics.

## 2) Scenario-to-Test Mapping

| Scenario | File | Primary Assertions | Planned Test ID | Status |
|---|---|---|---|---|
| 00 | `docs/sync-scenarios/00-handshake-empty-sync.md` | connect lifecycle + empty sync response | `PT-SC-00` | added (`spec/protocol/src/sync-client.test.js`, `spec/protocol/src/sync-server.test.js`) |
| 01 | `docs/sync-scenarios/01-local-draft-commit-broadcast.md` | local commit + peer broadcast | `PT-SC-01` | added (`spec/protocol/src/sync-client.test.js`, `spec/protocol/src/sync-server.test.js`) |
| 02 | `docs/sync-scenarios/02-local-draft-rejected.md` | rejection path removes draft | `PT-SC-02` | added (`spec/protocol/src/sync-client.test.js`, `spec/protocol/src/sync-server.test.js`) |
| 03 | `docs/sync-scenarios/03-duplicate-submit-retry.md` | same-id retry dedupe result | `PT-SC-03` | added (`spec/protocol/src/sync-client.test.js`, `spec/protocol/src/sync-server.test.js`) |
| 04 | `docs/sync-scenarios/04-multi-partition-event.md` | partition intersection fanout | `PT-SC-04` | added |
| 05 | `docs/sync-scenarios/05-reconnect-catch-up-paged.md` | paged sync cursor progression | `PT-SC-05` | added |
| 06 | `docs/sync-scenarios/06-out-of-order-commit-arrival.md` | idempotent committed apply | `PT-SC-06` | added |
| 07 | `docs/sync-scenarios/07-snapshot-prune.md` | snapshot/prune optional path | `PT-SC-07` | added |
| 08 | `docs/sync-scenarios/08-model-local-validation.md` | local validation gate before submit | `PT-SC-08` | added |
| 09 | `docs/sync-scenarios/09-same-id-different-payload.md` | same-id mismatch rejection | `PT-SC-09` | added |
| 10 | `docs/sync-scenarios/10-broadcast-vs-origin-commit.md` | no self-broadcast, origin result authoritative | `PT-SC-10` | added |
| 11 | `docs/sync-scenarios/11-concurrent-drafts-commit-reordered.md` | resolve by id under reorder | `PT-SC-11` | added |
| 12 | `docs/sync-scenarios/12-partition-added-mid-session.md` | sync scope replacement | `PT-SC-12` | added |
| 13 | `docs/sync-scenarios/13-retry-while-draft-pending.md` | pending retry idempotency | `PT-SC-13` | added |
| 14 | `docs/sync-scenarios/14-lww-conflict-concurrent-update.md` | LWW conflict resolution behavior | `PT-SC-14` | added |
| 15 | `docs/sync-scenarios/15-server-crash-recovery.md` | persist-before-reply crash recovery | `PT-SC-15` | added |
| 16 | `docs/sync-scenarios/16-batch-submit-offline-catchup.md` | offline draft queue drain order | `PT-SC-16` | added |
| 17 | `docs/sync-scenarios/17-heartbeat-and-disconnect.md` | transport close + reconnect flow | `PT-SC-17` | added |
| 18 | `docs/sync-scenarios/18-error-and-version-change.md` | error boundaries and close/keep-open behavior | `PT-SC-18` | added |

## 3) Additional Focused Tests (Not fully covered by scenario docs)

- [x] `PT-VAL-001`: invalid envelope fields -> `bad_request`.
- [x] `PT-VAL-002`: duplicate `partitions` rejected (`validation_failed`).
- [x] `PT-VAL-003`: unsupported `protocol_version` closes connection.
- [x] `PT-SYNC-001`: sync `limit` clamping behavior and bounds.
- [x] `PT-SYNC-002`: fixed `sync_to_committed_id` paging convergence under concurrent writes.
- [x] `PT-IDEMP-001`: canonicalization deterministic equality tests.
- [x] `PT-IDEMP-002`: canonicalization mismatch with same `id` rejects.
- [x] `PT-STORE-001`: `applySubmitResult` committed transaction correctness.
- [x] `PT-STORE-002`: `applySubmitResult` rejected transaction correctness.
- [x] `PT-STORE-003`: `applyCommittedBatch` idempotent insert + draft cleanup.
- [x] `PT-STORE-004`: cursor persistence on final sync page.

## 4) Execution Gates

- [x] No implementation PR until required test files exist and fail first.
- [x] Merge blocked unless all `PT-SC-*` pass.
- [x] Merge blocked unless all `must-fix-before-implementation` issues are closed.
