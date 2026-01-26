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

```typescript
// Message Types
type MessageType =
  | "connect"        // Client connects
  | "connected"      // Server acknowledges connection
  | "submit_event"   // Client submits draft event
  | "event_accepted" // Server accepts and commits event
  | "event_rejected" // Server rejects event
  | "broadcast"      // Server broadcasts committed event
  | "sync"           // Client requests state sync
  | "sync_response"  // Server sends current state
  | "heartbeat"      // Keep-alive messages
  | "error";         // Error messages

// Base Message Structure
interface BaseMessage {
  id: string;        // Unique message ID
  type: MessageType;
  timestamp: number; // Unix timestamp
}
```

#### Connection Flow

```typescript
// 1. Client connects
{
  id: "msg-1",
  type: "connect",
  timestamp: 1234567890,
  payload: {
    clientId: "client-uuid",
    version: "0.0.8",
    partition?: string  // Optional partition identifier
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
    initialState?: object,     // If client needs full state
    sinceSnapshot?: number     // Events since snapshot
  }
}
```

#### Event Submission Flow

```typescript
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
      payload: { ... },
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

```typescript
// Server broadcasts to all clients (including submitter)
{
  id: "msg-5",
  type: "broadcast",
  timestamp: 1234567894,
  payload: {
    eventId: 1501,
    event: {
      type: "treePush",
      payload: { ... },
      partition: "session-1",
      id: "evt-1501",
      timestamp: 1234567893,
      clientId: "client-uuid"
    }
  }
}
```

#### State Synchronization

```typescript
// Client requests sync (e.g., after reconnection)
{
  id: "msg-6",
  type: "sync",
  timestamp: 1234567895,
  payload: {
    sinceEventId: 1400,         // Optional: get events since this ID
    partition?: string
  }
}

