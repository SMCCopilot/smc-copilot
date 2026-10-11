import { z } from 'zod';

export const VENUE_TERMS_DECISIONS = [
  'DISPLAY_OK',
  'INTERNAL_ONLY',
  'BYO_ONLY',
  'PROHIBITED',
] as const;

/** Evidence for a licence decision (spike S5). Recording it is what can ever move an instrument off INTERNAL_ONLY. */
export const VenueTermsInputSchema = z.strictObject({
  url: z.url().max(500),
  retrievedAt: z.iso.date(),
  summary: z.string().min(10).max(2000),
  decision: z.enum(VENUE_TERMS_DECISIONS),
  reviewer: z.string().min(1).max(120),
  counselReviewed: z.boolean().default(false),
});
export type VenueTermsInput = z.infer<typeof VenueTermsInputSchema>;

export const VenuePatchSchema = z
  .strictObject({
    enabled: z.boolean().optional(),
    analysisEnabled: z.boolean().optional(),
    crosscheckEnabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'at least one field is required' });
export type VenuePatch = z.infer<typeof VenuePatchSchema>;
