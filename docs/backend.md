# Backend Design for Insieme

## Overview

This document explores the design and implementation of an authoritative backend server for Insieme. The backend serves as the central source of truth, validating events from clients and broadcasting confirmed state changes to all connected clients via WebSockets.

## Architecture Principles

### Authoritative Server Model

- **Single Source of Truth**: The backend maintains the canonical state
- **Client Optimism**: Clients apply events optimistically as "drafts"
- **Validation Layer**: All events must be validated by the server before being committed
- **Event Ordering**: Server assigns sequential IDs to events to ensure ordering
- **Broadcast**: Committed events are broadcast to all connected clients

### Flow Diagram

```
Client A                          Server                          Client B
   |                                |                                |
   |--[Draft Event]---------------->|                                |
   |                                |--[Validate]                   |
   |                                |--[Apply to State]             |
   |                                |--[Assign ID]                  |
   |<--[Committed Event]------------|                                |
   |                                |--[Broadcast]----------------->|
   |                                |                                |
   |--[Apply Committed]             |                         <--[Apply Committed]
   |                                |                                |
```

## Design Decisions

### 1. WebSocket Protocol

#### Protocol Choice: WebSocket over HTTP/REST

**Why WebSocket?**
- Real-time bidirectional communication
- Low latency for event broadcasting
- Persistent connection reduces overhead
- Natural fit for collaborative applications

**Protocol Structure:**

```javascript
/**
 * @typedef {"connect"|"connected"|"submit_event"|"event_accepted"|"event_rejected"|"broadcast"|"sync"|"sync_response"|"heartbeat"|"error"} MessageType
 */

/**
 * Base message structure
 * @typedef {Object} BaseMessage
 * @property {string} id - Unique message ID
 * @property {MessageType} type - Message type
 * @property {number} timestamp - Unix timestamp
 */
```

#### Connection Flow

```javascript
// 1. Client connects
{
  id: "msg-1",
  type: "connect",
  timestamp: 1234567890,
  payload: {
    clientId: "client-uuid",
    version: "0.0.8",
    partition: "session-1"  // Optional partition identifier
  }
}

// 2. Server acknowledges
{
  id: "msg-2",
  type: "connected",
  timestamp: 1234567891,
  payload: {
    serverId: "server-uuid",
    currentEventIndex: 1500,  // Last committed event ID
    initialState: {},         // If client needs full state
    sinceSnapshot: 1000       // Events since snapshot
  }
}
```

#### Event Submission Flow

```javascript
// Client submits draft event
{
  id: "msg-3",
  type: "submit_event",
  timestamp: 1234567892,
  payload: {
    draftId: "draft-abc",      // Client's draft identifier
    event: {
      type: "treePush",
      payload: {
        target: "explorer",
        value: { id: "file1", name: "New File", type: "file" },
        options: { parent: "_root" }
      },
      partition: "session-1"
    }
  }
}

// Server accepts and commits
{
  id: "msg-4",
  type: "event_accepted",
  timestamp: 1234567893,
  payload: {
    draftId: "draft-abc",
    eventId: 1501,              // Server-assigned sequential ID
    event: {
      type: "treePush",
      payload: { /* ... */ },
      partition: "session-1",
      id: "evt-1501",           // Global event ID
      timestamp: 1234567893,
      clientId: "client-uuid"
    }
  }
}

// OR Server rejects
{
  id: "msg-4",
  type: "event_rejected",
  timestamp: 1234567893,
  payload: {
    draftId: "draft-abc",
    reason: "validation_failed",
    errors: [
      {
        field: "payload.value.id",
        message: "ID already exists"
      }
    ]
  }
}
```

#### Event Broadcasting

```javascript
// Server broadcasts to all clients (including submitter)
{
  id: "msg-5",
  type: "broadcast",
  timestamp: 1234567894,
  payload: {
    eventId: 1501,
    event: {
      type: "treePush",
      payload: { /* ... */ },
      partition: "session-1",
      id: "evt-1501",
      timestamp: 1234567893,
      clientId: "client-uuid"
    }
  }
}
```

