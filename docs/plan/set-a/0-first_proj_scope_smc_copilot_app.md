# Auto Pilot Trading System --- Developer-Ready PRD

**Document status:** Development Specification\
**Version:** 1.0\
**Primary research case:** EUR/USD\
**Purpose:** Build the first production-ready foundation of an automated
market-analysis and trade-execution system, using the accumulated
EUR/USD observations as the initial behavioral reference while keeping
the engine instrument-agnostic.

NOTE: EUR/USD are currency samples used, the project is not limited to just EUR/USD

------------------------------------------------------------------------

## 1. Executive Summary

SMC Co Pilot is an automated trading-analysis and execution platform
designed to turn a defined discretionary trading process into a
repeatable software system.

The system should:

1.  ingest live and historical market data;
2.  normalize and store that data;
3.  identify market context and structure;
4.  detect candidate setups;
5.  score setups against explicit rules;
6.  apply risk and trade-management constraints;
7.  produce a proposed trade;
8.  execute only when the configured operating mode permits it;
9.  monitor open positions;
10. record every decision and market event;
11. learn from accumulated observations without silently changing
    production behavior.

The EUR/USD case study gathered so far is the initial source of
behavioral observations. It must **not** be hardcoded as a single
pair-specific strategy. The architecture must allow additional
instruments to be added later without rewriting the signal engine.

### Core principle

> **Auto Pilot should reproduce a clearly defined decision process, not
> invent trades.**

The system must be deterministic where rules are deterministic,
auditable where decisions are model-assisted, and conservative when
information is incomplete.

------------------------------------------------------------------------

# 2. Product Goals

## 2.1 Primary goals

-   Convert the existing manual market-observation workflow into
    executable rules.
-   Create a reliable market-data pipeline.
-   Separate market analysis from execution.
-   Make every trade decision explainable.
-   Support historical replay and backtesting before live deployment.
-   Support paper/simulation mode before real execution.
-   Provide strong risk controls and emergency shutdown mechanisms.
-   Preserve a complete decision journal.
-   Allow additional currency pairs and instruments to be introduced
    incrementally.
-   Make strategy parameters configurable rather than embedded in
    application code.

## 2.2 Secondary goals

-   Provide a dashboard for system state and decisions.
-   Show why a setup passed or failed.
-   Compare actual market outcomes against the original setup thesis.
-   Collect structured examples for later strategy refinement.
-   Support multiple strategy versions.
-   Make it possible to run the same strategy against different
    instruments and timeframes.

## 2.3 Non-goals for V1

The following should not be part of the initial release:

-   unrestricted autonomous strategy invention;
-   automatic modification of production strategy rules;
-   opaque "AI says buy/sell" decisions without traceable inputs;
-   uncontrolled high-frequency trading;
-   leverage optimization as a primary objective;
-   deploying real capital before sufficient simulation validation;
-   assuming EUR/USD behavior automatically applies to every instrument.

------------------------------------------------------------------------

# 3. Product Philosophy

Auto Pilot is not simply a bot that generates BUY and SELL signals.

It is a pipeline:

``` text
MARKET DATA
    ↓
DATA VALIDATION
    ↓
MARKET CONTEXT
    ↓
STRUCTURE ANALYSIS
    ↓
SETUP DETECTION
    ↓
SETUP SCORING
    ↓
RISK VALIDATION
    ↓
TRADE PLAN
    ↓
EXECUTION GATE
    ↓
ORDER EXECUTION
    ↓
POSITION MONITORING
    ↓
TRADE MANAGEMENT
    ↓
JOURNAL + OUTCOME
    ↓
RESEARCH / VALIDATION
```

Every stage must have a clear input, output and failure state.

------------------------------------------------------------------------

# 4. Important Interpretation of the Existing EUR/USD Data

The EUR/USD screenshots and observations collected during the research
phase are **training/reference evidence**, not automatically confirmed
strategy rules.

The developer must classify each observation as one of:

-   `OBSERVED`
-   `HYPOTHESIS`
-   `CONFIRMED_RULE`
-   `REJECTED`
-   `INSUFFICIENT_DATA`

This distinction is critical.

For example:

``` text
Observation:
"Price reacted from a particular area."

Status:
OBSERVED

Not:
"Always buy from this area."
```

The system must not turn a visual observation into an automated rule
until that behavior has been formally defined and validated.

### Research principle

The first implementation should reproduce the **process used to analyze
EUR/USD**, while allowing the exact thresholds and rules to remain
configurable.

------------------------------------------------------------------------

# 5. Target Users

## Primary user

The system owner/trader who:

-   configures the strategy;
-   reviews market context;
-   monitors system decisions;
-   enables/disables automation;
-   reviews performance;
-   approves progression from simulation to live execution.

## Developer / operator

Responsible for:

-   maintaining the platform;
-   monitoring infrastructure;
-   managing integrations;
-   reviewing logs;
-   testing strategy versions;
-   deploying changes.

------------------------------------------------------------------------

