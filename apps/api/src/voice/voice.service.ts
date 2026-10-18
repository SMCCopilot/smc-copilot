import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Inject, Injectable } from '@nestjs/common';
import {
  buildGlossary,
  correctTranscript,
  type Glossary,
  type VoiceConfig,
  VoiceConfigSchema,
} from '@smc/contracts';
import type { Sql } from '@smc/db';
import { ApiProblemError } from '../common/problem.js';
import { SQL } from '../config/tokens.js';

interface ManifestFile {
  id: string;
  path: string;
  sha256: string | null;
  bytes: number | null;
}
interface ManifestGroup {
  repo: string;
  revision: string | null;
  files: ManifestFile[];
}
interface Manifest {
  engines: (ManifestGroup & {
    tag: 'whisper-web' | 'moonshine-web';
    label: string;
    backend: 'webgpu' | 'wasm';
  })[];
  vad: ManifestGroup;
}

const here = dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATHS = [
  join(here, 'model-manifest.json'),
  join(here, '../../src/voice/model-manifest.json'),
];

export function loadManifest(): Manifest {
  for (const p of MANIFEST_PATHS) {
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as Manifest;
    } catch {
      /* try the next location (compiled output vs source) */
    }
  }
  throw new Error('voice model manifest not found');
}

const GLOSSARY_TTL_MS = 60_000;
const MAX_UTTERANCE_MS = 180_000; // three minutes
const MIN_CONFIDENCE = 0.6;

const pinned = (g: ManifestGroup): boolean =>
  Boolean(g.revision) &&
  g.files.length > 0 &&
  g.files.every((f) => Boolean(f.sha256) && Boolean(f.bytes));

const filesOf = (g: ManifestGroup) =>
  g.files.map((f) => ({
    id: f.id,
    url: `https://huggingface.co/${g.repo}/resolve/${g.revision}/${f.path}`,
    sha256: f.sha256 as string,
    bytes: f.bytes as number,
  }));

/**
 * Everything the browser needs to run speech recognition on the device, and the glossary that corrects what it hears.
 * No audio ever reaches the server; the only thing stored about speech is metadata in `voice_events` (A02 section 6).
 */
@Injectable()
export class VoiceService {
  private glossaryCache: { at: number; value: Glossary } | null = null;

  constructor(@Inject(SQL) private readonly sql: Sql | null) {}

  config(): VoiceConfig {
    const m = loadManifest();
    const cfg: VoiceConfig = {
      audioLeavesDevice: false,
      maxUtteranceMs: MAX_UTTERANCE_MS,
      minConfidence: MIN_CONFIDENCE,
      languages: ['en'],
      glossaryVersion: '',
      engines: m.engines.map((e) => ({
        tag: e.tag,
        label: e.label,
        // An engine whose files are not all pinned by hash must not be used: the browser cannot verify it.
        status: pinned(e) ? ('READY' as const) : ('UNPINNED' as const),
        backend: e.backend,
        files: pinned(e) ? filesOf(e) : [],
      })),
      vad: {
        status: pinned(m.vad) ? 'READY' : 'UNPINNED',
        files: pinned(m.vad) ? filesOf(m.vad) : [],
      },
    };
    return VoiceConfigSchema.parse(cfg);
  }

  async glossary(): Promise<Glossary> {
    const now = Date.now();
    if (this.glossaryCache && now - this.glossaryCache.at < GLOSSARY_TTL_MS)
      return this.glossaryCache.value;
    const rows = this.sql
      ? await this.sql<
          { base: string }[]
        >`select distinct base from instruments where active order by base`
      : [];
    const draft = buildGlossary(rows.map((r) => r.base));
    const version = createHash('sha1').update(JSON.stringify(draft)).digest('hex').slice(0, 12);
    const value = { ...draft, version };
    this.glossaryCache = { at: now, value };
    return value;
  }

  /** The server's own correction pass: the authority, whatever the browser did first. */
  async correct(text: string) {
    return correctTranscript(text, await this.glossary());
  }

  async recordEvent(
    workspaceId: string,
    userId: string,
    sessionId: string | null,
    e: {
      engine: string;
      outcome: string;
      durationMs?: number | undefined;
      latencyMs?: number | undefined;
      confidence?: number | undefined;
      language?: string | undefined;
      errorCode?: string | undefined;
    },
  ): Promise<void> {
    if (!this.sql) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    if (sessionId) {
      const [s] = await this
        .sql`select 1 from copilot_sessions where id = ${sessionId} and user_id = ${userId}`;
      if (!s) throw new ApiProblemError('NOT_FOUND', 'Unknown session.');
    }
    await this.sql`
      insert into voice_events (workspace_id, user_id, session_id, engine, duration_ms, latency_ms, confidence, language, outcome, error_code)
      values (${workspaceId}, ${userId}, ${sessionId}, ${e.engine}, ${e.durationMs ?? null}, ${e.latencyMs ?? null},
              ${e.confidence ?? null}, ${e.language ?? null}, ${e.outcome}, ${e.errorCode ?? null})`;
  }
}