#### State Synchronization

```javascript
// Client requests sync (e.g., after reconnection)
{
  id: "msg-6",
  type: "sync",
  timestamp: 1234567895,
  payload: {
    sinceEventId: 1400,         // Optional: get events since this ID
    partition: "session-1"
  }
}

// Server responds
{
  id: "msg-7",
  type: "sync_response",
  timestamp: 1234567896,
  payload: {
    snapshot: {
      state: { /* ... */ },
      eventIndex: 1500
    },
    events: [ /* events 1401-1500 */ ],
    currentEventIndex: 1500
  }
}
```

### 2. Server Architecture

#### Component Design

```
┌─────────────────────────────────────────────────────────────┐
│                     WebSocket Server                         │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Connection   │    │ Message      │    │ Event        │  │
│  │ Manager      │───>│ Handler      │───>│ Validator    │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│         │                                       │           │
│         v                                       v           │
│  ┌──────────────┐                        ┌──────────┐     │
│  │ Client       │                        │ State    │     │
│  │ Registry     │                        │ Manager  │     │
│  └──────────────┘                        └──────────┘     │
│         │                                       │           │
│         v                                       v           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────┐     │
│  │ Broadcast    │<──>│ Repository   │<──>│ Store    │     │
│  │ Manager      │    │ (Insieme)    │    │ (DB)     │     │
│  └──────────────┘    └──────────────┘    └──────────┘     │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

#### Core Components

##### 1. Connection Manager

```javascript
/**
 * Connection manager interface
 * @typedef {Object} ConnectionManager
 * @property {function(string, WebSocket): Connection} connect - Connect a client
 * @property {function(string): void} disconnect - Disconnect a client
 * @property {function(string): Connection|undefined} getConnection - Get connection by ID
 * @property {function(string, ClientMetadata): void} registerClient - Register a client
 * @property {function(string): void} unregisterClient - Unregister a client
 * @property {function(): Client[]} getClients - Get all clients
 * @property {function(string): Client[]} getClientsInPartition - Get clients in partition
 * @property {function(string): boolean} isConnected - Check if client is connected
 * @property {function(): number} getConnectionCount - Get connection count
 */

/**
 * Connection object
 * @typedef {Object} Connection
 * @property {string} id - Connection ID
 * @property {string} clientId - Client ID
 * @property {WebSocket} ws - WebSocket instance
 * @property {string} [partition] - Optional partition
 * @property {number} connectedAt - Connection timestamp
 * @property {number} lastHeartbeat - Last heartbeat timestamp
 * @property {ClientMetadata} metadata - Client metadata
 */

/**
 * Client metadata
 * @typedef {Object} ClientMetadata
 * @property {string} version - Client version
 * @property {string} [userAgent] - User agent string
 * @property {string} [partition] - Partition identifier
 */
```

##### 2. Message Handler

```javascript
/**
 * Message handler interface
 * @typedef {Object} MessageHandler
 * @property {function(IncomingMessage, Connection): Promise<void>} handle - Handle message
 */

/**
 * Incoming message
 * @typedef {BaseMessage & {payload: unknown}} IncomingMessage
 */

// Message routing
const messageHandlers = {
  connect: new ConnectHandler(),
  submit_event: new SubmitEventHandler(),
  sync: new SyncHandler(),
  heartbeat: new HeartbeatHandler(),
  // ... other handlers
};
```

##### 3. Event Validator

```javascript
/**
 * Event validator interface
 * @typedef {Object} EventValidator
 * @property {function(RepositoryEvent, ValidationContext): ValidationResult} validate - Validate event
 */

/**
 * Validation context
 * @typedef {Object} ValidationContext
 * @property {string} clientId - Client ID
 * @property {string} [partition] - Optional partition
 * @property {RepositoryState} currentState - Current state
 * @property {RepositoryEvent[]} eventHistory - Event history
 */

/**
 * Validation result
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - Whether validation passed
 * @property {ValidationError[]} [errors] - Validation errors
 */

