'use client';

import * as React from 'react';
import Link from 'next/link';
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
// Public types
// ============================================================================

export type IconProps = { size?: number; className?: string };

export type Platform = {
  id: string;
  label: string;
  Icon: React.ComponentType<IconProps>;
  /** Compass angle in degrees: 0 = top, increases clockwise. */
  angle: number;
};

export type Feature = {
  id: string;
  name: string;
  description: string;
  /** Compass angle in degrees: 0 = top, increases clockwise. */
  angle: number;
  /** Optional link target. When set, the card becomes a `<Link>`. */
  href?: string;
  /** Optional click handler. When set (and `href` is not), the card becomes a `<button>`. */
  onClick?: () => void;
};

export type FeaturesInfographicV2Props = {
  features?: Feature[];
  platforms?: Platform[];
  className?: string;
};

// ============================================================================
// Custom 3-tier outlined server icon (Tabler ships only 2-tier variants).
// Stroke style matches Tabler's default (width 2, round caps/joins).
// Exported so consumers can reuse or replace it.
// ============================================================================

export function ServerStackIcon({ size = 24, className }: IconProps) {
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

// ============================================================================
// Default data
// ============================================================================

export const DEFAULT_PLATFORMS: Platform[] = [
  { id: 'mobile',  label: 'Mobile',  Icon: TbDeviceMobile as unknown as React.ComponentType<IconProps>,         angle: 0 },
  { id: 'apple',   label: 'Apple',   Icon: TbBrandApple as unknown as React.ComponentType<IconProps>,           angle: 45 },
  { id: 'server',  label: 'Server',  Icon: ServerStackIcon,                                                     angle: 90 },
  { id: 'android', label: 'Android', Icon: SiAndroid as unknown as React.ComponentType<IconProps>,              angle: 135 },
  { id: 'iot',     label: 'IoT',     Icon: TbAccessPoint as unknown as React.ComponentType<IconProps>,          angle: 180 },
  { id: 'windows', label: 'Windows', Icon: TbBrandWindows as unknown as React.ComponentType<IconProps>,         angle: 225 },
  { id: 'desktop', label: 'Desktop', Icon: TbDeviceLaptop as unknown as React.ComponentType<IconProps>,         angle: 270 },
  { id: 'linux',   label: 'Linux',   Icon: SiLinux as unknown as React.ComponentType<IconProps>,                angle: 315 },
];

export const DEFAULT_FEATURES: Feature[] = [
  {
    id: 'local-first',
    name: 'Local-first AI',
    description:
      'Run AI models and inference locally, without relying on third-party APIs, SaaS, or cloud infrastructure.',
    angle: 315,
  },
  {
    id: 'p2p',
    name: 'Peer-to-peer',
    description:
      'Delegate inference to peers and build AI systems that work across P2P networks.',
    angle: 45,
  },
  {
    id: 'cross-platform',
    name: 'Cross-platform',
    description:
      'Consistent developer experience across hardware, operating systems, and JavaScript runtimes — write code once, run it everywhere.',
    angle: 90,
  },
  {
    id: 'pluggable',
    name: 'Pluggable',
    description:
      'Include only the capabilities your app needs, and extend the SDK with custom plugins.',
    angle: 135,
  },
  {
    id: 'open-source',
    name: 'Open source',
    description:
      '100% free to use and modify, released under Apache 2.0 license.',
    angle: 180,
  },
  {
    id: 'openai',
    name: 'OpenAI-compatible API',
    description:
      'Launch an HTTP server that exposes an OpenAI-compatible API for integration with the broader AI ecosystem.',
    angle: 225,
  },
  {
    id: 'unified',
    name: 'Unified JS/TS interface',
    description:
      'Use one typed JavaScript SDK to run multiple AI capabilities from a single npm package.',
    angle: 270,
  },
];

// ============================================================================
// Geometry (all in SVG viewBox units; scales uniformly with the container)
// ============================================================================

const VIEW_W = 1280;
const CENTER_X = VIEW_W / 2;
// CENTER_Y is intentionally fixed (not derived from VIEW_H) so the rings and
// platform icons stay locked in place even if VIEW_H is later adjusted to make
// room for additional content below.
const CENTER_Y = 440;
const VIEW_H = 900;

const R_INNER = 95;       // small circle around the Q
const R_PLATFORMS = 180;  // ring where platform icons sit
const R_OUTER = 290;      // outermost dotted circle (where feature pins live)

// Vertical crop applied to the viewBox so the infographic does not waste
// space above the outer ring (which begins at y = CENTER_Y - R_OUTER).
// Geometry stays anchored to CENTER_Y; only the visible window is shifted.
const VIEWBOX_TOP = CENTER_Y - R_OUTER - 2; // = 148, ~2px breathing above the ring
const VIEWBOX_HEIGHT = VIEW_H - VIEWBOX_TOP;

const PLATFORM_BOX = 80;  // foreignObject square that holds each platform icon

type FeatureCardLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  titleAlign: 'left' | 'center' | 'right';
};

