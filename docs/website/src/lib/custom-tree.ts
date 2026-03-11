import type { Node } from 'fumadocs-core/page-tree';
import { resolveIcon } from "@/lib/resolveIcon";
import React from "react";
import { SiExpo, SiElectron } from '@icons-pack/react-simple-icons';

// Custom tree structure that replicates the GitBook SUMMARY.md structure
export const customTree: Node[] = [
  {
    name: 'Home',
    url: '/',
    type: 'page',
    icon: resolveIcon('Map'),
  },
  {
    name: 'About QVAC',
    type: 'folder',
    icon: resolveIcon('Info'),
    children: [
      {
        name: 'Welcome',
        url: '/about-qvac/welcome',
        type: 'page',
        icon: resolveIcon('Sparkles'),
      },
      {
        name: 'How it works',
        url: '/about-qvac/how-it-works',
        type: 'page',
        icon: resolveIcon('Cog'),
      },
      {
        name: 'Flagship Apps',
        url: '/about-qvac/flagship-apps',
        type: 'page',
        icon: resolveIcon('LayoutGrid'),
      },
    ]
  },
  {
  type: "separator",
  name: "Build",
  },
  {
    name: 'Getting started',
    type: 'folder',
    icon: resolveIcon('Compass'),
    index: {
      name: 'Installation',
      url: '/getting-started',
      type: 'page',
    },
    children: [
      {
        name: 'Quickstart',
        url: '/getting-started/quickstart',
        type: 'page',
        icon: resolveIcon('Rocket'),
      },
      {
        name: 'Installation',
        url: '/getting-started/install',
        type: 'page',
        icon: resolveIcon('Wrench'),
      },
      { 
        name: 'Configuration',
        url: '/getting-started/configuration',
        type: 'page',
        icon: resolveIcon('SlidersHorizontal'),
      },
    ]
  },
  {
    name: 'How-to guides',
    type: 'folder',
    icon: resolveIcon('ListChecks'),
    children: [      
      { name: 'Blind relays', url: '/how-tos/blind-relays', type: 'page', icon: resolveIcon('Router') },
      { name: 'Completion', url: '/how-tos/completion', type: 'page', icon: resolveIcon('MessagesSquare') },
      { name: 'Delegated inference', url: '/how-tos/delegated-inference', type: 'page', icon: resolveIcon('Share2') },
      { name: 'Download Lifecycle', url: '/how-tos/download-lifecycle', type: 'page', icon: resolveIcon('Download') },
      { name: 'Logging', url: '/how-tos/logging', type: 'page', icon: resolveIcon('Activity') },
      { name: 'Multimodal', url: '/how-tos/multimodal', type: 'page', icon: resolveIcon('GalleryHorizontal') },
      { name: 'OCR', url: '/how-tos/ocr', type: 'page', icon: resolveIcon('ScanText') },
      { name: 'Plugin system', type: 'folder', icon: resolveIcon('Plug'), index: {type: 'page', name: 'Plugin system', url: '/how-tos/plugin-system'}, children: [
        { name: 'Write a custom plugin', url: '/how-tos/write-custom-plugin', type: 'page' },
      ] },
      { name: 'RAG', url: '/how-tos/rag', type: 'page', icon: resolveIcon('ScanSearch') },
      { name: 'Sharded models', url: '/how-tos/sharded-models', type: 'page', icon: resolveIcon('Merge') },
      { name: 'Text embeddings', url: '/how-tos/text-embeddings', type: 'page', icon: resolveIcon('Hash') },
      { name: 'Text-to-Speech', url: '/how-tos/text-to-speech', type: 'page', icon: resolveIcon('Volume2') },
      { name: 'Transcription', url: '/how-tos/transcription', type: 'page', icon: resolveIcon('Mic') },
      { name: 'Translation', url: '/how-tos/translation', type: 'page', icon: resolveIcon('Languages') },
    ],
  },
  {
    name: 'Tutorials',
    type: 'folder',
    icon: resolveIcon('GraduationCap'),
    children: [
      {
        name: 'Build on Electron',
        url: '/tutorials/electron',
        type: 'page',
        icon: React.createElement(SiElectron, { className: "h-4 w-4" }),
      },
      {
        name: 'Build on Expo',
        url: '/tutorials/expo',
        type: 'page',
        icon: React.createElement(SiExpo, { className: "h-4 w-4" }),
      }, 
    ]
  },
  {
    type: "separator",
    name: "References",
  },
  {
    name: 'API',
    type: 'folder',
    icon: resolveIcon('BookA'),
    index: {type: 'page', name: 'API', url: '/references/api'},
    children: [
      { name: 'cancel( )', url: '/references/api/cancel', type: 'page' },
      { name: 'close( )', url: '/references/api/close', type: 'page' },
      { name: 'completion( )', url: '/references/api/completion', type: 'page' },
      { name: 'defineHandler( )', url: '/references/api/defineHandler', type: 'page' },
      { name: 'definePlugin( )', url: '/references/api/definePlugin', type: 'page' },
      { name: 'deleteCache( )', url: '/references/api/deleteCache', type: 'page' },
      { name: 'downloadAsset( )', url: '/references/api/downloadAsset', type: 'page' },
      { name: 'embed( )', url: '/references/api/embed', type: 'page' },
      { name: 'Errors', url: '/references/api/errors', type: 'page' },
      { name: 'getLogger( )', url: '/references/api/getLogger', type: 'page' },
      { name: 'getModelByName( )', url: '/references/api/getModelByName', type: 'page' },
      { name: 'getModelBySrc( )', url: '/references/api/getModelBySrc', type: 'page' },
      { name: 'getModelInfo( )', url: '/references/api/getModelInfo', type: 'page' },
      { name: 'invokePlugin( )', url: '/references/api/invokePlugin', type: 'page' },
      { name: 'invokePluginStream( )', url: '/references/api/invokePluginStream', type: 'page' },
      { name: 'loadModel( )', url: '/references/api/loadModel', type: 'page' },
      { name: 'loggingStream( )', url: '/references/api/loggingStream', type: 'page' },
      { name: 'modelRegistryGetModel( )', url: '/references/api/modelRegistryGetModel', type: 'page' },
      { name: 'modelRegistryList( )', url: '/references/api/modelRegistryList', type: 'page' },
      { name: 'modelRegistrySearch( )', url: '/references/api/modelRegistrySearch', type: 'page' },
      { name: 'ocr( )', url: '/references/api/ocr', type: 'page' },
      { name: 'ping( )', url: '/references/api/ping', type: 'page' },
      { name: 'ragChunk( )', url: '/references/api/ragChunk', type: 'page' },
      { name: 'ragCloseWorkspace( )', url: '/references/api/ragCloseWorkspace', type: 'page' },
      { name: 'ragDeleteEmbeddings( )', url: '/references/api/ragDeleteEmbeddings', type: 'page' },
      { name: 'ragDeleteWorkspace( )', url: '/references/api/ragDeleteWorkspace', type: 'page' },
      { name: 'ragIngest( )', url: '/references/api/ragIngest', type: 'page' },
      { name: 'ragListWorkspaces( )', url: '/references/api/ragListWorkspaces', type: 'page' },
      { name: 'ragReindex( )', url: '/references/api/ragReindex', type: 'page' },
      { name: 'ragSaveEmbeddings( )', url: '/references/api/ragSaveEmbeddings', type: 'page' },
      { name: 'ragSearch( )', url: '/references/api/ragSearch', type: 'page' },
      { name: 'startQVACProvider( )', url: '/references/api/startQVACProvider', type: 'page' },
      { name: 'stopQVACProvider( )', url: '/references/api/stopQVACProvider', type: 'page' },
      { name: 'textToSpeech( )', url: '/references/api/textToSpeech', type: 'page' },
      { name: 'transcribe( )', url: '/references/api/transcribe', type: 'page' },
      { name: 'transcribeStream( )', url: '/references/api/transcribeStream', type: 'page' },
      { name: 'translate( )', url: '/references/api/translate', type: 'page' },
      { name: 'unloadModel( )', url: '/references/api/unloadModel', type: 'page' },
    ],
  },
  {
    name: 'Release notes',
    url: 'https://github.com/tetherto/qvac-sdk/releases/tag/v0.5.0',
    type: 'page',
    external: true,
    icon: resolveIcon('Tag'),
  },
  { 
    name: 'Addons', type: 'folder', index: {type: 'page', name: 'Addons', url: '/references/addons'}, icon: resolveIcon('Blocks'), children: [
      { name: 'embed-llamacpp', url: '/references/addons/embed-llamacpp', type: 'page' },
      { name: 'llm-llamacpp', url: '/references/addons/llm-llamacpp', type: 'page' },
      { name: 'ocr-onnx', url: '/references/addons/ocr-onnx', type: 'page' },
      { name: 'transcription-whispercpp', url: '/references/addons/transcription-whispercpp', type: 'page' },
      { name: 'translation-nmtcpp', url: '/references/addons/translation-nmtcpp', type: 'page' },
      { name: 'tts-onnx', url: '/references/addons/tts-onnx', type: 'page' },
    ] 
  },
  {
    type: "separator",
    name: "Help",
  },
  {   
    name: 'SDK FAQ',
    url: 'https://qvac.tether.dev/products/how-tos/#faq',
    type: 'page',
    external: true,
    icon: resolveIcon('MessageCircleQuestionMark'),
  },
  {   
    name: 'Support',
    url: '/#support',
    type: 'page',
    icon: resolveIcon('LifeBuoy'),
  },
];
