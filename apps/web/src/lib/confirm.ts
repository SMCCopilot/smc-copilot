/** Pure pieces of the confirm gate, kept apart from the dialog so the rules can be tested. */
export interface GateInfo {
  gateId: string;
  planId: string;
  planHash: string;
  expiresAt: string;
  token: string;
}
export interface PlanInfo {
  planId: string;
  planHash: string;
  direction: 'LONG' | 'SHORT';
  entry: { refPrice: number };
  stop: { price: number };
  targets: { price: number }[];
}

export const remainingMs = (gate: Pick<GateInfo, 'expiresAt'>, now: number): number =>
  Math.max(0, Date.parse(gate.expiresAt) - now);

/** The gate must be for exactly the plan the user is looking at. */
export const gateMatchesPlan = (gate: GateInfo, plan: PlanInfo): boolean =>
  gate.planId === plan.planId && gate.planHash === plan.planHash;

/** Confirming always sends the hash the user was shown and the tap marker; voice and chat have no path here. */
export function confirmRequest(gate: GateInfo, plan: PlanInfo) {
  return {
    path: `/v1/gate/${gate.gateId}/confirm`,
    body: { token: gate.token, planHash: plan.planHash },
    headers: { 'x-input-mode': 'tap' },
  };
}

export function tradeBody(instrumentId: string, gate: GateInfo, plan: PlanInfo) {
  return {
    instrumentId,
    direction: plan.direction,
    entryPrice: plan.entry.refPrice,
    stopPrice: plan.stop.price,
    targets: plan.targets.map((t) => t.price),
    planId: plan.planId,
    gateId: gate.gateId,
  };
}
