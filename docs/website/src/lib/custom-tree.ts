import type { Node } from 'fumadocs-core/page-tree';
import { resolveIcon } from '@/lib/resolveIcon';
import React from 'react';
import { SiExpo, SiElectron } from '@icons-pack/react-simple-icons';

/**
 * Only the API summary and release notes are versioned (one MDX per
 * version; latest at `index.mdx`, older at `vX.Y.Z.mdx` under
 * `content/docs/reference/api` and `content/docs/reference/release-notes`).
 * The version dropdown handles switching for those pages; everything else
 * uses a single bare path per topic.
 */
export const customTree: Node[] = [
  {
    name: 'Home',
    url: '/',
    type: 'page',
    icon: resolveIcon('House'),
  },
  {
    type: 'separator',
    name: 'Getting started',
  },
  {
    name: 'Introduction',
    url: '/introduction',
    type: 'page',
    icon: resolveIcon('DoorOpen'),
  },
  {
    name: 'Quickstart',
    url: '/quickstart',
    type: 'page',
    icon: resolveIcon('Rocket'),
  },
  {
    name: 'System requirements',
    url: '/system-requirements',
    type: 'page',
    icon: resolveIcon('Stethoscope'),
  },
  {
    name: 'Installation',
    url: '/installation',
    type: 'page',
    icon: resolveIcon('Package'),
  },
  {
    name: 'Configuration',
    type: 'folder',
    icon: resolveIcon('SlidersHorizontal'),
    index: { type: 'page', name: 'Configuration', url: '/configuration' },
    children: [
      {
        name: 'Plugin system',
        type: 'folder',
        icon: resolveIcon('Plug'),
        index: { type: 'page', name: 'Plugin system', url: '/configuration/plugins' },
        children: [
          {
            name: 'Write a custom plugin',
            url: '/configuration/plugins/write-custom-plugin',
            type: 'page',
          },
        ],
      },
    ],
  },
  {
    name: 'CLI',
    type: 'folder',
    icon: resolveIcon('Terminal'),
    index: { type: 'page', name: 'CLI', url: '/cli' },
    children: [
      {
        name: 'HTTP server',
        url: '/cli/http-server',
        type: 'page',
        icon: resolveIcon('Server'),
      },
    ],
  },
  {
    type: 'separator',
    name: 'Models',
  },
  {
    name: 'Download lifecycle',
    url: '/models/download-lifecycle',
    type: 'page',
    icon: resolveIcon('Download'),
  },
  {
    name: 'Sharded models',
    url: '/models/sharded-models',
    type: 'page',
    icon: resolveIcon('Merge'),
  },
  {
    type: 'separator',
    name: 'AI capabilities',
  },
  {
    name: 'Text generation',
    url: '/ai-capabilities/text-generation',
    type: 'page',
    icon: resolveIcon('MessagesSquare'),
  },
  {
    name: 'Text embeddings',
    url: '/ai-capabilities/text-embeddings',
    type: 'page',
    icon: resolveIcon('Hash'),
  },
  {
    name: 'RAG',
    url: '/ai-capabilities/rag',
    type: 'page',
    icon: resolveIcon('ScanSearch'),
  },
  {
    name: 'Fine-tuning',
    url: '/ai-capabilities/fine-tuning',
    type: 'page',
    icon: resolveIcon('FlaskConical'),
  },
  {
    name: 'Multimodal',
    url: '/ai-capabilities/multimodal',
    type: 'page',
    icon: resolveIcon('GalleryHorizontal'),
  },
  {
    name: 'Image generation',
    url: '/ai-capabilities/image-generation',
    type: 'page',
    icon: resolveIcon('Image'),
  },
  {
    name: 'Transcription',
    url: '/ai-capabilities/transcription',
    type: 'page',
    icon: resolveIcon('Speech'),
  },
  {
    name: 'Text-to-Speech',
    url: '/ai-capabilities/text-to-speech',
    type: 'page',
    icon: resolveIcon('Volume2'),
  },
  {
    name: 'Voice assistant',
    url: '/ai-capabilities/voice-assistant',
    type: 'page',
    icon: resolveIcon('Mic'),
  },
  {
    name: 'Translation',
    url: '/ai-capabilities/translation',
    type: 'page',
    icon: resolveIcon('Languages'),
  },
  {
    name: 'OCR',
    url: '/ai-capabilities/ocr',
    type: 'page',
    icon: resolveIcon('ScanText'),
  },
  {
    type: 'separator',
    name: 'P2P capabilities',
  },
  {
    name: 'Delegated inference',
    url: '/p2p-capabilities/delegated-inference',
    type: 'page',
    icon: resolveIcon('Share2'),
  },
  {
    name: 'Blind relays',
    url: '/p2p-capabilities/blind-relays',
    type: 'page',
    icon: resolveIcon('Router'),
  },
  {
    type: 'separator',
    name: 'Runtime',
  },
  {
    name: 'Runtime lifecycle',
    url: '/runtime/lifecycle',
    type: 'page',
    icon: resolveIcon('Moon'),
  },
  {
    name: 'Logging',
    url: '/runtime/logging',
    type: 'page',
    icon: resolveIcon('Activity'),
  },
  {
    name: 'Profiler',
    url: '/runtime/profiler',
    type: 'page',
    icon: resolveIcon('Timer'),
  },
  {
    type: 'separator',
    name: 'Tutorials',
  },
  {
    name: 'Build on Electron',
    url: '/tutorials/electron',
    type: 'page',
    icon: React.createElement(SiElectron, { className: 'h-4 w-4' }),
  },
  {
    name: 'Build on Expo',
    url: '/tutorials/expo',
    type: 'page',
    icon: React.createElement(SiExpo, { className: 'h-4 w-4' }),
  },
  {
    type: 'separator',
    name: 'Reference',
  },
  {
    name: 'API',
    url: '/reference/api',
    type: 'page',
    icon: resolveIcon('BookA'),
  },
  {
    name: 'Release notes',
    url: '/reference/release-notes',
    type: 'page',
    icon: resolveIcon('Tag'),
  },
  {
    name: 'Addons',
    type: 'folder',
    icon: resolveIcon('Blocks'),
    index: { type: 'page', name: 'Addons', url: '/addons' },
    children: [
      { name: 'llm-llamacpp', url: '/addons/llm-llamacpp', type: 'page' },
      { name: 'embed-llamacpp', url: '/addons/embed-llamacpp', type: 'page' },
      { name: 'translation-nmtcpp', url: '/addons/translation-nmtcpp', type: 'page' },
      { name: 'transcription-whispercpp', url: '/addons/transcription-whispercpp', type: 'page' },
      { name: 'transcription-parakeet', url: '/addons/transcription-parakeet', type: 'page' },
      { name: 'tts-onnx', url: '/addons/tts-onnx', type: 'page' },
      { name: 'ocr-onnx', url: '/addons/ocr-onnx', type: 'page' },
      { name: 'diffusion-cpp', url: '/addons/diffusion-cpp', type: 'page' },
    ],
  },
  {
    type: 'separator',
    name: 'Help',
  },
  {
    name: 'Troubleshooting',
    url: '/troubleshooting',
    type: 'page',
    icon: resolveIcon('Bug'),
  },
  {
    name: 'Discord',
    url: 'https://discord.com/invite/tetherdev',
    type: 'page',
    external: true,
    icon: resolveIcon('MessageCircle'),
  },
  {
    type: 'separator',
    name: 'About QVAC',
  },
  {
    name: 'How it works',
    url: '/about/how-it-works',
    type: 'page',
    icon: resolveIcon('Cog'),
  },
  {
    name: 'Vision',
    type: 'folder',
    icon: resolveIcon('Telescope'),
    index: { type: 'page', name: 'Vision', url: '/about/vision' },
    children: [
      {
        name: 'Public launch',
        url: '/about/public-launch',
        type: 'page',
        icon: resolveIcon('Megaphone'),
      },
    ],
  },
];
