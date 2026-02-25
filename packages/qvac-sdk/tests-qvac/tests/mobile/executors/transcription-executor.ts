// Mobile transcription executor
import { transcribe, loadModel, WHISPER_TINY } from '@qvac/sdk';
import { AssetExecutor, ValidationHelpers, type TestResult, type Expectation } from '@tetherto/qvac-test-suite/mobile';
import { transcriptionTests } from '../../transcription-tests.js';

export class MobileTranscriptionExecutor extends AssetExecutor<typeof transcriptionTests> {
  pattern = /^transcription-/;
  protected handlers = {}; // Use defaultHandler for all tests
  protected defaultHandler = this.transcribeAudio.bind(this);

  private whisperModelId: string | null = null;
  private audioAssets: Record<string, number> | null = null;

  private async loadAudioAssets() {
    if (!this.audioAssets) {
      // Dynamic import - assets.ts is generated at consumer build time
      // Path: dist/tests/mobile/executors/ → ../../../../ → root/assets
      // @ts-ignore - assets.ts doesn't exist during sdk-tests compilation
      const assets = await import('../../../../assets');
      this.audioAssets = assets.audio;
    }
    return this.audioAssets!;
  }

  private async transcribeAudio(
    testId: string,
    params: unknown,
    expectation: unknown
  ): Promise<TestResult> {
    const p = params as { audioFileName: string; timeout?: number };

    // Lazy load Whisper model
    if (!this.whisperModelId) {
      this.whisperModelId = await loadModel({
        modelSrc: WHISPER_TINY,
        modelType: 'whisper',
      });
    }

    // Load audio assets
    const audio = await this.loadAudioAssets();
    const assetModule = audio[p.audioFileName];
    if (!assetModule) {
      return { passed: false, output: `Audio file not found: ${p.audioFileName}` };
    }

    try {
      const audioUri = await this.resolveAsset(assetModule);
      const text = await transcribe({ modelId: this.whisperModelId, audioChunk: audioUri });
      const trimmedText = text.trim();

      return ValidationHelpers.validate(trimmedText, expectation as Expectation);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return { passed: false, output: `Transcription failed: ${errorMsg}` };
    }
  }
}
