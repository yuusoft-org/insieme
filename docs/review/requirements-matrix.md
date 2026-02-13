# MUST/SHOULD Requirement Matrix

Review date: February 13, 2026

Status values:
- `planned`: requirement mapped to tests/modules but not yet implemented in this phase
- `implemented`: behavior exists and verified by tests
- `gap`: no implementation/test mapping yet

| Req ID | Source | Requirement | Priority | Planned Tests | Target Modules | Status |
|---|---|---|---|---|---|---|
| PR-001 | `docs/protocol/messages.md:9` | Envelope includes `type`, `payload`, `protocol_version`. | must | `SC-00`, `SC-18` | server protocol handler | planned |
| PR-002 | `docs/protocol/messages.md:22` | Unknown message type -> `bad_request`. | must | `SC-18` | server protocol handler | planned |
| PR-003 | `docs/protocol/messages.md:23` | Missing envelope fields -> `bad_request`. | must | `SC-18` | server protocol handler | planned |
| PR-004 | `docs/protocol/messages.md:24` | Unsupported protocol version -> `protocol_version_unsupported` and close. | must | `SC-18` | server connection lifecycle | planned |
| PR-005 | `docs/protocol/messages.md:25` | Unknown extra fields ignored. | must | `SC-18` | server validation boundary | planned |
| PR-006 | `docs/protocol/messages.md:59` | `submit_events.payload.events` contains exactly one item in core mode. | must | `SC-01`, `SC-02`, `SC-18` | server submit handler | planned |
| PR-007 | `docs/protocol/messages.md:125` | Exactly one `submit_events_result` per `submit_events` request. | must | `SC-01`, `SC-02`, `SC-03` | server submit handler | planned |
| PR-008 | `docs/protocol/messages.md:126` | `submit_events_result.results` has one entry in core mode. | must | `SC-01`, `SC-02` | server submit handler | planned |
| PR-009 | `docs/protocol/messages.md:150` | No self-broadcast to submitting connection. | must | `SC-10` | server broadcast fanout | planned |
| PR-010 | `docs/protocol/messages.md:177` | If `has_more=true`, client re-syncs with `next_since_committed_id`. | must | `SC-05` | client sync engine | planned |
| PR-011 | `docs/protocol/messages.md:179` | `sync_response.payload.partitions` present and normalized to active scope. | must | `SC-12` | server sync response builder | planned |
| PR-012 | `docs/protocol/connection.md:17` | Before handshake, only `connect` accepted. | must | `SC-00`, `SC-18` | server connection lifecycle | planned |
| PR-013 | `docs/protocol/connection.md:18` | Valid `connect` -> `connected` + state transition to active. | must | `SC-00` | server connection lifecycle | planned |
| PR-014 | `docs/protocol/connection.md:19` | Auth failure -> `auth_failed` + close. | must | `SC-18` | server auth boundary | planned |
| PR-015 | `docs/protocol/connection.md:52` | Token claim `client_id` must match connect payload. | must | `SC-18` | server auth boundary | planned |
| PR-016 | `docs/protocol/connection.md:54` | Partition auth checked on submit and sync. | must | `SC-04`, `SC-12`, `SC-18` | server authz boundary | planned |
| PR-017 | `docs/protocol/connection.md:55` | Token expiry mid-connection -> `auth_failed` + close. | must | dedicated connection-expiry test | server connection lifecycle | planned |
| PR-018 | `docs/protocol/connection.md:69` | Reconnect sequence is `connect` then `sync`. | must | `SC-05`, `SC-17` | client sync engine | planned |
| PR-019 | `docs/protocol/ordering-and-idempotency.md:9` | `committed_id` globally monotonic and never reused. | must | `SC-03`, `SC-15` | server commit allocator | planned |
| PR-020 | `docs/protocol/ordering-and-idempotency.md:15` | Server dedupes by event `id`. | must | `SC-03`, `SC-13` | server submit/dedupe path | planned |
| PR-021 | `docs/protocol/ordering-and-idempotency.md:16` | Same `id` + same payload returns existing committed result. | must | `SC-03`, `SC-13` | server dedupe path | planned |
| PR-022 | `docs/protocol/ordering-and-idempotency.md:17` | Same `id` + different payload rejected (`validation_failed`). | must | `SC-09` | server dedupe validation | planned |
| PR-023 | `docs/protocol/ordering-and-idempotency.md:34` | Canonicalization is deterministic and consistent. | must | `SC-03`, `SC-09` + unit tests | server canonicalizer | planned |
| PR-024 | `docs/protocol/ordering-and-idempotency.md:50` | Client apply path is idempotent across submit/sync/broadcast. | must | `SC-06`, `SC-10`, `SC-13` | client store/runtime | planned |
| PR-025 | `docs/protocol/partitions.md:9` | Partitions non-empty array; entries non-empty. | must | `SC-04`, `SC-18` | request validation | planned |
| PR-026 | `docs/protocol/partitions.md:11` | Duplicate partitions rejected with `validation_failed`. | must | dedicated partitions-shape test | request validation | planned |
| PR-027 | `docs/protocol/partitions.md:12` | Accepted partition set normalized deterministically. | must | `SC-04` + canonicalization unit tests | request normalization | planned |
| PR-028 | `docs/protocol/partitions.md:19` | Unauthorized sync partition -> `forbidden`. | must | `SC-18` | authz boundary | planned |
| PR-029 | `docs/protocol/validation.md:9` | Server validates every submitted event before commit. | must | `SC-02`, `SC-08`, `SC-18` | server validation pipeline | planned |
| PR-030 | `docs/protocol/durability.md:21` | Commit order: assign id -> durable persist -> reply/broadcast. | must | `SC-15` | server commit transaction | planned |
| PR-031 | `docs/protocol/durability.md:34` | Persist final sync cursor at `has_more=false` (intermediate optional). | must | `SC-05`, `SC-17` | client store/runtime | planned |
| PR-032 | `docs/protocol/durability.md:40` | During active sync cycle, no broadcasts to that connection. | must | `SC-05`, `SC-17` | server subscription delivery | planned |
| PR-033 | `docs/protocol/durability.md:46` | No committed result/broadcast before durable persist. | must | `SC-15` | server durability boundary | planned |
| PR-034 | `docs/protocol/durability.md:63` | Sync limit clamped to server bounds. | must | dedicated sync-limit test | server sync handler | planned |
| PR-035 | `docs/client/drafts.md:19` | Draft submit order is `(draft_clock, id)`. | must | `SC-16`, `SC-11` | client queue + store | planned |
| PR-036 | `docs/client/storage.md:67` | Any committed arrival path inserts committed and removes matching draft idempotently. | must | `SC-01`, `SC-05`, `SC-10` | client store adapter | planned |
