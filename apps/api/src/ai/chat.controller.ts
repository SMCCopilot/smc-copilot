import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, Res } from '@nestjs/common';
import { ChatSendBodySchema } from '@smc/contracts';
import type { Response } from 'express';
import { type AccountRequest, UserOnly } from '../account/account.guards.js';
import { RATE_LIMITS, RateLimit } from '../account/rate-limit.js';
import { ApiProblemError } from '../common/problem.js';
import { parseWith } from '../common/validation.js';
import { SessionsService } from '../sessions/sessions.service.js';
import { ChatService } from './chat.service.js';

/**
 * Chat over plain HTTP as server-sent events, for clients that cannot hold the socket (A05 section 7). The reply is
 * validated before the first byte is sent, exactly as on the socket.
 */
@Controller('v1')
export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly sessions: SessionsService,
  ) {}

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Post('chat/messages')
  async send(
    @Req() req: AccountRequest,
    @Res() res: Response,
    @Body() body: unknown,
  ): Promise<void> {
    const b = parseWith(ChatSendBodySchema, body);
    const s = await this.sessions.get(b.sessionId, req.account.userId);
    if (s.state === 'ENDED')
      throw new ApiProblemError('SESSION_NOT_ACTIVE', 'That session has ended.');
    const ip = (req.ip ?? 'unknown').replace(/^::ffff:/i, '');
    const device = req.header('x-device-id');
    let opened = false;
    const frame = (event: string, data: unknown): void => {
      if (!opened) {
        opened = true;
        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
      }
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let aborted = false;
    req.on('close', () => {
      aborted = true;
    });
    // Errors thrown before the first frame become ordinary problem responses; the exception filter handles them.
    await this.chat.send(
      {
        sessionId: b.sessionId,
        userId: req.account.userId,
        workspaceId: req.account.workspaceId,
        instrumentId: s.instrumentId,
        ip,
        ...(device ? { deviceId: device.slice(0, 64) } : {}),
      },
      {
        clientMsgId: b.clientMsgId,
        text: b.text,
        inputMode: b.inputMode,
        sttConfidence: b.sttConfidence,
      },
      {
        chunk: (e) => frame('chat.chunk', e),
        done: (e) => frame('chat.done', e),
        budget: (e) => frame('budget.update', e),
        cancelled: () => aborted,
      },
    );
    res.end();
  }

  @UserOnly()
  @RateLimit(RATE_LIMITS.read)
  @Get('sessions/:id/chat')
  history(@Req() req: AccountRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.chat.history(id, req.account.userId);
  }
}
