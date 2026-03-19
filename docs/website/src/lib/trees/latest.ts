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
    children: [
      {
        name: 'Welcome',
        url: '/welcome',
        type: 'page',
        icon: resolveIcon('DoorOpen'),
      },
      {
        name: 'How it works',
        url: '/sdk/how-it-works',
        type: 'page',
        icon: resolveIcon('Cog'),
      },
      {
        name: 'Flagship apps',
        url: '/flagship-apps',
        type: 'page',
        icon: resolveIcon('LayoutGrid'),
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
    children: [
      {
        name: 'Overview',
        url: '/sdk',
        type: 'page',
        icon: resolveIcon('Map'),
      },
      {
        name: 'Quickstart',
        url: '/sdk/quickstart',
        type: 'page',
        icon: resolveIcon('Rocket'),
      },
      {
        name: 'Installation',
        url: '/sdk/installation',
        type: 'page',
        icon: resolveIcon('Package'),
      },
      {
        name: 'Configuration',
        url: '/sdk/configuration',
        type: 'page',
        icon: resolveIcon('SlidersHorizontal'),
      },
    ],
  },
  {
    name: 'How-to guides',
    type: 'folder',
    icon: resolveIcon('ListChecks'),
    children: [
      { name: 'Blind relays', url: '/sdk/p2p/blind-relays', type: 'page', icon: resolveIcon('Router') },
      { name: 'Completion', url: '/sdk/ai-tasks/completion', type: 'page', icon: resolveIcon('MessagesSquare') },
      { name: 'Delegated inference', url: '/sdk/p2p/delegated-inference', type: 'page', icon: resolveIcon('Share2') },
      { name: 'Download lifecycle', url: '/sdk/utilities/download-lifecycle', type: 'page', icon: resolveIcon('Download') },
      { name: 'Logging', url: '/sdk/utilities/logging', type: 'page', icon: resolveIcon('Activity') },
      { name: 'Multimodal', url: '/sdk/ai-tasks/multimodal', type: 'page', icon: resolveIcon('GalleryHorizontal') },
      { name: 'OCR', url: '/sdk/ai-tasks/ocr', type: 'page', icon: resolveIcon('ScanText') },
      {
        name: 'Plugin system',
        type: 'folder',
        icon: resolveIcon('Plug'),
        index: { type: 'page', name: 'Plugin system', url: '/sdk/utilities/plugin-system' },
        children: [
          { name: 'Write a custom plugin', url: '/sdk/utilities/write-custom-plugin', type: 'page' },
        ],
      },
      { name: 'RAG', url: '/sdk/ai-tasks/rag', type: 'page', icon: resolveIcon('ScanSearch') },
      { name: 'Sharded models', url: '/sdk/utilities/sharded-models', type: 'page', icon: resolveIcon('Merge') },
      { name: 'Text embeddings', url: '/sdk/ai-tasks/text-embeddings', type: 'page', icon: resolveIcon('Hash') },
      { name: 'Text-to-Speech', url: '/sdk/ai-tasks/text-to-speech', type: 'page', icon: resolveIcon('Volume2') },
      { name: 'Transcription', url: '/sdk/ai-tasks/transcription', type: 'page', icon: resolveIcon('Mic') },
      { name: 'Translation', url: '/sdk/ai-tasks/translation', type: 'page', icon: resolveIcon('Languages') },
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