/**
 * Validation error
 * @typedef {Object} ValidationError
 * @property {string} field - Field with error
 * @property {string} message - Error message
 * @property {string} code - Error code
 */

// Validation rules
class EventValidatorImpl {
  // 1. Schema validation (using existing Insieme validation)
  // 2. Business logic validation
  // 3. Permission validation
  // 4. Idempotency checks
  // 5. Conflict detection
}
```

##### 4. State Manager

```javascript
/**
 * State manager interface
 * @typedef {Object} StateManager
 * @property {function(string=): RepositoryState} getCurrentState - Get current state
 * @property {function(): number} getCurrentEventIndex - Get current event index
 * @property {function(CommittedEvent): Promise<void>} applyEvent - Apply event
 * @property {function(CommittedEvent[]): Promise<void>} applyEvents - Apply events
 * @property {function(): Promise<Snapshot>} createSnapshot - Create snapshot
 * @property {function(): Promise<Snapshot|null>} loadSnapshot - Load snapshot
 * @property {function(number): RepositoryState} getStateAtEventIndex - Get state at index
 * @property {function(number, number): CommittedEvent[]} getEventsRange - Get events range
 */
```

##### 5. Broadcast Manager

```javascript
/**
 * Broadcast manager interface
 * @typedef {Object} BroadcastManager
 * @property {function(CommittedEvent): void} broadcast - Broadcast to all
 * @property {function(string, CommittedEvent): void} broadcastToPartition - Broadcast to partition
 * @property {function(string[], CommittedEvent): void} broadcastToClients - Broadcast to clients
 * @property {function(string, CommittedEvent): void} broadcastExcept - Broadcast except client
 */
```

### 3. Event Lifecycle

#### Event Submission to Commit

```
1. Client submits draft event
   ↓
2. Server validates schema (using existing Insieme validation)
   ↓
3. Server validates business rules
   ↓
4. Server assigns sequential ID and timestamp
   ↓
5. Server applies event to state
   ↓
6. Server persists event to store
   ↓
7. Server sends acceptance to submitter
   ↓
8. Server broadcasts to all clients
   ↓
9. Clients apply committed event (replacing draft)
```

#### Event Rejection

```
1. Client submits draft event
   ↓
2. Server validates schema
   ↓
3. Server validates business rules
   ↓
4. Validation fails
   ↓
5. Server sends rejection with details to submitter
   ↓
6. Client handles rejection (rollback, show error, etc.)
```

### 4. Validation Strategy

#### Multi-Layer Validation

```javascript
// Layer 1: Schema Validation (already exists in Insieme)
import { validateEventPayload } from "insieme";

/**
 * Validate event schema
 * @param {RepositoryEvent} event - Event to validate
 * @returns {ValidationResult} Validation result
 */
function validateSchema(event) {
  try {
    validateEventPayload(event.type, event.payload);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      errors: [{
        field: error.eventType,
        message: error.message,
        code: "SCHEMA_ERROR"
      }]
    };
  }
}

// Layer 2: Business Logic Validation
/**
 * Validate business logic
 * @param {RepositoryEvent} event - Event to validate
 * @param {RepositoryState} state - Current state
 * @returns {ValidationResult} Validation result
 */
function validateBusinessLogic(event, state) {
  switch (event.type) {
    case "treePush":
      return validateTreePush(event, state);
    case "treeDelete":
      return validateTreeDelete(event, state);
    case "treeMove":
      return validateTreeMove(event, state);
    // ... other cases
  }
}

// Layer 3: Permission Validation
/**
 * Validate permissions
 * @param {RepositoryEvent} event - Event to validate
 * @param {string} clientId - Client ID
 * @returns {ValidationResult} Validation result
 */
function validatePermissions(event, clientId) {
  // Check if client has permission to perform this action
  // Implement based on your auth system
}

// Layer 4: Conflict Detection
/**
 * Validate conflicts
 * @param {RepositoryEvent} event - Event to validate
 * @param {RepositoryEvent[]} history - Event history
 * @returns {ValidationResult} Validation result
 */
