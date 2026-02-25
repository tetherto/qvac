// Mobile consumer entry point
import { createExecutor } from '@tetherto/qvac-test-suite/mobile';
import { ModelLoadingExecutor } from '../desktop/executors/model-loading-executor.js';
import { MobileTranscriptionExecutor } from './executors/transcription-executor.js';

// Export executor - framework wraps this in React Native UI
export const executor = createExecutor({
  handlers: [
    new ModelLoadingExecutor(),
    new MobileTranscriptionExecutor(),
  ],
});
