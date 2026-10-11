// The 200-phrase voice set (A05 section 14.4). `say` is what a person reads aloud; `heard` is what a speech engine
// typically writes for it (punctuation, capitals, homophones, spelled-out letters). Expectations apply to the text AFTER
// glossary correction, which is the transcript the product acts on.
//
// For a real engine test the owner reads the `say` column aloud (pnpm voice:eval --print-script) and the engine's output
// replaces `heard`; the same expectations then measure the engine and the correction together.

const P = (category, say, heard, expect = {}) => ({ category, say, heard, expect });

const commands = [
  // explain
  ...[
    ['explain this chart', 'Explain this chart.'],
    ['explain this chart', 'explain the chart'],
    ['please explain this chart', 'Please explain this chart!'],
    ['explain the chart', 'Explain the chart'],
    ['explain this chart', 'explain this chart'],
  ].map(([s, h]) => P('command', s, h, { command: 'EXPLAIN_CHART' })),
  // timeframes
  ...[
    ['switch to fifteen minute', 'Switch to 15 minute.', '15m'],
    ['switch to fifteen minute', 'switch to fifteen minute', '15m'],
    ['go to the four hour chart', 'Go to the 4 hour chart.', '4h'],
    ['switch to four hour', 'switch to four hour', '4h'],
    ['show the one hour chart', 'show the 1 hour chart', '1h'],
    ['switch to one hour', 'Switch to one hour.', '1h'],
    ['go to daily', 'Go to daily', '1d'],
    ['switch to daily', 'switch to daily.', '1d'],
    ['switch to five minute', 'Switch to 5 minute', '5m'],
    ['show five minute', 'show five minutes', '5m'],
    ['switch to 15m', 'switch to 15m', '15m'],
    ['switch to 4h', 'Switch to 4h.', '4h'],
    ['go to one minute', 'go to one minute', '1m'],
    ['show thirty minute', 'Show 30 minute', '30m'],
    ['switch to weekly', 'switch to weekly', '1w'],
    ['go to the hourly chart', 'go to the hourly chart', '1h'],
  ].map(([s, h, tf]) => P('command', s, h, { command: 'SWITCH_TF', arg: tf })),
  // setups
  ...[
    ['next setup', 'Next setup.'],
    ['next setup', 'next setup'],
    ['show the next setup', 'Show the next setup'],
  ].map(([s, h]) => P('command', s, h, { command: 'SHOW_SETUP', arg: 'NEXT' })),
  ...[
    ['previous setup', 'previous setup.'],
    ['last setup', 'Last setup'],
    ['show the previous setup', 'show the previous setup'],
  ].map(([s, h]) => P('command', s, h, { command: 'SHOW_SETUP', arg: 'PREVIOUS' })),
  ...[
    ['show setup two', 'Show setup 2.'],
    ['show setup one', 'show setup one'],
    ['show setup three', 'Show setup three'],
    ['show setup 4', 'show setup 4'],
    ['show setup five', 'Show set up five'.replace('set up', 'setup')],
  ].map(([s, h], i) => P('command', s, h, { command: 'SHOW_SETUP', arg: [2, 1, 3, 4, 5][i] })),
  ...[
    ['watch this setup', 'Watch this setup.'],
    ['follow the setup', 'follow the setup'],
    ['watch the setup', 'watch the setup'],
  ].map(([s, h]) => P('command', s, h, { command: 'WATCH_SETUP', arg: true })),
  ...[
    ['stop watching this setup', 'Stop watching this setup.'],
    ['unwatch this setup', 'unwatch this setup'],
  ].map(([s, h]) => P('command', s, h, { command: 'WATCH_SETUP', arg: false })),
  // session
  ...[
    ['pause', 'Pause.'],
    ['stop listening', 'stop listening'],
    ['pause', 'pause'],
  ].map(([s, h]) => P('command', s, h, { command: 'PAUSE_RESUME', arg: false })),
  ...[
    ['resume', 'Resume.'],
    ['continue', 'Continue'],
    ['resume', 'resume'],
  ].map(([s, h]) => P('command', s, h, { command: 'PAUSE_RESUME', arg: true })),
  ...[
    ['mute', 'Mute.'],
    ['be quiet', 'be quiet'],
    ['silence', 'Silence'],
  ].map(([s, h]) => P('command', s, h, { command: 'MUTE', arg: true })),
  ...[
    ['unmute', 'Unmute.'],
    ['speak again', 'speak again'],
  ].map(([s, h]) => P('command', s, h, { command: 'MUTE', arg: false })),
  // instruments
  ...[
    ['switch to ETH perp', 'Switch to e t h perp.'],
    ['switch to bitcoin perp', 'switch to bitcoin perpetual'],
    ['go to BTC', 'go to bee tee see'],
    ['show solana perp', 'Show solana perp'],
    ['switch to ethereum spot', 'Switch to ethereum spot'],
    ['open BTC perp', 'open b t c perp'],
    ['switch to bitcoin', 'Switch to bitcoin.'],
    ['go to ETH', 'go to eth'],
    ['switch to ripple', 'switch to ripple perp'],
    ['show dogecoin', 'show doge coin'],
    ['switch to cardano', 'Switch to cardano.'],
  ].map(([s, h]) => P('command', s, h, { command: 'SWITCH_INSTRUMENT' })),
  // notes
  ...[
    ['switch to 1h', 'Switch to 1h.', '1h'],
    ['go to 1d', 'go to 1d', '1d'],
    ['show 5m', 'Show 5m', '5m'],
    ['switch to 30m', 'switch to 30m', '30m'],
    ['go to the 15 minute chart', 'Go to the 15 minute chart', '15m'],
    ['show the four hour chart', 'show the 4 hour chart.', '4h'],
    ['switch to the daily chart', 'Switch to the daily chart', '1d'],
    ['go to one hour', 'go to 1 hour', '1h'],
    ['show the hourly chart', 'Show the hourly chart', '1h'],
    ['switch to the fifteen minute timeframe', 'switch to the fifteen minute timeframe', '15m'],
    ['go to the weekly chart', 'Go to the weekly chart.', '1w'],
    ['switch to the five minute chart', 'switch to the 5 minute chart', '5m'],
  ].map(([s, h, tf]) => P('command', s, h, { command: 'SWITCH_TF', arg: tf })),
  ...[
    ['show setup two', 'show setup too'],
    ['show setup four', 'Show setup for'],
    ['next setup', 'Next set up'],
    ['watch this setup', 'watch this set up'],
    ['explain this chart', 'explain this chart.'],
  ].map(([s, h], i) =>
    P(
      'command',
      s,
      h,
      i === 0
        ? { command: 'SHOW_SETUP', arg: 2 }
        : i === 1
          ? { command: 'SHOW_SETUP', arg: 4 }
          : i === 2
            ? { command: 'SHOW_SETUP', arg: 'NEXT' }
            : i === 3
              ? { command: 'WATCH_SETUP', arg: true }
              : { command: 'EXPLAIN_CHART' },
    ),
  ),
  ...[
    ['note waited for the sweep', 'Note: waited for the sweep.'],
    ['note entry was too early', 'note entry was too early'],
    ['journal I felt rushed', 'Journal, I felt rushed.'],
    ['note stop was respected', 'Note stop was respected'],
  ].map(([s, h]) => P('command', s, h, { command: 'JOURNAL_NOTE' })),
];