# 6. Operating Modes

Auto Pilot must have explicit modes.

## 6.1 OFF

No market analysis actions that can result in execution.

The application may still display data if configured as a monitoring
dashboard.

## 6.2 ANALYSIS

The engine analyzes markets and generates internal signals but does not
create executable orders.

## 6.3 SIGNAL

The engine generates trade plans and notifications but does not execute
orders.

## 6.4 PAPER

The engine behaves as though it is executing trades against a simulated
account.

All fills, slippage assumptions, fees and outcomes must be simulated and
journaled.

## 6.5 LIVE

The engine may submit real orders through the configured broker/exchange
adapter.

Live mode must require:

-   explicit activation;
-   valid credentials;
-   risk configuration;
-   connectivity validation;
-   account validation;
-   all safety checks passing.

### Critical rule

A strategy update must never silently switch the system into LIVE mode.

------------------------------------------------------------------------

# 7. Supported Instrument Model

Although EUR/USD is the first research instrument, the system must
represent instruments generically.

Example:

``` text
Instrument
├── symbol
├── asset_class
├── base_asset
├── quote_asset
├── price_precision
├── quantity_precision
├── minimum_quantity
├── tick_size
├── contract_size
├── trading_session
└── broker_symbol
```

Initial configuration:

``` text
EUR/USD
Asset class: FX
```

Future instruments can be added through configuration and adapters.

------------------------------------------------------------------------

# 8. Timeframe Architecture

The system should support multi-timeframe analysis.

Example hierarchy:

``` text
Higher timeframe
    ↓
Market regime / directional context
    ↓
Intermediate timeframe
    ↓
Structure + key areas
    ↓
Execution timeframe
    ↓
Entry confirmation
```

The exact timeframe combination must be configurable.

Do not hardcode one timeframe hierarchy into the engine.

Example configuration:

``` yaml
timeframes:
  context: "4H"
  structure: "1H"
  setup: "15m"
  execution: "5m"
```

------------------------------------------------------------------------

# 9. Market Data Pipeline

## 9.1 Data sources

Implement a provider abstraction:

``` text
MarketDataProvider
├── get_candles()
├── get_latest_price()
├── get_bid_ask()
├── subscribe()
└── health_check()
```

A broker/provider-specific adapter should implement this interface.

The strategy engine must not directly depend on one provider.

## 9.2 Candle schema

Minimum candle fields:

``` text
timestamp
open
high
low
close
volume
symbol
timeframe
provider
```

Optional:

``` text
spread
bid
ask
tick_volume
real_volume
```

## 9.3 Data validation

Reject or flag:

-   duplicate candles;
-   missing timestamps;
-   impossible OHLC relationships;
-   zero/invalid prices;
-   unexpected timeframe gaps;
-   stale market data;
-   provider disconnects.

Example OHLC validation:

``` text
high >= max(open, close)
low <= min(open, close)
high >= low
```

------------------------------------------------------------------------

# 10. Market Context Engine

The context engine answers:

> "What kind of market are we currently looking at?"

It should classify the environment rather than immediately produce a
trade.

Possible states:

``` text
TREND_UP
TREND_DOWN
RANGE
TRANSITION
VOLATILE
LOW_ACTIVITY
UNKNOWN
```

The classification method should be configurable and versioned.

### Output

``` json
{
  "symbol": "EUR/USD",
  "timeframe": "4H",
  "regime": "TREND_UP",
  "confidence": 0.78,
  "as_of": "timestamp",
  "strategy_version": "v1"
}
```

Confidence must never be treated as probability of profit unless
explicitly calibrated and validated.

------------------------------------------------------------------------

# 11. Market Structure Engine

The structure engine identifies objective price behavior.

Potential components:

-   swing highs;
-   swing lows;
-   higher highs;
-   higher lows;
-   lower highs;
-   lower lows;
-   structural breaks;
-   range boundaries;
-   recent extremes;
-   displacement/impulse;
-   consolidation;
-   retests.

The implementation should produce structured objects rather than UI-only
annotations.

Example:

``` json
{
  "type": "SWING_HIGH",
  "price": 1.12345,
  "timestamp": "...",
  "timeframe": "1H",
  "strength": 0.72
}
```

------------------------------------------------------------------------

# 12. Key Area / Zone Engine

Where the existing research identifies meaningful price areas, the
system should represent them as zones.

A zone must have:

``` text
id
symbol
timeframe
upper_price
lower_price
created_at
source
status
strength
touch_count
invalidated_at
```

Possible sources:

``` text
STRUCTURE
RETEST
SUPPORT
RESISTANCE
LIQUIDITY
USER_DEFINED
STRATEGY_RULE
```

The engine must avoid creating thousands of meaningless zones.

Each zone needs an objective creation rule.

------------------------------------------------------------------------

# 13. Setup Detection Engine

The setup engine combines market context and structure to determine
whether a trade candidate exists.

Conceptually:

