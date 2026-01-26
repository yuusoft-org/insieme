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
/**
 * Create event validator
 * @returns {EventValidator} Event validator instance
 */
function createEventValidator() {
  return {
    /**
     * Validate event
     * @param {RepositoryEvent} event - Event to validate
     * @param {ValidationContext} context - Validation context
     * @returns {ValidationResult} Validation result
     */
    validate(event, context) {
      // 1. Schema validation (using existing Insieme validation)
      // 2. Business logic validation
      // 3. Permission validation
      // 4. Idempotency checks
      // 5. Conflict detection
      return { valid: true };
    }
  };
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,  -- Global event ID (evt-1501)
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,           -- JSON string
  partition TEXT,
  client_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- Indexes for queries
CREATE INDEX idx_events_partition ON events(partition);
CREATE INDEX idx_events_client_id ON events(client_id);
CREATE INDEX idx_events_timestamp ON events(timestamp);
CREATE INDEX idx_events_event_id ON events(event_id);

-- Snapshots table (for performance)
CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partition TEXT,
  state TEXT NOT NULL,             -- JSON string
  event_index INTEGER NOT NULL,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  UNIQUE(partition)
);

-- Clients table (for connection tracking)
CREATE TABLE clients (
  id TEXT PRIMARY KEY,
  metadata TEXT,                   -- JSON string
  connected_at INTEGER,
  last_heartbeat INTEGER,
  partition TEXT
);
```

#### Store Implementation

```javascript
// SQLite Store using existing Insieme interface
import Database from 'better-sqlite3';

/**
 * Create SQLite store
 * @param {string} [dbPath=':memory:'] - Database path
 * @returns {RepositoryStore} Store instance
 */
function createSQLiteStore(dbPath = ':memory:') {
  const db = new Database(dbPath);

  // Initialize schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT UNIQUE NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      partition TEXT,
      client_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      partition TEXT,
      state TEXT NOT NULL,
      event_index INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      UNIQUE(partition)
    );

    CREATE INDEX IF NOT EXISTS idx_events_partition ON events(partition);
    CREATE INDEX IF NOT EXISTS idx_events_client_id ON events(client_id);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_event_id ON events(event_id);
  `);

  // Prepare statements
  const getEventsStmt = db.prepare(`
    SELECT event_id as id, event_type as type, payload, partition, client_id, timestamp
    FROM events
    WHERE (?1 IS NULL OR partition = ?1)
    AND (?2 IS NULL OR id > ?2)
    ORDER BY id ASC
  `);

  const appendEventStmt = db.prepare(`
    INSERT INTO events (event_id, event_type, payload, partition, client_id, timestamp)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const getSnapshotStmt = db.prepare(`
    SELECT state, event_index as eventIndex, created_at as createdAt
    FROM snapshots
    ORDER BY created_at DESC
    LIMIT 1
  `);

  const setSnapshotStmt = db.prepare(`
    INSERT OR REPLACE INTO snapshots (partition, state, event_index, created_at)
    VALUES ((SELECT partition FROM snapshots LIMIT 1), ?, ?, ?)
  `);

  return {
    /**
     * Get events from store
     * @param {{partition?: string, since?: number}} [payload] - Optional filters
     * @returns {Promise<RepositoryEvent[]>} Array of events
     */
    async getEvents(payload) {
      const { partition, since } = payload || {};
      const rows = getEventsStmt.all(partition || null, since || null);

      return rows.map(row => ({
        id: row.id,
        type: row.type,
        payload: JSON.parse(row.payload),
        partition: row.partition,
        clientId: row.client_id,
        timestamp: row.timestamp
      }));
    },

    /**
     * Append event to store
     * @param {RepositoryEvent} event - Event to append
     * @returns {Promise<void>}
     */
    async appendEvent(event) {
      appendEventStmt.run(
        event.id || `evt-${Date.now()}`,
        event.type,
        JSON.stringify(event.payload),
        event.partition || null,
        event.clientId || 'unknown',
        event.timestamp || Date.now()
      );
    },

    /**
     * Get snapshot from store
     * @returns {Promise<Snapshot|null>} Snapshot or null
     */
    async getSnapshot() {
      const row = getSnapshotStmt.get();
      if (!row) return null;

      return {
        state: JSON.parse(row.state),
        eventIndex: row.eventIndex,
        createdAt: row.createdAt
      };
    },

    /**
     * Set snapshot in store
     * @param {Snapshot} snapshot - Snapshot to save
     * @returns {Promise<void>}
     */
    async setSnapshot(snapshot) {
      setSnapshotStmt.run(
        JSON.stringify(snapshot.state),
        snapshot.eventIndex,
        snapshot.createdAt
      );
    }
  };
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
/**
 * Create Insieme client
 * @param {Repository} repository - Repository instance
 * @returns {Object} Client instance
 */
