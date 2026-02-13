# Protocol/Design Issue Log

Review date: February 13, 2026
Scope: `docs/protocol/*.md`, `docs/client/*.md`, `docs/reference/javascript-interface.md`, example client/store adapters, and current repository runtime alignment.

Legend:
- Gate: `must-fix-before-implementation` or `can-defer`
- Status: `open` or `resolved`

| ID | Severity | Gate | Status | Source | Issue | Action |
|---|---|---|---|---|---|---|
| I-001 | high | must-fix-before-implementation | resolved | `docs/protocol/ordering-and-idempotency.md:34` | Canonical payload equality was underspecified (deterministic requirement without concrete algorithm). | Added required canonicalization steps (normalized partitions + deep key-sorted JSON) in `docs/protocol/ordering-and-idempotency.md:36`. |
| I-002 | high | must-fix-before-implementation | resolved | `docs/protocol/partitions.md:11` | Duplicate partition handling was `SHOULD`, which made dedupe/equality behavior ambiguous. | Tightened to `MUST` reject duplicates and documented deterministic partition normalization in `docs/protocol/partitions.md:11`. |
| I-003 | medium | must-fix-before-implementation | resolved | `docs/protocol/connection.md:55` | Mid-connection token expiry required close behavior but did not require explicit error code emission. | Required `auth_failed` before close in `docs/protocol/connection.md:55`. |
| I-004 | medium | must-fix-before-implementation | resolved | `docs/protocol/messages.md:179` | `sync_response.payload.partitions` semantics were shown in examples but not explicitly constrained. | Added explicit rule that `payload.partitions` must be present and reflect normalized active scope in `docs/protocol/messages.md:179`. |
| I-005 | medium | must-fix-before-implementation | resolved | `docs/protocol/durability.md:34` | Cursor durability timing across paged sync was ambiguous. | Clarified intermediate cursor persistence as optional and final page persistence as required in `docs/protocol/durability.md:34`. |
| I-006 | high | must-fix-before-implementation | resolved | `docs/reference/javascript-interface.md:35`, `examples/real-client-usage/common/createCoreSyncClient.js:1` | Interface docs and example runtime API drifted (`submit/sync/on` vs `submitEvent/syncNow/...`). | Aligned reference doc to runtime-facing API and added alias export `createSyncClient` in `examples/real-client-usage/common/createCoreSyncClient.js:195`. |
| I-007 | medium | must-fix-before-implementation | resolved | `docs/client/storage.md:16`, `examples/real-client-usage/common/createSqliteStore.js:47` | Storage schema docs used `type/payload` columns while examples stored a single `event` object. | Aligned schema docs to `event` JSON shape in `docs/client/storage.md:20`. |
| I-008 | high | must-fix-before-implementation | resolved | `src/repository.js:56`, `src/repository.js:65`, `src/repository.js:333`, `src/repository.js:504` | Repository/runtime was event-index-centric and not aligned to committed cursor vocabulary. | Added committed-cursor-first boundaries (`committedId`, `sinceCommittedId`, `untilCommittedId`) with backward-compatible aliases (`eventIndex`, `since`, `untilEventIndex`) in `src/repository.js` and `README.md`. |
| I-009 | medium | can-defer | open | `docs/protocol/messages.md:77`, `docs/protocol/durability.md:63` | `sync.limit` is clamped but normative default/min/max bounds are not specified, leaving server behavior non-uniform. | Add explicit bounds/default guidance in protocol docs and conformance tests; defer if single implementation only. |
| I-010 | low | can-defer | open | `docs/protocol/errors.md:16`, `docs/protocol/connection.md:64` | `server_error` exists in canonical code set, but trigger/shape examples and close timing details are minimal. | Add one normative failure-path example for internal error mapping and close semantics. |

## Summary

- Open issues: 2
- Open `must-fix-before-implementation`: 0
- Open `can-defer`: 2 (`I-009`, `I-010`)
