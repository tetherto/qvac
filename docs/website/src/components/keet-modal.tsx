'use client';

import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { QRCodeSVG } from 'qrcode.react';
import { Check, Copy, X } from 'lucide-react';

// QVAC brand tokens, inlined so the modal looks identical to the main
// site (https://qvac.tether.io) regardless of the docs light/dark theme.
const AQUA = '#16E3C1';
const DARK = '#171817';
const CARD_GRADIENT = 'linear-gradient(-10deg, #16e3c1 0%, #171717 20%)';
const GLOW = '0 0 10px 0 #16e3c1';

const KEET = {
  title: 'Join our Keet Room!',
  subtitle: 'In order to get there, please follow the steps below',
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
      'pear://keet/nfo35rbknsh35m184tmww7s4ssjh1hftiysx8yqreyi5njwsknuxs47nwhsbzt6wijoxfzmi6a8fh7b49gun3qxea3mumixnti8spizeysthyxdm968t6zof93yqpgyygb39rmoobki7fo7rh5hod71map4gayedt3qiwhkjakycqnfa5kswn58mtt8qg',
  },
} as const;

function KeetModalContent({ onClose }: { onClose: () => void }) {
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

  return (
    <div
      className="fixed inset-0 z-[999] overflow-y-auto bg-black/70 backdrop-blur-[12px]"
      onClick={onClose}
    >
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          role="dialog"
          aria-modal="true"
          aria-label={KEET.title}
          onClick={(e) => e.stopPropagation()}
          className="relative flex w-full max-w-[600px] flex-col items-center gap-6 rounded-[16px] px-6 py-10 text-center sm:px-[50px]"
          style={{ background: CARD_GRADIENT, boxShadow: GLOW }}
        >
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 flex size-9 items-center justify-center rounded-full text-white transition-opacity hover:opacity-70"
          >
            <X className="size-6" />
          </button>

          <div className="flex flex-col items-center gap-2">
            <h2 className="text-[30px] font-bold leading-[33px] text-white">
              {KEET.title}
            </h2>
            <p
              className="text-[18px] font-normal leading-[22px] sm:text-[24px] sm:leading-[30px]"
              style={{ color: AQUA }}
            >
              {KEET.subtitle}
            </p>
          </div>

          <div className="flex w-full flex-col items-stretch justify-center gap-4 sm:flex-row">
            {/* Step 1 — download the Keet app */}
            <div
              className="flex min-h-[290px] flex-1 flex-col justify-between rounded-[16px] p-4 text-center sm:max-w-[240px]"
              style={{ background: DARK, boxShadow: GLOW }}
            >
              <div className="flex flex-col items-center gap-2">
                <h3
                  className="text-[26px] font-bold leading-[33px]"
                  style={{ color: AQUA }}
                >
                  {KEET.card1.step}
                </h3>
                <h4 className="text-[19px] font-bold leading-[22px] text-white">
                  {KEET.card1.title}
                </h4>
                <p
                  className="text-[15px] leading-[17px]"
                  style={{ color: AQUA }}
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
                  style={{ borderColor: AQUA, color: AQUA, background: DARK }}
                >
                  {KEET.card1.downloadText}
                </a>
              </div>
            </div>

            {/* Step 2 — join the room (scan QR or copy link) */}
            <div
              className="flex min-h-[290px] flex-1 flex-col items-center gap-2 rounded-[16px] p-4 text-center sm:max-w-[240px]"
              style={{ background: DARK, boxShadow: GLOW }}
            >
              <h3
                className="text-[26px] font-bold leading-[33px]"
                style={{ color: AQUA }}
              >
                {KEET.card2.step}
              </h3>
              <h4 className="text-[19px] font-bold leading-[22px] text-white">
                {KEET.card2.title}
              </h4>
              <p className="text-[15px] leading-[17px]" style={{ color: AQUA }}>
                {KEET.card2.subtext}
              </p>
              <QRCodeSVG
                value={KEET.card2.roomLink}
                size={120}
                bgColor={DARK}
                fgColor={AQUA}
              />
              <p className="text-[14px] leading-[16px]" style={{ color: AQUA }}>
                {KEET.card2.copyText}
              </p>
              <div className="flex w-[85%] items-center justify-between gap-2">
                <p
                  className="truncate text-[9px] leading-[14px]"
                  style={{ color: AQUA }}
                  title={KEET.card2.roomLink}
                >
                  {KEET.card2.roomLink}
                </p>
                <button
                  type="button"
                  onClick={handleCopyLink}
                  aria-label="Copy room link"
                  className="flex size-5 shrink-0 items-center justify-center transition-opacity hover:opacity-70"
                  style={{ color: AQUA }}
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
