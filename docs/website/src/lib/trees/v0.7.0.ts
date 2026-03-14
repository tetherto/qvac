import type { Node } from 'fumadocs-core/page-tree';
import { source } from '@/lib/source';
import { resolveIcon } from "@/lib/resolveIcon";
import React from "react";
import { SiExpo, SiElectron } from '@icons-pack/react-simple-icons';

function findFolderChildren(nodes: Node[], indexUrl: string): Node[] {
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
    children: [
      {
        name: 'Welcome',
        url: '/v0.7.0/welcome',
        type: 'page',
        icon: resolveIcon('DoorOpen'),
      },
      {
        name: 'How it works',
        url: '/v0.7.0/sdk/how-it-works',
        type: 'page',
        icon: resolveIcon('Cog'),
      },
      {
        name: 'Flagship apps',
        url: '/v0.7.0/flagship-apps',
        type: 'page',
        icon: resolveIcon('LayoutGrid'),
      },
      {
        name: 'Vision',
        url: '/v0.7.0/vision',
        type: 'page',
        icon: resolveIcon('Telescope'),
      },
    ],
  },
  {
    type: 'separator',
    name: 'Build',
  },
  {
    name: 'Overview',
    url: '/v0.7.0/sdk',
    type: 'page',
    icon: resolveIcon('Map'),
  },
  {
    name: 'Getting started',
    type: 'folder',
    icon: resolveIcon('Compass'),
    children: [
      {
        name: 'Quickstart',
        url: '/v0.7.0/sdk/quickstart',
        type: 'page',
        icon: resolveIcon('Rocket'),
      },
      {
        name: 'Installation',
        url: '/v0.7.0/sdk/installation',
        type: 'page',
        icon: resolveIcon('Package'),
      },
      {
        name: 'Configuration',
        url: '/v0.7.0/sdk/configuration',
        type: 'page',
        icon: resolveIcon('SlidersHorizontal'),
      },
    ],
  },
  {
    name: 'AI tasks',
    type: 'folder',
    icon: resolveIcon('Sparkles'),
    children: [
      { name: 'Completion', url: '/v0.7.0/sdk/ai-tasks/completion', type: 'page', icon: resolveIcon('MessagesSquare') },
      { name: 'Text embeddings', url: '/v0.7.0/sdk/ai-tasks/text-embeddings', type: 'page', icon: resolveIcon('Hash') },
      { name: 'Translation', url: '/v0.7.0/sdk/ai-tasks/translation', type: 'page', icon: resolveIcon('Languages') },
      { name: 'Transcription', url: '/v0.7.0/sdk/ai-tasks/transcription', type: 'page', icon: resolveIcon('Mic') },
      { name: 'Text-to-Speech', url: '/v0.7.0/sdk/ai-tasks/text-to-speech', type: 'page', icon: resolveIcon('Volume2') },
      { name: 'OCR', url: '/v0.7.0/sdk/ai-tasks/ocr', type: 'page', icon: resolveIcon('ScanText') },
      { name: 'Multimodal', url: '/v0.7.0/sdk/ai-tasks/multimodal', type: 'page', icon: resolveIcon('GalleryHorizontal') },
      { name: 'RAG', url: '/v0.7.0/sdk/ai-tasks/rag', type: 'page', icon: resolveIcon('ScanSearch') },
    ],
  },
  {
    name: 'P2P capabilities',
    type: 'folder',
    icon: resolveIcon('Network'),
    children: [
      { name: 'Delegated inference', url: '/v0.7.0/sdk/p2p/delegated-inference', type: 'page', icon: resolveIcon('Share2') },
      { name: 'Blind relays', url: '/v0.7.0/sdk/p2p/blind-relays', type: 'page', icon: resolveIcon('Router') },
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
        index: { type: 'page', name: 'Plugin system', url: '/v0.7.0/sdk/utilities/plugin-system' },
        children: [
          { name: 'Write a custom plugin', url: '/v0.7.0/sdk/utilities/write-custom-plugin', type: 'page' },
        ],
      },
      { name: 'Logging', url: '/v0.7.0/sdk/utilities/logging', type: 'page', icon: resolveIcon('Activity') },
      { name: 'Download lifecycle', url: '/v0.7.0/sdk/utilities/download-lifecycle', type: 'page', icon: resolveIcon('Download') },
      { name: 'Sharded models', url: '/v0.7.0/sdk/utilities/sharded-models', type: 'page', icon: resolveIcon('Merge') },
    ],
  },
  {
    name: 'API',
    type: 'folder',
    icon: resolveIcon('BookA'),
    index: { type: 'page', name: 'API', url: '/v0.7.0/sdk/api' },
    children: findFolderChildren(source.pageTree.children, '/v0.7.0/sdk/api'),
  },
  {
    name: 'Tutorials',
    type: 'folder',
    icon: resolveIcon('GraduationCap'),
    children: [
      {
        name: 'Build on Electron',
        url: '/v0.7.0/sdk/tutorials/electron',
        type: 'page',
        icon: React.createElement(SiElectron, { className: "h-4 w-4" }),
      },
      {
        name: 'Build on Expo',
        url: '/v0.7.0/sdk/tutorials/expo',
        type: 'page',
        icon: React.createElement(SiExpo, { className: "h-4 w-4" }),
      },
    ],
  },
  {
    type: 'separator',
    name: 'Miscellaneous',
  },
  {
    name: 'Addons',
    type: 'folder',
    icon: resolveIcon('Blocks'),
    index: { type: 'page', name: 'Addons', url: '/v0.7.0/addons' },
    children: [
      { name: 'llm-llamacpp', url: '/v0.7.0/addons/llm-llamacpp', type: 'page' },
      { name: 'embed-llamacpp', url: '/v0.7.0/addons/embed-llamacpp', type: 'page' },
      { name: 'translation-nmtcpp', url: '/v0.7.0/addons/translation-nmtcpp', type: 'page' },
      { name: 'transcription-whispercpp', url: '/v0.7.0/addons/transcription-whispercpp', type: 'page' },
      { name: 'tts-onnx', url: '/v0.7.0/addons/tts-onnx', type: 'page' },
      { name: 'ocr-onnx', url: '/v0.7.0/addons/ocr-onnx', type: 'page' },      
    ],
  },
  {
    name: 'Release notes',
    url: 'https://github.com/tetherto/qvac/tree/main/packages/sdk/changelog',
    type: 'page',
    external: true,
    icon: resolveIcon('Tag'),
  },
  {
    name: 'Support',
    url: '/#support',
    type: 'page',
    icon: resolveIcon('LifeBuoy'),
  },
];
