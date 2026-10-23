'use client';
import { type ReactNode, useEffect } from 'react';
import { signOut, useAuthState, useMe } from '../lib/auth';
import { ApiError } from '../lib/errors';
import { nextStep } from '../lib/gate';
import { restorePrefs } from '../lib/records';
import { restoreSelection } from '../lib/sessions';
import { Onboarding } from './onboarding';
import { SignIn } from './sign-in';

const Splash = ({ text }: { text: string }) => (
  <main className="grid min-h-dvh place-items-center text-muted" aria-busy="true">
    <div className="flex flex-col items-center gap-4">
      <span
        className="brand-bg grid size-12 animate-pulse place-items-center rounded-2xl text-xl font-bold text-white shadow-[0_12px_30px_-10px_rgb(79_91_255/0.9)]"
        aria-hidden
      >
        S
      </span>
      {text}
    </div>
  </main>
);

/** Route protection: signed out sees sign-in, an open account gate sees onboarding, everyone else the app. */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuthState();
  const me = useMe(auth === 'in');
  useEffect(() => {
    restoreSelection();
    restorePrefs();
  }, []);

  if (auth === 'loading') return <Splash text="Loading…" />;
  if (auth === 'out') return <SignIn />;
  if (me.isPending) return <Splash text="Loading your account…" />;
  if (me.isError) {
    const e = me.error;
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <div className="surface-card max-w-sm p-6 text-center">
          <p role="alert">{e instanceof ApiError ? e.message : 'Could not load your account.'}</p>
          <div className="mt-4 flex justify-center gap-3">
            <button type="button" onClick={() => me.refetch()} className="btn-primary px-4 py-2">
              Try again
            </button>
            <button type="button" onClick={() => signOut()} className="btn-ghost px-4 py-2">
              Sign out
            </button>
          </div>
        </div>
      </main>
    );
  }
  if (nextStep(me.data) !== 'DONE') return <Onboarding me={me.data} />;
  return <>{children}</>;
}
