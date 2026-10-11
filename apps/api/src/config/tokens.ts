export const ENV = Symbol('ENV');
export const SQL = Symbol('SQL');
export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');
export const READINESS_CHECKS = Symbol('READINESS_CHECKS');
export const EVENT_BUS = Symbol('EVENT_BUS');
/** The live ingest runtime, or null when INGEST_ENABLED is off. */
export const INGEST_RUNTIME = Symbol('INGEST_RUNTIME');
