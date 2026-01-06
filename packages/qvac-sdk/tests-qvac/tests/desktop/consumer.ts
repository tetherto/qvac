// Desktop consumer entry point with SDK executors
import { createExecutor } from "@tetherto/qvac-test-suite";
import { CompletionExecutor } from "./executors/completion-executor.js";
import { ModelLoadingExecutor } from "./executors/model-loading-executor.js";
import { TranscriptionExecutor } from "./executors/transcription-executor.js";
import { EmbeddingExecutor } from "./executors/embedding-executor.js";
import { RagExecutor } from "./executors/rag-executor.js";
import { TranslationExecutor } from "./executors/translation-executor.js";
import { CacheExecutor } from "./executors/cache-executor.js";
import { ErrorExecutor } from "./executors/error-executor.js";
import { ToolsExecutor } from "./executors/tools-executor.js";
import { TodoExecutor } from "./executors/todo-executor.js";

export const executor = createExecutor({
  handlers: [
    new ModelLoadingExecutor(),
    new CompletionExecutor(),
    new TranscriptionExecutor(),
    new EmbeddingExecutor(),
    new RagExecutor(),
    new TranslationExecutor(),
    new CacheExecutor(),
    new ErrorExecutor(),
    new ToolsExecutor(),
    new TodoExecutor(),
  ],
});
