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
  type: "separator",
  name: "Discover",
  },
  {
    name: 'Overview',
    url: '/discover',
    type: 'page',
    icon: resolveIcon('Compass'),
  },  
  {
    name: 'Vision',
    url: '/vision',
    type: 'page',
    icon: resolveIcon('Telescope'),
  },
  {
  type: "separator",
  name: "Build",
  },
  {
    name: 'SDK',
    type: 'folder',
    index: {type: 'page', name: 'SDK', url: '/sdk'},
    icon: resolveIcon('Toolbox'),
    defaultOpen: true,
    collapsible: false,  
    children: [
      {
        name: 'Quickstart',
        url: '/sdk/quickstart',
        type: 'page',
        icon: resolveIcon('Rocket'),
      },
      {
        name: 'Installation',
        url: '/sdk/install',
        type: 'page',
        icon: resolveIcon('Wrench'),
      },
      {
        name: 'API',
        type: 'folder',
        icon: resolveIcon('BookA'),
        children: [
          {
            name: 'Latest (v0.5)',
            type: 'folder',
            index: {type: 'page', name: 'Latest', url: '/sdk/api/latest'},
            children: [
              {
                name: 'cancel( )',
                url: '/sdk/api/latest/cancel',
                type: 'page',
              },
              {
                name: 'close( )',
                url: '/sdk/api/latest/close',
                type: 'page',
              },
              {
                name: 'completion( )',
                url: '/sdk/api/latest/completion',
                type: 'page',
              },
              {
                name: 'deleteCache( )',
                url: '/sdk/api/latest/deleteCache',
                type: 'page',
              },
              {
                name: 'downloadAsset( )',
                url: '/sdk/api/latest/downloadAsset',
                type: 'page',
              },
              {
                name: 'embed( )',
                url: '/sdk/api/latest/embed',
                type: 'page',
              },
              {
                name: 'getLogger( )',
                url: '/sdk/api/latest/getLogger',
                type: 'page',
              },
              {
                name: 'getModelByName( )',
                url: '/sdk/api/latest/getModelByName',
                type: 'page',
              },
              {
                name: 'getModelBySrc( )',
                url: '/sdk/api/latest/getModelBySrc',
                type: 'page',
              },
              {
                name: 'getModelInfo( )',
                url: '/sdk/api/latest/getModelInfo',
                type: 'page',
              },
              {
                name: 'loadModel( )',
                url: '/sdk/api/latest/loadModel',
                type: 'page',
              },
              {
                name: 'loggingStream( )',
                url: '/sdk/api/latest/loggingStream',
                type: 'page',
              },
              {
                name: 'ocr( )',
                url: '/sdk/api/latest/ocr',
                type: 'page',
              },
              {
                name: 'ping( )',
                url: '/sdk/api/latest/ping',
                type: 'page',
              },
              {
                name: 'ragDeleteEmbeddings( )',
                url: '/sdk/api/latest/ragDeleteEmbeddings',
                type: 'page',
              },
              {
                name: 'ragSaveEmbeddings( )',
                url: '/sdk/api/latest/ragSaveEmbeddings',
                type: 'page',
              },
              {
                name: 'ragSearch( )',
                url: '/sdk/api/latest/ragSearch',
                type: 'page',
              },
              {
                name: 'startQVACProvider( )',
                url: '/sdk/api/latest/startQVACProvider',
                type: 'page',
              },
              {
                name: 'stopQVACProvider( )',
                url: '/sdk/api/latest/stopQVACProvider',
                type: 'page',
              },
              {
                name: 'textToSpeech( )',
                url: '/sdk/api/latest/textToSpeech',
                type: 'page',
              },
              {
                name: 'transcribe( )',
                url: '/sdk/api/latest/transcribe',
                type: 'page',
              },
              {
                name: 'transcribeStream( )',
                url: '/sdk/api/latest/transcribeStream',
                type: 'page',
              },
              {
                name: 'translate( )',
                url: '/sdk/api/latest/translate',
                type: 'page',
              },
              {
                name: 'unloadModel( )',
                url: '/sdk/api/latest/unloadModel',
                type: 'page',
              },
            ],
          },
        ],
      },
      {
        name: 'Completion',
        url: '/sdk/completion',
        type: 'page',
        icon: resolveIcon('MessagesSquare'),
      },
      {
        name: 'Text embeddings',
        url: '/sdk/text-embeddings',
        type: 'page',
        icon: resolveIcon('Hash'),
      },
      {
        name: 'Translation',
        url: '/sdk/translation',
        type: 'page',
        icon: resolveIcon('Languages'),
      },
      {
        name: 'Transcription',
        url: '/sdk/transcription',
        type: 'page',
        icon: resolveIcon('Mic'),
      },
      {
        name: 'Text-to-Speech',
        url: '/sdk/text-to-speech',
        type: 'page',
        icon: resolveIcon('Volume2'),
      },
      {
        name: 'OCR',
        url: '/sdk/ocr',
        type: 'page',
        icon: resolveIcon('ScanText'),
      },
      {
        name: 'Multimodal',
        url: '/sdk/multimodal',
        type: 'page',
        icon: resolveIcon('GalleryHorizontal'),
      },
      {
        name: 'RAG',
        url: '/sdk/rag',
        type: 'page',
        icon: resolveIcon('ScanSearch'),
      },
      {
        name: 'Delegated inference',
        url: '/sdk/delegated-inference',
        type: 'page',
        icon: resolveIcon('Share2'),
      },
      {
        name: 'Logging',
        url: '/sdk/logging',
        type: 'page',
        icon: resolveIcon('Activity'),
      },
      {
        name: 'Download Lifecycle',
        url: '/sdk/download-lifecycle',
        type: 'page',
        icon: resolveIcon('Download'),
      },
      {
        name: 'Blind relays',
        url: '/sdk/blind-relays',
        type: 'page',
        icon: resolveIcon('Router'),
      },
      {
        name: 'Sharded models',
        url: '/sdk/sharded-models',
        type: 'page',
        icon: resolveIcon('Merge'),
      },
      {
        name: 'Configuration',
        url: '/sdk/configuration',
        type: 'page',
        icon: resolveIcon('SlidersHorizontal'),
      },
      {
        name: 'How it works',
        url: '/sdk/how-it-works',
        type: 'page',
        icon: resolveIcon('Cog'),
      },
      {
        name: 'Release notes',
        type: 'folder',
        icon: resolveIcon('Tag'),
        children: [
          {
            name: 'v0.5 (latest)',
            url: '/sdk/release-notes/v0-5/',
            type: 'page',
          },
        ],
      },
    ],
  },
  {
    type: "separator",
    name: "Explore",
  },
  {
    name: 'Flagship apps',
    url: '/flagship-apps',
    type: 'page',
    icon: resolveIcon('LayoutGrid'),
  },
  {
    name: 'Addons',
    type: 'folder',
    index: {type: 'page', name: 'Addons', url: '/addons'},
    icon: resolveIcon('Blocks'),
    children: [
      {
        name: 'llm-llamacpp',
        url: '/addons/llm-llamacpp',
        type: 'page',
      },
      {
        name: 'embed-llamacpp',
        url: '/addons/embed-llamacpp',
        type: 'page',
      },
      {
        name: 'translation-nmtcpp',
        url: '/addons/translation-nmtcpp',
        type: 'page',
      },
      {
        name: 'transcription-whispercpp',
        url: '/addons/transcription-whispercpp',
        type: 'page',
      },
      {
        name: 'tts-onnx',
        url: '/addons/tts-onnx',
        type: 'page',
      },
      {
        name: 'ocr-onnx',
        url: '/addons/ocr-onnx',
        type: 'page',
      },
    ],
  },
  {
    type: "separator",
    name: "Learn",
  },
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
  {
    name: 'Build on Pear',
    url: '/sdk/tutorials/pear',
    type: 'page',
    icon: React.createElement("img", {
      key: 'pear',
      src: "/pear.svg",
      alt: "Pear",
      width: 24,
      height: 24,
      className: "h-4 w-4 object-contain",
    }),
  },
  {
    type: "separator",
    name: "Help",
  },
  {   
    name: 'SDK FAQ',
    url: 'https://qvac.tether.dev/products/sdk/#faq',
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
