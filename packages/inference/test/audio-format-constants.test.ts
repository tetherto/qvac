import test from 'brittle'
import { FORMATS_NEEDING_DECODE, SUPPORTED_AUDIO_FORMATS } from '@/constants/audio'
import {
  FORMATS_NEEDING_DECODE as DECODER_FORMATS_NEEDING_DECODE,
  SUPPORTED_AUDIO_FORMATS as DECODER_SUPPORTED_AUDIO_FORMATS
} from '@qvac/decoder-audio/constants'

test('audio format constants stay in lockstep with @qvac/decoder-audio', (t) => {
  t.alike(SUPPORTED_AUDIO_FORMATS, DECODER_SUPPORTED_AUDIO_FORMATS)
  t.alike(FORMATS_NEEDING_DECODE, DECODER_FORMATS_NEEDING_DECODE)
})
