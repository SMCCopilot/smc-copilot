'use client';
import * as Tooltip from '@radix-ui/react-tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Data stays fresh for half a minute and is kept for ten, so going back to a tab or page shows it at once.
          // Coming back to the browser tab does not refetch everything (the live socket keeps what matters current).
          queries: {
            retry: false,
            staleTime: 30_000,
            gcTime: 10 * 60_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );
  return (
    <QueryClientProvider client={qc}>
      <Tooltip.Provider delayDuration={200}>{children}</Tooltip.Provider>
    </QueryClientProvider>
  );
}
