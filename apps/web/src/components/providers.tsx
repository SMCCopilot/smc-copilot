'use client';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } }),
  );
  return (
    <QueryClientProvider client={qc}>
      <Tooltip.Provider delayDuration={200}>{children}</Tooltip.Provider>
    </QueryClientProvider>
  );
}
