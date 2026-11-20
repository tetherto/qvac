import type { BCIWhispercppConfig } from '@qvac/bci-whispercpp'
import type { BciConfig } from '@/schemas/index'
import {
  WHISPER_CONTEXT_NATIVE_KEYS,
  WHISPER_MISC_NATIVE_KEYS,
  WHISPER_NATIVE_KEYS
} from '@/plugins/builtin/asr-ggml/config'
import { withNativeKeys } from '@/utils/native-keys'

const BCI_WHISPER_NATIVE_KEYS = { ...WHISPER_NATIVE_KEYS, detectLanguage: 'detect_language' }

const BCI_SESSION_NATIVE_KEYS = { dayIdx: 'day_idx' }

export function buildBciWhispercppConfig(config: BciConfig): BCIWhispercppConfig {
  const { whisperConfig, bciConfig, contextParams, miscConfig, ...rest } = config
  return {
    ...rest,
    ...(whisperConfig && { whisperConfig: withNativeKeys(whisperConfig, BCI_WHISPER_NATIVE_KEYS) }),
    ...(bciConfig && { bciConfig: withNativeKeys(bciConfig, BCI_SESSION_NATIVE_KEYS) }),
    ...(contextParams && {
      contextParams: withNativeKeys(contextParams, WHISPER_CONTEXT_NATIVE_KEYS)
    }),
    ...(miscConfig && { miscConfig: withNativeKeys(miscConfig, WHISPER_MISC_NATIVE_KEYS) })
  } as BCIWhispercppConfig
}
