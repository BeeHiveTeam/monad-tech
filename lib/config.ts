/**
 * Single source of truth for environment-derived configuration.
 *
 * Every host/URL/db comes from an env var. No deployment address is baked into the source:
 * this repository is public, and hardcoding the operator's host published a map of which
 * internal ports live where — a convenience for a reader, and a starting point for anyone
 * else. Set MONAD_VALIDATOR_HOST (or the individual URLs) in the deployment environment.
 *
 * With nothing set, the node-backed endpoints fall back to the public RPC, so a fresh clone
 * runs and returns real data instead of failing against someone else's machine.
 *
 * Add new entries here rather than scattering `process.env.X || 'default'` across lib files.
 */

// Validator host. Empty means "not configured" — callers fall back to the public RPC rather
// than guessing an address.
const VALIDATOR_HOST = process.env.MONAD_VALIDATOR_HOST || '';

// Monad RPC + WebSocket on the validator
export const MONAD_RPC_URL    = process.env.MONAD_RPC_URL
  || (VALIDATOR_HOST ? `http://${VALIDATOR_HOST}:8080` : 'https://testnet-rpc.monad.xyz');
export const MONAD_WS_URL     = process.env.MONAD_WS_URL
  || (VALIDATOR_HOST ? `ws://${VALIDATOR_HOST}:8081` : '');
// Our own node's metrics have no public equivalent, so without a host there is nothing to
// scrape. Callers must treat an empty string as "not configured", not as "empty result".
export const NODE_METRICS_URL = process.env.NODE_METRICS_URL
  || (VALIDATOR_HOST ? `http://${VALIDATOR_HOST}:8889/metrics` : '');

// Reference RPC for tip-lag comparisons (public Monad testnet RPC)
export const MONAD_REFERENCE_RPC = process.env.MONAD_REFERENCE_RPC || 'https://testnet-rpc.monad.xyz';

// Loki on the dashboard host
export const LOKI_URL = process.env.LOKI_URL || 'http://127.0.0.1:3100';

// InfluxDB on the dashboard host (HTTPS via nginx proxy with self-signed cert)
export const INFLUX_URL = process.env.INFLUX_URL || 'https://localhost:8086';
export const INFLUX_DB  = process.env.INFLUX_DB  || 'monad';
