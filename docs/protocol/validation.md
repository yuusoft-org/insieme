# Validation

This document defines minimal server-side validation rules.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Server Authority

Server is authoritative and **MUST** validate every submitted event before commit.

## Required Validation

For each `submit_events` request:

1. Envelope and request shape are valid.
2. `payload.events` has at least one item.
3. Server validates and processes items in request order.
4. Each item `id` is present and well-formed for your UUID policy.
5. Each item `projectId` is present and matches the authenticated session project.
6. Each item `partition` is a non-empty string.
7. Each item `type` is a non-empty string, `schemaVersion` is a positive integer, and `payload` is an object.
8. Each item `meta.clientId` and `meta.clientTs` are valid, and `meta.clientId` matches the authenticated client.
9. If an item `userId` is present, validate it against the authenticated user when your auth layer exposes one.
10. Each event payload passes app/domain validation.
11. Each event `type` is recognized by the active application model.

Batch outcome rules:

- Server **MUST** stop processing the batch after the first rejected item.
- Later submitted items that were not attempted **MUST** be returned as `not_processed`.

If any check fails, server **MUST** return outcomes using:

- `bad_request` for malformed request shape,
- `forbidden` for authorization failures,
- `validation_failed` for metadata or domain validation failures,
- `not_processed` for later items in the same batch that were not attempted because an earlier item failed.

## App-Level Validation Extensions

The following are intentionally outside protocol core and should live in app-specific docs/modules:

- profile negotiation rules,
- schema-version contract details,
- custom semantic invariants beyond base protocol.
