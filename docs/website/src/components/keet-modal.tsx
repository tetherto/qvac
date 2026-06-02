'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTheme } from 'next-themes';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, X } from 'lucide-react';

// Copy is kept verbatim from the main site (https://qvac.tether.io) modal.
// `title` is only used for the dialog's accessible label — the modal itself
// renders no heading/description, it is purely a container for the two cards.
const KEET = {
  title: 'Join our Keet Room!',
  card1: {
    step: 'Step 1',
    title: 'Download Keet App!',
    subtext:
      'Keet is a P2P, private and unstoppable chat app. You need to download it first',
    downloadText: 'Download',
    downloadLink: 'https://keet.io/download/',
  },
  card2: {
    step: 'Step 2',
    title: 'Join the Community!',
    subtext: 'Scan the Invite QR Code',
    copyText: 'or copy/paste this link into your Keet app',
    roomLink:
      'pear://keet/nfo61f4e6zc5t1ifncyh9yp7s5eynbruz5bs95oc5ufn3e79entmhix74miigc8iz9iawfrb7pzk3am8eotxw8wat7554etbn7d6j4ho84b1zqnb63z7hxq1ubt5w4wi4kpq3mdgpijcnaifnhm7sy4cfxqqoyedpnb5qg1majcggy4s9s91fgtg3khgw',
  },
} as const;

// Card 1 carries the Keet logo artwork, so it stays a dark branded card in
// both themes; its accent is the bright brand teal.
const TEAL = '#16E3C1';
const DARK = '#171817';

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
  const containerBg = isDark
    ? 'radial-gradient(80% 80% at 10% 140%, #16E3C1, #171817)'
    : 'linear-gradient(140deg, #ffffff 40%, #ecf1ee 100%)';
  const containerShadow = isDark
    ? '0 0 10px 0 #16E3C1'
    : '0 10px 40px 0 rgba(0, 0, 0, 0.15)';
  const accent = isDark ? TEAL : '#00AF92';
  const card2Bg = isDark ? DARK : '#ffffff';
  const card2Shadow = isDark
    ? '0 0 10px 0 #16E3C1'
    : '0 0 0 1px rgba(0, 175, 146, 0.25)';
  const card2TitleColor = isDark ? '#ffffff' : DARK;
  const closeColor = isDark ? '#ffffff' : DARK;

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
          style={{ background: containerBg, boxShadow: containerShadow }}
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
            {/* Step 1 — download the Keet app (dark branded card with the Keet logo) */}
            <div
              className="flex min-h-[300px] flex-1 flex-col justify-between rounded-[16px] bg-cover bg-center p-4 text-center sm:max-w-[240px]"
              style={{
                backgroundImage: 'url(/keet.svg)',
                backgroundColor: DARK,
                boxShadow: '0 0 10px 0 #16E3C1',
              }}
            >
              <div className="flex flex-col items-center gap-2">
                <h3
                  className="text-[26px] font-bold leading-[33px]"
                  style={{ color: TEAL }}
                >
                  {KEET.card1.step}
                </h3>
                <h4 className="text-[19px] font-bold leading-[22px] text-white">
                  {KEET.card1.title}
                </h4>
                <p
                  className="text-[15px] font-medium leading-[18px]"
                  style={{ color: TEAL }}
                >
                  {KEET.card1.subtext}
                </p>
              </div>
              <div className="mt-3 flex w-full justify-center">
                <a
                  href={KEET.card1.downloadLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-[20px] border px-5 py-[5px] text-[18px] leading-[26px] no-underline transition-opacity hover:opacity-70 hover:no-underline"
                  style={{ borderColor: TEAL, color: TEAL, background: DARK }}
                >
                  {KEET.card1.downloadText}
                </a>
              </div>
            </div>

            {/* Step 2 — join the room. The QR is always black on white. */}
            <div
              className="flex min-h-[300px] flex-1 flex-col items-center gap-2 rounded-[16px] p-4 text-center sm:max-w-[240px]"
              style={{ background: card2Bg, boxShadow: card2Shadow }}
            >
              <h3
                className="text-[26px] font-bold leading-[33px]"
                style={{ color: accent }}
              >
                {KEET.card2.step}
              </h3>
              <h4
                className="text-[19px] font-bold leading-[22px]"
                style={{ color: card2TitleColor }}
              >
                {KEET.card2.title}
              </h4>
              <p className="text-[15px] leading-[17px]" style={{ color: accent }}>
                {KEET.card2.subtext}
              </p>
              <div className="rounded-[8px] bg-white p-2">
                <QRCodeSVG
                  value={KEET.card2.roomLink}
                  size={112}
                  bgColor="#ffffff"
                  fgColor="#000000"
                  imageSettings={{
                    src: '/keet-logo.svg',
                    height: 28,
                    width: 28,
                    excavate: true,
                  }}
                />
              </div>
              <p className="text-[14px] leading-[16px]" style={{ color: accent }}>
                {KEET.card2.copyText}
              </p>
              <div className="flex w-[85%] items-center justify-between gap-2">
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
