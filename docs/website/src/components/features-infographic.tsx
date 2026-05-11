'use client';

import * as React from 'react';
import {
  TbBrandApple,
  TbBrandWindows,
  TbDeviceLaptop,
  TbDeviceMobile,
  TbAccessPoint,
} from 'react-icons/tb';
import {
  SiLinux,
  SiAndroid,
} from '@icons-pack/react-simple-icons';

// ============================================================================
// Data
// ============================================================================

type Feature = {
  id: string;
  name: string;
  description: string;
  /** Compass angle in degrees: 0 = top, increases clockwise. */
  angle: number;
};

const FEATURES: Feature[] = [
  {
    id: 'local-first',
    name: 'Local-first AI',
    description:
      'Run AI models and inference locally, without third-party APIs, SaaS, or cloud dependencies.',
    angle: 315,
  },
  {
    id: 'p2p',
    name: 'Peer-to-peer',
    description:
      'Delegate inference to peers and build AI systems that work across a P2P network.',
    angle: 45,
  },
  {
    id: 'cross-platform',
    name: 'Cross-platform',
    description:
      'Run across Linux, macOS, Windows, Android, iOS, and JavaScript runtime environments.',
    angle: 80,
  },
  {
    id: 'unified',
    name: 'Unified JS/TS interface',
    description:
      'Use one typed JavaScript/TypeScript SDK to run multiple AI capabilities from a single npm package.',
    angle: 130,
  },
  {
    id: 'openai',
    name: 'OpenAI-compatible',
    description:
      'Expose a local HTTP API compatible with OpenAI-style tooling and integrations.',
    angle: 180,
  },
  {
    id: 'open-source',
    name: 'Open source',
    description:
      'Use, modify, and build on QVAC under the Apache 2.0 license.',
    angle: 230,
  },
  {
    id: 'pluggable',
    name: 'Pluggable',
    description:
      'Include only the capabilities your app needs, and extend the SDK with custom plugins.',
    angle: 280,
  },
];

type IconProps = { size?: number; className?: string };

// Custom 3-tier outlined server (Tabler ships only 2-tier variants).
// Stroke style matches Tabler's default (width 2, round caps/joins).
function ServerStackIcon({ size = 24, className }: IconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="5" rx="1" />
      <rect x="3" y="9.5" width="18" height="5" rx="1" />
      <rect x="3" y="16" width="18" height="5" rx="1" />
      <line x1="6.5" y1="5.5" x2="6.51" y2="5.5" />
      <line x1="6.5" y1="12" x2="6.51" y2="12" />
      <line x1="6.5" y1="18.5" x2="6.51" y2="18.5" />
    </svg>
  );
}

type Platform = {
  id: string;
  label: string;
  Icon: React.ComponentType<IconProps>;
  /** Compass angle in degrees: 0 = top, increases clockwise. */
  angle: number;
};

const PLATFORMS: Platform[] = [
  { id: 'desktop', label: 'Desktop', Icon: TbDeviceLaptop as unknown as React.ComponentType<IconProps>, angle: 0 },
  { id: 'apple', label: 'Apple', Icon: TbBrandApple as unknown as React.ComponentType<IconProps>, angle: 45 },
  { id: 'server', label: 'Server', Icon: ServerStackIcon, angle: 90 },
  { id: 'android', label: 'Android', Icon: SiAndroid as unknown as React.ComponentType<IconProps>, angle: 135 },
  { id: 'mobile', label: 'Mobile', Icon: TbDeviceMobile as unknown as React.ComponentType<IconProps>, angle: 180 },
  { id: 'windows', label: 'Windows', Icon: TbBrandWindows as unknown as React.ComponentType<IconProps>, angle: 225 },
  { id: 'iot', label: 'IoT', Icon: TbAccessPoint as unknown as React.ComponentType<IconProps>, angle: 270 },
  { id: 'linux', label: 'Linux', Icon: SiLinux as unknown as React.ComponentType<IconProps>, angle: 315 },
];

// ============================================================================
// Geometry (all in SVG viewBox units; scales uniformly with the container)
// ============================================================================

const VIEW_W = 1280;
const VIEW_H = 880;
const CENTER_X = VIEW_W / 2; // 640
const CENTER_Y = VIEW_H / 2; // 440

const R_INNER = 95; // small circle around the Q
const R_PLATFORMS = 180; // ring where platform icons sit
const R_OUTER = 290; // outermost dotted circle (where feature pins live)
const R_LABEL = 415; // center of each feature card outside the rings
const PIN_TIP_GAP = 90; // distance from card center where the connector line ends

const PLATFORM_BOX = 80; // foreignObject square that holds each platform icon
const CARD_W = 240;
const CARD_H = 210;

function polar(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: CENTER_X + radius * Math.sin(rad),
    y: CENTER_Y - radius * Math.cos(rad),
  };
}

