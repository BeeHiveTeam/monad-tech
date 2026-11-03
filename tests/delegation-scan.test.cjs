const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTS } = require('./helpers/load-ts.cjs');

const address = '0x' + '1'.repeat(40);
const encoded = value => '0x' + BigInt(value).toString(16).padStart(64, '0');
const request = (wallet = address, network = 'testnet') => ({ nextUrl: new URL(`http://localhost/api/my-delegations?address=${wallet}&network=${network}`) });
function setup({ count = 3, batch, registry, clock } = {}) {
  const data = new Map(Array.from({ length: count }, (_, index) => [index + 1, {
    authAddress: '0x' + (index + 2).toString(16).padStart(40, '0'), stakeMon: 11_000_000, commissionPct: 5,
  }]));
  let calls = 0;
  const state = registry || { complete: true, stale: false, fetchedAt: Date.now(), error: null };
  class Clock extends Date { static now() { return clock.value; } }
  const endpoint = loadTS('app/api/my-delegations/route.ts', {
    globals: clock ? { Date: Clock } : {},
    mocks: {
      'next/server': { NextResponse: { json: (body, options) => Response.json(body, options) } },
      '@/lib/rpc': { rpcBatch: async (network, requests) => { calls++; return batch ? batch(network, requests, calls) : requests.map(() => encoded(0)); } },
      '@/lib/validator-registry': {
        ensureRegistryLoaded: async () => {}, getChainDataById: () => data,
        getConsensusIds: () => new Set([1]), getRegistryStatus: () => ({ ...state }),
      },
      '@/lib/validator-monikers': { getValidatorInfo: () => null },
      '@/lib/validatorMetrics': { isInActiveSet: id => id === 1 },
      '@/lib/networks': { NETWORKS: { testnet: { rpc: 'http://test.invalid' }, mainnet: { rpc: 'http://main.invalid' } } },
      '@/lib/apiError': { apiError: () => Response.json({ error: 'Internal error' }, { status: 500 }) },
    },
  });
  return { GET: endpoint.GET, calls: () => calls, state };
}

test('null, missing, empty and malformed balance results are failed measurements, not measured zero', async () => {
  const scan = setup({ count: 6, batch: () => [encoded(2n * 10n ** 18n), encoded(0), null, '0x', 'invalid'] });
  const response = await scan.GET(request());
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.validatorsTotal, 6);
  assert.equal(body.validatorsScanned, 2);
  assert.equal(body.validatorsFailed, 4);
  assert.equal(body.complete, false);
  assert.equal(body.partial, true);
  assert.equal(body.totalStakeMon, 2);
  assert.equal(body.positions.length, 1);
});

test('a fully measured zero balance is complete, and only complete scans are cached', async () => {
  const scan = setup();
  const first = await (await scan.GET(request())).json();
  const second = await (await scan.GET(request())).json();
  assert.equal(first.complete, true);
  assert.equal(first.validatorsScanned, 3);
  assert.equal(first.totalStakeMon, 0);
  assert.equal(second.cached, true);
  assert.equal(scan.calls(), 1);
});

test('all failed reads return unavailable and are retried rather than cached as an empty wallet', async () => {
  const scan = setup({ batch: () => { throw new Error('RPC unavailable'); } });
  for (let i = 0; i < 2; i++) {
    const response = await scan.GET(request());
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(body.complete, false);
    assert.equal(body.validatorsScanned, 0);
    assert.equal(body.validatorsFailed, 3);
    assert.ok(body.error);
  }
  assert.equal(scan.calls(), 2);
});

test('stale registry prevents full-portfolio claims and bypasses an earlier complete cache', async () => {
  const scan = setup();
  assert.equal((await (await scan.GET(request())).json()).complete, true);
  scan.state.stale = true;
  const response = await scan.GET(request());
  const body = await response.json();
  assert.equal(body.complete, false);
  assert.equal(body.partial, true);
  assert.equal(body.registryStale, true);
  assert.equal(scan.calls(), 2);
});

test('cold registry is a building response, distinct from a complete registry with zero IDs', async () => {
  const scan = setup({ count: 0, registry: { complete: false, stale: true, fetchedAt: null, error: null } });
  const response = await scan.GET(request());
  const body = await response.json();
  assert.equal(response.status, 202);
  assert.equal(body.building, true);
  assert.equal(body.complete, false);
  assert.equal(body.positionCount, 0);
  assert.equal(scan.calls(), 0);
  const empty = setup({ count: 0 });
  assert.equal((await (await empty.GET(request())).json()).complete, true);
});

test('non-zero balances below the previous 0.001 MON threshold are retained', async () => {
  const scan = setup({ count: 1, batch: () => [encoded(1)] });
  const body = await (await scan.GET(request())).json();
  assert.equal(body.positions.length, 1);
  assert.equal(body.totalStakeMon, 1e-18);
});

test('cache has a bounded size and expired results trigger a fresh scan', async () => {
  const clock = { value: 1_000_000 };
  const scan = setup({ count: 1, clock });
  for (let i = 1; i <= 101; i++) await scan.GET(request('0x' + i.toString(16).padStart(40, '0')));
  assert.equal(scan.calls(), 101);
  await scan.GET(request('0x' + '1'.padStart(40, '0')));
  assert.equal(scan.calls(), 102, 'oldest wallet must have been evicted');
  clock.value += 60_001;
  await scan.GET(request('0x' + '1'.padStart(40, '0')));
  assert.equal(scan.calls(), 103, 'expired wallet must not reuse cached balances');
});

test('concurrent same-wallet scans share RPC work and network caches are isolated', async () => {
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  const scan = setup({ count: 1, batch: async () => { await pending; return [encoded(0)]; } });
  const first = scan.GET(request());
  const second = scan.GET(request());
  await new Promise(r => setImmediate(r));
  assert.equal(scan.calls(), 1);
  resolve();
  await Promise.all([first, second]);
  await scan.GET(request(address, 'mainnet'));
  assert.equal(scan.calls(), 2);
});
