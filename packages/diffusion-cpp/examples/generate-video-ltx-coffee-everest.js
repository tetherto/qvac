'use strict'

const path = require('bare-path')
const process = require('bare-process')

const defaults = {
  REFERENCE_SHEET: path.resolve(
    __dirname,
    '../assets/ltx-coffee-everest-reference-sheet-768x448.png'
  ),
  LTX_MODEL: 'LTX-2.3-22B-distilled-1.1-Q8_0.gguf',
  LTX_LLM: 'gemma-3-12b-it-UD-Q4_K_XL.gguf',
  LTX_VAE: 'ltx-2.3-22b-distilled_video_vae.safetensors',
  LTX_AUDIO_VAE: 'ltx-2.3-22b-distilled_audio_vae.safetensors',
  LTX_CONNECTORS: 'ltx-2.3-22b-distilled_embeddings_connectors.safetensors',
  WIDTH: '768',
  HEIGHT: '448',
  FRAMES: '217',
  FPS: '24',
  STEPS: '8',
  SCHEDULER: 'ltx2',
  CFG_SCALE: '1',
  SEED: '84',
  LORA_STRENGTH: '1.4',
  STG_SCALE: '1',
  STG_BLOCK: '29',
  VAE_TILE_SIZE: '8',
  OUTPUT: 'ltx-coffee-everest-9s.avi',
  PROMPT:
    'Use every panel in the reference sheet as an explicitly bound ingredient. The top-left panel defines the exact same adult man with black hair and green eyes. The top-middle panel defines his complete modern scientist outfit: light-grey laboratory coat over a charcoal shirt with dark trousers. The top-right panel defines exactly one matte-black branded Tether Coffee paper cup with visible steam. The bottom-left panel defines the pale birchwood table and single matching chair. The bottom-right panel defines the high Mount Everest landscape above a sea of clouds. Create one continuous cinematic live-action medium shot: the same scientist sits naturally in the birchwood chair at the birchwood table on a safe snowy overlook high above the clouds, with Mount Everest clearly visible behind him at sunrise. He holds the one Tether Coffee cup, slowly raises it to his lips, takes one calm sip, then lowers it slightly as steam curls in the cold air. Preserve his recognizable face, green eyes, black hair, scientist clothing, furniture, cup, and mountain environment. Warm sunrise rim light, subtle wind moving his coat, realistic skin and fabric, natural restrained motion, shallow controlled depth of field, stable camera with a very slow push-in, premium cinematic expedition commercial, no dialogue, no music.',
  NEG_PROMPT:
    'identity drift, different person, missing lab coat, missing table, missing chair, missing coffee cup, duplicate cup, extra person, extra furniture, malformed hands, cup fused to hand, drinking through lid, garbled text, duplicate mountain, indoor room, cartoon, CGI, blur, soft focus, camera shake, jitter, flicker, overexposure, text overlay, subtitles, watermark'
}

for (const [name, value] of Object.entries(defaults)) {
  if (!process.env[name]) process.env[name] = value
}

require('./generate-video-ltx-ingredients')
