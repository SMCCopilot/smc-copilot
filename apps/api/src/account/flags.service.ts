import { Inject, Injectable } from '@nestjs/common';
import type { KillSwitchScope } from '@smc/contracts';
import type { Sql } from '@smc/db';
import { SQL } from '../config/tokens.js';

const TTL_MS = 3000;

interface FlagRow {
  enabled: boolean;
  rollout: number;
  rules: Record<string, unknown> | null;
}

/**
 * Feature flags and kill switches (A07 section 9), read from `feature_flags` with a short cache so a switch flipped
 * by an admin takes effect within seconds and never needs a deploy. A kill switch is a flag named `kill.<SCOPE>`.
 */
@Injectable()
export class FlagsService {
  private cache: { at: number; flags: Map<string, FlagRow> } | null = null;

  constructor(@Inject(SQL) private readonly sql: Sql | null) {}

  private async load(): Promise<Map<string, FlagRow>> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < TTL_MS) return this.cache.flags;
    const flags = new Map<string, FlagRow>();
    if (this.sql) {
      const rows = await this.sql<
        {
          key: string;
          enabled: boolean;
          rollout_pct: number;
          rules: Record<string, unknown> | null;
        }[]
      >`select key, enabled, rollout_pct, rules from feature_flags`;
      for (const r of rows) {
        flags.set(r.key, { enabled: r.enabled, rollout: r.rollout_pct, rules: r.rules });
      }
    }
    this.cache = { at: now, flags };
    return flags;
  }

  /** The stored row for a flag, or undefined when no row exists (callers then use their configured default). */
  async row(
    key: string,
  ): Promise<{ enabled: boolean; rules: Record<string, unknown> | null } | undefined> {
    const f = (await this.load()).get(key);
    return f ? { enabled: f.enabled, rules: f.rules } : undefined;
  }

  /** Called after an admin write so this process sees the change immediately. */
  invalidate(): void {
    this.cache = null;
  }

  /** `subject` makes a percentage rollout stable per user: the same user always lands on the same side. */
  async isEnabled(key: string, subject?: string): Promise<boolean> {
    const f = (await this.load()).get(key);
    if (!f?.enabled) return false;
    if (f.rollout >= 100) return true;
    if (f.rollout <= 0 || subject === undefined) return false;
    let h = 0;
    for (const c of `${key}:${subject}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return h % 100 < f.rollout;
  }

  /** True when the capability is switched off. Killing AI also kills what is built on it. */
  async killed(scope: KillSwitchScope): Promise<boolean> {
    const flags = await this.load();
    const on = (s: string): boolean => flags.get(`kill.${s}`)?.enabled === true;
    if (on(scope)) return true;
    return (scope === 'EXPLAIN' || scope === 'IMAGE_READ' || scope === 'CHAT') && on('AI');
  }
}