``` text
IF
    context is valid
AND
    structure is compatible
AND
    price reaches a qualifying area
AND
    confirmation conditions are satisfied
AND
    risk conditions are valid
THEN
    create candidate setup
```

A setup is not yet an order.

### Setup object

``` json
{
  "setup_id": "uuid",
  "symbol": "EUR/USD",
  "direction": "LONG",
  "timeframe": "15m",
  "context": {},
  "structure": {},
  "zone": {},
  "confirmation": {},
  "score": 82,
  "status": "CANDIDATE"
}
```

------------------------------------------------------------------------

# 14. Confirmation Engine

Confirmation must be broken into explicit signals.

Possible confirmation categories:

-   structure confirmation;
-   candle behavior;
-   momentum;
-   volatility;
-   retest;
-   rejection;
-   trend alignment;
-   multi-timeframe alignment.

Each condition must return:

``` text
PASS
FAIL
NOT_AVAILABLE
```

Do not use vague boolean logic hidden inside large functions.

------------------------------------------------------------------------

# 15. Setup Scoring

The scoring system provides a consistent way to compare candidates.

Example:

``` text
Context alignment       20
Structure quality       20
Key-area quality        20
Confirmation            20
Risk/reward quality     10
Market conditions       10
---------------------------
Maximum                100
```

These weights are placeholders and must be configurable.

Example:

``` yaml
scoring:
  minimum_score: 75
  weights:
    context: 20
    structure: 20
    zone: 20
    confirmation: 20
    risk_reward: 10
    conditions: 10
```

A high score must not override a hard risk rule.

------------------------------------------------------------------------

# 16. Hard Filters vs Soft Scores

This distinction is mandatory.

## Hard filter

If failed, trade is rejected regardless of score.

Examples:

``` text
market data stale
risk limit exceeded
invalid stop
spread too large
execution unavailable
daily loss limit reached
system health failure
```

## Soft score

Improves or reduces setup quality.

Examples:

``` text
stronger structure
better context alignment
cleaner confirmation
better risk/reward
```

Logic:

``` text
if hard_filter_failed:
    REJECT

else if score < minimum:
    REJECT

else:
    ACCEPT
```

------------------------------------------------------------------------

# 17. Trade Plan

Every accepted setup must produce a complete trade plan before
execution.

Required fields:

``` text
symbol
direction
entry_type
entry_price / entry_range
stop_loss
take_profit
position_size
risk_amount
risk_percent
expected_R
setup_score
strategy_version
created_at
expiry
reason_codes
```

Example:

``` json
{
  "direction": "LONG",
  "entry": 1.1200,
  "stop_loss": 1.1160,
  "take_profit": 1.1280,
  "risk_percent": 0.5,
  "expected_R": 2.0
}
```

The numbers above are illustrative only.

------------------------------------------------------------------------

# 18. Risk Engine

The risk engine is independent of the signal engine.

The signal engine may say:

``` text
TRADE
```

The risk engine can still say:

``` text
REJECT
```

## Risk controls

At minimum:

-   maximum risk per trade;
-   maximum daily loss;
-   maximum open positions;
-   maximum exposure;
-   maximum consecutive losses;
-   maximum total risk;
-   maximum spread;
-   maximum slippage;
-   minimum acceptable risk/reward;
-   trading-session restrictions;
-   market-data freshness;
-   emergency kill switch.

All values must be configurable.

------------------------------------------------------------------------

# 19. Position Sizing

Position size should be calculated from:

``` text
Account equity
×
risk percentage
÷
stop distance
```

The exact calculation must account for the instrument's contract
specifications and quote/base currency conventions.

The implementation must never assume that:

``` text
1 pip = same monetary value for every instrument
```

Create a dedicated `PositionSizingService`.

------------------------------------------------------------------------

# 20. Execution Engine

The execution layer must be broker-agnostic.

Architecture:

``` text
Strategy Engine
      ↓
Trade Plan
      ↓
Execution Gate
      ↓
Broker Adapter
      ↓
Order
```

Interface:

``` text
BrokerAdapter
├── get_account()
├── get_positions()
├── get_orders()
├── place_order()
├── modify_order()
├── cancel_order()
├── close_position()
└── health_check()
```

------------------------------------------------------------------------

# 21. Execution Gate

Before any live order:

``` text
1. System enabled?
2. LIVE mode confirmed?
3. Market data fresh?
4. Broker connected?
5. Account valid?
6. Risk limits valid?
7. Setup still valid?
8. Price still within allowed deviation?
9. Position duplication check passed?
10. Order parameters valid?
11. Kill switch inactive?
12. Strategy version approved?
```

If any mandatory check fails:

``` text
DO NOT EXECUTE
```

------------------------------------------------------------------------

# 22. Order State Machine

Use an explicit state machine.

``` text
CREATED
   ↓
VALIDATING
   ↓
APPROVED
   ↓
SUBMITTING
   ↓
SUBMITTED
   ↓
PARTIALLY_FILLED
   ↓
FILLED
   ↓
MANAGED
   ↓
CLOSED
```