const jargon = [
  ['what is a choke', 'what is a choke', 'CHoCH'],
  ['explain choke', 'explain chalk', 'CHoCH'],
  ['is that a choc', 'is that a choc', 'CHoCH'],
  ['change of character', 'change of character', 'CHoCH'],
  ['was that a boss', 'was that a boss', 'BOS'],
  ['break of structure', 'break of structure', 'BOS'],
  ['b o s on the daily', 'b o s on the daily', 'BOS'],
  ['bee oh ess', 'bee oh ess', 'BOS'],
  ['where is the fair value gap', 'where is the fair value gap', 'FVG'],
  ['f v g', 'f v g', 'FVG'],
  ['mark the fair value gaps', 'mark the fair value gaps', 'FVG'],
  ['eff vee gee', 'eff vee gee', 'FVG'],
  ['order block', 'order blog', 'order block'],
  ['which order blocks', 'which order blocks', 'order block'],
  ['ordered block', 'ordered block', 'order block'],
  ['o t e zone', 'o t e zone', 'OTE'],
  ['optimal trade entry', 'optimal trade entry', 'OTE'],
  ['equal highs', 'equal highs', 'EQH'],
  ['e q h', 'e q h', 'EQH'],
  ['equal lows', 'equal lows', 'EQL'],
  ['e q l', 'e q l', 'EQL'],
  ['a t r', 'a t r', 'ATR'],
  ['average true range', 'average true range', 'ATR'],
  ['kill zone', 'kill zone', 'killzone'],
  ['kill zones', 'kill zones', 'killzone'],
  ['liquidity', 'liquid ity', 'liquidity'],
  ['liquidity pool', 'liquidy pool', 'liquidity'],
  ['premium and discount', 'premier and discount', 'premium'],
  ['displacement', 'displace meant', 'displacement'],
  ['inducement', 'in deuce meant', 'inducement'],
].map(([s, h, term]) => P('jargon', s, h, { contains: term }));

