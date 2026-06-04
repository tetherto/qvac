'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from 'next-themes';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, Download, X } from 'lucide-react';
import { KeetIcon } from '@/components/keet-icon';

// Copy is kept verbatim from the main site (https://qvac.tether.io) modal.
// `title` is only used for the dialog's accessible label — the modal renders
// no heading/description, it is purely a container for the two cards.
const KEET = {
  title: 'Join QVAC Keet Room!',
  card1: {
    step: 'Step 1',
    title: 'Download Keet App!',
    subtext:
      'In order to have access to our Room, you need to download Keet app before',
    downloadLink: 'https://keet.io/download/',
  },
  card2: {
    step: 'Step 2',
    title: 'Join QVAC Keet Room!',
    subtext: 'Scan the Invite QR Code. Or copy link into your Keet app',
    roomLink:
      'pear://keet/nfo61f4e6zc5t1ifncyh9yp7s5eynbruz5bs95oc5ufn3e79entmhix74miigc8iz9iawfrb7pzk3am8eotxw8wat7554etbn7d6j4ho84b1zqnb63z7hxq1ubt5w4wi4kpq3mdgpijcnaifnhm7sy4cfxqqoyedpnb5qg1majcggy4s9s91fgtg3khgw',
  },
} as const;

// Card 1 carries the Keet logo artwork, so it stays a dark branded card in
// both themes; its accent is the bright brand teal.
const TEAL = '#16E3C1';
const DARK = '#171817';

/**
 * The colorful Keet bird mascot (the app logo). It is inlined as an SVG element
 * — rather than referenced from /public via a CSS background or <img> — so it
 * can never fail to render: a separate asset fetch can be cached as a failure
 * (e.g. if the dev server restarts mid-session), which would leave it blank.
 * The viewBox is tightened to the bird's bounds so it sits as a centered logo
 * (no surrounding concentric-ring artwork).
 */
function KeetMascot({ className }: { className?: string }) {
  return (
    <svg
      viewBox="78 152 95 104"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <path fillRule="evenodd" clipRule="evenodd" d="M85.4537 156.147C85.3243 156.192 85.3311 156.628 85.3463 157.589C85.3527 157.988 85.3604 158.478 85.3604 159.068C85.3604 169.316 93.6582 171.4 93.6582 171.4C93.6582 171.4 85.3604 170.582 85.3604 172.79C85.3604 174.998 92.6122 177.827 92.6122 177.827C92.6122 177.827 80.2346 179.788 80.2346 181.996C80.2346 182.695 81.0736 182.839 82.5859 183.097C84.5219 183.428 87.5613 183.948 91.3568 186.064C86.1235 193.121 83.0304 201.844 83.0304 211.286C83.0304 234.775 102.174 253.817 125.788 253.817C134.29 253.817 142.213 251.348 148.871 247.093C148.357 246.384 148.167 245.421 148.53 244.459C150.515 239.201 151.336 235.367 151.123 232.031C150.912 228.738 149.681 225.773 147.237 222.272C145.893 220.346 144.549 218.867 143.264 217.545C142.926 217.197 142.583 216.853 142.243 216.51L142.242 216.509C141.319 215.58 140.407 214.662 139.61 213.714C138.482 212.374 137.508 210.894 136.826 208.993C136.148 207.1 135.784 204.86 135.784 202.021C135.784 194.31 140.98 188.126 147.299 185.546C151.234 183.94 155.695 183.7 159.694 185.371C151.877 175.267 139.597 168.755 125.788 168.755C125.31 168.755 124.834 168.763 124.36 168.779C96.1557 168.35 88.2874 159.259 86.1319 156.769C85.7629 156.343 85.5613 156.11 85.4537 156.147ZM119.827 204.778C118.72 204.389 117.528 204.177 116.286 204.177C115.191 204.177 114.135 204.342 113.141 204.647C112.388 204.879 112.011 204.995 111.722 204.94C111.471 204.892 111.235 204.76 111.064 204.57C110.867 204.352 110.802 204.087 110.67 203.557C110.469 202.75 110.361 201.887 110.361 200.991C110.361 196.468 113.125 192.802 116.535 192.802C119.946 192.802 122.71 196.468 122.71 200.991C122.71 201.964 122.582 202.897 122.348 203.762C122.204 204.294 122.132 204.56 121.927 204.775C121.749 204.962 121.505 205.089 121.25 205.129C120.956 205.175 120.58 205.042 119.827 204.778Z" fill="url(#keet-g6)" />
      <path d="M148.432 221.447C142.805 213.387 137.238 212.887 137.238 202.021C137.238 187.96 156.225 179.174 165.181 191.65C169.026 197.006 170.318 205.27 170.318 211.734C170.318 226.168 162.982 238.908 151.785 246.543C150.717 247.271 149.437 246.172 149.892 244.968C153.913 234.311 153.509 228.721 148.432 221.447Z" fill="url(#keet-r)" />
      <defs>
        <linearGradient id="keet-g6" x1="171.5" y1="155.723" x2="81.0365" y2="253.872" gradientUnits="userSpaceOnUse">
          <stop stopColor="#00FFCF" />
          <stop offset="1" stopColor="#4AA6FF" />
        </linearGradient>
        <radialGradient id="keet-r" cx="0" cy="0" r="1" gradientTransform="matrix(40.0869 -9.40855 12.4074 52.305 137.268 220.688)" gradientUnits="userSpaceOnUse">
          <stop stopColor="#F27C34" />
          <stop offset="1" stopColor="#A55282" />
        </radialGradient>
      </defs>
    </svg>
  );
}

