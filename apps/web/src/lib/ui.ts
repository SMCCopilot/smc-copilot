'use client';
import type { AnalysisResponse } from '@smc/contracts';
import { create } from 'zustand';
import { DEFAULT_LAYERS, type LayerId } from './overlays';

type Setup = NonNullable<AnalysisResponse['setups']>[number];

export type CanvasTab = 'Assistant' | 'Plan' | 'Evidence' | 'Changes' | 'Stats' | 'Journal';
export type View = 'room' | 'journal' | 'trades' | 'notifications' | 'settings';

interface Ui {
  layers: Record<LayerId, boolean>;
  toggleLayer: (l: LayerId) => void;
  setupId: string | null;
  chooseSetup: (id: string | null) => void;
  /** Setups the user dismissed in this browser tab. Display only; nothing is sent to the server. */
  dismissed: string[];
  dismiss: (id: string) => void;
  /** True while the confirm dialog is open. The microphone is disabled for as long as this is true. */
  confirmOpen: boolean;
  setConfirmOpen: (open: boolean) => void;
  tab: CanvasTab;
  setTab: (t: CanvasTab) => void;
  /** The right panel as a drawer on small screens. */
  drawer: boolean;
  setDrawer: (open: boolean) => void;
  view: View;
  setView: (v: View) => void;
  explainOpen: boolean;
  setExplainOpen: (open: boolean) => void;
}

export const useUi = create<Ui>((set) => ({
  layers: DEFAULT_LAYERS,
  toggleLayer: (l) => set((s) => ({ layers: { ...s.layers, [l]: !s.layers[l] } })),
  setupId: null,
  chooseSetup: (setupId) => set({ setupId }),
  dismissed: [],
  dismiss: (id) => set((s) => ({ dismissed: [...s.dismissed, id], setupId: null })),
  confirmOpen: false,
  setConfirmOpen: (confirmOpen) => set({ confirmOpen }),
  tab: 'Assistant',
  setTab: (tab) => set({ tab }),
  drawer: false,
  setDrawer: (drawer) => set({ drawer }),
  view: 'room',
  setView: (view) => set({ view }),
  explainOpen: false,
  setExplainOpen: (explainOpen) => set({ explainOpen }),
}));

/** The setup to show: the chosen one if still live, else the first live setup that has a plan. */
export function pickSetup(
  a: AnalysisResponse | undefined,
  id: string | null,
  dismissed: string[],
): Setup | null {
  const live = (a?.setups ?? []).filter(
    (s) => !dismissed.includes(s.id) && (s.state === 'ARMED' || s.state === 'TRIGGERED'),
  );
  return live.find((s) => s.id === id) ?? live.find((s) => s.plan) ?? live[0] ?? null;
}
