import dns from 'node:dns';

/**
 * Development aid: resolve names through the given DNS servers instead of the system resolver. Some home networks
 * block exchange hostnames at the router (found in spike S2); this lets the app reach the venues without changing
 * system settings. Never used in production (the VM resolves normally); enabled only by DNS_SERVERS.
 */
export function installDnsOverride(servers: readonly string[]): () => void {
  const resolver = new dns.Resolver();
  resolver.setServers([...servers]);
  const original = dns.lookup;
  const isIp = (h: string) => /^[\d.]+$/.test(h) || h.includes(':');

  const patched = ((
    hostname: string,
    optionsOrCallback: unknown,
    maybeCallback?: unknown,
  ): void => {
    const callback = (
      typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback
    ) as (err: Error | null, address?: unknown, family?: number) => void;
    const options = (
      typeof optionsOrCallback === 'object' && optionsOrCallback !== null ? optionsOrCallback : {}
    ) as {
      all?: boolean;
    };
    if (isIp(hostname) || hostname === 'localhost') {
      (original as (...a: unknown[]) => void)(hostname, optionsOrCallback, maybeCallback);
      return;
    }
    resolver.resolve4(hostname, (err, addresses) => {
      const first = addresses?.[0];
      if (err || !first) return callback(err ?? new Error(`no address for ${hostname}`));
      if (options.all)
        return callback(
          null,
          addresses.map((address) => ({ address, family: 4 })),
        );
      return callback(null, first, 4);
    });
  }) as unknown as typeof dns.lookup;

  dns.lookup = patched;
  return () => {
    dns.lookup = original;
  };
}
