# Task: Multi-Generation Support for lib-infer-diffusion

## Overview

Enable users to queue and process multiple text-to-image generation requests concurrently or sequentially, improving throughput and user experience for batch generation workflows.

## Current Limitations

### Single-Job Constraint

The addon currently enforces a strict single-job model:

```javascript:209:250:index.js
async _runInternal (params) {
  if (params.init_image) {
    throw new Error('img2img is not yet supported — omit init_image to run txt2img')
  }

  const mode = 'txt2img'
  this.logger.info('Starting generation with mode:', mode)

  return await this._withExclusiveRun(async () => {
    if (this._hasActiveResponse) {
      throw new Error(RUN_BUSY_ERROR_MESSAGE)
    }

    const response = this._createResponse('OnlyOneJob')

    let accepted
    try {
      accepted = await this.addon.runJob({ ...params, mode })
    } catch (error) {
      this._deleteJobMapping('OnlyOneJob')
      response.failed(error)
      throw error
    }

    if (!accepted) {
      this._deleteJobMapping('OnlyOneJob')
      const msg = RUN_BUSY_ERROR_MESSAGE
      response.failed(new Error(msg))
      throw new Error(msg)
    }

    this._hasActiveResponse = true
    const finalized = response.await().finally(() => { this._hasActiveResponse = false })
    finalized.catch(() => {})
    response.await = () => finalized

    this.logger.info('Generation job started successfully')

    return response
  })
}
```

**Constraints:**
- `_hasActiveResponse` flag prevents concurrent jobs
- Hard-coded `'OnlyOneJob'` job ID
- Throws error if a generation is already running: `"Cannot set new job: a job is already set or being processed"`

### Single Context Architecture

The C++ layer manages a single `sd_ctx_t` context:

```cpp:115:115:addon/src/model-interface/SdModel.hpp
std::unique_ptr<sd_ctx_t, decltype(&free_sd_ctx)> sdCtx_;
```

Thread-local progress tracking assumes one active job per thread:

```cpp:34:39:addon/src/model-interface/SdModel.cpp
struct ProgressCtx {
  const SdModel::GenerationJob* job = nullptr;
  std::chrono::steady_clock::time_point startTime;
};

thread_local ProgressCtx tl_progressCtx;
```

## Design Options

### Option 1: Job Queue (Recommended)

**Description:** Allow multiple generation requests to be queued, but process them sequentially using the same `sd_ctx_t`. This maintains memory efficiency while enabling batch workflows.

**Benefits:**
- Minimal memory overhead (single context)
- Simple implementation
- Predictable resource usage
- Works on 16GB machines with large models

**Tradeoffs:**
- Sequential processing (no parallel speedup)
- Total wall time = sum of individual generation times

**Implementation Changes:**
- Replace `OnlyOneJob` with UUID-based job IDs
- Add job queue in JS layer (`index.js`)
- Support multiple active `QvacResponse` objects
- Job runner processes queue sequentially

**API Example:**
```javascript
const model = new ImgStableDiffusion(args, config)
await model.load()

// Queue multiple jobs — they execute sequentially
const job1 = await model.run({ prompt: 'red fox', seed: 42 })
const job2 = await model.run({ prompt: 'blue wolf', seed: 43 })
const job3 = await model.run({ prompt: 'green dragon', seed: 44 })

// Each job returns immediately with a QvacResponse
// Processing happens in the order jobs were submitted

const images1 = []
await job1.onUpdate(data => {
  if (data instanceof Uint8Array) images1.push(data)
}).await()

const images2 = []
await job2.onUpdate(data => {
  if (data instanceof Uint8Array) images2.push(data)
}).await()

const images3 = []
await job3.onUpdate(data => {
  if (data instanceof Uint8Array) images3.push(data)
}).await()

await model.unload()
```

### Option 2: Multi-Context (Future Work)

**Description:** Support multiple `sd_ctx_t` contexts for true parallel generation across different model instances.

**Benefits:**
- True parallel execution
- Better throughput on multi-GPU systems or machines with >32GB RAM

**Tradeoffs:**
- High memory usage (4-8GB per context for FLUX.2)
- Complex resource management
- Requires architectural changes in C++ layer

**Memory Requirements (FLUX.2 [klein]):**
- 1 context: ~8.5 GB
- 2 contexts: ~17 GB
- 3 contexts: ~25.5 GB

**Not Recommended** unless targeting high-end workstations with 64GB+ RAM.

### Option 3: Enhanced Batching (Alternative)

**Description:** Improve the existing `batch_count` parameter to support different prompts per batch item.

**Benefits:**
- Leverages existing infrastructure
- Efficient for generating variations

**Tradeoffs:**
- Limited to same-size outputs within a batch
- All items share the same step schedule
- Less flexible than a true job queue

