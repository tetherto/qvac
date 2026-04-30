import type { Node } from 'fumadocs-core/page-tree';
import { resolveIcon } from '@/lib/resolveIcon';
import React from 'react';
import { SiExpo, SiElectron } from '@icons-pack/react-simple-icons';

/**
 * The single sidebar tree for the docs site. Imported directly by
 * `src/app/(docs)/layout.tsx` — no per-version trees, no aggregator.
 *
 * Only the API summary and release notes are versioned (one MDX per
 * version; latest at `index.mdx`, older at `vX.Y.Z.mdx`). The version
 * dropdown next to the page title handles version switching for those
 * sections; everything else here lives at a single bare path that always
 * reflects the current SDK.
 */
export const customTree: Node[] = [
  {
    name: 'Home',
    url: '/',
    type: 'page',
    icon: resolveIcon('House'),
  },
  {
    name: 'About QVAC',
    type: 'folder',
    icon: resolveIcon('Info'),
    index: { type: 'page', name: 'About QVAC', url: '/about-qvac/welcome' },
    children: [
      {
        name: 'Welcome',
        url: '/about-qvac/welcome',
        type: 'page',
        icon: resolveIcon('DoorOpen'),
      },
      {
        name: 'Our vision',
        url: '/about-qvac/vision',
        type: 'page',
        icon: resolveIcon('Telescope'),
      },
      {
        name: 'How it works',
        url: '/about-qvac/how-it-works',
        type: 'page',
        icon: resolveIcon('Cog'),
      },
      {
        name: 'Flagship apps',
        url: '/about-qvac/flagship-apps',
        type: 'page',
        icon: resolveIcon('LayoutGrid'),
      },
      {
        name: 'Public launch',
        url: '/about-qvac/public-launch',
        type: 'page',
        icon: resolveIcon('Megaphone'),
      },
    ],
  },
  {
    type: 'separator',
    name: 'Build',
  },
  {
    name: 'Getting started',
    type: 'folder',
    icon: resolveIcon('Compass'),
    index: { type: 'page', name: 'Getting started', url: '/sdk/getting-started' },
    children: [
      {
        name: 'Overview',
        url: '/sdk/getting-started',
        type: 'page',
        icon: resolveIcon('Map'),
      },
      {
        name: 'Quickstart',
        url: '/sdk/getting-started/quickstart',
        type: 'page',
        icon: resolveIcon('Rocket'),
      },
      {
        name: 'Installation',
        url: '/sdk/getting-started/installation',
        type: 'page',
        icon: resolveIcon('Package'),
      },
      {
        name: 'Configuration',
        url: '/sdk/getting-started/configuration',
        type: 'page',
        icon: resolveIcon('SlidersHorizontal'),
      },
    ],
  },
  {
    name: 'Usage examples',
    type: 'folder',
    icon: resolveIcon('ListChecks'),
    children: [
      {
        name: 'AI tasks',
        type: 'folder',
        icon: resolveIcon('Sparkles'),
        children: [
          { name: 'Completion', url: '/sdk/examples/ai-tasks/completion', type: 'page', icon: resolveIcon('MessagesSquare') },
          { name: 'Text embeddings', url: '/sdk/examples/ai-tasks/text-embeddings', type: 'page', icon: resolveIcon('Hash') },
          { name: 'Translation', url: '/sdk/examples/ai-tasks/translation', type: 'page', icon: resolveIcon('Languages') },
          { name: 'Transcription', url: '/sdk/examples/ai-tasks/transcription', type: 'page', icon: resolveIcon('Mic') },
          { name: 'Text-to-Speech', url: '/sdk/examples/ai-tasks/text-to-speech', type: 'page', icon: resolveIcon('Volume2') },
          { name: 'OCR', url: '/sdk/examples/ai-tasks/ocr', type: 'page', icon: resolveIcon('ScanText') },
          { name: 'Image generation', url: '/sdk/examples/ai-tasks/image-generation', type: 'page', icon: resolveIcon('Image') },
          { name: 'Multimodal', url: '/sdk/examples/ai-tasks/multimodal', type: 'page', icon: resolveIcon('GalleryHorizontal') },
          { name: 'Fine-tuning', url: '/sdk/examples/ai-tasks/fine-tuning', type: 'page', icon: resolveIcon('FlaskConical') },
          { name: 'RAG', url: '/sdk/examples/ai-tasks/rag', type: 'page', icon: resolveIcon('ScanSearch') },
        ],
      },
      {
        name: 'P2P capabilities',
        type: 'folder',
        icon: resolveIcon('Network'),
        children: [
          { name: 'Delegated inference', url: '/sdk/examples/p2p/delegated-inference', type: 'page', icon: resolveIcon('Share2') },
          { name: 'Blind relays', url: '/sdk/examples/p2p/blind-relays', type: 'page', icon: resolveIcon('Router') },
        ],
      },
      {
        name: 'Utilities',
        type: 'folder',
        icon: resolveIcon('Wrench'),
        children: [
          {
            name: 'Plugin system',
            type: 'folder',
            icon: resolveIcon('Plug'),
            index: { type: 'page', name: 'Plugin system', url: '/sdk/examples/utilities/plugin-system' },
            children: [
              { name: 'Write a custom plugin', url: '/sdk/examples/utilities/write-custom-plugin', type: 'page' },
            ],
          },
          { name: 'Logging', url: '/sdk/examples/utilities/logging', type: 'page', icon: resolveIcon('Activity') },
          { name: 'Profiler', url: '/sdk/examples/utilities/profiler', type: 'page', icon: resolveIcon('Timer') },
          { name: 'Download lifecycle', url: '/sdk/examples/utilities/download-lifecycle', type: 'page', icon: resolveIcon('Download') },
          { name: 'Runtime lifecycle', url: '/sdk/examples/utilities/runtime-lifecycle', type: 'page', icon: resolveIcon('Moon') },
          { name: 'Sharded models', url: '/sdk/examples/utilities/sharded-models', type: 'page', icon: resolveIcon('Merge') },
        ],
      },
    ],
  },
  {
    name: 'Tutorials',
    type: 'folder',
    icon: resolveIcon('GraduationCap'),
    children: [
      {
        name: 'Build on Electron',
        url: '/sdk/tutorials/electron',
        type: 'page',
        icon: React.createElement(SiElectron, { className: 'h-4 w-4' }),
      },
      {
        name: 'Build on Expo',
        url: '/sdk/tutorials/expo',
        type: 'page',
        icon: React.createElement(SiExpo, { className: 'h-4 w-4' }),
      },
    ],
  },
  {
    type: 'separator',
    name: 'References',
  },
  {
    name: 'JS API',
    url: '/sdk/api',
    type: 'page',
    icon: resolveIcon('BookA'),
  },
  {
    name: 'CLI',
    url: '/cli',
    type: 'page',
    icon: resolveIcon('Terminal'),
  },
  {
    name: 'HTTP server',
    url: '/http-server',
    type: 'page',
    icon: resolveIcon('Server'),
  },
  {
    name: 'Release notes',
    url: '/sdk/release-notes',
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
    name: 'Support',
    url: '/#support',
    type: 'page',
    icon: resolveIcon('LifeBuoy'),
  },
];
