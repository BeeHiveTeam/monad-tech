// Shared log pattern definitions — used by both the server-side aggregator
// (app/api/node/log-events) and the client-side UI (app/node/page.tsx).
// Each pattern identifies a known WARN/ERROR line from the Monad daemons,
// explains what it means, and indicates whether operator action is needed.

export type LogAction = 'none' | 'monitor' | 'investigate';

export interface LogPattern {
  id: string;             // stable identifier for UI keys + API
  label: string;          // short human label
  regex: string;          // regex source (compiled with `i` flag)
  service?: string;       // restrict match to this service_name
  note: string;           // operator guidance
  action: LogAction;
}

export const LOG_PATTERNS: LogPattern[] = [
  {
    id: 'rebroadcast_fail',
    label: 'Rebroadcast target unreachable',
    regex: 'failed to find address for rebroadcast target',
    service: 'monad-bft',
    note: 'Remote validator unreachable in P2P mesh. The target= pubkey is the offline/unreachable node — not yours. No action needed.',
    action: 'none',
  },
  {
    id: 'sync_done_fail',
    label: 'SyncDone with failure',
    regex: 'received SyncDone with failure',
    service: 'monad-bft',
    note: 'Remote peer failed to complete state sync. Transient network issue on the peer\'s side. Normal if infrequent.',
    action: 'none',
  },
  {
    id: 'local_timeout',
    label: 'BFT local timeout',
    regex: '\\blocal timeout\\b',
    service: 'monad-bft',
    note: 'BFT consensus round timed out locally. Occasional timeouts are normal; investigate if rate spikes persistently.',
    action: 'monitor',
  },
  {
    id: 'peer_headers_fail',
    label: 'Peer headers request failed',
    regex: 'peer headers request failed',
    service: 'monad-bft',
    note: 'Block sync headers request to a peer failed. If delta is growing fast, check peer connectivity.',
    action: 'monitor',
  },
  {
    id: 'peer_payload_fail',
    label: 'Peer payload request failed',
    regex: 'peer payload request failed',
    service: 'monad-bft',
    note: 'Block sync payload request to a peer failed. Same pattern as headers — peer-side issue.',
    action: 'monitor',
  },
  {
    id: 'invalid_timestamp',
    label: 'Invalid timestamp',
    regex: 'failed timestamp validation|invalid timestamp',
    service: 'monad-bft',
    note: 'Received message with invalid timestamp (sender\'s clock skew). Peer-side.',
    action: 'none',
  },
  {
    id: 'invalid_signature',
    label: 'Invalid/malformed signature',
    regex: '\\b(invalid|malformed) signature',
    service: 'monad-bft',
    note: 'Received message with invalid signature. Peer-side protocol issue.',
    action: 'none',
  },
  {
    id: 'insufficient_stake',
    label: 'Insufficient stake signatures',
    regex: 'insufficient stake',
    service: 'monad-bft',
    note: 'Received message with insufficient stake signatures. Peer-side.',
    action: 'none',
  },
  {
    id: 'state_sync_fail',
    label: 'State sync failure',
    regex: 'state sync (failed|error)|sync failed',
    note: 'State sync operation failed. Monitor — check peer availability if frequent.',
    action: 'monitor',
  },
  {
    id: 'execution_error',
    label: 'Execution error (LOG_ERROR)',
    regex: 'LOG_ERROR|LOG_FATAL|LOG_CRITICAL',
    service: 'monad-execution',
    note: 'Execution engine emitted an ERROR/FATAL log. Investigate — could indicate data corruption or disk issues.',
    action: 'investigate',
  },
];

// Compile once. The `i` flag matches case-insensitively.
const compiled: Array<{ p: LogPattern; re: RegExp }> = LOG_PATTERNS.map(p => ({
  p,
  re: new RegExp(p.regex, 'i'),
}));

export interface LogMatch {
  patternId: string | null;  // null = unmatched ("other")
}

export function matchLogLine(message: string, service: string): LogMatch {
  for (const { p, re } of compiled) {
    if (p.service && p.service !== service) continue;
    if (re.test(message)) return { patternId: p.id };
  }
  return { patternId: null };
}

export function getPatternById(id: string): LogPattern | undefined {
  return LOG_PATTERNS.find(p => p.id === id);
}