function createInsiemeClient(repository) {
  let mode = "online";
  const drafts = new Map();
  let websocket = null;

  return {
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
    },

    /**
     * Handle disconnect
     */
    async handleDisconnect() {
      // Enter offline mode
      mode = "offline";

      // Queue events for later submission
      this.queuePendingEvents();

      // Attempt reconnection with exponential backoff
      this.reconnect();
    },

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
      mode = "online";
    },

    getMode() {
      return mode;
    }
  };
}
```

#### Server-Side Error Handling

```javascript
/**
 * Create message handler
 * @param {Object} logger - Logger instance
 * @returns {MessageHandler} Message handler instance
 */
function createMessageHandler(logger) {
  return {
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
        logger.error("Message handling error", error);

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
  };
}
```

### 8. Performance Optimization

#### Snapshot Strategy

```javascript
// Use existing Insieme snapshot functionality
const snapshotInterval = 1000; // Create snapshot every 1000 events

/**
 * Create snapshot scheduler
 * @returns {Object} Snapshot scheduler instance
 */
function createSnapshotScheduler() {
  return {
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
  };
}
```

#### Event Batching

```javascript
// Batch events for broadcasting to reduce overhead
/**
 * Create broadcast manager with batching
 * @returns {BroadcastManager} Broadcast manager instance
 */
