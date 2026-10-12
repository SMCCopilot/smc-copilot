import type { NextFunction, Request, Response } from 'express';

/** Request counts by status class and total time, for the 5xx alert. In memory, per process; no paths, no users. */
export const requestStats = {
  total: 0,
  byClass: { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 } as Record<string, number>,
  seconds: 0,
};

export function requestStatsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    // The metrics scrape itself is not traffic.
    if (req.path === '/metrics') return;
    const cls = `${Math.floor(res.statusCode / 100)}xx`;
    requestStats.total++;
    requestStats.byClass[cls] = (requestStats.byClass[cls] ?? 0) + 1;
    requestStats.seconds += Number(process.hrtime.bigint() - start) / 1e9;
  });
  next();
}
