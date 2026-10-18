import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Env } from '@smc/config';
import {
  BlocklistEntrySchema,
  BlocklistImportSchema,
  BlockUserSchema,
  EntitlementsPatchSchema,
  FlagBodySchema,
  KillSwitchSchema,
  StrategyVersionCreateSchema,
} from '@smc/contracts';
import { AdminGuard, adminSourceIp } from '../admin/admin.guard.js';
import { type AuthenticatedRequest, JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { parseWith } from '../common/validation.js';
import { ENV } from '../config/tokens.js';
import { AdminOpsService } from './admin-ops.service.js';

/** Operator endpoints beyond feed health: blocklist, users, flags, kill switches, strategy versions. */
@Controller('v1/admin')
@UseGuards(JwtAuthGuard, AdminGuard)
export class AdminOpsController {
  constructor(
    private readonly ops: AdminOpsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private actor(req: AuthenticatedRequest) {
    return {
      userId: req.principal.userId,
      ip: adminSourceIp(req, this.env.TRUST_PROXY_HEADERS) || null,
    };
  }

  @Post('blocklist')
  @HttpCode(204)
  async blocklist(@Req() req: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    await this.ops.blocklist(this.actor(req), parseWith(BlocklistEntrySchema, body));
  }

  @Post('blocklist/import')
  importBlocklist(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    const { source, entries } = parseWith(BlocklistImportSchema, body);
    return this.ops.importBlocklist(this.actor(req), source, entries);
  }

  @Get('users/:id')
  user(@Param('id', ParseUUIDPipe) id: string) {
    return this.ops.user(id);
  }

  @Post('users/:id/entitlements')
  @HttpCode(204)
  async entitlements(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<void> {
    await this.ops.patchEntitlements(this.actor(req), id, parseWith(EntitlementsPatchSchema, body));
  }

  @Post('users/:id/block')
  @HttpCode(204)
  async block(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const { blocked, reason } = parseWith(BlockUserSchema, body);
    await this.ops.blockUser(this.actor(req), id, blocked, reason);
  }

  @Post('flags/:key')
  @HttpCode(204)
  async flag(
    @Req() req: AuthenticatedRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<void> {
    const { enabled, rolloutPct } = parseWith(FlagBodySchema, body);
    await this.ops.setFlag(this.actor(req), key, enabled, rolloutPct);
  }

  @Post('kill-switch')
  @HttpCode(204)
  async killSwitch(@Req() req: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    const { scope, active } = parseWith(KillSwitchSchema, body);
    await this.ops.killSwitch(this.actor(req), scope, active);
  }

  @Post('strategy-versions')
  createStrategy(@Req() req: AuthenticatedRequest, @Body() body: unknown) {
    return this.ops.createStrategyVersion(
      this.actor(req),
      parseWith(StrategyVersionCreateSchema, body),
    );
  }

  @Post('strategy-versions/:id/activate')
  @HttpCode(204)
  async activate(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    await this.ops.activateStrategyVersion(this.actor(req), id);
  }

  @Get('dq-incidents')
  incidents(@Query('status') status?: string) {
    return this.ops.dqIncidents(status === 'closed' || status === 'all' ? status : 'open');
  }

  @Post('dq-incidents/:id/close')
  @HttpCode(204)
  async closeIncident(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ): Promise<void> {
    await this.ops.closeDqIncident(this.actor(req), id);
  }
}
