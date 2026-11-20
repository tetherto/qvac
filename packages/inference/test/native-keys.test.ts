import test from 'brittle'
import type ASRGgml from '@qvac/asr-ggml'
import type { SdConfig } from '@qvac/diffusion-cpp'
import { SD_NATIVE_KEYS } from '@/plugins/builtin/sdcpp-generation/load-files'
import { GGML_GPU_NATIVE_KEYS } from '@/plugins/builtin/asr-ggml/config'
import type { MossTranscribeConfig, ParakeetConfig, SdcppConfig } from '@/schemas/index'

// Each plugin maps its camelCase config onto the addon's own names, and a key
// with no entry passes through unchanged. An addon that ignores unknown keys
// would then silently drop a new key, so each check fails to compile until
// every config key reaches the addon under a name the addon's type declares,
// or is listed as consumed by the plugin itself.

type DeclaredKeys<T> = keyof {
  [K in keyof T as string extends K ? never : number extends K ? never : K]: T[K]
}

type NativeName<K, Map> = K extends keyof Map ? Map[K] : K

type UndeclaredKeys<Config, PluginOwned, Map, Native> = Exclude<
  NativeName<Exclude<keyof Config, PluginOwned>, Map>,
  DeclaredKeys<Native>
>

type Covered<Undeclared> = [Undeclared] extends [never] ? true : Undeclared

const sdcpp: Covered<
  UndeclaredKeys<
    SdcppConfig,
    'mode' | 'upscaler' | 'world' | `${string}Src`,
    typeof SD_NATIVE_KEYS,
    SdConfig
  >
> = true

const parakeet: Covered<
  UndeclaredKeys<
    ParakeetConfig,
    'speakerAttribution',
    typeof GGML_GPU_NATIVE_KEYS,
    ASRGgml.ParakeetConfig
  >
> = true

const mossTranscribe: Covered<
  UndeclaredKeys<
    MossTranscribeConfig,
    never,
    typeof GGML_GPU_NATIVE_KEYS,
    ASRGgml.MossTranscribeConfig
  >
> = true

test('every load key reaches its addon under a name the addon declares', (t) => {
  t.alike([sdcpp, parakeet, mossTranscribe], [true, true, true])
})
