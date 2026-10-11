export interface BreakerOptions {
  failures: number;
  windowMs: number;
  cooldownMs: number;
}
export const DEFAULT_BREAKER: BreakerOptions = {
  failures: 5,
  windowMs: 60_000,
  cooldownMs: 30_000,
};

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/** Opens after N failures inside the window, lets one probe through after the cooldown (A05 section 10). */
export class CircuitBreaker {
  private fails: number[] = [];
  private openedAt = 0;
  private state: State = 'CLOSED';
  private probing = false;

  constructor(
    private readonly now: () => number,
    private readonly opts: BreakerOptions = DEFAULT_BREAKER,
  ) {}

  /** True when a call may go ahead. In HALF_OPEN only one probe is allowed at a time. */
  allow(): boolean {
    if (this.state === 'CLOSED') return true;
    if (this.state === 'OPEN') {
      if (this.now() - this.openedAt < this.opts.cooldownMs) return false;
      this.state = 'HALF_OPEN';
    }
    if (this.probing) return false;
    this.probing = true;
    return true;
  }

  success(): void {
    this.state = 'CLOSED';
    this.fails = [];
    this.probing = false;
  }

  failure(): void {
    const t = this.now();
    this.probing = false;
    if (this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.openedAt = t;
      return;
    }
    this.fails = this.fails.filter((x) => t - x < this.opts.windowMs);
    this.fails.push(t);
    if (this.fails.length >= this.opts.failures) {
      this.state = 'OPEN';
      this.openedAt = t;
    }
  }

  get current(): State {
    return this.state;
  }
}