function validateConflicts(event, history) {
  // Check for concurrent modifications
  // Implement Last-Write-Wins or other conflict resolution
}
```

#### Example: treePush Validation

```javascript
/**
 * Validate treePush event
 * @param {RepositoryEvent} event - Event to validate
 * @param {RepositoryState} state - Current state
 * @returns {ValidationResult} Validation result
 */
function validateTreePush(event, state) {
  const { target, value, options } = event.payload;

  // Check if target exists in state
  if (!state[target]) {
    return {
      valid: false,
      errors: [{
        field: "payload.target",
        message: `Target "${target}" does not exist in state`,
        code: "TARGET_NOT_FOUND"
      }]
    };
  }

  // Check if ID is unique
  const targetData = state[target];
  if (targetData.items[value.id]) {
    return {
      valid: false,
      errors: [{
        field: "payload.value.id",
        message: `ID "${value.id}" already exists`,
        code: "DUPLICATE_ID"
      }]
    };
  }

  // Validate parent exists (if not _root)
  if (options.parent && options.parent !== "_root") {
    if (!targetData.items[options.parent]) {
      return {
        valid: false,
        errors: [{
          field: "payload.options.parent",
          message: `Parent "${options.parent}" does not exist`,
          code: "PARENT_NOT_FOUND"
        }]
      };
    }
  }

  return { valid: true };
}
```

### 5. Storage Strategy

#### Database Schema

```sql
-- Events table (append-only log)
CREATE TABLE events (
  id BIGSERIAL PRIMARY KEY,
  event_id VARCHAR(255) UNIQUE NOT NULL,  -- Global event ID (evt-1501)
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  partition VARCHAR(255),
  client_id VARCHAR(255) NOT NULL,
  timestamp BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for queries
CREATE INDEX idx_events_partition ON events(partition);
CREATE INDEX idx_events_client_id ON events(client_id);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_event_id ON events(event_id);

-- Snapshots table (for performance)
CREATE TABLE snapshots (
  id SERIAL PRIMARY KEY,
  partition VARCHAR(255),
  state JSONB NOT NULL,
  event_index BIGINT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(partition)
);

-- Clients table (for connection tracking)
CREATE TABLE clients (
  id VARCHAR(255) PRIMARY KEY,
  metadata JSONB,
  connected_at TIMESTAMP,
  last_heartbeat TIMESTAMP,
  partition VARCHAR(255)
);
```

#### Store Implementation

```javascript
// PostgreSQL Store using existing Insieme interface
/**
 * PostgreSQL store implementation
 * @class
 */
class PostgresStore {
  /**
   * Get events from store
   * @param {{partition?: string, since?: number}} [payload] - Optional filters
   * @returns {Promise<RepositoryEvent[]>} Array of events
   */
  async getEvents(payload) {
    // Query events table with optional filters
    // Support pagination for large datasets
  }

  /**
   * Append event to store
   * @param {RepositoryEvent} event - Event to append
   * @returns {Promise<void>}
   */
  async appendEvent(event) {
    // Insert event into events table
    // Return with server-assigned ID
  }

  /**
   * Get snapshot from store
   * @returns {Promise<Snapshot|null>} Snapshot or null
   */
  async getSnapshot() {
    // Query latest snapshot from snapshots table
  }

  /**
   * Set snapshot in store
   * @param {Snapshot} snapshot - Snapshot to save
   * @returns {Promise<void>}
   */
  async setSnapshot(snapshot) {
    // Upsert snapshot into snapshots table
  }
}
```

### 6. Concurrency & Consistency

#### Event Ordering

```javascript
/**
 * Committed event structure
 * @typedef {RepositoryEvent & {id: string, eventId: number, clientId: string, timestamp: number, partition?: string}} CommittedEvent
 */

// Sequential event IDs ensure ordering
// Event sequence is maintained by database
// Clients use eventId for ordering and conflict resolution
```

#### Last-Write-Wins (LWW)

```javascript
// For concurrent modifications to same target
// Higher eventId wins (later event overwrites earlier)
/**
 * Resolve conflicts between events
 * @param {RepositoryEvent[]} events - Events to resolve
 * @param {RepositoryState} state - Current state
 * @returns {void}
 */
function resolveConflict(events, state) {
  // Sort by eventId and apply in order
  // Last write to a specific path wins
}
```

### 7. Error Handling & Recovery

#### Connection Errors

```javascript
// Client-side error handling
class InsiemeClient {
  /**
   * Handle submit error
   * @param {Error} error - Error to handle
   */
  async handleSubmitError(error) {
    if (error.message.includes("validation_failed")) {
      // Rollback optimistic update
      this.rollbackDraft(error.draftId);

      // Show user-friendly error
      this.showValidationError(error.errors);
    }
  }

  /**
   * Handle disconnect
   */
  async handleDisconnect() {
    // Enter offline mode
    this.mode = "offline";

    // Queue events for later submission
    this.queuePendingEvents();

    // Attempt reconnection with exponential backoff
    this.reconnect();
  }

  /**
   * Handle reconnect
   */
  async handleReconnect() {
    // Request sync to get missed events
    const syncResponse = await this.requestSync();

    // Apply missed events
    this.applyEvents(syncResponse.events);

    // Submit queued events
    await this.submitQueuedEvents();

    // Return to online mode
    this.mode = "online";
  }
}
```

#### Server-Side Error Handling

```javascript
class MessageHandlerImpl {
  /**
   * Handle message
   * @param {IncomingMessage} message - Message to handle
   * @param {Connection} connection - Connection instance
   */
  async handle(message, connection) {
    try {
      // Process message
      await this.processMessage(message, connection);
    } catch (error) {
      // Log error
      this.logger.error("Message handling error", error);

      // Send error response to client
      connection.send({
        type: "error",
        payload: {
          code: error.code,
          message: error.message,
          details: error.details
        }
      });
    }
  }
}
```

### 8. Performance Optimization

#### Snapshot Strategy

```javascript
// Use existing Insieme snapshot functionality
const snapshotInterval = 1000; // Create snapshot every 1000 events

class SnapshotScheduler {
  /**
   * Schedule snapshot creation
   * @param {StateManager} stateManager - State manager instance
   */
  async scheduleSnapshot(stateManager) {
    setInterval(async () => {
      const currentIndex = stateManager.getCurrentEventIndex();

      if (currentIndex % snapshotInterval === 0) {
        await stateManager.createSnapshot();
      }
    }, 60000); // Check every minute
  }
}
```

#### Event Batching

```javascript
// Batch events for broadcasting to reduce overhead
class BroadcastManagerImpl {
  constructor() {
    /** @type {CommittedEvent[]} */
    this.eventQueue = [];
    /** @type {NodeJS.Timeout|null} */
    this.batchTimeout = null;
  }

  /**
   * Broadcast event
   * @param {CommittedEvent} event - Event to broadcast
   */
  broadcast(event) {
    this.eventQueue.push(event);

    // Send batch after 50ms or when queue reaches 10 events
    if (!this.batchTimeout) {
      this.batchTimeout = setTimeout(() => {
        this.flushBatch();
      }, 50);
    }

    if (this.eventQueue.length >= 10) {
      this.flushBatch();
    }
  }

  /**
   * Flush batch
   * @private
   */
  flushBatch() {
    if (this.eventQueue.length === 0) return;

    const events = this.eventQueue.splice(0);
    this.broadcastBatch(events);

    if (this.batchTimeout) {
      clearTimeout(this.batchTimeout);
      this.batchTimeout = null;
    }
  }
}
```

#### Compression

```javascript
// Compress large state snapshots
import * as zlib from "zlib";

/**
 * Compress snapshot
 * @param {Snapshot} snapshot - Snapshot to compress
 * @returns {Promise<Buffer>} Compressed snapshot
 */
async function compressSnapshot(snapshot) {
  const json = JSON.stringify(snapshot);
  return zlib.gzip(json);
}

/**
 * Decompress snapshot
 * @param {Buffer} buffer - Compressed snapshot
 * @returns {Promise<Snapshot>} Decompressed snapshot
 */
async function decompressSnapshot(buffer) {
  const json = await zlib.gunzip(buffer);
  return JSON.parse(json.toString());
}
```

### 9. Security Considerations

#### Authentication & Authorization

```javascript
// JWT-based authentication
/**
 * Auth token structure
 * @typedef {Object} AuthToken
 * @property {string} clientId - Client ID
 * @property {string} userId - User ID
 * @property {string[]} permissions - Permissions array
 * @property {string} [partition] - Optional partition
 * @property {number} exp - Expiration timestamp
 */

// Validate client on connection
/**
 * Authenticate connection
 * @param {string} token - JWT token
 * @returns {Promise<AuthToken>} Decoded token
 */
async function authenticateConnection(token) {
  // Verify JWT signature
  // Check expiration
  // Return decoded token
}

// Authorization check
/**
 * Check permission
 * @param {AuthToken} token - Auth token
 * @param {string} action - Action to check
 * @param {string} target - Target to check
 * @returns {boolean} Whether action is permitted
 */
function checkPermission(token, action, target) {
  // Check if token.permissions includes required permission
  // Implement role-based access control
}
```

#### Rate Limiting

```javascript
// Rate limit event submissions per client
class RateLimiter {
  constructor() {
    /** @type {Map<string, number[]>} */
    this.limits = new Map();
  }

  /**
   * Check if client can submit
   * @param {string} clientId - Client ID
   * @returns {boolean} Whether submission is allowed
   */
  canSubmit(clientId) {
    const now = Date.now();
    const windowMs = 60000; // 1 minute
    const maxRequests = 100;

    const timestamps = this.limits.get(clientId) || [];
    const recentTimestamps = timestamps.filter(t => now - t < windowMs);

    if (recentTimestamps.length >= maxRequests) {
      return false;
    }

    recentTimestamps.push(now);
    this.limits.set(clientId, recentTimestamps);
    return true;
  }
}
```

#### Input Validation

```javascript
// Use existing Insieme validation
import { validateEventPayload } from "insieme";

// Additional server-side validation
/**
 * Sanitize input
 * @param {RepositoryEvent} event - Event to sanitize
 * @returns {RepositoryEvent} Sanitized event
 */
function sanitizeInput(event) {
  // Remove any sensitive data
  // Validate data types
  // Check for malicious payloads
  return event;
}
```

### 10. Monitoring & Observability

#### Metrics to Track

```javascript
// Performance metrics
/**
 * Metrics structure
 * @typedef {Object} Metrics
 * @property {number} activeConnections - Active connection count
 * @property {number} totalConnections - Total connection count
 * @property {number} connectionsPerSecond - Connections per second
 * @property {number} eventsPerSecond - Events per second
 * @property {number} averageEventProcessingTime - Average event processing time
 * @property {number} eventValidationFailureRate - Event validation failure rate
 * @property {number} averageBroadcastLatency - Average broadcast latency
 * @property {number} broadcastQueueSize - Broadcast queue size
 * @property {number} averageEventPersistenceTime - Average event persistence time
 * @property {number} snapshotCreationTime - Snapshot creation time
 * @property {number} errorRate - Error rate
 * @property {Record<string, number>} errorsByType - Errors by type
 */
```

#### Logging

```javascript
// Structured logging
class Logger {
  /**
   * Log info message
   * @param {string} message - Message to log
   * @param {object} [meta] - Optional metadata
   */
  info(message, meta) {
    console.log(JSON.stringify({
      level: "info",
      timestamp: Date.now(),
      message,
      ...meta
    }));
  }

  /**
   * Log error message
   * @param {string} message - Message to log
   * @param {Error} error - Error to log
   * @param {object} [meta] - Optional metadata
   */
  error(message, error, meta) {
    console.error(JSON.stringify({
      level: "error",
      timestamp: Date.now(),
      message,
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      },
      ...meta
    }));
  }
}
```

### 11. Scalability

#### Horizontal Scaling

```javascript
// Use Redis Pub/Sub for cross-server broadcasting
import { Redis } from "ioredis";

