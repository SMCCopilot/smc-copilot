import { Controller, Get } from '@nestjs/common';
import { ApiProblemError } from '../common/problem.js';
import { ReadinessService } from './readiness.js';

@Controller()
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /** Liveness: the process is up and the event loop is turning. Never touches a dependency. */
  @Get('healthz')
  healthz(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: 200 only when every dependency check passes (B02 section 4: engine warm-up joins this later). */
  @Get('readyz')
  async readyz(): Promise<{ status: 'ready'; checks: Record<string, 'ok' | 'fail'> }> {
    const report = await this.readiness.report();
    if (!report.ready) {
      throw new ApiProblemError('NOT_READY', 'One or more dependencies are not ready.', {
        checks: report.checks,
      });
    }
    return { status: 'ready', checks: report.checks };
  }
}
