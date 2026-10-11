import { Controller, Post, Req, Res } from '@nestjs/common';
import { CanonicalInstrumentSchema, OcrContextSchema, TimeframeSchema } from '@smc/contracts';
import type { Request, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { type AccountRequest, UserOnly } from '../account/account.guards.js';
import { RateLimit } from '../account/rate-limit.js';
import { ApiProblemError } from '../common/problem.js';
import { parseWith } from '../common/validation.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ExplainService, type ExplainSink, MAX_IMAGE_BYTES } from './explain.service.js';

const FieldsSchema = z.object({
  sessionId: z.uuid().optional(),
  source: z.enum(['SHARE', 'UPLOAD']).optional(),
  instrumentHint: CanonicalInstrumentSchema.optional(),
  tfHint: TimeframeSchema.optional(),
  question: z.string().max(500).optional(),
  /** OCR text read on the device, as a JSON string (multipart fields are strings). */
  ocr: z.string().max(60_000).optional(),
});

/**
 * Memory storage only: the upload never touches the disk. Limits are tight so an oversized or malformed request is
 * stopped at the parser, before any image library sees it.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 10, fieldSize: 64 * 1024, parts: 12 },
}).single('image');

function parseUpload(req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    upload(req, res, (err: unknown) => {
      if (!err) return resolve();
      const code = (err as { code?: string }).code;
      reject(
        code === 'LIMIT_FILE_SIZE'
          ? new ApiProblemError('IMAGE_TOO_LARGE', 'That image is too large. The limit is 6 MB.')
          : new ApiProblemError('VALIDATION_FAILED', 'The upload could not be read.'),
      );
    });
  });
}

@Controller('v1')
export class ExplainController {
  constructor(
    private readonly explain: ExplainService,
    private readonly sessions: SessionsService,
  ) {}

  /** `POST /v1/explain` (multipart): an optional image and context. The answer streams as server-sent events. */
  @UserOnly()
  @RateLimit({ name: 'explain.upload', limit: 12, windowMs: 60_000 })
  @Post('explain')
  async run(@Req() req: AccountRequest, @Res() res: Response): Promise<void> {
    if (!(req.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
      throw new ApiProblemError(
        'VALIDATION_FAILED',
        'Send multipart/form-data with an "image" file.',
      );
    }
    await parseUpload(req, res);
    const file = (req as unknown as { file?: { buffer: Buffer; mimetype: string } }).file;
    const f = parseWith(FieldsSchema, { ...(req.body as Record<string, unknown>) });
    let ocr: z.infer<typeof OcrContextSchema> | undefined;
    if (f.ocr) {
      try {
        ocr = parseWith(OcrContextSchema, JSON.parse(f.ocr));
      } catch (e) {
        if (e instanceof ApiProblemError) throw e;
        throw new ApiProblemError('VALIDATION_FAILED', 'The OCR context is not valid JSON.');
      }
    }
    if (!file && !ocr && !f.instrumentHint && !f.sessionId) {
      throw new ApiProblemError(
        'VALIDATION_FAILED',
        'Provide an image, OCR text, an instrument or a session.',
      );
    }
    let sessionInstrumentId: string | null = null;
    if (f.sessionId) {
      const s = await this.sessions.get(f.sessionId, req.account.userId);
      sessionInstrumentId = s.instrumentId;
    }

    // Stages before the answer is ready are held back: if reading or checking fails, the caller gets a proper
    // error status instead of a stream that has already said 200.
    let opened = false;
    const queued: string[] = [];
    const open = (): void => {
      if (opened) return;
      opened = true;
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      for (const q of queued.splice(0)) res.write(q);
    };
    const frame = (event: string, data: unknown): void => {
      const text = `event: ${event}
data: ${JSON.stringify(data)}

`;
      if (opened) res.write(text);
      else queued.push(text);
    };
    const sink: ExplainSink = {
      stage: (stage) => {
        frame('explain.stage', { stage });
        if (stage === 'writing') open();
      },
      chunk: (delta) => frame('explain.chunk', { delta }),
      done: (e) => frame('explain.done', e),
    };
    const device = req.header('x-device-id');
    try {
      await this.explain.run(
        {
          sessionId: f.sessionId ?? null,
          userId: req.account.userId,
          workspaceId: req.account.workspaceId,
          sessionInstrumentId,
          ip: (req.ip ?? 'unknown').replace(/^::ffff:/i, ''),
          ...(device ? { deviceId: device.slice(0, 64) } : {}),
        },
        {
          source: f.source ?? (file ? 'UPLOAD' : 'SHARE'),
          image: file?.buffer ?? null,
          ocr,
          instrumentHint: f.instrumentHint,
          tfHint: f.tfHint,
          question: f.question,
        },
        sink,
      );
    } catch (e) {
      if (!opened) throw e;
      // Already streaming: report the failure in-band and end cleanly.
      frame('error', { code: e instanceof ApiProblemError ? e.code : 'INTERNAL' });
    }
    res.end();
  }
}