class RedisBroadcastManager {
  constructor() {
    /** @type {Redis} */
    this.redis = new Redis();
    /** @type {Redis} */
    this.publisher = new Redis();
    /** @type {Redis} */
    this.subscriber = new Redis();

    // Subscribe to broadcast channel
    this.subscriber.subscribe("insieme:broadcast", (err) => {
      if (err) console.error("Failed to subscribe", err);
    });

    this.subscriber.on("message", (channel, message) => {
      if (channel === "insieme:broadcast") {
        const event = JSON.parse(message);
        this.broadcastToLocalClients(event);
      }
    });
  }

  /**
   * Broadcast event
   * @param {CommittedEvent} event - Event to broadcast
   */
  broadcast(event) {
    // Publish to Redis for all servers
    this.publisher.publish("insieme:broadcast", JSON.stringify(event));

    // Also broadcast to local clients
    this.broadcastToLocalClients(event);
  }

  /**
   * Broadcast to local clients
   * @param {CommittedEvent} event - Event to broadcast
   * @private
   */
  broadcastToLocalClients(event) {
    // Broadcast to clients connected to this server
  }
}
```

#### Partition-Based Sharding

```javascript
// Shard clients by partition
class ShardedConnectionManager {
  constructor() {
    /** @type {Map<string, ConnectionManager>} */
    this.shards = new Map();
  }