Failure states:

``` text
REJECTED
CANCELLED
EXPIRED
FAILED
```

Every state transition must be logged.

------------------------------------------------------------------------

# 23. Position Management

After execution, Auto Pilot must monitor:

-   stop loss;
-   take profit;
-   current price;
-   unrealized P/L;
-   duration;
-   spread;
-   execution status;
-   strategy invalidation;
-   management rules.

Trade-management rules must be explicit.

Possible future modules:

``` text
Break-even
Trailing stop
Partial exit
Time-based exit
Structure invalidation
Emergency exit
```

Do not enable these automatically until individually specified and
tested.

------------------------------------------------------------------------

# 24. Trade Lifecycle

``` text
MARKET EVENT
     ↓
CONTEXT UPDATED
     ↓
STRUCTURE UPDATED
     ↓
SETUP DETECTED
     ↓
SETUP SCORED
     ↓
RISK CHECK
     ↓
TRADE PLAN
     ↓
EXECUTION GATE
     ↓
ORDER
     ↓
POSITION
     ↓
MANAGEMENT
     ↓
EXIT
     ↓
OUTCOME
     ↓
JOURNAL
```

------------------------------------------------------------------------

# 25. Decision Journal

This is one of the most important components.

The system must record not only trades, but also **why trades were not
taken**.

## Every candidate setup should store

``` text
setup_id
timestamp
symbol
timeframe
market_context
structure_state
zone_state
confirmation_state
score
hard_filters
risk_result
decision
rejection_reason
trade_plan
strategy_version
```

## Decision values

``` text
NO_SETUP
REJECTED
WATCH
APPROVED
EXECUTED
EXPIRED
INVALIDATED
```

------------------------------------------------------------------------

# 26. Reason Codes

Avoid storing only free-form text.

Use machine-readable reason codes.

Examples:

``` text
INSUFFICIENT_CONTEXT
STRUCTURE_MISMATCH
NO_CONFIRMATION
SCORE_TOO_LOW
RR_TOO_LOW
SPREAD_TOO_HIGH
STALE_DATA
RISK_LIMIT
DUPLICATE_POSITION
SESSION_BLOCKED
EXECUTION_ERROR
SETUP_EXPIRED
```

Human-readable explanations can be generated from these codes.

------------------------------------------------------------------------

# 27. Research / Learning Layer

Auto Pilot should have a separate research layer.

Production strategy:

``` text
APPROVED STRATEGY VERSION
```

Research:

``` text
EXPERIMENTAL STRATEGY
```

Experimental changes must never automatically modify the live strategy.

The research system can analyze:

-   win/loss distribution;
-   setup categories;
-   rejected setups;
-   missed opportunities;
-   false confirmations;
-   market regimes;
-   time-of-day behavior;
-   instrument behavior;
-   execution quality;
-   slippage;
-   drawdown;
-   expectancy.

------------------------------------------------------------------------

# 28. Strategy Versioning

Every decision must contain:

``` text
strategy_id
strategy_version
configuration_version
```

Example:

``` text
strategy_id: autopilot-core
strategy_version: 1.0.0
configuration_version: 2026-08-01-a
```

This makes historical results reproducible.

Never modify a strategy configuration in-place without creating a new
version.

------------------------------------------------------------------------

# 29. Backtesting Engine

The backtester must replay historical data through the same strategy
logic used by paper/live mode wherever possible.

Architecture:

``` text
Historical Data
      ↓
Replay Clock
      ↓
Market Data Interface
      ↓
Strategy Engine
      ↓
Risk Engine
      ↓
Simulated Execution
      ↓
Trade Journal
```

The strategy should not know whether data is:

``` text
LIVE
PAPER
BACKTEST
```

That distinction belongs below the strategy layer.

------------------------------------------------------------------------

# 30. Backtest Requirements

Backtests must account for:

-   spread;
-   slippage;
-   fees/commission where applicable;
-   execution delay assumptions;
-   position sizing;
-   stop/target behavior;
-   trading sessions;
-   data gaps;
-   instrument specifications.

Avoid look-ahead bias.

A strategy must never access future candles while processing the current
candle.

------------------------------------------------------------------------

# 31. Historical Replay

The developer should implement a replay mode that allows the owner to
move through historical EUR/USD data candle by candle.

The dashboard should show:

``` text
Current market
Current context
Current structure
Active zones
Candidate setups
Score
Risk decision
Would-be trade
Outcome after replay
```

This is useful for validating whether the automation matches the
intended analysis process.

------------------------------------------------------------------------

# 32. Paper Trading

Before LIVE:

``` text
BACKTEST
   ↓
HISTORICAL REPLAY
   ↓
PAPER
   ↓
LIMITED LIVE
   ↓
FULL LIVE
```

The transition between modes should be deliberate.

Paper execution must simulate:

-   entry;
-   exit;
-   spread;
-   slippage;
-   order rejection;
-   partial fills where relevant;
-   latency assumptions.

