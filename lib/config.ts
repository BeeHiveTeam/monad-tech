/**
 * Single source of truth for environment-derived configuration.
 * Every host/URL/db is overridable via env var; defaults match the production
 * setup (validator on 15.235.117.52, dashboard on 195.3.223.201).
 *
 * Add new entries here rather than scattering `process.env.X || 'default'`
 * across lib files.
 */

// Validator host — single place to change if the validator moves
const VALIDATOR_HOST = process.env.MONAD_VALIDATOR_HOST || '15.235.117.52';

// Monad RPC + WebSocket on the validator
export const MONAD_RPC_URL    = process.env.MONAD_RPC_URL    || `http://${VALIDATOR_HOST}:8080`;
export const MONAD_WS_URL     = process.env.MONAD_WS_URL     || `ws://${VALIDATOR_HOST}:8081`;
export const NODE_METRICS_URL = process.env.NODE_METRICS_URL || `http://${VALIDATOR_HOST}:8889/metrics`;

// Reference RPC for tip-lag comparisons (public Monad testnet RPC)
export const MONAD_REFERENCE_RPC = process.env.MONAD_REFERENCE_RPC || 'https://testnet-rpc.monad.xyz';

// Loki on the dashboard host
export const LOKI_URL = process.env.LOKI_URL || 'http://127.0.0.1:3100';

// InfluxDB on the dashboard host (HTTPS via nginx proxy with self-signed cert)
export const INFLUX_URL = process.env.INFLUX_URL || 'https://localhost:8086';
export const INFLUX_DB  = process.env.INFLUX_DB  || 'monad';
