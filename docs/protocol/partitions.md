# Projects & Partitions

This document defines the project-scoped partition model for submit, sync, and broadcast.

Normative keywords in this document are to be interpreted as described in RFC 2119: `MUST`, `MUST NOT`, `SHOULD`, `SHOULD NOT`, `MAY`.

## Project Scope

- Each sync connection is bound to exactly one `projectId`.
- `connect.payload.projectId` **MUST** be a non-empty string.
- `sync.payload.projectId` **MUST** equal the authenticated connection project.
- Submitted events are scoped by `partitions`. The server **MUST** add the authenticated project scope before commit.
- New committed events **MUST** include the server-controlled `project:<projectId>` partition. Raw project-id partitions are read for legacy SQLite compatibility only.

## Partition Shape

- `partitions` **MUST** be a non-empty string array.
- Each committed event carries one or more partitions.
- Application partitions **MUST NOT** include a `project:<id>` scope for any project other than the authenticated connection project.

## Authorization

- Subscription/delivery behavior is not an authorization grant.
- Server **MUST** authorize project access before activating the connection.
- After connect, server **MUST** reject submit or sync requests whose `projectId` does not match the authenticated session.
- If a submitted event includes a project-scoped partition, the server **MUST** reject the event unless every project scope matches the authenticated session project.
- If `sync.payload.partitions` includes a project-scoped partition, the server **MUST** reject the request unless every project scope matches the authenticated session project.
- Application-level partition checks may still exist, but they are outside the core protocol contract.

## Sync Scope

- Sync catch-up and broadcast scope are project-wide.
- Within that project scope, each committed event still carries its own application partitions.
- Broadcast is delivered to other active connections for the same project, except while a connection is in an active sync paging cycle.