  /**
   * Get shard for partition
   * @param {string} partition - Partition identifier
   * @returns {ConnectionManager} Connection manager for partition
   */
  getShard(partition) {
    if (!this.shards.has(partition)) {
      this.shards.set(partition, new ConnectionManagerImpl());
    }
    return this.shards.get(partition);
  }

  /**
   * Connect client
   * @param {string} clientId - Client ID
   * @param {WebSocket} ws - WebSocket instance
   * @param {string} [partition] - Optional partition
   * @returns {Connection} Connection instance
   */
  connect(clientId, ws, partition) {
    const shard = partition ? this.getShard(partition) : this.getDefaultShard();
    return shard.connect(clientId, ws);
  }
}
```

### 12. Technology Stack Recommendations

#### Core Server

- **Runtime**: Node.js with Bun or Node.js
- **WebSocket Library**: `ws` (minimal, fast) or `socket.io` (feature-rich)
- **Framework**: Fastify or Express (for REST endpoints alongside WebSocket)

#### Storage

- **Database**: PostgreSQL (reliable, supports JSONB)
- **Cache**: Redis (for pub/sub and session management)
- **Alternative**: MongoDB (for simpler deployments)

#### Validation

- **Schema Validation**: AJV (already used in Insieme)
- **Business Logic**: Custom validators

#### Monitoring

- **Metrics**: Prometheus + Grafana
- **Logging**: Winston or Pino
- **Tracing**: OpenTelemetry

#### Development

- **Language**: JavaScript with JSDoc
- **Testing**: Vitest (already used in Insieme)
- **Code Quality**: ESLint, Prettier

### 13. Implementation Roadmap

#### Phase 1: Core WebSocket Server (MVP)
- [ ] Basic WebSocket server with connection management
- [ ] Message routing and handling
- [ ] Event validation using existing Insieme validation
- [ ] Event storage in PostgreSQL
- [ ] Basic broadcasting to all clients

#### Phase 2: Advanced Features
- [ ] Partition support
- [ ] Snapshot management
- [ ] State synchronization
- [ ] Reconnection handling
- [ ] Error recovery

#### Phase 3: Production Readiness
- [ ] Authentication and authorization
- [ ] Rate limiting
- [ ] Monitoring and logging
- [ ] Performance optimization
- [ ] Comprehensive testing

#### Phase 4: Scalability
- [ ] Horizontal scaling with Redis
- [ ] Load balancing
- [ ] Sharding strategies
- [ ] CDN integration for static assets

### 14. Client Integration

#### Client-Side Changes Needed

```javascript
// Extend Insieme client to support backend sync
class InsiemeClient {
  /**
   * Constructor
   * @param {Repository} repository - Repository instance
   */
  constructor(repository) {
    /** @type {Repository} */
    this.repository = repository;
    /** @type {WebSocket} */
    this.websocket = null;
    /** @type {Map<string, DraftEvent>} */
    this.drafts = new Map();
  }

