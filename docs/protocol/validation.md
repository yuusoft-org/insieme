# Validation

This document defines minimal server-side validation rules.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Server Authority

Server is authoritative and **MUST** validate every submitted event before commit.

## Required Validation

For each `submit_events` request (core mode: one event):

1. Envelope and request shape are valid.
2. `payload.events` has exactly one item.
3. `id` is present and well-formed for your UUID policy.
4. `partitions` are valid and authorized.
5. Event payload passes app/domain validation.
6. Event type is recognized by the active application mode.

If any check fails, server **MUST** reject with:

- `bad_request` for malformed request shape,
- `forbidden` for authorization failures,
- `validation_failed` for domain/schema failures.

## App-Level Validation Extensions

The following are intentionally outside protocol core and should live in app-specific docs/modules:

- strict tree target/action policy matrices,
- profile negotiation rules,
- model-version contract details,
- custom semantic invariants beyond base protocol.
