import { Inject, Injectable } from '@nestjs/common';
import type { TradeCloseSchema, TradeCreateSchema, TradePatchSchema } from '@smc/contracts';
import type { Sql } from '@smc/db';
import type { z } from 'zod';
import { AccountService } from '../account/account.service.js';
import { ApiProblemError } from '../common/problem.js';
import { SQL } from '../config/tokens.js';
import { GateService } from '../gate/gate.service.js';
import { decodeCursor, encodeCursor } from '../setups/setups.service.js';

interface TradeRow {
  id: string;
  plan_id: string | null;
  setup_id: string | null;
  gate_id: string | null;
  instrument_id: string;
  direction: 'LONG' | 'SHORT';
  leverage: string | null;
  stop_price: string | null;
  targets: string[] | null;
  status: 'OPEN' | 'CLOSED' | 'CANCELLED';
  close_reason: string | null;
  realized_r: string | null;
  opened_at: Date;
  closed_at: Date | null;
  notes: string | null;
  entry_price: string | null;
  exit_price: string | null;
  size: string | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

export const toTradeDto = (r: TradeRow) => ({
  id: r.id,
  planId: r.plan_id,
  setupId: r.setup_id,
  gateId: r.gate_id,
  instrumentId: r.instrument_id,
  direction: r.direction,
  entryPrice: num(r.entry_price),
  exitPrice: num(r.exit_price),
  size: num(r.size),
  leverage: num(r.leverage),
  stopPrice: num(r.stop_price),
  targets: (r.targets ?? []).map(Number),
  status: r.status,
  closeReason: r.close_reason,
  realizedR: num(r.realized_r),
  openedAt: r.opened_at.toISOString(),
  closedAt: r.closed_at ? r.closed_at.toISOString() : null,
  notes: r.notes,
});
export type TradeDto = ReturnType<typeof toTradeDto>;

/**
 * Realised R, net of round-trip taker fees, from the trade's own stop. `fee` is the total fee paid when the user
 * entered one; otherwise the profile's taker rate on both legs. Null when there is no stop to measure risk against.
 */
export function realizedR(
  direction: 'LONG' | 'SHORT',
  entry: number,
  exit: number,
  stop: number | null,
  takerFeeBps: number,
  size: number | null,
  fee: number | undefined,
): number | null {
  if (stop === null) return null;
  const risk = Math.abs(entry - stop);
  if (risk === 0) return null;
  const gross = (direction === 'LONG' ? exit - entry : entry - exit) / risk;
  const feePerUnit =
    fee !== undefined && size ? fee / size : ((entry + exit) * takerFeeBps) / 10_000;
  return Math.round((gross - feePerUnit / risk) * 1000) / 1000;
}

const SELECT = (sql: Sql) => sql`
  select t.id, t.plan_id, t.setup_id, t.gate_id, t.instrument_id, t.direction, t.leverage, t.stop_price,
         t.targets, t.status, t.close_reason, t.realized_r, t.opened_at, t.closed_at, t.notes,
         (select price from trade_fills f where f.trade_id = t.id and f.side = 'ENTRY' order by f.id limit 1) as entry_price,
         (select price from trade_fills f where f.trade_id = t.id and f.side = 'EXIT' order by f.id desc limit 1) as exit_price,
         (select size from trade_fills f where f.trade_id = t.id and f.side = 'ENTRY' order by f.id limit 1) as size
    from trade_records t`;

@Injectable()
export class TradesService {
  /** Realtime hook: called after a trade changes so the open session can show it. */
  onChange: ((workspaceId: string, userId: string, trade: TradeDto) => void) | null = null;

  constructor(
    @Inject(SQL) private readonly sqlOrNull: Sql | null,
    private readonly gate: GateService,
    private readonly account: AccountService,
  ) {}

  private get sql(): Sql {
    if (!this.sqlOrNull) throw new ApiProblemError('NOT_READY', 'The database is not configured.');
    return this.sqlOrNull;
  }