function KeetModalContent({ onClose }: { onClose: () => void }) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme !== 'light';
  const [isCopied, setIsCopied] = useState(false);

  const handleCopyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(KEET.card2.roomLink);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy Keet room link:', err);
    }
  }, []);

  // Theme-aware palette for the container and the (themed) second card.
  // Light mode mirrors the dark treatment: a bottom-left teal "glow" radial
  // and a surrounding teal aura, tuned softer so it reads well on white.
  const containerBg = isDark
    ? 'radial-gradient(80% 80% at 10% 140%, #16E3C1, #171817)'
    : 'radial-gradient(80% 80% at 10% 140%, #16E3C1, #ffffff 70%)';
  const containerShadow = isDark
    ? '0 0 10px 0 #16E3C1'
    : '0 0 18px 0 rgba(22, 227, 193, 0.55), 0 10px 40px 0 rgba(0, 0, 0, 0.15)';
  // Both cards share the same solid, theme-aware treatment.
  const accent = isDark ? TEAL : '#00AF92';
  const cardBg = isDark ? DARK : '#ffffff';
  const cardShadow = isDark
    ? '0 0 10px 0 #16E3C1'
    : '0 0 0 1px rgba(0, 175, 146, 0.25)';
  const fg = isDark ? '#ffffff' : DARK;
  const closeColor = fg;

  return (
    <div
      className="fixed inset-0 z-[999] overflow-y-auto bg-black/60 backdrop-blur-[12px]"
      onClick={onClose}
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={KEET.title}
          onClick={(e) => e.stopPropagation()}
          className="relative flex w-full max-w-[600px] flex-col items-center rounded-[16px] px-6 py-[40px] sm:px-[40px]"
          style={{
            background: containerBg,
            boxShadow: containerShadow,
            fontFamily: 'var(--font-inconsolata)',
          }}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex size-9 items-center justify-center rounded-full transition-opacity hover:opacity-70"
            style={{ color: closeColor }}
          >
            <X className="size-6" />
          </button>

          <div className="flex w-full flex-col items-stretch justify-center gap-4 sm:flex-row">
            {/* Step 1 — download the Keet app */}
            <div
              className="flex min-h-[340px] w-full flex-col items-center justify-between gap-2 rounded-[16px] p-4 text-center sm:w-[240px]"
              style={{ background: cardBg, boxShadow: cardShadow }}
            >
              <div className="flex flex-col items-center gap-2">
                <h3
                  className="text-[26px] font-bold leading-[33px]"
                  style={{ color: accent }}
                >
                  {KEET.card1.step}
                </h3>
                <h4
                  className="text-[19px] font-bold leading-[22px]"
                  style={{ color: fg }}
                >
                  {KEET.card1.title}
                </h4>
                <p
                  className="text-[15px] font-medium leading-[18px]"
                  style={{ color: accent }}
                >
                  {KEET.card1.subtext}
                </p>
              </div>
              <KeetMascot className="my-1 size-[88px]" />
              <div className="flex w-full flex-col items-center gap-2">
                <a
                  href={KEET.card1.downloadLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex w-[180px] max-w-full items-center justify-center gap-2 rounded-[8px] border px-4 py-[6px] text-[15px] leading-[22px] no-underline transition-opacity hover:opacity-70 hover:no-underline"
                  style={{ borderColor: fg, color: fg }}
                >
                  <Download className="size-[15px]" />
                  Download
                </a>
              </div>
            </div>

            {/* Step 2 — join the room. The QR is always black on white. */}
            <div
              className="flex min-h-[340px] w-full flex-col items-center gap-2 rounded-[16px] p-4 text-center sm:w-[240px]"
              style={{ background: cardBg, boxShadow: cardShadow }}
            >
              <h3
                className="text-[26px] font-bold leading-[33px]"
                style={{ color: accent }}
              >
                {KEET.card2.step}
              </h3>
              <h4
                className="text-[19px] font-bold leading-[22px]"
                style={{ color: fg }}
              >
                {KEET.card2.title}
              </h4>
              <p className="text-[15px] leading-[18px]" style={{ color: accent }}>
                {KEET.card2.subtext}
              </p>
              <div className="relative rounded-[8px] bg-white p-2">
                <QRCodeSVG
                  value={KEET.card2.roomLink}
                  size={112}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  level="M"
                />
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <span
                    className="flex items-center justify-center rounded-[4px] bg-white"
                    style={{ width: 30, height: 30, color: TEAL }}
                  >
                    <KeetIcon className="size-[22px]" />
                  </span>
                </span>
              </div>
              <div className="mt-1 flex w-[85%] items-center justify-between gap-2">
                <p
                  className="truncate text-[9px] leading-[14px]"
                  style={{ color: accent }}
                  title={KEET.card2.roomLink}
                >
                  {KEET.card2.roomLink}
                </p>
                <button
                  type="button"
                  onClick={handleCopyLink}
                  aria-label="Copy room link"
                  className="flex size-5 shrink-0 items-center justify-center transition-opacity hover:opacity-70"
                  style={{ color: accent }}
                >
                  {isCopied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Mounts the Keet community modal and opens it when the user activates the
 * Keet entry in the navbar / mobile sidebar. Fumadocs' notebook layout only
 * places `type: 'icon'` items in the icon cluster (next to Discord), and it
 * renders them as plain anchors that can't carry an onClick. So the layout
 * registers Keet as an icon link with a placeholder hash href and
 * `aria-label="Keet"`, and this component intercepts clicks on that anchor
 * (capture phase) to open the modal instead of navigating.
 */
export default function KeetRoomModalMount() {
  const [open, setOpen] = useState(false);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      const target = event.target as Element | null;
      const anchor = target?.closest?.('a[aria-label="Keet"]');
      if (!anchor) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setOpen(true);
    }

    document.addEventListener('click', onDocumentClick, true);
    return () => document.removeEventListener('click', onDocumentClick, true);
  }, []);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    document.addEventListener('keydown', onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, close]);

  if (!open || typeof document === 'undefined') return null;
  return createPortal(<KeetModalContent onClose={close} />, document.body);
}
