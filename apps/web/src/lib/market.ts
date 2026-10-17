'use client';
import type { AnalysisResponse, Timeframe } from '@smc/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { API_URL } from './env';
import { toApiError } from './errors';
import { getAccessToken } from './supabase';

const INCLUDE = 'structure,zones,liquidity,context,setups,bias';

// One cached body per instrument and timeframe so a 304 can answer from memory.
const etags = new Map<string, { etag: string; body: AnalysisResponse }>();

async function fetchAnalysis(instrumentId: string, tf: Timeframe): Promise<AnalysisResponse> {
  const key = `${instrumentId}|${tf}`;
  const prev = etags.get(key);
  const token = await getAccessToken();
  const res = await fetch(
    `${API_URL}/v1/instruments/${instrumentId}/analysis?tf=${tf}&include=${INCLUDE}`,
    {
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(prev ? { 'if-none-match': prev.etag } : {}),
      },
    },
  );
  if (res.status === 304 && prev) return prev.body;
  if (!res.ok) throw await toApiError(res);
  const { AnalysisResponseSchema } = await import('@smc/contracts');
  const body = AnalysisResponseSchema.parse(await res.json());
  const etag = res.headers.get('etag');
  if (etag) etags.set(key, { etag, body });
  return body;
}

export const useAnalysis = (instrumentId: string | null, tf: Timeframe) =>
  useQuery({
    queryKey: ['analysis', instrumentId, tf],
    enabled: instrumentId !== null,
    queryFn: () => fetchAnalysis(instrumentId as string, tf),
    refetchInterval: 30_000, // safety net; the socket normally triggers refetches sooner
  });

export interface CandleRow {
  openTime: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  status: 'CLOSED' | 'INCOMPLETE';
}

export const useCandles = (instrumentId: string | null, tf: Timeframe, enabled: boolean) =>
  useQuery({
    queryKey: ['candles', instrumentId, tf],
    enabled: enabled && instrumentId !== null,
    queryFn: async () =>
      (
        await api<{ items: CandleRow[] }>(
          `/v1/instruments/${instrumentId}/candles?tf=${tf}&limit=500`,
        )
      ).items,
  });

export interface EngineEvent {
  id: string;
  type: string;
  tf: string;
  scale: string | null;
  time: string;
  anchor: string;
  data: Record<string, unknown>;
}

export const useEngineEvents = (instrumentId: string | null, tf: Timeframe) =>
  useQuery({
    queryKey: ['events', instrumentId, tf],
    enabled: instrumentId !== null,
    queryFn: async () =>
      (
        await api<{ items: EngineEvent[] }>(
          `/v1/instruments/${instrumentId}/analysis/events?tf=${tf}&limit=60`,
        )
      ).items,
  });

export interface Cohort {
  template: string;
  grade: string;
  direction: string | null;
  source: string;
  n: number;
  rate: number | null;
  ci95: [number, number] | null;
  avgR: number | null;
  sufficient: boolean;
  window: { from: string; to: string };
}

export const useCohorts = () =>
  useQuery({
    queryKey: ['cohorts'],
    queryFn: async () => (await api<{ items: Cohort[] }>('/v1/stats/cohorts')).items,
  });

export const useRejected = (instrumentId: string | null) =>
  useQuery({
    queryKey: ['rejected', instrumentId],
    enabled: instrumentId !== null,
    queryFn: async () => {
      const { SetupDtoSchema } = await import('@smc/contracts');
      const r = await api<{ items: unknown[] }>(
        `/v1/setups/rejected?instrumentId=${instrumentId}&limit=10`,
      );
      return SetupDtoSchema.array().parse(r.items);
    },
  });
