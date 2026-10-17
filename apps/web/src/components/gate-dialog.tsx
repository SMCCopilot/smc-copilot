'use client';
import * as Dialog from '@radix-ui/react-dialog';
import type { AnalysisResponse } from '@smc/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { GateInfo } from '@/lib/confirm';
import { confirmRequest, gateMatchesPlan, remainingMs, tradeBody } from '@/lib/confirm';
import { ApiError, type FriendlyError } from '@/lib/errors';
import { createKeyHolder } from '@/lib/gate';
import { formatPrice } from '@/lib/overlays';
import { useUi } from '@/lib/ui';
import { directionLabel } from '@/lib/wording';

type Setup = NonNullable<AnalysisResponse['setups']>[number];
type Gate = GateInfo;
type Phase = 'issuing' | 'ready' | 'confirming' | 'done' | 'failed';

export function GateDialog({
  setup,
  precision,
  onClose,
}: {
  setup: Setup;
  precision: number;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const setConfirmOpen = useUi((s) => s.setConfirmOpen);
  const plan = setup.plan;
  const [gate, setGate] = useState<Gate | null>(null);
  const [phase, setPhase] = useState<Phase>('issuing');
  const [err, setErr] = useState<FriendlyError | null>(null);
  const [left, setLeft] = useState(0);
  const keys = useRef(createKeyHolder(() => crypto.randomUUID()));
  const f = (n: number) => formatPrice(n, precision);

  // The microphone stays disabled for as long as this dialog is open.
  useEffect(() => {
    setConfirmOpen(true);
    return () => setConfirmOpen(false);
  }, [setConfirmOpen]);

  useEffect(() => {
    if (!plan) return;
    let live = true;
    api<Gate & { state: string }>('/v1/gate/issue', {
      method: 'POST',
      body: { planId: plan.planId },
    }).then(
      (g) => {
        if (!live) return;
        if (!gateMatchesPlan(g, plan)) {
          setErr({
            message:
              'The plan changed while the confirmation was prepared. Review the updated plan.',
            recovery: 'REFRESH_PLAN',
          });
          setPhase('failed');
          return;
        }
        setGate(g);
        setPhase('ready');
      },
      (e: unknown) => {
        if (!live) return;
        setErr(
          e instanceof ApiError
            ? e.friendly
            : { message: 'Could not prepare the confirmation.', recovery: 'RETRY' },
        );
        setPhase('failed');
      },
    );
    return () => {
      live = false;
    };
  }, [plan]);

  useEffect(() => {
    if (!gate) return;
    const tick = () => setLeft(remainingMs(gate, Date.now()));
    tick();
    const t = setInterval(tick, 250);
    return () => clearInterval(t);
  }, [gate]);

  const expired = phase === 'ready' && gate !== null && left <= 0;

  function refreshAndClose() {
    qc.invalidateQueries({ queryKey: ['analysis'] });
    onClose();
  }
  function cancel() {
    if (gate && phase === 'ready')
      void api(`/v1/gate/${gate.gateId}/decline`, { method: 'POST', body: {} }).catch(() => {});
    onClose();
  }

  /** The one deliberate tap: confirms the gate for exactly this plan, then records the trade the user chose to log. */
  async function confirm() {
    if (!gate || !plan || left <= 0) return;
    setPhase('confirming');
    setErr(null);
    try {
      const c = confirmRequest(gate, plan);
      await api(c.path, { method: 'POST', body: c.body, headers: c.headers });
      await api('/v1/trades', {
        method: 'POST',
        idempotencyKey: keys.current.get(gate.gateId),
        body: tradeBody(setup.instrumentId, gate, plan),
      });
      keys.current.release();
      qc.invalidateQueries({ queryKey: ['trades'] });
      setPhase('done');
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.friendly
          : { message: 'Could not complete that. Nothing was logged.', recovery: 'RETRY' },
      );
      setPhase('failed');
    }
  }

  const secs = Math.ceil(left / 1000);
  return (
    <Dialog.Root open onOpenChange={(o) => !o && (phase === 'done' ? onClose() : cancel())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-card border border-line bg-s1 p-5">
          <Dialog.Title className="text-base font-semibold">Log this trade</Dialog.Title>
          <Dialog.Description className="mt-1 text-muted">
            This only records the trade in your journal. Nothing is sent to any exchange. Review the
            plan, then tap Confirm.
          </Dialog.Description>
          {plan && (
            <dl className="num mt-3 rounded-card border border-line bg-s2 p-3">
              <div className="flex justify-between py-0.5">
                <dt className="text-muted">Scenario</dt>
                <dd>{directionLabel(plan.direction)}</dd>
              </div>
              <div className="flex justify-between py-0.5">
                <dt className="text-muted">Entry</dt>
                <dd>{f(plan.entry.refPrice)}</dd>
              </div>
              <div className="flex justify-between py-0.5">
                <dt className="text-muted">Stop</dt>
                <dd>{f(plan.stop.price)}</dd>
              </div>
              {plan.targets.map((t) => (
                <div key={t.id} className="flex justify-between py-0.5">
                  <dt className="text-muted">{t.label}</dt>
                  <dd>{f(t.price)}</dd>
                </div>
              ))}
              <div className="flex justify-between py-0.5">
                <dt className="text-muted">Invalidation</dt>
                <dd>{f(plan.invalidation.level)}</dd>
              </div>
            </dl>
          )}
          <p className="mt-3 text-sm" role="timer" aria-live="off">
            {phase === 'issuing' && 'Preparing confirmation…'}
            {phase === 'ready' && !expired && (
              <>
                Confirmation valid for <strong className="num">{secs}s</strong> (single use)
              </>
            )}
            {expired && (
              <span className="text-warn">The 60 second window ended. Review the plan again.</span>
            )}
            {phase === 'confirming' && 'Recording…'}
            {phase === 'done' && 'Trade logged in your journal.'}
          </p>
          {err && (
            <p role="alert" className="mt-2 text-warn">
              {err.message}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            {phase === 'done' ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded-ctl bg-accent px-3 py-2 font-medium text-white"
              >
                Close
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={cancel}
                  className="rounded-ctl border border-line px-3 py-2"
                >
                  Cancel
                </button>
                {(expired || err?.recovery === 'REFRESH_PLAN') && (
                  <button
                    type="button"
                    onClick={refreshAndClose}
                    className="rounded-ctl border border-line px-3 py-2"
                  >
                    Review updated plan
                  </button>
                )}
                <button
                  type="button"
                  onClick={confirm}
                  disabled={phase !== 'ready' || expired}
                  className="rounded-ctl bg-accent px-3 py-2 font-medium text-white disabled:opacity-50"
                >
                  Confirm (tap)
                </button>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