// Server responds
{
  id: "msg-7",
  type: "sync_response",
  timestamp: 1234567896,
  payload: {
    snapshot?: {
      state: object,
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

```typescript
interface ConnectionManager {
  // Connection lifecycle
  connect(clientId: string, ws: WebSocket): Connection;
  disconnect(clientId: string): void;
  getConnection(clientId: string): Connection | undefined;

  // Client registry
  registerClient(clientId: string, metadata: ClientMetadata): void;
  unregisterClient(clientId: string): void;
  getClients(): Client[];
  getClientsInPartition(partition: string): Client[];

  // Connection state
  isConnected(clientId: string): boolean;
  getConnectionCount(): number;
}

interface Connection {
  id: string;
  clientId: string;
  ws: WebSocket;
  partition?: string;
  connectedAt: number;
  lastHeartbeat: number;
  metadata: ClientMetadata;
}

interface ClientMetadata {
  version: string;
  userAgent?: string;
  partition?: string;
}
```

##### 2. Message Handler

```typescript
interface MessageHandler {
  handle(message: IncomingMessage, connection: Connection): Promise<void>;
}

type IncomingMessage = BaseMessage & {
  payload: unknown;
};

// Message routing
const messageHandlers: Record<MessageType, MessageHandler> = {
  connect: new ConnectHandler(),
  submit_event: new SubmitEventHandler(),
  sync: new SyncHandler(),
  heartbeat: new HeartbeatHandler(),
  // ... other handlers
};
```

##### 3. Event Validator

```typescript
interface EventValidator {
  validate(event: RepositoryEvent, context: ValidationContext): ValidationResult;
}

interface ValidationContext {
  clientId: string;
  partition?: string;
  currentState: RepositoryState;
  eventHistory: RepositoryEvent[];
}

interface ValidationResult {
  valid: boolean;
  errors?: ValidationError[];
}

interface ValidationError {
  field: string;
  message: string;
  code: string;
}

// Validation rules
class EventValidatorImpl implements EventValidator {
  // 1. Schema validation (using existing Insieme validation)
  // 2. Business logic validation
  // 3. Permission validation
  // 4. Idempotency checks
  // 5. Conflict detection
}
```

##### 4. State Manager

```typescript
interface StateManager {
  // State operations
  getCurrentState(partition?: string): RepositoryState;
  getCurrentEventIndex(): number;

  // Event application
  applyEvent(event: CommittedEvent): Promise<void>;
  applyEvents(events: CommittedEvent[]): Promise<void>;

  // Snapshot management
  createSnapshot(): Promise<Snapshot>;
  loadSnapshot(): Promise<Snapshot | null>;

  // State queries
  getStateAtEventIndex(eventIndex: number): RepositoryState;
  getEventsRange(start: number, end: number): CommittedEvent[];
}
```

##### 5. Broadcast Manager

```typescript
interface BroadcastManager {
  // Broadcast to all clients
  broadcast(event: CommittedEvent): void;

  // Broadcast to specific partition
  broadcastToPartition(partition: string, event: CommittedEvent): void;

  // Broadcast to specific clients
  broadcastToClients(clientIds: string[], event: CommittedEvent): void;

  // Exclude specific client (e.g., the submitter)
  broadcastExcept(excludeClientId: string, event: CommittedEvent): void;
}
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

```typescript
// Layer 1: Schema Validation (already exists in Insieme)
import { validateEventPayload } from "insieme";

function validateSchema(event: RepositoryEvent) {
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
function validateBusinessLogic(event: RepositoryEvent, state: RepositoryState) {
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
function validatePermissions(event: RepositoryEvent, clientId: string) {
  // Check if client has permission to perform this action
  // Implement based on your auth system
}

// Layer 4: Conflict Detection
function validateConflicts(event: RepositoryEvent, history: RepositoryEvent[]) {
  // Check for concurrent modifications
  // Implement Last-Write-Wins or other conflict resolution
}
```

#### Example: treePush Validation

```typescript
function validateTreePush(event: RepositoryEvent, state: RepositoryState): ValidationResult {
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

```typescript
// PostgreSQL Store using existing Insieme interface
class PostgresStore implements RepositoryStore {
  async getEvents(payload?: { partition?: string, since?: number }): Promise<RepositoryEvent[]> {
    // Query events table with optional filters
    // Support pagination for large datasets
  }

  async appendEvent(event: RepositoryEvent): Promise<void> {
    // Insert event into events table
    // Return with server-assigned ID
  }

  async getSnapshot(): Promise<Snapshot | null> {
    // Query latest snapshot from snapshots table
  }

  async setSnapshot(snapshot: Snapshot): Promise<void> {
    // Upsert snapshot into snapshots table
  }
}
```

### 6. Concurrency & Consistency

#### Event Ordering

```typescript
// Sequential event IDs ensure ordering
interface CommittedEvent extends RepositoryEvent {
  id: string;           // Global unique ID (evt-1501)
  eventId: number;      // Sequential number (1501)
  clientId: string;     // Submitter's client ID
  timestamp: number;    // Server timestamp
  partition?: string;   // Optional partition
}

// Event sequence is maintained by database
// Clients use eventId for ordering and conflict resolution
```

#### Last-Write-Wins (LWW)

```typescript
// For concurrent modifications to same target
// Higher eventId wins (later event overwrites earlier)
function resolveConflict(events: RepositoryEvent[], state: RepositoryState) {
  // Sort by eventId and apply in order
  // Last write to a specific path wins
}
```

### 7. Error Handling & Recovery

#### Connection Errors

```typescript
// Client-side error handling
class InsiemeClient {
  async handleSubmitError(error: Error) {
    if (error.message.includes("validation_failed")) {
      // Rollback optimistic update
      this.rollbackDraft(error.draftId);

      // Show user-friendly error
      this.showValidationError(error.errors);
    }
  }

  async handleDisconnect() {
    // Enter offline mode
    this.mode = "offline";

    // Queue events for later submission
    this.queuePendingEvents();

    // Attempt reconnection with exponential backoff
    this.reconnect();
  }

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

```typescript
class MessageHandlerImpl implements MessageHandler {
  async handle(message: IncomingMessage, connection: Connection) {
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

```typescript
// Use existing Insieme snapshot functionality
const snapshotInterval = 1000; // Create snapshot every 1000 events

class SnapshotScheduler {
  async scheduleSnapshot(stateManager: StateManager) {
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

```typescript
// Batch events for broadcasting to reduce overhead
class BroadcastManagerImpl implements BroadcastManager {
  private eventQueue: CommittedEvent[] = [];
  private batchTimeout: NodeJS.Timeout | null = null;

  broadcast(event: CommittedEvent) {
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

  private flushBatch() {
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

```typescript
// Compress large state snapshots
import * as zlib from "zlib";

async function compressSnapshot(snapshot: Snapshot): Promise<Buffer> {
  const json = JSON.stringify(snapshot);
  return zlib.gzip(json);
}

async function decompressSnapshot(buffer: Buffer): Promise<Snapshot> {
  const json = await zlib.gunzip(buffer);
  return JSON.parse(json.toString());
}
```

### 9. Security Considerations

#### Authentication & Authorization

```typescript
// JWT-based authentication
interface AuthToken {
  clientId: string;
  userId: string;
  permissions: string[];
  partition?: string;
  exp: number;
}

// Validate client on connection
async function authenticateConnection(token: string): Promise<AuthToken> {
  // Verify JWT signature
  // Check expiration
  // Return decoded token
}

// Authorization check
function checkPermission(token: AuthToken, action: string, target: string): boolean {
  // Check if token.permissions includes required permission
  // Implement role-based access control
}
```

#### Rate Limiting

```typescript
// Rate limit event submissions per client
class RateLimiter {
  private limits = new Map<string, number[]>();

  canSubmit(clientId: string): boolean {
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

```typescript
// Use existing Insieme validation
import { validateEventPayload } from "insieme";

// Additional server-side validation
function sanitizeInput(event: RepositoryEvent): RepositoryEvent {
  // Remove any sensitive data
  // Validate data types
  // Check for malicious payloads
  return event;
}
```

### 10. Monitoring & Observability

#### Metrics to Track

```typescript
// Performance metrics
interface Metrics {
  // Connection metrics
  activeConnections: number;
  totalConnections: number;
  connectionsPerSecond: number;

  // Event metrics
  eventsPerSecond: number;
  averageEventProcessingTime: number;
  eventValidationFailureRate: number;

  // Broadcast metrics
  averageBroadcastLatency: number;
  broadcastQueueSize: number;

  // Storage metrics
  averageEventPersistenceTime: number;
  snapshotCreationTime: number;

  // Error metrics
  errorRate: number;
  errorsByType: Record<string, number>;
}
```

#### Logging

```typescript
// Structured logging
class Logger {
  info(message: string, meta?: object) {
    console.log(JSON.stringify({
      level: "info",
      timestamp: Date.now(),
      message,
      ...meta
    }));
  }

  error(message: string, error: Error, meta?: object) {
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

```typescript
// Use Redis Pub/Sub for cross-server broadcasting
import { Redis } from "ioredis";

class RedisBroadcastManager implements BroadcastManager {
  private redis: Redis;
  private publisher: Redis;
  private subscriber: Redis;

  constructor() {
    this.redis = new Redis();
    this.publisher = new Redis();
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

  broadcast(event: CommittedEvent) {
    // Publish to Redis for all servers
    this.publisher.publish("insieme:broadcast", JSON.stringify(event));

    // Also broadcast to local clients
    this.broadcastToLocalClients(event);
  }

  private broadcastToLocalClients(event: CommittedEvent) {
    // Broadcast to clients connected to this server
  }
}
```

#### Partition-Based Sharding

```typescript
// Shard clients by partition
class ShardedConnectionManager implements ConnectionManager {
  private shards = new Map<string, ConnectionManager>();

  getShard(partition: string): ConnectionManager {
    if (!this.shards.has(partition)) {
      this.shards.set(partition, new ConnectionManagerImpl());
    }
    return this.shards.get(partition)!;
  }

  connect(clientId: string, ws: WebSocket, partition?: string): Connection {
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

- **Language**: TypeScript (for type safety)
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

```typescript
// Extend Insieme client to support backend sync
class InsiemeClient {
  private repository: Repository;
  private websocket: WebSocket;
  private drafts = new Map<string, DraftEvent>();

  async connect(serverUrl: string) {
    this.websocket = new WebSocket(serverUrl);

    this.websocket.onmessage = (message) => {
      this.handleServerMessage(JSON.parse(message.data));
    };
  }

  async addEvent(event: RepositoryEvent) {
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

  handleServerMessage(message: ServerMessage) {
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

  handleEventAccepted(payload: EventAcceptedPayload) {
    // Remove draft
    this.drafts.delete(payload.draftId);

    // Apply committed event (replaces draft)
    // The event is the same, but now has server ID
    console.log(`Event accepted: ${payload.eventId}`);
  }

  handleEventRejected(payload: EventRejectedPayload) {
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

  handleBroadcast(payload: BroadcastPayload) {
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
