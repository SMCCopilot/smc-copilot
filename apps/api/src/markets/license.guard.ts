import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { ApiProblemError } from '../common/problem.js';
import { MarketsService } from './markets.service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Egress guard (invariant 6): raw prices and candles leave the server only for an instrument whose effective class,
 * read from the `instrument_license` view and never from `instruments.license_class`, is DISPLAY_OK. Default for every
 * instrument is INTERNAL_ONLY until a venue_terms row says otherwise.
 */
@Injectable()
export class LicenseGuard implements CanActivate {
  constructor(private readonly markets: MarketsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const id = context.switchToHttp().getRequest<Request>().params.id;
    if (typeof id !== 'string') throw new ApiProblemError('NOT_FOUND');
    // Guards run before the route's ParseUUIDPipe; a malformed id must be a 4xx, not a database cast error.
    if (!UUID.test(id))
      throw new ApiProblemError('VALIDATION_FAILED', 'The instrument id is not valid.');
    const effective = await this.markets.effectiveLicense(id);
    if (effective === undefined) throw new ApiProblemError('NOT_FOUND');
    if (effective !== 'DISPLAY_OK') {
      throw new ApiProblemError(
        'FEED_LICENSE_RESTRICTED',
        'Raw prices for this instrument are not available; analysis and levels are.',
      );
    }
    return true;
  }
}
