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

export type FeaturesInfographicProps = {
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
    id: 'complete-suite',
    name: 'Complete AI suite',
    description:
      'Use one SDK for LLMs, fine-tuning, diffusion, speech, RAG, and more.',
    angle: 0,
    href: '#ai-capabilities',
  },
  {
    id: 'local-first',
    name: 'Local-first',
    description:
      'Run AI models locally, without relying on third-party APIs, SaaS, or cloud infrastructure.',
    angle: 315,
    href: '/quickstart',
  },
  {
    id: 'p2p',
    name: 'Peer-to-peer',
    description:
      'Delegate inference to peers and build AI systems that work across P2P networks.',
    angle: 45,
    href: '/p2p-capabilities/delegated-inference',
  },
  {
    id: 'cross-platform',
    name: 'Cross-platform',
    description:
      'Consistent developer experience across hardware, operating systems, and JavaScript runtimes — write code once, run it everywhere.',
    angle: 90,
    href: '/installation#supported-environments',
  },
  {
    id: 'pluggable',
    name: 'Pluggable',
    description:
      'Include only the capabilities your app needs, and extend the SDK with custom plugins.',
    angle: 135,
    href: '/configuration/plugins',
  },
  {
    id: 'open-source',
    name: 'Open source',
    description:
      '100% free to use and modify, released under Apache 2.0 license.',
    angle: 180,
    href: 'https://github.com/tetherto/qvac',
  },
  {
    id: 'openai',
    name: 'OpenAI-compatible',
    description:
      'Launch an HTTP server that exposes an OpenAI-compatible API for integration with the broader AI ecosystem.',
    angle: 225,
    href: '/cli/http-server',
  },
  {
    id: 'unified',
    name: 'Unified JS/TS interface',
    description:
      'Use one typed JavaScript SDK to run multiple AI capabilities from a single npm package.',
    angle: 270,
    href: '/introduction',
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

// Vertical crop applied to the viewBox. The top "Complete AI suite" card sits
// ABOVE the outer ring (its foreignObject extends from y=-10 upward), so the
// viewBox starts at y=-20 to give the card ~10px of breathing room. Geometry
// stays anchored to CENTER_Y; only the visible window is shifted.
const VIEWBOX_TOP = -20;
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
  // N bullet ~ (640, 150); card sits ABOVE the bullet. Title at the top of
  // the card (natural reading order); the description box sits just above
  // the bullet.
  'complete-suite': {
    x: 490,
    y: -10,
    width: 300,
    height: 150,
    titleAlign: 'center',
  },
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
// Sparkles around the Q (continuous, discreet twinkle).
// ============================================================================

// 4-pointer star, ~20×20 viewBox units, centered on (0,0). Curves give a soft
// "scintillation" silhouette instead of a hard star.
const SPARKLE_PATH =
  'M0 -10 C 0 -3, 3 0, 10 0 C 3 0, 0 3, 0 10 C 0 3, -3 0, -10 0 C -3 0, 0 -3, 0 -10 Z';

type Sparkle = {
  id: string;
  /** Compass angle in degrees: 0 = top, increases clockwise. */
  angle: number;
  /** Distance from center, in viewBox units. Stays inside R_INNER vicinity. */
  radius: number;
  /** Final scale multiplier applied to the 20×20 sparkle path. */
  scale: number;
  /** Per-sparkle animation duration (ms). Distinct values prevent sync. */
  duration: number;
  /** Per-sparkle initial delay (ms). Spreads the entry across ~2.2s. */
  delay: number;
};

// Sparkles are organised as 8 RAYS, one per platform direction (matching
// DEFAULT_PLATFORMS angles). Each ray fires TWO sparkles per tier (inner
// and outer), slightly offset in angle, radius and timing — so each tier
// reads as a small twin-burst rather than a lone particle. With 8 rays ×
// 4 sparkles = 32 sparkles total, the effect is denser than the previous
// 16-particle version while still kept discreet by the 70%-rest keyframe.
//
// For each ray:
//   - inner-A fires at baseDelay (slightly above the ray's central angle)
//   - inner-B fires at baseDelay + INTRA_DELAY (slightly below)
//   - outer-A fires at baseDelay + INNER_OUT_DELAY (above-of-centre, but
//     with a smaller angular spread because at a larger radius the same
//     spread would visually drift further apart)
//   - outer-B fires at baseDelay + INNER_OUT_DELAY + INTRA_DELAY (below-of-
//     centre)
//
// The outer band stops at r=140 to stay clear of each platform icon's
// foreignObject box (PLATFORM_BOX=80 centred on R_PLATFORMS=180 spans
// r=140 → r=220 on its ray).
const INNER_OUT_DELAY = 750; // ms — outer pair follows the inner pair
const INTRA_DELAY = 220;     // ms — A → B within a tier
const ANGLE_SPREAD = 8;      // deg — angular fan within a tier (inner)
const RADIUS_SPREAD = 6;     // viewBox units — radial scatter within a tier

type SparkleRayConfig = {
  id: string;
  /** Compass angle in degrees: 0 = top, increases clockwise. */
  angle: number;
  /** Mean radius for the inner pair (around the Q, inside R_INNER=95). */
  innerRadius: number;
  /** Mean radius for the outer pair (between rings, ≤140 to clear icons). */
  outerRadius: number;
  /** Peak scale for the inner pair (B sibling is rendered ~80% as large). */
  innerScale: number;
  /** Peak scale for the outer pair. */
  outerScale: number;
  /** Cycle duration in ms (shared by all 4 sparkles in this ray). */
  duration: number;
  /** When this ray's inner-A starts; the others key off this value. */
  baseDelay: number;
};

const SPARKLE_RAYS: SparkleRayConfig[] = [
  { id: 'n',  angle: 0,   innerRadius: 70, outerRadius: 130, innerScale: 0.85, outerScale: 0.6,  duration: 4400, baseDelay: 0    },
  { id: 'ne', angle: 45,  innerRadius: 75, outerRadius: 125, innerScale: 0.7,  outerScale: 0.55, duration: 4500, baseDelay: 550  },
  { id: 'e',  angle: 90,  innerRadius: 65, outerRadius: 130, innerScale: 0.95, outerScale: 0.7,  duration: 4200, baseDelay: 1100 },
  { id: 'se', angle: 135, innerRadius: 80, outerRadius: 125, innerScale: 0.6,  outerScale: 0.5,  duration: 4600, baseDelay: 1650 },
  { id: 's',  angle: 180, innerRadius: 70, outerRadius: 130, innerScale: 0.85, outerScale: 0.65, duration: 4300, baseDelay: 2200 },
  { id: 'sw', angle: 225, innerRadius: 75, outerRadius: 125, innerScale: 0.65, outerScale: 0.55, duration: 4500, baseDelay: 2750 },
  { id: 'w',  angle: 270, innerRadius: 65, outerRadius: 130, innerScale: 0.8,  outerScale: 0.65, duration: 4200, baseDelay: 3300 },
  { id: 'nw', angle: 315, innerRadius: 75, outerRadius: 125, innerScale: 0.7,  outerScale: 0.5,  duration: 4500, baseDelay: 3850 },
];

// Outer pairs use a smaller angular fan (×0.7) so the visual spread along
// the ray stays roughly constant once the angular gap is multiplied by the
// larger radius. Sibling B is ~80% the scale of sibling A in each tier,
// adding a subtle "echo" feel without registering as a distinct second hit.
function expandRay(ray: SparkleRayConfig): Sparkle[] {
  const outerAngleSpread = ANGLE_SPREAD * 0.7;
  return [
    {
      id: `inner-${ray.id}-a`,
      angle: ray.angle - ANGLE_SPREAD,
      radius: ray.innerRadius - RADIUS_SPREAD / 2,
      scale: ray.innerScale,
      duration: ray.duration,
      delay: ray.baseDelay,
    },
    {
      id: `inner-${ray.id}-b`,
      angle: ray.angle + ANGLE_SPREAD,
      radius: ray.innerRadius + RADIUS_SPREAD / 2,
      scale: ray.innerScale * 0.8,
      duration: ray.duration,
      delay: ray.baseDelay + INTRA_DELAY,
    },
    {
      id: `outer-${ray.id}-a`,
      angle: ray.angle - outerAngleSpread,
      radius: ray.outerRadius - RADIUS_SPREAD / 2,
      scale: ray.outerScale,
      duration: ray.duration,
      delay: ray.baseDelay + INNER_OUT_DELAY,
    },
    {
      id: `outer-${ray.id}-b`,
      angle: ray.angle + outerAngleSpread,
      radius: ray.outerRadius + RADIUS_SPREAD / 2,
      scale: ray.outerScale * 0.8,
      duration: ray.duration,
      delay: ray.baseDelay + INNER_OUT_DELAY + INTRA_DELAY,
    },
  ];
}

const SPARKLES: Sparkle[] = SPARKLE_RAYS.flatMap(expandRay);

// ============================================================================
// Card shell — chooses the right wrapper element based on `feature` props.
// Extracted so future interactivity hooks live in a single place.
// ============================================================================

// Anything starting with `http(s)://` is treated as off-site and rendered as
// a native <a target="_blank">, matching the behaviour of the sidebar link
// items that set `external: true`. Internal hrefs (including pure anchors
// like "#ai-capabilities") use next/link so client-side navigation and hash
// scrolling stay intact.
function isExternalHref(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function FeatureCardShell({
  feature,
  children,
}: {
  feature: Feature;
  children: React.ReactNode;
}) {
  // The `group` class lets hover state propagate from the whole wrapper
  // (which extends above the box to include the title) to the inner box, so
  // the border highlight + soft shadow on the box trigger even when the
  // cursor is over the title region. We intentionally don't apply a hover
  // background to the wrapper itself: with the title sitting OUTSIDE the
  // visible box, an accent-tinted pill behind the title looks disconnected
  // from the rest of the card.
  const interactiveClasses =
    'group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fd-ring focus-visible:ring-offset-2 focus-visible:ring-offset-fd-background rounded-md';
  const linkClasses = `inline-flex w-full flex-col no-underline ${interactiveClasses}`;

  if (feature.href) {
    if (isExternalHref(feature.href)) {
      return (
        <a
          href={feature.href}
          target="_blank"
          rel="noreferrer noopener"
          className={linkClasses}
        >
          {children}
        </a>
      );
    }
    return (
      <Link href={feature.href} className={linkClasses}>
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

export function FeaturesInfographic({
  features = DEFAULT_FEATURES,
  platforms = DEFAULT_PLATFORMS,
  className,
}: FeaturesInfographicProps = {}) {
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
          aria-label="QVAC features and platforms overview"
        >
          {/* The accessible name lives on the <svg aria-label> above rather
              than in a <title> child element, because browsers render <title>
              as a native hover tooltip and we don't want that here. Screen
              readers still announce the SVG correctly via aria-label. */}

          {/* ----- Sparkle twinkle styles (around the Q) -----
              Scoped via the .qvac-sparkle class. Each sparkle is hidden by
              default (opacity: 0) and only animates when the OS doesn't ask
              for reduced motion. The keyframe spends ~70% of every cycle in
              an invisible "rest" state, so at any given moment only 1-2 of
              the seven sparkles are actually visible — discreet, not festive.
          */}
          <style>{`
            .qvac-sparkle {
              transform-box: fill-box;
              transform-origin: center;
              opacity: 0;
            }
            @media (prefers-reduced-motion: no-preference) {
              .qvac-sparkle {
                animation-name: qvac-sparkle-twinkle;
                animation-iteration-count: infinite;
                animation-timing-function: ease-in-out;
              }
            }
            /* Note: each sparkle's peak scale comes from --sparkle-scale, set
               inline per element. Position is handled by the wrapper <g>'s
               SVG transform attribute, so this CSS transform only animates
               size + opacity around the sparkle's own center. */
            @keyframes qvac-sparkle-twinkle {
              0%   { transform: scale(0);                                  opacity: 0; }
              12%  { transform: scale(var(--sparkle-scale, 1));            opacity: 0.8; }
              28%  { transform: scale(calc(var(--sparkle-scale, 1) * 0.5)); opacity: 0; }
              100% { transform: scale(0);                                  opacity: 0; }
            }
          `}</style>

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

          {/* ----- Sparkles around the Q (pointer-events: none → never blocks clicks) -----
              Each sparkle is wrapped in a <g> whose SVG `transform` carries
              the position (CSS animations on SVG can't compose with the SVG
              `transform` attribute, so position MUST live on the wrapper).
              The inner <path> only animates scale + opacity via CSS, with
              per-sparkle peak size driven by the --sparkle-scale custom
              property set inline.
          */}
          <g pointerEvents="none" aria-hidden="true">
            {SPARKLES.map((s) => {
              const pos = polar(s.angle, s.radius);
              return (
                <g key={s.id} transform={`translate(${pos.x}, ${pos.y})`}>
                  <path
                    d={SPARKLE_PATH}
                    fill="currentColor"
                    stroke="none"
                    className="qvac-sparkle"
                    style={{
                      ['--sparkle-scale' as string]: s.scale,
                      animationDuration: `${s.duration}ms`,
                      animationDelay: `${s.delay}ms`,
                    } as React.CSSProperties}
                  />
                </g>
              );
            })}
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
                    {/* Hover effect lives on the box (the visible card shell): the
                        border picks up an inset ring of the primary color (≈2px
                        thick visual) and a subtle shadow. transition-shadow
                        animates both because Tailwind's `ring` and `shadow` are
                        implemented as box-shadows. `group-hover:` triggers
                        whenever the cursor is anywhere on the wrapper, which
                        includes the title above the box. */}
                    <div className="rounded-md border border-fd-primary/40 bg-fd-background p-4 transition-shadow group-hover:shadow-sm group-hover:ring-1 group-hover:ring-inset group-hover:ring-fd-primary">
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
