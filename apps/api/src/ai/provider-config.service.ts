import { Inject, Injectable } from '@nestjs/common';
import {
  type DataClass,
  PROVIDER_IDS,
  type ProviderId,
  type ProviderSource,
  type ProviderState,
} from '@smc/ai';
import type { Env } from '@smc/config';
import { FlagsService } from '../account/flags.service.js';
import { ENV } from '../config/tokens.js';

/**
 * Anthropic keeps the broad default. OpenAI and Gemini default to text data classes (D0 facts, D2 user text) and not
 * to chart images (D1) until the owner has reviewed their retention terms and widens it (A05 section 12.2).
 */
export const DEFAULT_DATA_CLASSES: Record<ProviderId, readonly DataClass[]> = {
  anthropic: ['D0', 'D1', 'D2'],
  openai: ['D0', 'D2'],
  gemini: ['D0', 'D2'],
};

export const providerFlagKey = (id: ProviderId): string => `ai.provider.${id}`;

export interface ProviderView {
  id: ProviderId;
  enabled: boolean;
  /** Where the on/off value comes from: the database switch, or the environment default before any switch is stored. */
  enabledSource: 'database' | 'env';
  keyPresent: boolean;
  priority: number;
  dataClasses: readonly DataClass[];
  models: { fast: string | null; strong: string | null };
  /** True when the provider could answer right now: enabled, key present and a model set. */
  ready: boolean;
}

const CLASSES = new Set<string>(['D0', 'D1', 'D2']);

/**
 * The owner's provider switches (A05 section 10, owner request): which providers are active, in what order, and what
 * each may see. Env gives the starting values; a row in `feature_flags` overrides them without a deploy.
 */
@Injectable()
export class ProviderConfigService implements ProviderSource {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly flags: FlagsService,
  ) {}

  private keyOf(id: ProviderId): string | undefined {
    return id === 'anthropic'
      ? this.env.ANTHROPIC_API_KEY
      : id === 'openai'
        ? this.env.OPENAI_API_KEY
        : this.env.GEMINI_API_KEY;
  }

  private modelsOf(id: ProviderId): { fast: string | undefined; strong: string | undefined } {
    return id === 'anthropic'
      ? { fast: this.env.ANTHROPIC_MODEL_FAST, strong: this.env.ANTHROPIC_MODEL_STRONG }
      : id === 'openai'
        ? { fast: this.env.OPENAI_MODEL_FAST, strong: this.env.OPENAI_MODEL_STRONG }
        : { fast: this.env.GEMINI_MODEL_FAST, strong: this.env.GEMINI_MODEL_STRONG };
  }

  private envEnabled(id: ProviderId): boolean {
    return id === 'anthropic'
      ? this.env.AI_PROVIDER_ANTHROPIC_ENABLED
      : id === 'openai'
        ? this.env.AI_PROVIDER_OPENAI_ENABLED
        : this.env.AI_PROVIDER_GEMINI_ENABLED;
  }

  private envOrder(): ProviderId[] {
    const listed = this.env.AI_PROVIDER_ORDER.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is ProviderId => (PROVIDER_IDS as readonly string[]).includes(s));
    return [...new Set([...listed, ...PROVIDER_IDS])];
  }

  async views(): Promise<ProviderView[]> {
    const order = this.envOrder();
    const out: ProviderView[] = [];
    for (const id of PROVIDER_IDS) {
      const row = await this.flags.row(providerFlagKey(id));
      const rules = row?.rules ?? {};
      const priority = typeof rules.priority === 'number' ? rules.priority : order.indexOf(id) + 1;
      const classes = Array.isArray(rules.dataClasses)
        ? (rules.dataClasses.filter((c) => typeof c === 'string' && CLASSES.has(c)) as DataClass[])
        : [...DEFAULT_DATA_CLASSES[id]];
      const m = this.modelsOf(id);
      const keyPresent = Boolean(this.keyOf(id));
      const enabled = row ? row.enabled : this.envEnabled(id);
      out.push({
        id,
        enabled,
        enabledSource: row ? 'database' : 'env',
        keyPresent,
        priority,
        dataClasses: classes,
        models: { fast: m.fast ?? null, strong: m.strong ?? null },
        ready: enabled && keyPresent && Boolean(m.fast ?? m.strong),
      });
    }
    return out;
  }

  async providers(): Promise<readonly ProviderState[]> {
    return (await this.views()).map((v) => ({
      id: v.id,
      enabled: v.enabled,
      apiKey: this.keyOf(v.id),
      priority: v.priority,
      dataClasses: v.dataClasses,
      // A provider with only one model configured uses it for both kinds of job.
      models: {
        ...((v.models.fast ?? v.models.strong)
          ? { fast: (v.models.fast ?? v.models.strong) as string }
          : {}),
        ...((v.models.strong ?? v.models.fast)
          ? { strong: (v.models.strong ?? v.models.fast) as string }
          : {}),
      },
    }));
  }

  /** True when at least one provider could answer: used to skip work that would only produce a template. */
  async anyReady(): Promise<boolean> {
    return (await this.views()).some((v) => v.ready);
  }
}
