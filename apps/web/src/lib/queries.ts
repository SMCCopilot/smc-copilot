'use client';
import type { LicenseClass, MarketType, Venue } from '@smc/contracts';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';

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
  licenseClass: LicenseClass;
  rawDataAllowed: boolean;
}

export const useFeedStatus = () =>
  useQuery({
    queryKey: ['status'],
    queryFn: () => apiGet<FeedStatus>('/v1/status'),
    refetchInterval: 15_000,
  });

export const useInstruments = () =>
  useQuery({
    queryKey: ['instruments'],
    queryFn: () => apiGet<{ items: InstrumentDto[] }>('/v1/instruments'),
  });