const TITLE_ALIGN_CLASS: Record<FeatureCardLayout['titleAlign'], string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

// Card positions are tuned so that each card's title sits right next to its
// matching outer-ring bullet (no connector line is drawn; the bullet is the
// visual anchor instead). titleAlign indicates which edge of the title hugs
// the bullet (left = title's left edge, right = title's right edge,
// center = title centered horizontally below the bullet).
const FEATURE_CARD_LAYOUT: Record<string, FeatureCardLayout> = {
  // NW bullet ~ (435, 235)
  'local-first': {
    x: 103,
    y: 222,
    width: 320,
    height: 180,
    titleAlign: 'right',
  },
  // NE bullet ~ (845, 235)
  p2p: {
    x: 857,
    y: 222,
    width: 320,
    height: 165,
    titleAlign: 'left',
  },
  // E bullet ~ (930, 440); shifted slightly up so the taller box still hugs
  // the bullet vertically without colliding with the SE card below.
  'cross-platform': {
    x: 945,
    y: 420,
    width: 315,
    height: 215,
    titleAlign: 'left',
  },
  // SE bullet ~ (845, 645); pushed down a few px to keep clearance from the
  // taller cross-platform card above.
  pluggable: {
    x: 857,
    y: 642,
    width: 320,
    height: 170,
    titleAlign: 'left',
  },
  // S bullet ~ (640, 730)
  'open-source': {
    x: 490,
    y: 742,
    width: 300,
    height: 150,
    titleAlign: 'center',
  },
  // SW bullet ~ (435, 645)
  openai: {
    x: 103,
    y: 632,
    width: 320,
    height: 180,
    titleAlign: 'right',
  },
  // W bullet ~ (350, 440)
  unified: {
    x: 20,
    y: 427,
    width: 315,
    height: 165,
    titleAlign: 'right',
  },
};

function polar(angleDeg: number, radius: number): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: CENTER_X + radius * Math.sin(rad),
    y: CENTER_Y - radius * Math.cos(rad),
  };
}

function getFeatureCardLayout(feature: Feature): FeatureCardLayout {
  const layout = FEATURE_CARD_LAYOUT[feature.id];
  if (layout) return layout;

  // Fallback: place the card just outside the outer ring at the feature's
  // angle. Title alignment hugs the bullet on whichever side of the diagram
  // the card lands.
  const bullet = polar(feature.angle, R_OUTER);
  const isLeft = bullet.x < CENTER_X;
  const width = 320;
  const height = 160;
  const gap = 12;
  return {
    x: isLeft ? bullet.x - width - gap : bullet.x + gap,
    y: bullet.y - 13,
    width,
    height,
    titleAlign: isLeft ? 'right' : 'left',
  };
}

// Q mark path extracted from /public/qvac-icon.svg (viewBox 0 0 56 48).
const Q_VIEW_W = 56;
const Q_VIEW_H = 48;
const Q_SCALE = 1.5; // → ~84 × 72 px, comfortably inside R_INNER (95)
const Q_PATH =
  'M46.0067 25.3175H43.5317V20.5455C43.5317 20.2954 43.4385 20.0581 43.2689 19.8758L38.713 14.9936C38.5265 14.7944 38.268 14.6799 37.9925 14.6799H9.91516C9.64392 14.6799 9.38116 14.7944 9.19469 14.9936L4.63874 19.8716C4.46921 20.0538 4.37598 20.2954 4.37598 20.5412V27.5086C4.37598 27.7587 4.46921 27.996 4.63874 28.1783L9.19469 33.0563C9.38116 33.2555 9.63969 33.3699 9.91516 33.3699H52.6902C52.9615 33.3657 53.2242 33.2513 53.4107 33.0521C53.4107 33.0521 46.5535 25.3133 46.011 25.3133L46.0067 25.3175ZM35.4793 24.3301C35.4793 24.8725 35.0386 25.3133 34.4961 25.3133H13.4116C13.1403 25.3133 12.8776 25.1989 12.6911 24.9997C12.5216 24.8174 12.4284 24.5759 12.4284 24.3301V23.7198C12.4284 23.4697 12.5216 23.2324 12.6953 23.0502C12.8818 22.851 13.1403 22.7365 13.4158 22.7365H34.4791C34.7419 22.7365 34.9919 22.8383 35.1742 23.0247L35.1954 23.0459C35.3819 23.2324 35.4836 23.4824 35.4836 23.741V24.3301H35.4793Z';