  async create(
    userId: string,
    workspaceId: string,
    b: z.infer<typeof TradeCreateSchema>,
    ip: string | null,
  ): Promise<TradeDto> {
    if (b.planId && !b.gateId) {
      throw new ApiProblemError(
        'GATE_TOKEN_INVALID',
        'A trade that follows a plan needs a confirmed gate.',
      );
    }
    if (b.gateId && !b.planId) {
      throw new ApiProblemError('VALIDATION_FAILED', 'planId is required with gateId.');
    }
    const [inst] = await this.sql<
      { id: string }[]
    >`select id from instruments where id = ${b.instrumentId}`;
    if (!inst) throw new ApiProblemError('NOT_FOUND', 'Unknown instrument.');

    const id = await this.sql.begin(async (tx) => {
      let setupId: string | null = null;
      if (b.planId && b.gateId) {
        await this.gate.spend(tx as unknown as Sql, userId, b.gateId, b.planId);
        const [p] = await tx<
          { setup_id: string; instrument_id: string }[]
        >`select p.setup_id, s.instrument_id from trade_plans p join setups s on s.id = p.setup_id where p.id = ${b.planId}`;
        if (!p || p.instrument_id !== b.instrumentId) {
          throw new ApiProblemError('VALIDATION_FAILED', 'The plan is for a different instrument.');
        }
        setupId = p.setup_id;
      }
      const [t] = await tx<{ id: string }[]>`
        insert into trade_records (workspace_id, user_id, plan_id, setup_id, gate_id, instrument_id, direction, leverage, stop_price, targets, notes)
        values (${workspaceId}, ${userId}, ${b.planId ?? null}, ${setupId}, ${b.gateId ?? null}, ${b.instrumentId},
                ${b.direction}, ${b.leverage ?? null}, ${b.stopPrice ?? null}, ${b.targets ?? null}, ${b.notes ?? null})
        returning id`;
      const tradeId = (t as { id: string }).id;
      await tx`
        insert into trade_fills (trade_id, side, fill_time, price, size)
        values (${tradeId}, 'ENTRY', now(), ${b.entryPrice}, ${b.size ?? 0})`;
      if (b.gateId) {
        await tx`
          insert into journal_entries (workspace_id, user_id, setup_id, plan_id, trade_id, kind, payload)
          values (${workspaceId}, ${userId}, ${setupId}, ${b.planId ?? null}, ${tradeId}, 'GATE',
                  ${tx.json({ gateId: b.gateId, via: 'UI_TAP' })})`;
      }
      await tx`
        insert into journal_entries (workspace_id, user_id, setup_id, plan_id, trade_id, kind, payload)
        values (${workspaceId}, ${userId}, ${setupId}, ${b.planId ?? null}, ${tradeId}, 'TRADE',
                ${tx.json({ event: 'OPENED', direction: b.direction, entryPrice: b.entryPrice, initialStop: b.stopPrice ?? null })})`;
      return tradeId;
    });
    await this.account.audit(userId, workspaceId, 'trade.open', id, ip, {
      planned: Boolean(b.planId),
    });
    return this.emit(workspaceId, userId, await this.get(id, workspaceId));
  }

  private emit(workspaceId: string, userId: string, t: TradeDto): TradeDto {
    this.onChange?.(workspaceId, userId, t);
    return t;
  }

  async get(id: string, workspaceId: string): Promise<TradeDto> {
    const [r] = await this.sql<TradeRow[]>`
      ${SELECT(this.sql)} where t.id = ${id} and t.workspace_id = ${workspaceId}`;
    if (!r) throw new ApiProblemError('NOT_FOUND');
    return toTradeDto(r);
  }

