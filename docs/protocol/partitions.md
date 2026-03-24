# Projects & Partitions

This document defines the project-scoped partition model for submit, sync, and broadcast.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Project Scope

- Each sync connection is bound to exactly one `projectId`.
- `connect.payload.projectId` **MUST** be a non-empty string.
- `sync.payload.projectId` **MUST** equal the authenticated connection project.
- Submitted events **MUST** include `projectId`, and it **MUST** equal the authenticated connection project.

## Partition Shape

- `partition` **MUST** be a non-empty string.
- Each committed event carries exactly one `partition`.
- If the application needs to fan out one logical change to multiple partitions, it **MUST** submit multiple events.

## Authorization

- Subscription/delivery behavior is not an authorization grant.
- Server **MUST** authorize project access before activating the connection.
- After connect, server **MUST** reject submit or sync requests whose `projectId` does not match the authenticated session.
- Application-level partition checks may still exist, but they are outside the core protocol contract.

## Sync Scope

- Sync catch-up and broadcast scope are project-wide.
- Within that project scope, each committed event still carries its own `partition`.
- Broadcast is delivered to other active connections for the same project, except while a connection is in an active sync paging cycle.
