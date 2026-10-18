'use client';
import { DELETE_CONFIRMATION } from '@smc/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { signOut, useMe } from '../lib/auth';
import { useChat } from '../lib/chat';
import { ApiError } from '../lib/errors';
import { usePrefs } from '../lib/records';
import { allowAutoStart, useEndSession, useSelection } from '../lib/sessions';
import { useTheme } from '../lib/theme';
import { DisclaimerText } from './disclaimer';
import { WalletList } from './wallet-list';

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-4 rounded-card border border-line bg-s2 p-4">
    <h2 className="mb-2 font-medium">{title}</h2>
    {children}
  </section>
);

function DeleteAccount() {
  const qc = useQueryClient();
  const [phrase, setPhrase] = useState('');
  const [stepUp, setStepUp] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ purgeAfter: string }>('/v1/me', {
        method: 'DELETE',
        body: { confirm: DELETE_CONFIRMATION },
      });
      try {
        sessionStorage.setItem(
          'smc-notice',
          `Deletion requested. Your data will be erased after ${new Date(r.purgeAfter).toLocaleString()}. Sign in again with your wallet before then to cancel.`,
        );
      } catch {}
      qc.clear();
      await signOut();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STEP_UP_REQUIRED') {
        setStepUp(true);
        setErr('For your safety, sign with your wallet again, then press Delete once more.');
      } else {
        setErr(e instanceof ApiError ? e.message : 'Could not request deletion.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section title="Delete my data">
      <p className="text-muted">
        Removes your account, wallet links, sessions, journal and trade records after a grace
        period. You can cancel by signing in again before it ends.
      </p>
      <label htmlFor="del" className="mt-3 block text-xs text-muted">
        Type {DELETE_CONFIRMATION} to confirm
      </label>
      <input
        id="del"
        value={phrase}
        onChange={(e) => setPhrase(e.target.value)}
        className="mt-1 w-full max-w-sm rounded-ctl border border-line bg-s3 px-2 py-1.5"
      />
      {stepUp && <WalletList onDone={() => setStepUp(false)} />}
      {err && (
        <p role="alert" className="mt-2 text-warn-text">
          {err}
        </p>
      )}
      <button
        type="button"
        disabled={phrase !== DELETE_CONFIRMATION || busy}
        onClick={() => void run()}
        className="mt-3 rounded-ctl bg-bear-strong px-3 py-1.5 font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Working…' : 'Delete my account'}
      </button>
    </Section>
  );
}

function SessionControl() {
  const sel = useSelection();
  const end = useEndSession();
  const qc = useQueryClient();
  return (
    <Section title="Analysis session">
      <p className="text-muted">
        Your live analysis starts by itself when you open the chart and picks up where you left off.
        Ending it stops live updates and chat until you start it again.
      </p>
      <div className="mt-3">
        {sel.sessionId ? (
          <button
            type="button"
            disabled={end.isPending}
            onClick={() => end.mutate()}
            className="rounded-ctl border border-line px-3 py-1.5 hover:bg-s3 disabled:opacity-50"
          >
            End session
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              allowAutoStart();
              void qc.invalidateQueries({ queryKey: ['sessions'] });
            }}
            className="rounded-ctl border border-line px-3 py-1.5 hover:bg-s3"
          >
            Start session
          </button>
        )}
      </div>
    </Section>
  );
}

export function SettingsView() {
  const [theme, toggle] = useTheme();
  const prefs = usePrefs();
  const me = useMe(true);
  const budget = useChat((s) => s.budget);
  return (
    <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-auto p-4">
      <h1 className="mb-3 text-lg font-semibold">Settings</h1>
      <div className="max-w-2xl">
        <SessionControl />
        <Section title="Appearance">
          <button
            type="button"
            onClick={toggle}
            className="rounded-ctl border border-line px-3 py-1.5 hover:bg-s3"
          >
            Switch to {theme === 'dark' ? 'light' : 'dark'} theme
          </button>
          <p className="mt-2 text-xs text-muted">
            The first visit follows your system setting. Your choice is remembered on this device.
          </p>
        </Section>
        <Section title="Privacy">
          <ul className="list-inside list-disc text-muted">
            <li>
              Screen frames and audio are never stored. Speech and screen text are read on your
              device.
            </li>
            <li>
              Only text leaves your device, and only when you send it. One uploaded image is sent
              once and dropped.
            </li>
            <li>No wallet address, email or IP address is sent to an AI model.</li>
          </ul>
          <label className="mt-3 flex items-start gap-2">
            <input
              type="checkbox"
              checked={prefs.neverSendImages}
              onChange={(e) => prefs.setNeverSendImages(e.target.checked)}
              className="mt-1"
            />
            <span>
              Never send images to AI. Switches off “Upload an image” in Explain. Screen sharing
              still works because only text is sent.
            </span>
          </label>
        </Section>
        <Section title="AI budget today">
          <p className="num text-muted">
            {budget
              ? `$${budget.spentUsd.toFixed(2)} of $${budget.limitUsd.toFixed(2)} used`
              : 'No AI use yet today.'}
          </p>
          {me.data && (
            <p className="mt-1 text-xs text-muted">
              Limits for your plan ({me.data.workspace.plan}) are set by the server.
            </p>
          )}
        </Section>
        <Section title="Disclaimer">
          <DisclaimerText />
          {me.data && (
            <p className="mt-2 text-xs text-muted">Version {me.data.disclaimer.currentVersion}</p>
          )}
        </Section>
        <Section title="Account">
          {me.data && (
            <ul className="num text-muted">
              {me.data.wallets.map((w) => (
                <li key={w.id}>
                  {w.chain === 'solana' ? 'Solana' : 'Ethereum'} · {w.address}
                  {w.primary ? ' (primary)' : ''}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-muted">
            Email is optional and not needed for anything here.
          </p>
          <button
            type="button"
            onClick={() => void signOut()}
            className="mt-3 rounded-ctl border border-line px-3 py-1.5 hover:bg-s3"
          >
            Sign out
          </button>
        </Section>
        <DeleteAccount />
      </div>
    </main>
  );
}
