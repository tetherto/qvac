import type { Node } from 'fumadocs-core/page-tree';
import { source } from '@/lib/source';
import { resolveIcon } from "@/lib/resolveIcon";
import React from "react";
import { SiExpo, SiElectron } from '@icons-pack/react-simple-icons';

export function findFolderChildren(nodes: Node[], indexUrl: string): Node[] {
  for (const node of nodes) {
    if (node.type === 'folder') {
      if (node.index?.url === indexUrl) return node.children;
      const found = findFolderChildren(node.children, indexUrl);
      if (found.length > 0) return found;
    }
  }
  return [];
}

export const tree: Node[] = [
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
    name: 'Usage Examples',
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
          { name: 'Multimodal', url: '/sdk/examples/ai-tasks/multimodal', type: 'page', icon: resolveIcon('GalleryHorizontal') },
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
        icon: React.createElement(SiElectron, { className: "h-4 w-4" }),
      },
      {
        name: 'Build on Expo',
        url: '/sdk/tutorials/expo',
        type: 'page',
        icon: React.createElement(SiExpo, { className: "h-4 w-4" }),
      },
    ],
  },
  {
    type: 'separator',
    name: 'References',
  },
  {
    name: 'JS API',
    type: 'folder',
    icon: resolveIcon('BookA'),
    index: { type: 'page', name: 'API', url: '/sdk/api' },
    children: findFolderChildren(source.pageTree.children, '/sdk/api'),
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
    url: 'https://github.com/tetherto/qvac/tree/main/packages/sdk/changelog',
    type: 'page',
    external: true,
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
    ],
  },
  {
    type: "separator",
    name: "Help",
  },
  {
    name: 'Support',
    url: '/#support',
    type: 'page',
    icon: resolveIcon('LifeBuoy'),
  },
];