// Round dotted stroke that visually matches medium-weight typography.
const STROKE = 2;
const DASH = '0.1 5';
const HTML_NS = 'http://www.w3.org/1999/xhtml';

// ============================================================================
// Card shell — chooses the right wrapper element based on `feature` props.
// Extracted so future interactivity hooks live in a single place.
// ============================================================================

function FeatureCardShell({
  feature,
  children,
}: {
  feature: Feature;
  children: React.ReactNode;
}) {
  const interactiveClasses =
    'transition-colors hover:bg-fd-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2 focus-visible:ring-offset-fd-background rounded-md';

  if (feature.href) {
    return (
      <Link
        href={feature.href}
        className={`inline-flex w-full flex-col no-underline ${interactiveClasses}`}
      >
        {children}
      </Link>
    );
  }
  if (feature.onClick) {
    return (
      <button
        type="button"
        onClick={feature.onClick}
        className={`inline-flex w-full flex-col bg-transparent p-0 text-left ${interactiveClasses}`}
      >
        {children}
      </button>
    );
  }
  return <div className="inline-flex w-full flex-col">{children}</div>;
}

// ============================================================================
// Component
// ============================================================================

export function FeaturesInfographicV2({
  features = DEFAULT_FEATURES,
  platforms = DEFAULT_PLATFORMS,
  className,
}: FeaturesInfographicV2Props = {}) {
  return (
    <div className={`not-prose mt-2 mb-8 ${className ?? ''}`}>
      <div className="text-fd-primary">
        <svg
          className="mx-auto block h-auto w-full max-w-[1280px]"
          viewBox={`0 ${VIEWBOX_TOP} ${VIEW_W} ${VIEWBOX_HEIGHT}`}
          fill="none"
          stroke="currentColor"
          strokeLinecap="round"
          role="img"
          aria-labelledby="features-infographic-v2-title"
        >
          <title id="features-infographic-v2-title">
            QVAC features and platforms overview
          </title>

          {/* ----- Geometry: rings ----- */}
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={R_INNER}
            strokeWidth={STROKE}
            strokeDasharray={DASH}
          />
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={R_PLATFORMS}
            strokeWidth={STROKE}
            strokeDasharray={DASH}
          />
          <circle
            cx={CENTER_X}
            cy={CENTER_Y}
            r={R_OUTER}
            strokeWidth={STROKE}
            strokeDasharray={DASH}
          />

          {/* ----- Inner spokes: inner ring → middle ring (passes through icon) ----- */}
          {platforms.map((p) => {
            const a = polar(p.angle, R_INNER);
            const b = polar(p.angle, R_PLATFORMS);
            return (
              <line
                key={`spoke-in-${p.id}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                strokeWidth={STROKE}
                strokeDasharray={DASH}
              />
            );
          })}

          {/* ----- Outer spokes: middle ring → outer ring bullet ----- */}
          {features.map((f) => {
            const a = polar(f.angle, R_PLATFORMS);
            const b = polar(f.angle, R_OUTER);
            return (
              <line
                key={`spoke-out-${f.id}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                strokeWidth={STROKE}
                strokeDasharray={DASH}
              />
            );
          })}

          {/* ----- Solid bullets on the outer ring (one per feature) ----- */}
          {features.map((f) => {
            const dot = polar(f.angle, R_OUTER);
            return (
              <circle
                key={`bullet-${f.id}`}
                cx={dot.x}
                cy={dot.y}
                r={5}
                fill="currentColor"
                stroke="none"
              />
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
          {platforms.map((p) => {
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
                  aria-label={p.label}
                >
                  <p.Icon size={48} className="text-fd-primary" />
                </div>
              </foreignObject>
            );
          })}

          {/* ----- Feature cards (foreignObject so they scale) ----- */}
          {features.map((f) => {
            const layout = getFeatureCardLayout(f);
            return (
              <foreignObject
                key={f.id}
                x={layout.x}
                y={layout.y}
                width={layout.width}
                height={layout.height}
              >
                <div {...{ xmlns: HTML_NS }} className="w-full overflow-visible">
                  <FeatureCardShell feature={f}>
                    <p
                      className={`m-0 mb-2 text-[22px] font-medium leading-tight text-fd-primary ${TITLE_ALIGN_CLASS[layout.titleAlign]}`}
                    >
                      {f.name}
                    </p>
                    <div className="rounded-md border border-fd-primary/40 bg-fd-background p-4">
                      <p className="m-0 text-left text-[18px] leading-snug text-fd-foreground">
                        {f.description}
                      </p>
                    </div>
                  </FeatureCardShell>
                </div>
              </foreignObject>
            );
          })}
        </svg>
      </div>
    </div>
  );
}