------------------------------------------------------------------------

# 33. Dashboard Requirements

## 33.1 Overview

Display:

-   current mode;
-   system health;
-   connected provider;
-   account state;
-   active instruments;
-   active positions;
-   daily P/L;
-   current risk;
-   latest setup;
-   latest decision.

## 33.2 Market panel

Display:

-   instrument;
-   timeframe;
-   price;
-   context;
-   structure;
-   key areas;
-   active setup;
-   score.

## 33.3 Trade panel

Display:

-   direction;
-   entry;
-   stop;
-   target;
-   size;
-   risk;
-   expected R;
-   status.

## 33.4 Decision journal

Filter by:

``` text
symbol
date
strategy version
decision
setup type
reason code
mode
```

## 33.5 Performance

Show:

-   total trades;
-   win rate;
-   average win;
-   average loss;
-   expectancy;
-   profit factor;
-   max drawdown;
-   consecutive losses;
-   average R;
-   performance by setup;
-   performance by market regime;
-   performance by instrument.

------------------------------------------------------------------------

# 34. Alerts

Alerts should exist for:

-   candidate setup;
-   approved setup;
-   order submitted;
-   order filled;
-   order rejected;
-   position closed;
-   daily risk threshold;
-   system error;
-   broker disconnected;
-   stale market data;
-   kill switch activated.

Notification delivery must be abstracted.

------------------------------------------------------------------------

# 35. Kill Switches

Implement multiple levels.

## Global kill switch

Stops all new execution.

## Instrument kill switch

Stops execution for one symbol.

## Strategy kill switch

Stops one strategy version.

## Risk kill switch

Automatically disables execution after a configured risk threshold.

The kill switch should fail closed.

------------------------------------------------------------------------

# 36. System Health

Create a health monitor for:

``` text
API connectivity
Market data freshness
Database
Execution provider
Queue
Worker process
Clock synchronization
Strategy worker
Risk worker
Notification service
```

Each component should expose:

``` text
HEALTHY
DEGRADED
FAILED
```

Live execution should require critical dependencies to be healthy.

------------------------------------------------------------------------

# 37. Recommended Architecture

``` text
                    ┌─────────────────────┐
                    │     Dashboard       │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │    API / Gateway    │
                    └──────────┬──────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
┌───────▼───────┐      ┌───────▼───────┐      ┌──────▼──────┐
│ Market Data   │      │ Strategy Core │      │ Risk Engine │
│ Service       │─────▶│               │─────▶│             │
└───────┬───────┘      └───────┬───────┘      └──────┬──────┘
        │                       │                     │
        │                ┌──────▼──────┐              │
        │                │ Trade Plan  │              │
        │                └──────┬──────┘              │
        │                       │                     │
        │                ┌──────▼─────────────────────▼────┐
        │                │         Execution Gate           │
        │                └────────────────┬─────────────────┘
        │                                 │
        │                         ┌───────▼────────┐
        │                         │ Broker Adapter │
        │                         └───────┬────────┘
        │                                 │
        └─────────────────────────────────┘

                         ┌───────────────────┐
                         │ Decision Journal  │
                         └─────────┬─────────┘
                                   │
                         ┌─────────▼─────────┐
                         │ Research/Reports  │
                         └───────────────────┘
```

------------------------------------------------------------------------

# 38. Suggested Backend Modules

``` text
/core
  /market
  /structure
  /zones
  /setups
  /scoring
  /risk
  /execution
  /positions
  /journal
  /research

/infrastructure
  /database
  /market-data
  /brokers
  /notifications
  /queues

/api
  /markets
  /setups
  /trades
  /positions
  /journal
  /performance
  /system

/workers
  market-worker
  analysis-worker
  execution-worker
  position-monitor-worker
  research-worker
```

------------------------------------------------------------------------

# 39. Database Model

Recommended core entities:

``` text
users
accounts
instruments
market_candles
market_events
market_contexts
structure_points
zones
setups
trade_plans
orders
positions
trades
risk_events
decision_logs
strategy_versions
strategy_configs
backtest_runs
backtest_trades
system_events
alerts
```

## Relationship

``` text
StrategyVersion
      ↓
Setup
      ↓
TradePlan
      ↓
Order
      ↓
Position
      ↓
Trade
      ↓
Outcome
```

Every downstream object should retain enough references to reconstruct
the decision.

------------------------------------------------------------------------

# 40. API Requirements

Example endpoints:

``` text
GET    /api/markets
GET    /api/markets/:symbol
GET    /api/context/:symbol
GET    /api/setups
GET    /api/setups/:id

GET    /api/trades
GET    /api/trades/:id
GET    /api/positions
GET    /api/orders

GET    /api/journal
GET    /api/performance

POST   /api/system/mode
POST   /api/system/kill-switch
POST   /api/backtests
POST   /api/strategies/:id/activate
```

Live order endpoints must be protected with strong authorization.