  /**
   * Connect to server
   * @param {string} serverUrl - Server WebSocket URL
   */
  async connect(serverUrl) {
    this.websocket = new WebSocket(serverUrl);

    this.websocket.onmessage = (message) => {
      this.handleServerMessage(JSON.parse(message.data));
    };
  }

  /**
   * Add event
   * @param {RepositoryEvent} event - Event to add
   */
  async addEvent(event) {
    // Generate draft ID
    const draftId = `draft-${Date.now()}-${Math.random()}`;

    // Apply optimistically
    await this.repository.addEvent(event);
    this.drafts.set(draftId, { event, state: this.repository.getState() });

    // Send to server
    this.websocket.send(JSON.stringify({
      type: "submit_event",
      payload: {
        draftId,
        event
      }
    }));
  }

  /**
   * Handle server message
   * @param {ServerMessage} message - Server message
   */
  handleServerMessage(message) {
    switch (message.type) {
      case "event_accepted":
        this.handleEventAccepted(message.payload);
        break;
      case "event_rejected":
        this.handleEventRejected(message.payload);
        break;
      case "broadcast":
        this.handleBroadcast(message.payload);
        break;
    }
  }

  /**
   * Handle event accepted
   * @param {EventAcceptedPayload} payload - Event accepted payload
   */
  handleEventAccepted(payload) {
    // Remove draft
    this.drafts.delete(payload.draftId);

    // Apply committed event (replaces draft)
    // The event is the same, but now has server ID
    console.log(`Event accepted: ${payload.eventId}`);
  }