  async list(
    workspaceId: string,
    status: string | undefined,
    cursor: string | undefined,
    limit: number,
  ) {
    const cur = decodeCursor(cursor);
    const rows = await this.sql<TradeRow[]>`
      ${SELECT(this.sql)}
       where t.workspace_id = ${workspaceId}
         ${status ? this.sql`and t.status = ${status}` : this.sql``}
         ${cur ? this.sql`and (t.opened_at, t.id) < (${cur.at}, ${cur.id})` : this.sql``}
       order by t.opened_at desc, t.id desc limit ${limit + 1}`;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toTradeDto),
      nextCursor: rows.length > limit && last ? encodeCursor(last.opened_at, last.id) : null,
    };
  }

  /** Recording what the user did elsewhere: stop, targets and notes only. Never an order. */
  async patch(
    id: string,
    userId: string,
    workspaceId: string,
    b: z.infer<typeof TradePatchSchema>,
  ) {
    const cur = await this.get(id, workspaceId);
    if (cur.status !== 'OPEN') throw new ApiProblemError('CONFLICT', 'The trade is closed.');
    await this.sql`
      update trade_records set
        stop_price = ${b.stopPrice === undefined ? cur.stopPrice : b.stopPrice},
        targets = ${b.targets === undefined ? cur.targets : b.targets},
        notes = ${b.notes === undefined ? cur.notes : b.notes}
       where id = ${id} and workspace_id = ${workspaceId} and status = 'OPEN'`;
    return this.emit(workspaceId, userId, await this.get(id, workspaceId));
  }

  async close(
    id: string,
    userId: string,
    workspaceId: string,
    b: z.infer<typeof TradeCloseSchema>,
    takerFeeBps: number,
    ip: string | null,
  ) {
    const cur = await this.get(id, workspaceId);
    if (cur.status !== 'OPEN')
      throw new ApiProblemError('CONFLICT', 'The trade is already closed.');
    // Risk is measured against the stop the trade opened with, not one moved later (a breakeven stop would give R = 0).
    const [opened] = await this.sql<{ s: string | null }[]>`
      select payload->>'initialStop' as s from journal_entries
       where trade_id = ${id} and kind = 'TRADE' and payload->>'event' = 'OPENED' limit 1`;
    const riskStop = opened?.s != null ? Number(opened.s) : cur.stopPrice;
    const r =
      cur.entryPrice === null
        ? null
        : realizedR(
            cur.direction,
            cur.entryPrice,
            b.exitPrice,
            riskStop,
            takerFeeBps,
            cur.size,
            b.fee,
          );
    const done = await this.sql.begin(async (tx) => {
      const [u] = await tx<{ id: string }[]>`
        update trade_records set status = 'CLOSED', close_reason = ${b.reason}, realized_r = ${r}, closed_at = now()
         where id = ${id} and workspace_id = ${workspaceId} and status = 'OPEN' returning id`;
      if (!u) return false;
      await tx`
        insert into trade_fills (trade_id, side, fill_time, price, size, fee)
        values (${id}, 'EXIT', now(), ${b.exitPrice}, ${cur.size ?? 0}, ${b.fee ?? null})`;
      await tx`
        insert into journal_entries (workspace_id, user_id, setup_id, plan_id, trade_id, kind, payload)
        values (${workspaceId}, ${userId}, ${cur.setupId}, ${cur.planId}, ${id}, 'TRADE',
                ${tx.json({ event: 'CLOSED', reason: b.reason, realizedR: r })})`;
      return true;
    });
    if (!done) throw new ApiProblemError('CONFLICT', 'The trade is already closed.');
    await this.account.audit(userId, workspaceId, 'trade.close', id, ip, { reason: b.reason });
    return this.emit(workspaceId, userId, await this.get(id, workspaceId));
  }

  async openFor(workspaceId: string): Promise<TradeDto[]> {
    const rows = await this.sql<TradeRow[]>`
      ${SELECT(this.sql)} where t.workspace_id = ${workspaceId} and t.status = 'OPEN'`;
    return rows.map(toTradeDto);
  }
}