const symbols = [
  ['BTC perp', 'bee tee see perp', 'BTC perp'],
  ['b t c', 'b t c', 'BTC'],
  ['bitcoin', 'bit coin', 'BTC'],
  ['ETH', 'e t h', 'ETH'],
  ['ethereum', 'ethereum', 'ETH'],
  ['ether perp', 'ether perp', 'ETH perp'],
  ['SOL', 's o l', 'SOL'],
  ['solana', 'solana', 'SOL'],
  ['solana perpetual', 'solana perpetual', 'SOL perp'],
  ['XRP', 'x r p', 'XRP'],
  ['ripple', 'ripple', 'XRP'],
  ['BNB', 'b n b', 'BNB'],
  ['doge', 'doge', 'DOGE'],
  ['dogecoin', 'doge coin', 'DOGE'],
  ['cardano', 'cardano', 'ADA'],
  ['ADA', 'a d a', 'ADA'],
  ['avalanche', 'avalanche', 'AVAX'],
  ['chainlink', 'chain link', 'LINK'],
  ['BTC spot', 'bitcoin spot', 'BTC spot'],
  ['ETH spot', 'ethereum spot', 'ETH spot'],
  ['BTC and ETH', 'bitcoin and ethereum', 'BTC and ETH'],
  ['compare BTC and SOL', 'compare bitcoin and solana', 'compare BTC and SOL'],
  ['bee tee see on the four hour', 'bee tee see on the four hour', 'BTC on the 4h'],
  ['ETH on fifteen minute', 'e t h on fifteen minute', 'ETH on 15m'],
  ['SOL on the one hour', 's o l on the one hour', 'SOL on the 1h'],
  ['BTC perp four hour', 'b t c perp four hour', 'BTC perp 4h'],
  ['ethereum perp daily', 'ethereum perp daily', 'ETH perp daily'],
  ['bitcoin perpetual fifteen minute', 'bitcoin perpetual fifteen minute', 'BTC perp 15m'],
  ['b t c perk', 'b t c perk', 'BTC perp'],
  ['purp on solana', 'purp on solana', 'perp on SOL'],
].map(([s, h, out]) => P('symbol', s, h, { text: out.toLowerCase() === out ? out : out }));

const questions = [
  'what is the current bias',
  'why is this setup graded a',
  'where is the invalidation',
  'what does the engine say about the higher timeframe',
  'is the data fresh',
  'what is the alternate scenario',
  'how was the stop chosen',
  'what is premium and discount',
  'what happened at the sweep',
  'which zone is the point of interest',
  'tell me about liquidity',
  'what is an order block',
  'how does the killzone matter',
  'what are the risks here',
  'summarise the analysis',
  'what is a fair value gap',
  'why did price reverse',
  'what would weaken the bias',
  'explain the plan in simple words',
  'what is the target based on',
  'how many setups are active',
  'what does grade b mean',
  'what is the difference between a boss and a choke',
  'walk me through the scenarios',
  'is this a trend or a range',
  'what is equal highs liquidity',
  'what is mitigation',
  'how does displacement work',
  'what timeframe is the bias',
  'what is the risk calculator for',
  'show me the risks',
  'open the journal and tell me about it',
  'go to bed with a clear plan',
  'pay attention to the order block',
  'show me why this is graded b',
  'what does the upgrade of structure mean',
].map((q) => P('question', q, `${q[0].toUpperCase()}${q.slice(1)}?`, { command: null }));

const forbidden = [
  ['confirm the trade', 'confirm_trade'],
  ['confirm my trade', 'confirm_trade'],
  ['place the order', 'confirm_trade'],
  ['place an order', 'confirm_trade'],
  ['submit my order', 'confirm_trade'],
  ['execute the trade', 'confirm_trade'],
  ['confirm the gate', 'confirm_gate'],
  ['approve the plan', 'confirm_gate'],
  ['approve my plan', 'confirm_gate'],
  ['authorise the gate', 'confirm_gate'],
  ['accept the plan', 'confirm_gate'],
  ['log this trade', 'log_trade'],
  ['log my trade', 'log_trade'],
  ['log the trade', 'log_trade'],
  ['change my risk', 'change_risk'],
  ['raise my risk', 'change_risk'],
  ['lower the risk', 'change_risk'],
  ['set my risk', 'change_risk'],
  ['increase my leverage', 'change_risk'],
  ['reduce my leverage', 'change_risk'],
  ['delete my account', 'delete_account'],
  ['delete account', 'delete_account'],
  ['delete my data', 'delete_data'],
  ['delete my journal', 'delete_data'],
  ['erase my history', 'delete_data'],
  ['wipe everything', 'delete_data'],
  ['remove my data', 'delete_data'],
  ['upgrade my plan', 'pay'],
  ['subscribe me', 'pay'],
  ['pay the invoice', 'pay'],
].map(([s, a]) => P('forbidden', s, `${s[0].toUpperCase()}${s.slice(1)}.`, { forbidden: a }));

export const PHRASES = [...commands, ...jargon, ...symbols, ...questions, ...forbidden].map(
  (p, i) => ({ id: i + 1, ...p }),
);
