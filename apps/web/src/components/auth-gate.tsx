'use client';
import { type ReactNode, useEffect } from 'react';
import { signOut, useAuthState, useMe } from '@/lib/auth';
import { ApiError } from '@/lib/errors';
import { nextStep } from '@/lib/gate';
import { restoreSelection } from '@/lib/sessions';
import { Onboarding } from './onboarding';
import { SignIn } from './sign-in';

const Splash = ({ text }: { text: string }) => (
  <main className="grid min-h-dvh place-items-center text-muted" aria-busy="true">
    {text}
  </main>
);

/** Route protection: signed out sees sign-in, an open account gate sees onboarding, everyone else the app. */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuthState();
  const me = useMe(auth === 'in');
  useEffect(() => restoreSelection(), []);

  if (auth === 'loading') return <Splash text="Loading…" />;
  if (auth === 'out') return <SignIn />;
  if (me.isPending) return <Splash text="Loading your account…" />;
  if (me.isError) {
    const e = me.error;
    return (
      <main className="grid min-h-dvh place-items-center p-4">
        <div className="max-w-sm rounded-card border border-line bg-s1 p-6 text-center">
          <p role="alert">{e instanceof ApiError ? e.message : 'Could not load your account.'}</p>
          <div className="mt-4 flex justify-center gap-3">
            <button
              type="button"
              onClick={() => me.refetch()}
              className="rounded-ctl bg-accent px-3 py-2 text-white"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => signOut()}
              className="rounded-ctl border border-line px-3 py-2"
            >
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