------------------------------------------------------------------------

# 41. Configuration Management

Strategy configuration must be externalized.

Example:

``` yaml
strategy:
  id: autopilot-core
  version: "1.0.0"

market:
  symbols:
    - EUR/USD

risk:
  max_risk_per_trade: 0.5
  max_daily_loss: 2.0
  max_open_positions: 3

execution:
  max_spread: configurable
  max_slippage: configurable

filters:
  minimum_setup_score: 75
```

These values are examples and must be replaced with validated project
values.

------------------------------------------------------------------------

# 42. Security Requirements

The system must:

-   encrypt sensitive credentials;
-   never expose broker credentials to the frontend;
-   use server-side execution;
-   authenticate dashboard users;
-   authorize dangerous actions;
-   log security-sensitive events;
-   protect live execution endpoints;
-   avoid storing credentials in source control;
-   use environment/secret management.

------------------------------------------------------------------------

# 43. Reliability Requirements

The system must handle:

-   network disconnects;
-   broker/API failures;
-   duplicate order requests;
-   delayed responses;
-   worker restarts;
-   stale market data;
-   partial fills;
-   process crashes.

### Idempotency

Order submission must use an idempotency mechanism so that a retry
cannot accidentally create duplicate positions.

------------------------------------------------------------------------

# 44. Observability

Every important event must be traceable.

Recommended event fields:

``` text
event_id
timestamp
service
symbol
strategy_version
correlation_id
event_type
payload
severity
```

Use structured logs.

Example:

``` json
{
  "event_type": "SETUP_REJECTED",
  "symbol": "EUR/USD",
  "reason_code": "SCORE_TOO_LOW",
  "score": 68,
  "strategy_version": "1.0.0"
}
```

------------------------------------------------------------------------

# 45. Performance Requirements

For V1:

-   dashboard should remain responsive under normal load;
-   analysis should process new candles promptly;
-   duplicate processing must be prevented;
-   database queries must be indexed;
-   historical data ingestion must be batch-capable;
-   workers should recover after restart;
-   execution decisions should not depend on frontend availability.

Do not optimize prematurely for ultra-low latency. Correctness and
auditability come first.

------------------------------------------------------------------------

# 46. Testing Strategy

## Unit tests

Test independently:

-   candle validation;
-   structure detection;
-   zone creation;
-   setup detection;
-   scoring;
-   risk calculations;
-   position sizing;
-   order validation.

## Integration tests

Test:

``` text
Market Data → Strategy → Risk → Execution
```

using mocked providers.

## Replay tests

Given the same historical dataset and strategy version:

``` text
same input
    =
same decision
```

unless randomness is explicitly part of the simulation.

## Failure tests

Simulate:

-   disconnected broker;
-   stale candles;
-   rejected orders;
-   partial fills;
-   database failure;
-   duplicate execution request;
-   invalid configuration;
-   risk-limit breach.

------------------------------------------------------------------------

# 47. Acceptance Criteria

The first production candidate is acceptable only when:

### Data

-   market data is ingested reliably;
-   invalid data is detected;
-   historical data can be replayed.

### Analysis

-   market context is generated;
-   structure is represented;
-   candidate setups are generated;
-   each decision is explainable.

### Risk

-   every trade passes the risk engine;
-   hard limits cannot be bypassed by high setup scores;
-   position sizing is deterministic.

### Execution

-   execution is separated from strategy;
-   duplicate order protection exists;
-   order states are persisted;
-   failures are handled safely.

### Research

-   every candidate setup is journaled;
-   rejected setups are stored;
-   strategy versions are identifiable;
-   backtest results are reproducible.

### Safety

-   LIVE mode requires deliberate activation;
-   kill switches work;
-   system failure defaults toward no new execution.

------------------------------------------------------------------------

# 48. EUR/USD Phase 1 Implementation

EUR/USD should be the first instrument used to validate the complete
pipeline.

The development sequence should be:

``` text
1. EUR/USD historical data
2. Data normalization
3. Market context
4. Structure detection
5. Key-area detection
6. Setup detection
7. Setup scoring
8. Risk engine
9. Historical replay
10. Backtesting
11. Paper execution
12. Dashboard
13. Live execution adapter
14. Controlled live validation
```

The purpose of EUR/USD is to prove the architecture and validate the
observed process.

------------------------------------------------------------------------

# 49. Adding Additional Pairs

Once the EUR/USD pipeline is stable, additional instruments can be
introduced.

Suggested process:

``` text
Instrument
    ↓
Historical data validation
    ↓
Replay
    ↓
Compare behavior
    ↓
Parameter validation
    ↓
Paper mode
    ↓
Enable for live strategy
```

Do not assume identical thresholds across instruments.

The engine should distinguish:

``` text
GLOBAL RULE
```

from:

``` text
INSTRUMENT-SPECIFIC PARAMETER
```

------------------------------------------------------------------------

# 50. Human-in-the-Loop Validation

Before full autonomy, provide an optional approval workflow.

