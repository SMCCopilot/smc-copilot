'use client';
import type { LicenseClass, MarketType, Venue } from '@smc/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';

export interface FeedStatus {
  ingest: 'DISABLED' | 'RUNNING';
  feeds: { ok: number; degraded: number; stale: number; total: number };
  asOf: string;
}
// Shape of apps/api InstrumentDto (markets.service.ts); it is not exported from @smc/contracts yet.
export interface InstrumentDto {
  id: string;
  canonical: string;
  venue: Venue;
  marketType: MarketType;
  display: string;
  pricePrecision: number;
  tickSize: number;
  licenseClass: LicenseClass;
  rawDataAllowed: boolean;
  devRawPrices?: boolean;
}

export const useFeedStatus = () =>
  useQuery({
    queryKey: ['status'],
    queryFn: () => api<FeedStatus>('/v1/status', { auth: false }),
    refetchInterval: 15_000,
  });

export const useInstruments = (enabled = true) =>
  useQuery({
    queryKey: ['instruments'],
    enabled,
    queryFn: () => api<{ items: InstrumentDto[] }>('/v1/instruments'),
  });
