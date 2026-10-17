'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { TURNSTILE_SITE_KEY } from '@/lib/env';

interface TurnstileApi {
  render: (el: HTMLElement, o: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
export interface TurnstileHandle {
  reset: () => void;
}

/** Renders nothing when no site key is configured; the API then skips the check only outside production. */
export const Turnstile = forwardRef<TurnstileHandle, { onToken: (t: string | null) => void }>(
  function Turnstile({ onToken }, ref) {
    const box = useRef<HTMLDivElement>(null);
    const id = useRef<string | undefined>(undefined);
    useImperativeHandle(ref, () => ({
      reset: () => {
        onToken(null);
        window.turnstile?.reset(id.current);
      },
    }));
    useEffect(() => {
      if (!TURNSTILE_SITE_KEY || !box.current) return;
      const el = box.current;
      const mount = () => {
        if (!window.turnstile || id.current) return;
        id.current = window.turnstile.render(el, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (t: string) => onToken(t),
          'expired-callback': () => onToken(null),
          'error-callback': () => onToken(null),
        });
      };
      if (window.turnstile) mount();
      else {
        let s = document.querySelector<HTMLScriptElement>('script[data-turnstile]');
        if (!s) {
          s = document.createElement('script');
          s.src = SRC;
          s.async = true;
          s.dataset.turnstile = '1';
          document.head.appendChild(s);
        }
        s.addEventListener('load', mount);
      }
      return () => {
        if (id.current) window.turnstile?.remove(id.current);
        id.current = undefined;
      };
    }, [onToken]);
    if (!TURNSTILE_SITE_KEY) return null;
    return <div ref={box} />;
  },
);