function createBroadcastManager() {
  const eventQueue = [];
  let batchTimeout = null;
  let broadcastBatch = () => {}; // To be implemented

  return {
    /**
     * Broadcast event
     * @param {CommittedEvent} event - Event to broadcast
     */
    broadcast(event) {
      eventQueue.push(event);

      // Send batch after 50ms or when queue reaches 10 events
      if (!batchTimeout) {
        batchTimeout = setTimeout(() => {
          flushBatch();
        }, 50);
      }

      if (eventQueue.length >= 10) {
        flushBatch();
      }
    },

    /**
     * Set batch broadcast handler
     * @param {function} handler - Broadcast handler
     */
    setBroadcastBatch(handler) {
      broadcastBatch = handler;
    },

    /**
     * Flush batch
     * @private
     */
    flushBatch() {
      if (eventQueue.length === 0) return;

      const events = eventQueue.splice(0);
      broadcastBatch(events);

      if (batchTimeout) {
        clearTimeout(batchTimeout);
        batchTimeout = null;
      }
    }
  };
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
/**
 * Create rate limiter
 * @returns {Object} Rate limiter instance
 */
function createRateLimiter() {
  const limits = new Map();

  return {
    /**
     * Check if client can submit
     * @param {string} clientId - Client ID
     * @returns {boolean} Whether submission is allowed
     */
    canSubmit(clientId) {
      const now = Date.now();
      const windowMs = 60000; // 1 minute
      const maxRequests = 100;

      const timestamps = limits.get(clientId) || [];
      const recentTimestamps = timestamps.filter(t => now - t < windowMs);

      if (recentTimestamps.length >= maxRequests) {
        return false;
      }

      recentTimestamps.push(now);
      limits.set(clientId, recentTimestamps);
      return true;
    }
  };
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
/**
 * Create logger
 * @returns {Object} Logger instance
 */
function createLogger() {
  return {
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
    },

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
  };
}
```

### 11. Technology Stack

#### Core Server

- **Runtime**: Node.js or Bun
- **WebSocket Library**: `ws` (minimal, fast, battle-tested)
- **Storage**: SQLite with `better-sqlite3` (synchronous API, simple deployment)
- **Validation**: AJV (already used in Insieme)

#### Development

- **Language**: JavaScript with JSDoc
- **Testing**: Vitest (already used in Insieme)
- **Code Quality**: ESLint, Prettier

### 12. Implementation Roadmap

#### Phase 1: Core WebSocket Server (MVP)
- [ ] Basic WebSocket server with connection management
- [ ] Message routing and handling
- [ ] Event validation using existing Insieme validation
- [ ] Event storage in SQLite
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
- [ ] Logging
- [ ] Performance optimization (batching, compression)
- [ ] Comprehensive testing

### 14. Client Integration

#### Client-Side Changes Needed

```javascript
// Extend Insieme client to support backend sync
/**
 * Create Insieme client with backend sync
 * @param {Repository} repository - Repository instance
 * @returns {Object} Client instance
 */
function createInsiemeClient(repository) {
  /** @type {WebSocket|null} */
  let websocket = null;
  /** @type {Map<string, DraftEvent>} */
  const drafts = new Map();

  return {
    /**
     * Connect to server
     * @param {string} serverUrl - Server WebSocket URL
     */
    async connect(serverUrl) {
      websocket = new WebSocket(serverUrl);

      websocket.onmessage = (message) => {
        this.handleServerMessage(JSON.parse(message.data));
      };
    },

    /**
     * Add event
     * @param {RepositoryEvent} event - Event to add
     */
    async addEvent(event) {
      // Generate draft ID
      const draftId = `draft-${Date.now()}-${Math.random()}`;

      // Apply optimistically
      await repository.addEvent(event);
      drafts.set(draftId, { event, state: repository.getState() });

      // Send to server
      websocket.send(JSON.stringify({
        type: "submit_event",
        payload: {
          draftId,
          event
        }
      }));
    },

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
    },

    /**
     * Handle event accepted
     * @param {EventAcceptedPayload} payload - Event accepted payload
     */
    handleEventAccepted(payload) {
      // Remove draft
      drafts.delete(payload.draftId);

      // Apply committed event (replaces draft)
      // The event is the same, but now has server ID
      console.log(`Event accepted: ${payload.eventId}`);
    },

    /**
     * Handle event rejected
     * @param {EventRejectedPayload} payload - Event rejected payload
     */
    handleEventRejected(payload) {
      // Rollback to state before draft
      const draft = drafts.get(payload.draftId);
      if (draft) {
        // Rollback state
        repository.restoreState(draft.state);
        drafts.delete(payload.draftId);

        // Show error to user
        console.error("Event rejected:", payload.reason, payload.errors);
      }
    },

    /**
     * Handle broadcast
     * @param {BroadcastPayload} payload - Broadcast payload
     */
    handleBroadcast(payload) {
      // Apply committed event from another client
      repository.addEvent(payload.event);
    }
  };
}
```

### 13. Deployment

#### Simple Deployment

```bash
# Run the server
node server.js

# Or with Bun
bun run server.js

# Server will:
# - Create SQLite database file (insieme.db)
# - Start WebSocket server on port 3001
# - Handle connections and events
```

#### Environment Variables

```bash
# Optional configuration
PORT=3001              # WebSocket port (default: 3001)
DB_PATH=./insieme.db   # SQLite database path (default: :memory:)
SNAPSHOT_INTERVAL=1000 # Events between snapshots (default: 1000)
LOG_LEVEL=info         # Log level (default: info)
```

#### Docker Deployment (Optional)

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install --production

# Copy source
COPY . .

# Expose WebSocket port
EXPOSE 3001

# Start server
CMD ["node", "server.js"]
```

```bash
# Build and run
docker build -t insieme-backend .
docker run -p 3001:3001 -v $(pwd)/data:/app/data insieme-backend
```

## Conclusion

This backend design provides a simple, minimal, yet robust architecture for building an authoritative server for Insieme. The design prioritizes:

1. **Simplicity**: Single server, SQLite storage, factory functions
2. **Correctness**: Central authority ensures consistent state
3. **Performance**: Optimizations like snapshots and batching
4. **Reliability**: Error handling, reconnection, and recovery
5. **Security**: Authentication, authorization, and input validation

The WebSocket-based approach enables real-time collaboration while maintaining the Insieme philosophy of optimistic client updates with server validation.

## Next Steps

1. Implement Phase 1 (MVP) - Basic WebSocket server
2. Add comprehensive testing
3. Deploy to staging environment
4. Iterate based on real-world usage