  /**
   * Handle event rejected
   * @param {EventRejectedPayload} payload - Event rejected payload
   */
  handleEventRejected(payload) {
    // Rollback to state before draft
    const draft = this.drafts.get(payload.draftId);
    if (draft) {
      // Rollback state
      this.repository.restoreState(draft.state);
      this.drafts.delete(payload.draftId);

      // Show error to user
      console.error("Event rejected:", payload.reason, payload.errors);
    }
  }

  /**
   * Handle broadcast
   * @param {BroadcastPayload} payload - Broadcast payload
   */
  handleBroadcast(payload) {
    // Apply committed event from another client
    this.repository.addEvent(payload.event);
  }
}
```

### 15. Deployment Considerations

#### Docker Setup

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json bun.lockb ./
RUN npm install -g bun && bun install

# Copy source
COPY . .

# Build
RUN bun run build

# Expose WebSocket port
EXPOSE 3001

# Start server
CMD ["node", "dist/server.js"]
```

#### Kubernetes Deployment

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: insieme-backend
spec:
  replicas: 3
  selector:
    matchLabels:
      app: insieme-backend
  template:
    metadata:
      labels:
        app: insieme-backend
    spec:
      containers:
      - name: backend
        image: insieme-backend:latest
        ports:
        - containerPort: 3001
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: insieme-secrets
              key: database-url
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: insieme-secrets
              key: redis-url
---
apiVersion: v1
kind: Service
metadata:
  name: insieme-backend
spec:
  selector:
    app: insieme-backend
  ports:
  - port: 3001
    targetPort: 3001
  type: LoadBalancer
```

## Conclusion

This backend design provides a comprehensive architecture for building an authoritative server for Insieme. The design prioritizes:

1. **Correctness**: Central authority ensures consistent state
2. **Performance**: Optimizations like snapshots, batching, and compression
3. **Scalability**: Horizontal scaling support with Redis
4. **Reliability**: Error handling, reconnection, and recovery
5. **Security**: Authentication, authorization, and input validation

The WebSocket-based approach enables real-time collaboration while maintaining the Insieme philosophy of optimistic client updates with server validation.

## Next Steps

1. Review and refine this design based on team feedback
2. Choose specific technology stack
3. Implement Phase 1 (MVP)
4. Add comprehensive testing
5. Deploy to staging environment
6. Iterate based on real-world usage
