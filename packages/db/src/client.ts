import postgres, { type Sql } from 'postgres';

export type { Sql };

export interface ClientOptions {
  /** Pool size. Default 10 for the app (B02 section 3.3: api pool 10 + pg-boss 4). */
  readonly max?: number;
  /** Seconds a connection may stay idle before it is closed. */
  readonly idleTimeout?: number;
}

/**
 * The application's database client. `prepare: false` is required for the Supabase transaction pooler
 * (port 6543), which does not support session state or named prepared statements (B02 section 3.3).
 * Notices are dropped so a verbose migration or function cannot leak into application logs.
 */
export function createClient(url: string, options: ClientOptions = {}): Sql {
  return postgres(url, {
    prepare: false,
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    connect_timeout: 10,
    onnotice: () => {},
  });
}