// Q mark path extracted from /public/qvac-icon.svg (viewBox 0 0 56 48).
const Q_VIEW_W = 56;
const Q_VIEW_H = 48;
const Q_SCALE = 1.5; // → ~84 × 72 px, comfortably inside R_INNER (95)
const Q_PATH =
  'M46.0067 25.3175H43.5317V20.5455C43.5317 20.2954 43.4385 20.0581 43.2689 19.8758L38.713 14.9936C38.5265 14.7944 38.268 14.6799 37.9925 14.6799H9.91516C9.64392 14.6799 9.38116 14.7944 9.19469 14.9936L4.63874 19.8716C4.46921 20.0538 4.37598 20.2954 4.37598 20.5412V27.5086C4.37598 27.7587 4.46921 27.996 4.63874 28.1783L9.19469 33.0563C9.38116 33.2555 9.63969 33.3699 9.91516 33.3699H52.6902C52.9615 33.3657 53.2242 33.2513 53.4107 33.0521C53.4107 33.0521 46.5535 25.3133 46.011 25.3133L46.0067 25.3175ZM35.4793 24.3301C35.4793 24.8725 35.0386 25.3133 34.4961 25.3133H13.4116C13.1403 25.3133 12.8776 25.1989 12.6911 24.9997C12.5216 24.8174 12.4284 24.5759 12.4284 24.3301V23.7198C12.4284 23.4697 12.5216 23.2324 12.6953 23.0502C12.8818 22.851 13.1403 22.7365 13.4158 22.7365H34.4791C34.7419 22.7365 34.9919 22.8383 35.1742 23.0247L35.1954 23.0459C35.3819 23.2324 35.4836 23.4824 35.4836 23.741V24.3301H35.4793Z';

const DASH = '3 6';
const STROKE = 2;
const HTML_NS = 'http://www.w3.org/1999/xhtml';

// ============================================================================
// Component
// ============================================================================

export function FeaturesInfographic() {
  return (
    <div className="not-prose my-8">
      {/* ============= Infographic (md+) ============= */}
      <div className="hidden text-fd-primary md:block">
        <svg
          className="mx-auto block h-auto w-full max-w-[1280px]"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          fill="none"
          stroke="currentColor"
          role="img"
          aria-labelledby="features-infographic-title"
        >
          <title id="features-infographic-title">
            QVAC features and platforms overview
          </title>

          {/* ----- Geometry: rings + spokes ----- */}
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={R_INNER}
            strokeWidth={STROKE}
            strokeDasharray={DASH}
            opacity={0.55}
          />
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={R_PLATFORMS}
            strokeWidth={STROKE}
            strokeDasharray={DASH}
            opacity={0.45}
          />
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={R_OUTER}
            strokeWidth={STROKE}
            strokeDasharray={DASH}
            opacity={0.4}
          />

          {PLATFORMS.map((p) => {
            const a = polar(p.angle, R_INNER);
            const b = polar(p.angle, R_PLATFORMS);
            return (
              <line
                key={`spoke-${p.id}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                strokeWidth={STROKE}
                strokeDasharray={DASH}
                opacity={0.45}
              />
            );
          })}

          {FEATURES.map((f) => {
            const dot = polar(f.angle, R_OUTER);
            const tip = polar(f.angle, R_LABEL - PIN_TIP_GAP);
            return (
              <g key={`conn-${f.id}`}>
                <line
                  x1={dot.x}
                  y1={dot.y}
                  x2={tip.x}
                  y2={tip.y}
                  strokeWidth={STROKE}
                  strokeDasharray={DASH}
                  opacity={0.6}
                />
                <circle
                  cx={dot.x}
                  cy={dot.y}
                  r={5}
                  fill="currentColor"
                  stroke="none"
                />
                <circle
                  cx={tip.x}
                  cy={tip.y}
                  r={3}
                  fill="currentColor"
                  stroke="none"
                  opacity={0.6}
                />
              </g>
            );
          })}

          {/* ----- Q mark, centered ----- */}
          <g
            transform={`translate(${
              CENTER_X - (Q_VIEW_W * Q_SCALE) / 2
            }, ${
              CENTER_Y - (Q_VIEW_H * Q_SCALE) / 2
            }) scale(${Q_SCALE})`}
          >
            <path d={Q_PATH} fill="currentColor" stroke="none" />
          </g>

          {/* ----- Platform icons (foreignObject so they scale with viewBox) ----- */}
          {PLATFORMS.map((p) => {
            const pos = polar(p.angle, R_PLATFORMS);
            return (
              <foreignObject
                key={p.id}
                x={pos.x - PLATFORM_BOX / 2}
                y={pos.y - PLATFORM_BOX / 2}
                width={PLATFORM_BOX}
                height={PLATFORM_BOX}
              >
                <div
                  {...{ xmlns: HTML_NS }}
                  className="flex h-full w-full items-center justify-center rounded-full bg-fd-background"
                >
                  <p.Icon size={48} className="text-fd-primary" />
                </div>
              </foreignObject>
            );
          })}

          {/* ----- Feature cards (static; foreignObject so they scale) ----- */}
          {FEATURES.map((f) => {
            const pos = polar(f.angle, R_LABEL);
            return (
              <foreignObject
                key={f.id}
                x={pos.x - CARD_W / 2}
                y={pos.y - CARD_H / 2}
                width={CARD_W}
                height={CARD_H}
              >
                <div {...{ xmlns: HTML_NS }} className="flex h-full w-full flex-col">
                  <p className="m-0 mb-2 text-center text-[22px] font-medium leading-tight text-fd-primary">
                    {f.name}
                  </p>
                  <div className="flex-1 rounded-md border border-fd-primary/40 bg-fd-background p-3">
                    <p className="m-0 text-[18px] leading-snug text-fd-muted-foreground">
                      {f.description}
                    </p>
                  </div>
                </div>
              </foreignObject>
            );
          })}
        </svg>
      </div>

      {/* ============= Mobile fallback list (<md) ============= */}
      <ul className="m-0 list-none space-y-3 p-0 md:hidden">
        {FEATURES.map((f) => (
          <li key={f.id} className="m-0">
            <p className="m-0 font-medium text-fd-primary">{f.name}</p>
            <p className="m-0 text-sm text-fd-muted-foreground">
              {f.description}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}