Example:

``` text
SETUP FOUND
    ↓
AUTO PILOT EXPLAINS
    ↓
USER APPROVES / REJECTS
    ↓
SYSTEM RECORDS DECISION
```

This mode is valuable for comparing the automated interpretation with
the original discretionary process.

The approval decision should be stored as research data.

------------------------------------------------------------------------

# 51. AI / ML Layer

AI may be introduced as an auxiliary layer, but it must not initially
control execution directly.

Good uses:

-   summarize market context;
-   classify screenshots/notes;
-   organize research observations;
-   detect recurring setup characteristics;
-   assist with post-trade analysis;
-   generate human-readable explanations.

Bad V1 architecture:

``` text
AI → "BUY"
```

Preferred:

``` text
Rules + structured data
        ↓
Candidate setup
        ↓
Risk engine
        ↓
Optional AI explanation
        ↓
Execution gate
```

If an ML model is later used for prediction, its version, inputs,
outputs and validation results must be recorded.

------------------------------------------------------------------------

# 52. Screenshot / Observation Ingestion

The research workflow may contain screenshots of charts.

Create an optional research record:

``` text
observation_id
image_reference
symbol
timeframe
timestamp
manual_annotation
observed_behavior
hypothesis
status
linked_setup_id
```

Screenshots should be treated as research evidence.

They should not directly trigger trades.

------------------------------------------------------------------------

# 53. Research Annotation Workflow

A developer/researcher should be able to annotate an observation:

``` text
What happened?
What was expected?
What confirmed the idea?
What invalidated it?
What happened afterward?
```

This produces structured data that can later be tested quantitatively.

------------------------------------------------------------------------

# 54. Strategy Development Loop

The intended long-term workflow is:

``` text
OBSERVE
   ↓
DOCUMENT
   ↓
FORMALIZE
   ↓
BACKTEST
   ↓
REPLAY
   ↓
PAPER TEST
   ↓
MEASURE
   ↓
REFINE
   ↓
VERSION
   ↓
PAPER TEST AGAIN
   ↓
CONTROLLED LIVE
```

Never:

``` text
OBSERVE → immediately automate with real money
```

------------------------------------------------------------------------

# 55. Metrics

The platform should calculate:

## Trading metrics

-   total trades;
-   winning trades;
-   losing trades;
-   win rate;
-   average win;
-   average loss;
-   expectancy;
-   profit factor;
-   maximum drawdown;
-   average R;
-   largest loss;
-   largest win;
-   consecutive wins;
-   consecutive losses.

## Process metrics

-   setups detected;
-   setups rejected;
-   rejection reasons;
-   setups executed;
-   setups expired;
-   average setup score;
-   average time from setup to execution;
-   execution failures.

## Quality metrics

-   slippage;
-   spread at entry;
-   spread at exit;
-   planned vs actual entry;
-   planned vs actual risk;
-   planned vs actual R.

------------------------------------------------------------------------

# 56. Important Product Rule: No Silent Learning

Auto Pilot must never silently learn and change behavior in production.

If the system discovers:

``` text
"This condition appears to improve results."
```

it should create a research finding.

It must not automatically change:

``` text
minimum score
risk
entry logic
stop logic
exit logic
```

The change must become a new strategy version and pass validation.

------------------------------------------------------------------------

# 57. Development Milestones

## Milestone 1 --- Foundation

-   repository;
-   configuration;
-   database;
-   authentication;
-   logging;
-   environment setup.

## Milestone 2 --- Market Data

-   provider adapter;
-   historical ingestion;
-   candle storage;
-   validation;
-   live feed.

## Milestone 3 --- Analysis

-   context engine;
-   structure engine;
-   zones;
-   setup detection.

## Milestone 4 --- Decision Engine

-   scoring;
-   filters;
-   trade plan;
-   risk engine.

## Milestone 5 --- Research

-   journal;
-   replay;
-   annotations;
-   backtesting;
-   metrics.

## Milestone 6 --- Paper Execution

-   simulated broker;
-   order lifecycle;
-   position management;
-   dashboard.

## Milestone 7 --- Live Integration

-   broker adapter;
-   execution gate;
-   kill switches;
-   live monitoring.

## Milestone 8 --- Expansion

-   additional instruments;
-   strategy variants;
-   advanced research;
-   optional AI/ML assistance.

------------------------------------------------------------------------

# 58. Definition of Done for V1

V1 is complete when a developer can run:

``` text
EUR/USD historical dataset
        ↓
Auto Pilot strategy v1
        ↓
Market analysis
        ↓
Candidate setup
        ↓
Risk validation
        ↓
Simulated order
        ↓
Position lifecycle
        ↓
Trade outcome
        ↓
Journal
        ↓
Performance report
```

and inspect every decision from beginning to end.

The developer must be able to answer:

> Why did Auto Pilot take this trade?

and:

> Why did Auto Pilot reject that trade?

without inspecting undocumented source-code behavior.

------------------------------------------------------------------------

