# Delegated Inference Implementation Plan

## 🕚 Overview

Enable delegation of completion requests to remote peers via Hyperswarm topic while maintaining existing API compatibility. **Key constraint**: Single Hyperswarm instance per process - shared between model downloads and inference delegation.

## Current Architecture

### Flow

1. `loadModel()` → RPC → Bare worker loads model → Registry stores `LoadedModel`
2. `completionStream(modelId)` → RPC → Registry lookup → Execute inference

### Components

- **API Layer**: `client/api/` (loadModel, completionStream)
- **RPC Client**: `client/rpc/rpc-client.ts` (Bare worker communication)
- **Registry**: `server/bare/registry/model-registry.ts` (Map<string, LoadedModel>)
- **Hyperswarm**: Currently in `server/rpc/handlers/load-model/hyperdrive.ts` for downloads

## Proposed Changes

### 1. Schema Extensions

**File**: `schemas/load-model.ts`

```typescript
interface DelegateOptions {
  topic: string; // Single Hyperswarm topic key for peer discovery
}

type LoadModelOptions = {
  // ... existing options
  delegate?: DelegateOptions;
};
```

### 2. Shared Hyperswarm Module

**New File**: `server/bare/hyperswarm.ts`

- Module-scoped Hyperswarm instance
- Export swarm instance directly
- Use bare-rpc over Hyperswarm streams

### 3. Enhanced Model Registry

**File**: `server/bare/registry/model-registry.ts`

```typescript
interface ModelEntry {
  isDelegated: boolean;
  local?: LoadedModel;
  delegated?: DelegateOptions;
}
```

### 4. Delegation Router

**New File**: `client/rpc/delegation-router.ts`

- Import `getModelEntry` from registry
- Route requests to Hyperswarm or local RPC based on delegation status
- Join Hyperswarm topic directly using exported swarm instance

### 5. Hyperswarm RPC Client

**New File**: `client/rpc/hyperswarm-rpc-client.ts`

- Bare-rpc over Hyperswarm streams for multiplexing
- Peer discovery and basic load balancing
- Reuse existing request/response schemas

## Implementation Phases

### Phase 1: Infrastructure

1. **Shared Hyperswarm Module** - Create simple module with exported swarm instance
2. **Schema Extensions** - Add delegate option with single topic
3. **Registry Enhancement** - Support delegated entries

### Phase 2: Core Routing

4. **Hyperswarm RPC Client** - Bare-rpc over Hyperswarm streams
5. **Delegation Router** - Route requests based on delegation status
6. **RPC Client Integration** - Add delegation-aware routing

### Phase 3: Completion Integration

7. **Completion Stream** - Support delegated streaming
8. **Error Handling** - Basic error handling and cleanup

## Technical Details

### Shared Hyperswarm Module

```typescript
// server/bare/hyperswarm.ts
import Hyperswarm from "hyperswarm";

export const swarm = new Hyperswarm();
```

### Request Routing Flow

```typescript
import { getSwarm } from "@/server/bare/hyperswarm";

async function routeRequest(modelId: string, request: Request) {
  const entry = getModelEntry(modelId);

  if (entry.isDelegated) {
    // Join topic (idempotent - safe to call multiple times)
    getSwarm().join(Buffer.from(entry.delegated.topic, "hex"));
    return await routeToHyperswarmTopic(entry.delegated.topic, request);
  } else {
    return await routeToLocalWorker(request);
  }
}
```

## Dependencies & Compatibility

### New Dependencies

- None (reuse existing Hyperswarm from hyperdrive integration)

### Backward Compatibility

- ✅ Existing APIs unchanged
- ✅ Local models work as before
- ✅ `delegate` option is optional

---

## ✅ Implementation Complete

All phases have been successfully implemented:

### ✅ Phase 1: Infrastructure

- ✅ **Shared Hyperswarm Module** - Created `server/bare/hyperswarm.ts` with exported swarm instance
- ✅ **Schema Extensions** - Added `delegate` option with single topic to load model schemas
- ✅ **Registry Enhancement** - Modified model registry to support delegated entries

### ✅ Phase 2: Core Routing

- ✅ **Hyperswarm RPC Client** - Created bare-rpc client over Hyperswarm streams
- ✅ **Delegation Router** - Route requests based on delegation status
- ✅ **RPC Client Integration** - Added delegation-aware routing to RPC client

### ✅ Phase 3: Completion Integration

- ✅ **Completion Stream** - Supports delegated requests through RPC integration
- ✅ **Error Handling** - Basic error handling with fallback to local RPC

### ✅ Build Verification

- ✅ **TypeScript Compilation** - No type errors
- ✅ **ESLint** - No linting errors
- ✅ **Build Process** - Successful compilation

The delegated inference feature is now ready for testing! 🫡
