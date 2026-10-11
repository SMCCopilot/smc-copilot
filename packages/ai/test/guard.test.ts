import { describe, expect, it } from 'vitest';
import { checkRefs, formatPrice, refSpaceOf, scanNumbers, substitute } from '../src/guard.js';
import { checkLexicon } from '../src/lexicon.js';
import { checkProse } from '../src/pipeline.js';
import { FACTS } from './helpers.js';

/** A corpus of 50 outputs: 25 that must be rejected and 25 that must pass. */
const BAD: [string, string][] = [
  ['price literal', 'Price is sitting at 64020 right now.'],
  ['price with comma', 'The high is 64,450 and the low 63,960.'],
  ['decimal price', 'The level is 1.0852 on the chart.'],
  ['dollar amount', 'You could risk $500 here.'],
  ['k suffix', 'A move to 65k is likely.'],
  ['k suffix decimal', 'Targeting 64.5k next.'],
  ['four digit alone', 'It sweeps 2050 and reverses.'],
  ['unknown reference style', 'The level at 63960.5 holds.'],
  ['buy now', 'Buy now at the order block.'],
  ['sell here', 'Sell here and wait for the drop.'],
  ['you should enter', 'You should enter a long at the zone.'],
  ['you must close', 'You must close the position below the low.'],
  ['take this trade', 'Take this trade with a tight stop.'],
  ['enter a long', 'Enter a long at the retest.'],
  ['guaranteed', 'This setup is guaranteed to work.'],
  ['for sure', 'Price will bounce for sure.'],
  ['risk free', 'A risk-free entry at the zone.'],
  ['certainly', 'It will certainly reach the target.'],
  ['price will go', 'Price will go up from here.'],
  ['btc will rise', 'BTC will rise to the next liquidity pool.'],
  ['easy money', 'This is easy money for patient traders.'],
  ['i recommend', 'I recommend taking the long.'],
  ['my advice', 'My advice is to wait for the sweep.'],
  ['use leverage', 'Use high leverage to get more out of it.'],
  ['100 percent', 'A 100% safe pattern.'],
];
const GOOD: string[] = [
  'The 4h structure is bullish after a break of structure.',
  'If price holds {{Z:Z3}}, the long idea stays valid.',
  'If price closes below {{L:L9}}, the idea is invalidated.',
  'Liquidity above {{L:L4}} is the next area price may be drawn to.',
  'There is not enough history to quote a base rate.',
  'The 15m order block is untested.',
  'Price swept sell-side liquidity at {{L:L7}} and reacted.',
  'On the 1h, momentum is slowing near the premium of the range.',
  'The engine reports a data warning; treat this as provisional.',
  'A close beyond the invalidation weakens the bullish reading.',
  'The entry zone sits in discount, near 0.618 of the range.',
  'The OTE band between 0.62 and 0.79 overlaps the order block.',
  'This is a 1:2 reward to risk idea if the first target is reached.',
  'Confidence is low because the history is limited.',
  'The alternate reading is that the sweep continues lower.',
  'Weekend liquidity is thin, so moves can be erratic.',
  'The bias timeframes disagree, which lowers the grade.',
  "It is the reader's decision whether any of this fits their plan.",
  'The setup was rejected because the break was close to the previous high.',
  'The killzone is active, which the engine scores slightly higher.',
  'Equal lows form a pool of sell-side liquidity.',
  'A fair value gap formed during the displacement.',
  'The last break of structure on the 4h was bullish.',
  'If the zone fails, the next level of interest is {{L:L7}}.',
  'Volatility is elevated relative to the last 14 candles.',
];

describe('shared output checks, 50-case corpus', () => {
  it.each(BAD)('rejects: %s', (_n, text) => {
    expect(checkProse([text]).length).toBeGreaterThan(0);
  });
  it.each(GOOD.map((t) => [t.slice(0, 60), t] as const))('accepts: %s', (_n, text) => {
    expect(checkProse([text])).toEqual([]);
  });
});

describe('number scan details', () => {
  it('ignores digits inside placeholders and short timeframe numbers', () => {
    expect(scanNumbers('{{L:L7}} and 15m and 4h and 1:2 and the 0.618 retracement')).toEqual([]);
  });
  it('reports each offending literal once', () => {
    expect(scanNumbers('64020 then 64020 then 63,960').sort()).toEqual(['63,960', '64020']);
  });
});

describe('lexicon', () => {
  it('names the rule that fired', () => {
    expect(checkLexicon('You should buy now.').map((h) => h.rule)).toContain('IMPERATIVE_TRADE');
    expect(checkLexicon('guaranteed').map((h) => h.rule)).toContain('CERTAINTY');
  });
  it('lets ordinary trading vocabulary through', () => {
    expect(checkLexicon('The buy-side liquidity was taken; sellers stepped in.')).toEqual([]);
  });
});

describe('references and substitution', () => {
  const space = refSpaceOf(FACTS, 2);
  it('flags an unknown placeholder, a malformed one and an unknown id', () => {
    expect(checkRefs(['see {{L:NOPE}}'], [], space)).not.toEqual([]);
    expect(checkRefs(['see {{L:L7'], [], space)).not.toEqual([]);
    expect(checkRefs(['{{STAT:rate}}'], [], space)).not.toEqual([]);
    expect(checkRefs([], ['X99'], space)).not.toEqual([]);
    expect(checkRefs(['{{L:L7}} {{Z:Z3}}'], ['L7', 'S19', 'E41'], space)).toEqual([]);
  });
  it('substitutes levels and zones with the instrument precision', () => {
    expect(substitute('at {{L:L7}} in {{Z:Z3}}', space)).toBe(
      'at 64,020.00 in 64,040.00 to 64,110.00',
    );
    expect(formatPrice(1.08523, 4)).toBe('1.0852');
  });
});

describe('evasion and invented statistics', () => {
  it.each([
    ['a 70% win rate', 'Setups like this win 70% of the time.'],
    ['short price', 'SOL is near 150.5 today.'],
    ['three digits', 'Price is at 150 now.'],
    ['spaced thousands', 'It sits around 65 000.'],
    ['number words', 'It is near sixty-five thousand.'],
    ['fullwidth digits', 'Price is ６５０００.'],
    ['zero-width split', 'Price is 65​000 now.'],
    ['zero-width in a banned phrase', 'It w​ill rise from here, price will go up.'],
    ['soft hyphen', 'This is guar­anteed.'],
  ])('rejects: %s', (_n, text) => {
    expect(checkProse([text]).length).toBeGreaterThan(0);
  });
  it('still accepts ordinary short numbers and timeframes', () => {
    expect(checkProse(['On the 15m chart there are 2 zones and 3 levels, a 1:2 idea.'])).toEqual(
      [],
    );
  });
});
