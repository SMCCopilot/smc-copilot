import { describe, expect, it } from 'vitest';
import { VOICE_FORBIDDEN_ACTIONS } from '../src/voice.js';
import { buildGlossary, correctTranscript } from '../src/voice-glossary.js';
import { forbiddenByVoice, parseVoiceCommand } from '../src/voice-grammar.js';

const g = buildGlossary(['BTC', 'ETH', 'SOL', 'PEPE']);

describe('transcript correction', () => {
  it.each([
    ['bee tee see perp', 'BTC perp'],
    ['switch to b t c', 'switch to BTC'],
    ['show ethereum perpetual', 'show ETH perp'],
    ['what is a choke', 'what is a CHoCH'],
    ['there was a boss on the four hour', 'there was a BOS on the 4h'],
    ['mark the fair value gap', 'mark the FVG'],
    ['switch to fifteen minute', 'switch to 15m'],
    ['show the one hour chart', 'show the 1h chart'],
    ['look at pepe', 'look at PEPE'],
    ['where is the liquidty', 'where is the liquidity'],
    ['explain this chart', 'explain this chart'],
  ])('%s -> %s', (heard, want) => {
    expect(correctTranscript(heard, g).text).toBe(want);
  });

  it('reports what it changed, and changes nothing in ordinary speech', () => {
    const r = correctTranscript('bee tee see perp', g);
    expect(r.changes.length).toBeGreaterThan(0);
    expect(correctTranscript('what is the current bias', g).changes).toEqual([]);
  });

  it('is deterministic', () => {
    expect(correctTranscript('b t c choke', g)).toEqual(correctTranscript('b t c choke', g));
  });
});

describe('command grammar', () => {
  it.each([
    ['explain this chart', { command: 'EXPLAIN_CHART' }],
    ['Switch to 15m.', { command: 'SWITCH_TF', tf: '15m' }],
    ['switch to the 4h chart', { command: 'SWITCH_TF', tf: '4h' }],
    ['go to daily', { command: 'SWITCH_TF', tf: '1d' }],
    ['switch to ETH perp', { command: 'SWITCH_INSTRUMENT', text: 'eth perp' }],
    ['next setup', { command: 'SHOW_SETUP', ordinal: 'NEXT' }],
    ['previous setup', { command: 'SHOW_SETUP', ordinal: 'PREVIOUS' }],
    ['show setup 2', { command: 'SHOW_SETUP', ordinal: 2 }],
    ['show setup three', { command: 'SHOW_SETUP', ordinal: 3 }],
    ['watch this setup', { command: 'WATCH_SETUP', watch: true }],
    ['stop watching this setup', { command: 'WATCH_SETUP', watch: false }],
    ['pause', { command: 'PAUSE_RESUME', resume: false }],
    ['resume', { command: 'PAUSE_RESUME', resume: true }],
    ['mute', { command: 'MUTE', muted: true }],
    ['unmute', { command: 'MUTE', muted: false }],
    ['note waited for the sweep', { command: 'JOURNAL_NOTE', note: 'waited for the sweep' }],
  ])('%s', (text, want) => {
    expect(parseVoiceCommand(text)).toEqual(want);
  });

  it('does not turn a setup request into an instrument switch', () => {
    expect(parseVoiceCommand('show setup banana')).toBeNull();
  });
  it('never produces anything that moves money or data', () => {
    for (const t of [
      'confirm the trade',
      'buy bitcoin',
      'sell everything',
      'log this trade',
      'delete my account',
      'place an order',
    ]) {
      const c = parseVoiceCommand(t);
      expect(c === null || c.command === 'SWITCH_INSTRUMENT').toBe(c === null ? true : false);
    }
    expect(parseVoiceCommand('confirm the trade')).toBeNull();
    expect(parseVoiceCommand('buy bitcoin')).toBeNull();
    expect(parseVoiceCommand('delete my account')).toBeNull();
  });
});

describe('forbidden by voice', () => {
  it.each([
    ['confirm the trade', 'confirm_trade'],
    ['confirm the gate', 'confirm_gate'],
    ['approve my plan', 'confirm_gate'],
    ['place the order', 'confirm_trade'],
    ['log this trade', 'log_trade'],
    ['change my risk', 'change_risk'],
    ['raise my leverage', 'change_risk'],
    ['delete my account', 'delete_account'],
    ['delete my journal', 'delete_data'],
    ['upgrade my plan', 'pay'],
  ])('%s is %s', (text, action) => {
    expect(forbiddenByVoice(text)).toBe(action);
    expect(VOICE_FORBIDDEN_ACTIONS).toContain(action);
  });
  it('lets ordinary requests through', () => {
    expect(forbiddenByVoice('explain this chart')).toBeNull();
    expect(forbiddenByVoice('what is an order block')).toBeNull();
  });
});

describe('review regressions', () => {
  it.each([
    'show me the risks',
    'open the journal',
    'go to bed',
    'show the risks',
    'switch to something odd',
    'open settings',
  ])('a request that is not a market is not a market switch: %s', (t) => {
    expect(parseVoiceCommand(t)).toBeNull();
  });
  it('a recognised market is still a switch', () => {
    expect(parseVoiceCommand('show SOL perp')).toEqual({
      command: 'SWITCH_INSTRUMENT',
      text: 'sol perp',
    });
    expect(parseVoiceCommand('open BTC')).toEqual({ command: 'SWITCH_INSTRUMENT', text: 'btc' });
  });
  it.each([
    ['zero-width space', 'confirm\u200B the gate'],
    ['soft hyphen', 'con\u00ADfirm the trade'],
    ['cyrillic a', 'confirm the g\u0430te'],
    ['fullwidth letters', '\uFF43onfirm the trade'],
    ['doubled spaces', 'confirm   the    trade'],
  ])('invisible or lookalike characters do not dodge the refusal: %s', (_n, t) => {
    expect(forbiddenByVoice(t)).not.toBeNull();
  });
  it('normalisation also reaches the grammar', () => {
    expect(parseVoiceCommand('explain\u200B this chart')).toEqual({ command: 'EXPLAIN_CHART' });
  });
  it('ordinary words that are also assets are not rewritten', () => {
    const g2 = buildGlossary(['ONE', 'LINK', 'GAS', 'TIME', 'PEPE']);
    expect(correctTranscript('show setup one', g2).text).toBe('show setup 1');
    expect(correctTranscript('open the link at one', g2).text).toBe('open the link at one');
    expect(correctTranscript('look at pepe', g2).text).toBe('look at PEPE');
  });
  it('"pay attention" is a question, "pay the invoice" is refused', () => {
    expect(forbiddenByVoice('pay attention to the order block')).toBeNull();
    expect(forbiddenByVoice('pay the invoice')).toBe('pay');
    expect(forbiddenByVoice('upgrade my plan')).toBe('pay');
  });
});