# 59. Final Implementation Principles

1.  **Do not hardcode the EUR/USD observations as universal truth.**
2.  **Separate observation from validated strategy rules.**
3.  **Separate signal generation from risk approval.**
4.  **Separate risk approval from execution.**
5.  **Make every decision auditable.**
6.  **Store rejected setups as well as executed trades.**
7.  **Version every strategy change.**
8.  **Use the same strategy interface for backtest, paper and live
    modes.**
9.  **Fail closed when critical systems are unhealthy.**
10. **Never allow AI/model output to bypass risk controls.**
11. **Never allow research changes to silently alter production
    behavior.**
12. **Build EUR/USD first, then generalize to additional pairs.**

------------------------------------------------------------------------

# 60. Developer Handoff Checklist

Before starting implementation, the developer should confirm:

-   [ ] Market-data provider selected.
-   [ ] Broker/execution provider selected.
-   [ ] Supported instruments defined.
-   [ ] Timeframes defined.
-   [ ] Strategy configuration schema created.
-   [ ] Database schema created.
-   [ ] Data validation implemented.
-   [ ] Context engine implemented.
-   [ ] Structure engine implemented.
-   [ ] Zone engine implemented.
-   [ ] Setup engine implemented.
-   [ ] Scoring implemented.
-   [ ] Risk engine implemented.
-   [ ] Position sizing implemented.
-   [ ] Execution gate implemented.
-   [ ] Broker adapter implemented.
-   [ ] Order state machine implemented.
-   [ ] Journal implemented.
-   [ ] Backtester implemented.
-   [ ] Historical replay implemented.
-   [ ] Paper trading implemented.
-   [ ] Dashboard implemented.
-   [ ] Alerts implemented.
-   [ ] Kill switches implemented.
-   [ ] Health monitoring implemented.
-   [ ] Strategy versioning implemented.
-   [ ] Unit tests implemented.
-   [ ] Integration tests implemented.
-   [ ] Failure/recovery tests implemented.
-   [ ] EUR/USD validation completed.
-   [ ] Additional instruments remain disabled until separately
    validated.

------------------------------------------------------------------------

# 61. Immediate Next Step

The first engineering task is **not** to build the live trading bot.

The first task is to build the **EUR/USD research and replay pipeline**.

That pipeline should make it possible to feed the accumulated EUR/USD
data into Auto Pilot and see:

``` text
WHAT THE MARKET LOOKED LIKE
        ↓
WHAT THE ENGINE IDENTIFIED
        ↓
WHICH SETUP WAS FOUND
        ↓
WHY IT PASSED / FAILED
        ↓
WHAT TRADE WOULD HAVE BEEN PLANNED
        ↓
WHAT ACTUALLY HAPPENED
```

Once this matches the intended decision process consistently, the same
engine can move into paper execution and eventually controlled live
execution.

------------------------------------------------------------------------

## Appendix A --- Core Domain Objects

### MarketContext

``` typescript
interface MarketContext {
  symbol: string;
  timeframe: string;
  regime: string;
  confidence: number;
  timestamp: string;
  strategyVersion: string;
}
```

### Setup

``` typescript
interface Setup {
  id: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  timeframe: string;
  score: number;
  status: string;
  reasonCodes: string[];
  strategyVersion: string;
}
```

### TradePlan

``` typescript
interface TradePlan {
  setupId: string;
  symbol: string;
  direction: "LONG" | "SHORT";
  entry: number;
  stopLoss: number;
  takeProfit: number;
  positionSize: number;
  riskAmount: number;
  riskPercent: number;
  expectedR: number;
  expiresAt: string;
}
```

### Decision

``` typescript
interface Decision {
  setupId: string;
  decision:
    | "NO_SETUP"
    | "REJECTED"
    | "WATCH"
    | "APPROVED"
    | "EXECUTED"
    | "EXPIRED"
    | "INVALIDATED";
  reasonCodes: string[];
  timestamp: string;
  strategyVersion: string;
}
```

------------------------------------------------------------------------

## Appendix B --- Example End-to-End Decision

``` text
EUR/USD
   ↓
Higher timeframe context = valid
   ↓
Structure = compatible
   ↓
Price enters qualifying area
   ↓
Confirmation detected
   ↓
Setup score = above configured threshold
   ↓
Risk engine validates
   ↓
Trade plan generated
   ↓
Execution gate validates
   ↓
PAPER/LIVE mode determines action
   ↓
Order lifecycle tracked
   ↓
Position monitored
   ↓
Trade closed
   ↓
Outcome recorded
   ↓
Performance metrics updated
```

------------------------------------------------------------------------

# Document Status

**This PRD is the engineering baseline.**

The exact trading conditions, thresholds, setup definitions, and EUR/USD
behavioral rules should be promoted from research observations into
formal strategy configuration only after they have been explicitly
defined and validated.

The architecture should therefore be built now, while strategy rules
remain versioned and configurable as additional market evidence is
collected.