**Current Behavior:**
```javascript
const response = await model.run({
  prompt: 'red fox',
  batch_count: 4,  // generates 4 images with the same prompt
  seed: -1
})
```

**Enhanced Behavior (potential):**
```javascript
const response = await model.run({
  prompts: ['red fox', 'blue wolf', 'green dragon', 'yellow lion'],
  batch_count: 4,
  seed: -1
})
```

Requires upstream changes to `stable-diffusion.cpp` — not under our control.

## Recommended Approach: Job Queue

### Phase 1: Core Infrastructure

**JS Layer Changes (`index.js`):**

1. **Replace single-job constraint:**
   - Remove `_hasActiveResponse` flag
   - Generate UUID job IDs instead of `'OnlyOneJob'`
   - Track multiple active responses in `_jobToResponse` Map

2. **Add job queue:**
   - `_jobQueue: Array<{ id, params }>`
   - `_activeJobId: string | null`
   - `_processNextJob()` method

3. **Update `_runInternal()`:**
   ```javascript
   async _runInternal(params) {
     const jobId = crypto.randomUUID()
     const response = this._createResponse(jobId)
     
     this._jobQueue.push({ id: jobId, params })
     
     // Start processing if no active job
     if (!this._activeJobId) {
       this._processNextJob()
     }
     
     return response
   }
   ```

4. **Implement queue processor:**
   ```javascript
   async _processNextJob() {
     if (this._jobQueue.length === 0) {
       this._activeJobId = null
       return
     }
     
     const { id, params } = this._jobQueue.shift()
     this._activeJobId = id
     
     try {
       await this.addon.runJob({ ...params, mode: 'txt2img' })
     } catch (error) {
       const response = this._jobToResponse.get(id)
       if (response) response.failed(error)
     } finally {
       this._activeJobId = null
       this._processNextJob()  // process next in queue
     }
   }
   ```

**C++ Layer Changes:**
- Update `SdModel::GenerationJob` to include job ID
- Update thread-local progress context to track job ID
- No changes needed to context management

### Phase 2: Advanced Features

1. **Job cancellation by ID:**
   ```javascript
   await model.cancelJob(jobId)
   ```

2. **Queue inspection:**
   ```javascript
   const queueStatus = model.getQueueStatus()
   // Returns: { active: jobId | null, queued: [jobId1, jobId2, ...] }
   ```

3. **Priority queue:**
   ```javascript
   await model.run({ prompt: '...', priority: 'high' })
   ```

## Testing Strategy

### Unit Tests (C++)

- ✅ Existing: Single-job generation works
- **New:** Multiple sequential jobs with different seeds
- **New:** Job queue ordering
- **New:** Job cancellation mid-queue

### Integration Tests (JS)

- **New:** Queue 3 jobs, verify execution order
- **New:** Cancel queued job before it starts
- **New:** Cancel active job, verify next job proceeds
- **New:** Stress test: queue 10 jobs, verify all complete

### Example Script

Create `examples/batch-generation.js`:

```javascript
const model = new ImgStableDiffusion(args, config)
await model.load()

const prompts = [
  'red fox in snow',
  'blue wolf at dusk',
  'green dragon in mountains',
  'yellow lion on savanna'
]

const jobs = []
for (const prompt of prompts) {
  jobs.push(await model.run({ prompt, seed: -1 }))
}

// Collect results as they complete
const results = await Promise.all(
  jobs.map(async (job, i) => {
    const images = []
    await job.onUpdate(data => {
      if (data instanceof Uint8Array) images.push(data)
    }).await()
    return { prompt: prompts[i], images }
  })
)

await model.unload()
```

## Success Criteria

- ✅ Multiple `model.run()` calls can be made without errors
- ✅ Jobs execute in FIFO order
- ✅ Each job receives its own progress updates
- ✅ Each job receives its own output images
- ✅ Job cancellation works for both active and queued jobs
- ✅ Memory usage remains constant (single context)
- ✅ No regressions in single-job performance

## Non-Goals

- Parallel execution across multiple contexts (defer to future work)
- Dynamic resource allocation based on available memory
- GPU multi-tenancy / fractional GPU usage

## Timeline Estimate

- **Phase 1 (Core Queue):** 3-5 days
  - JS layer refactoring: 1-2 days
  - C++ job ID tracking: 1 day
  - Testing: 1-2 days

- **Phase 2 (Advanced Features):** 2-3 days
  - Priority queue: 1 day
  - Queue inspection API: 0.5 days
  - Documentation: 0.5-1 day
  - Additional testing: 1 day

**Total:** ~1-1.5 weeks of focused development

## References

- Current single-job implementation: `packages/lib-infer-diffusion/index.js:209-250`
- C++ model interface: `packages/lib-infer-diffusion/addon/src/model-interface/SdModel.hpp`
- Example usage: `packages/lib-infer-diffusion/examples/generate-image.js`
- Upstream library: [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)
