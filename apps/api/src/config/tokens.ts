export const ENV = Symbol('ENV');
export const SQL = Symbol('SQL');
export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');
export const READINESS_CHECKS = Symbol('READINESS_CHECKS');
export const EVENT_BUS = Symbol('EVENT_BUS');
/** The live ingest runtime, or null when INGEST_ENABLED is off. */
export const INGEST_RUNTIME = Symbol('INGEST_RUNTIME');
/** The engine runner, or null when it is off (no ingest, API-only role, or ENGINE_ENABLED=false). */
export const ENGINE_RUNNER = Symbol('ENGINE_RUNNER');
/** The model router (`LlmRouter`): provider switches, data-class policy, breakers and the cost meter behind one object. */
export const LLM_ROUTER = Symbol('LLM_ROUTER');
