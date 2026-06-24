# Detailed Data Flows

This document contains detailed diagrams showing how data moves through the `@qvac/diffusion-cpp` system.

**Audience:** Developers debugging complex behavior, contributors understanding system interactions.

> **⚠️ Note:** These detailed diagrams are intended for initial reference and can quickly become outdated as the codebase evolves. For exact debugging and deep understanding, regenerate diagrams from the actual code or trace through the implementation directly.

<details>
<summary>⚡ TL;DR: Data Flow Overview</summary>

**Communication Pattern:**
- Two-thread architecture: JavaScript thread + dedicated C++ processing thread
- Synchronization via mutex and condition variables
- Cross-thread flow: JS → submit job via `runJob(params)` → wake C++ → process diffusion steps → output → uv_async_send → JS callback

**Generation Path:**
- JS calls `model.run(params)` → returns QvacResponse immediately (non-blocking)
- JS serializes params to JSON, calls `addon.runJob(paramsJson)` once; returns boolean (accepted or job already active)
- C++ single-job runner takes the job, executes diffusion loop → generates image
- Queues progress/output events → triggers JS callback asynchronously
- Emits: StepProgress, Output (final image), JobStarted, JobEnded, Error

</details>

## Table of Contents

- [Text-to-Image Generation Flow](#text-to-image-generation-flow)

---

## Text-to-Image Generation Flow

### High-Level Flow

```mermaid
flowchart TD
    Start([JS: model.run]) --> ParseParams[Parse generation params]
    ParseParams --> SerializeJSON[Serialize to JSON]
    
    SerializeJSON --> RunJob["addon.runJob(paramsJson)"]
    RunJob --> CreateResp[Create QvacResponse]
    CreateResp --> ReturnJS([Return to JavaScript])
    
    RunJob -.->|Enters native| LockMutex[Lock mutex]
    LockMutex --> SetJob[Set single job input]
    SetJob --> NotifyCV[Notify condition variable]
    NotifyCV --> UnlockMutex[Unlock mutex]
    
    NotifyCV -.->|Wakes| ProcThread[Processing Thread]
    
    ProcThread --> WaitWork{Has work?}
    WaitWork -->|No| SleepCV[cv.wait]
    SleepCV --> WaitWork
    
    WaitWork -->|Yes| LockProc[Lock mutex]
    LockProc --> TakeJob[Take job input]
    TakeJob --> UnlockProc[Unlock mutex]
    UnlockProc --> EmitStart[Queue JobStarted event]
    EmitStart --> SendAsync1[uv_async_send]
    
    SendAsync1 --> ParseJSON[Parse JSON params]
    ParseJSON --> EncodePrompt["Encode prompt (CLIP)"]
    EncodePrompt --> EncodeNeg[Encode negative prompt]
    EncodeNeg --> InitLatents["Initialize random latents (seed)"]
    
    InitLatents --> DiffusionLoop{Diffusion Loop}
    DiffusionLoop -->|Continue| PredictNoise[UNet predict noise]
    PredictNoise --> ApplyCFG[Apply CFG guidance]
    ApplyCFG --> SchedulerStep[Scheduler step]
    SchedulerStep --> QueueProgress[Queue StepProgress event]
    QueueProgress --> SendAsync2[uv_async_send]
    SendAsync2 --> DiffusionLoop
    
    DiffusionLoop -->|Complete| VAEDecode[VAE decode]
    VAEDecode --> EncodePNG[Encode to PNG]
    EncodePNG --> QueueOutput[Queue Output event]
    QueueOutput --> GetStats[Collect runtime stats]
    GetStats --> QueueJobEnd[Queue JobEnded event]
    QueueJobEnd --> SendAsync3[uv_async_send]
    SendAsync3 --> ProcThread
    
    DiffusionLoop -->|Error| QueueError[Queue Error event]
    QueueError --> ResetModel[model.reset]
    ResetModel --> SendAsync3
    
    SendAsync2 -.->|Triggers| UVCallback[UV async callback]
    UVCallback --> LockCB[Lock output mutex]
    LockCB --> DequeueOutputs[Dequeue all outputs]
    DequeueOutputs --> UnlockCB[Unlock mutex]
    UnlockCB --> ForEach[For each output event]
    
    ForEach --> InvokeJS[Call JavaScript outputCb]
    InvokeJS --> UpdateResponse[QvacResponse emits]
    UpdateResponse --> ProgressYield([onStep callback / await])
```

<details>
<summary>📊 LLM-Friendly: Generation Flow Breakdown</summary>

**Phase 1: Job Submission (JavaScript → C++)**

| Step | Thread | Duration | Operation | Blocking? |
|------|--------|----------|-----------|-----------|
| 1 | JS | <0.1ms | Parse params | No |
| 2 | JS | <0.1ms | Serialize to JSON | No |
| 3 | JS | <1ms | Call addon.runJob(params) | No |
| 4 | JS | <0.1ms | Lock mutex | No |
| 5 | JS | <0.1ms | Set job input | No |
| 6 | JS | <0.1ms | Signal CV | No |
| 7 | JS | <0.1ms | Unlock mutex | No |
| 8 | JS | <0.1ms | Return accepted (boolean) | No |
| 9 | C++ | - | Wake from cv.wait() | - |

**Phase 2: Processing (C++ Background Thread)**

| Step | Thread | Duration | Operation | Blocks JS? |
|------|--------|----------|-----------|------------|
| 10 | C++ | <0.1ms | Lock mutex | No |
| 11 | C++ | <0.1ms | Take job input | No |
| 12 | C++ | <0.1ms | Unlock mutex | No |
| 13 | C++ | <1ms | Parse JSON params | No |
| 14 | C++ | 50-200ms | Encode prompts (CLIP) | No |
| 15 | C++ | <10ms | Initialize latents | No |
| 16 | C++ | 100-500ms per step | UNet inference | No |
| 17 | C++ | 200-1000ms | VAE decode | No |
| 18 | C++ | 10-50ms | PNG encode | No |

**Phase 3: Output Delivery (C++ → JavaScript)**

| Step | Thread | Duration | Operation | Details |
|------|--------|----------|-----------|---------|
| 19 | C++ | <0.1ms | Lock output mutex | Per step |
| 20 | C++ | <0.1ms | Queue progress | Per step |
| 21 | C++ | <0.1ms | Unlock mutex | Per step |
| 22 | C++ | <0.1ms | uv_async_send() | May coalesce |
| 23 | JS | - | UV schedules callback | Next tick |
| 24 | JS | <0.1ms | Lock mutex | Batch |
| 25 | JS | <0.1ms | Drain outputs | Batch |
| 26 | JS | <0.1ms | Unlock mutex | Batch |
| 27 | JS | Varies | Invoke outputCb | User code |

**Event Types:**

| Event | When | Data | Purpose |
|-------|------|------|---------|
| JobStarted | Processing begins | {jobId, timestamp} | Track start |
| StepProgress | Each diffusion step | {jobId, step, totalSteps} | Progress UI |
| Output | Generation complete | {jobId, image: Uint8Array, format: 'png'} | Final image |
| JobEnded | All processing done | {jobId, stats: RuntimeStats} | Track completion |
| Error | Processing fails | {jobId, error: string} | Error handling |

**Performance Characteristics:**

- Job queueing: <1ms total
- Prompt encoding: 50-200ms (depends on prompt length)
- Diffusion steps: 100-500ms per step (model and GPU dependent)
- VAE decoding: 200-1000ms (resolution dependent)
- Total 512x512, 20 steps: ~5-15 seconds
- Total 1024x1024, 20 steps: ~15-60 seconds

</details>

**Related Documents:**
- [architecture.md](architecture.md) - Complete architecture documentation

**Last Updated:** 2026-03-11
