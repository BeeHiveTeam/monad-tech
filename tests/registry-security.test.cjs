const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTS } = require('./helpers/load-ts.cjs');

const word = n => BigInt(n).toString(16).padStart(64, '0');
const address = id => '0x' + id.toString(16).padStart(40, '0');
const validatorResult = id => '0x' + [word(id), word(0), word(10n ** 25n), word(0), word(10n ** 17n), word(0), word(10n ** 25n), word(0), word(10n ** 25n), word(0)].join('');
const consensusResult = '0x' + [word(1), word(0), word(96), word(2), word(1), word(2)].join('');
const response = (value, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => value });

function registryFixture() {
  let now = 20_000_000_000;
  let failure = null;
  let release;
  let hold = false;
  let gate;
  const scans = new Map();
  const snapshots = new Map();
  const counters = { loads: 0 };
  class Clock extends Date { static now() { return now; } }
  const registry = loadTS('lib/validator-registry.ts', {
    mocks: {
      './validator-monikers': {
        loadRegistry: (entries, network) => { snapshots.set(network, entries); counters.loads++; },
        getRegistrySnapshot: network => snapshots.get(network) ?? [],
      },
    },
    globals: {
      Date: Clock,
      console: { log() {}, warn() {}, error() {} },
      setTimeout: callback => { queueMicrotask(callback); return 0; },
      fetch: async (url, options) => {
        if (url.startsWith('https://api.github.com/')) {
          if (failure === 'github') throw new Error('GitHub unavailable');
          return response([{ name: 'one.json', download_url: 'https://metadata.test/1' }]);
        }
        if (url.startsWith('https://metadata.test/')) return response({ id: 1, name: 'Known validator', secp: 'public' });
        const body = JSON.parse(options.body);
        if (Array.isArray(body)) {
          if (body[0].id === 1) {
            scans.set(url, (scans.get(url) ?? 0) + 1);
            if (hold) await gate;
          }
          if (failure === 'batch' && body[0].id === 26) return response(null, false);
          const rows = body.map(item => ({ id: item.id, result: failure === 'empty' ? '0x' : item.id <= 2 ? validatorResult(item.id) : '0x' }));
          if (failure === 'missing' && body[0].id === 26) rows.pop();
          if (failure === 'json-error' && body[0].id === 26) rows[0] = { id: 26, error: { message: 'rate limit exceeded' } };
          return response(rows);
        }
        if (failure === 'consensus') throw new Error('Consensus unavailable');
        return response({ result: failure === 'consensus-empty' ? '0x' : consensusResult });
      },
    },
  });
  return {
    registry, scans, snapshots, counters,
    advance: ms => { now += ms; },
    fail: kind => { failure = kind; },
    block: () => { hold = true; gate = new Promise(resolve => { release = resolve; }); },
    release: () => { hold = false; release(); },
  };
}

test('registry cold loads join one scan per network and await its completion', async () => {
  const f = registryFixture();
  f.block();
  const first = f.registry.ensureRegistryLoaded('https://rpc.test/testnet', 'testnet');
  const second = f.registry.ensureRegistryLoaded('https://rpc.test/testnet', 'testnet');
  const mainnet = f.registry.ensureRegistryLoaded('https://rpc.test/mainnet', 'mainnet');
  assert.equal(first, second);
  assert.notEqual(first, mainnet);
  assert.equal(f.registry.getRegistryStatus('testnet').complete, false);
  let finished = false;
  second.then(() => { finished = true; });
  await Promise.resolve();
  assert.equal(finished, false);
  f.release();
  await Promise.all([first, second, mainnet]);
  assert.equal(f.scans.get('https://rpc.test/testnet'), 1);
  assert.equal(f.scans.get('https://rpc.test/mainnet'), 1);
  assert.equal(f.registry.getRegistryStatus('testnet').complete, true);
  assert.equal(f.registry.getRegistryStatus('mainnet').stale, false);
});

for (const failure of ['batch', 'missing', 'json-error', 'empty']) {
  test(`registry retains last complete snapshot and retry backoff after ${failure}`, async () => {
    const f = registryFixture();
    await f.registry.ensureRegistryLoaded('https://rpc.test');
    const previous = f.registry.getChainDataById();
    const metadata = f.snapshots.get('testnet');
    const fetchedAt = f.registry.getRegistryStatus().fetchedAt;
    f.advance(61 * 60_000);
    f.fail(failure);
    await Promise.all(Array.from({ length: 10 }, () => f.registry.ensureRegistryLoaded('https://rpc.test')));
    assert.equal(f.scans.get('https://rpc.test'), 2);
    assert.equal(f.registry.getChainDataById(), previous);
    assert.equal(f.snapshots.get('testnet'), metadata);
    const status = f.registry.getRegistryStatus();
    assert.equal(status.complete, true);
    assert.equal(status.stale, true);
    assert.equal(status.fetchedAt, fetchedAt);
    assert.ok(status.error);
    await f.registry.ensureRegistryLoaded('https://rpc.test');
    assert.equal(f.scans.get('https://rpc.test'), 2);
    f.advance(5 * 60_000 + 1);
    f.fail(null);
    await f.registry.ensureRegistryLoaded('https://rpc.test');
    assert.equal(f.scans.get('https://rpc.test'), 3);
    assert.equal(f.registry.getRegistryStatus().stale, false);
  });
}

test('cold failed scan is unavailable; legitimate completed empty scan is distinguishable', async () => {
  const failed = registryFixture();
  failed.fail('batch');
  await failed.registry.ensureRegistryLoaded('https://rpc.test');
  assert.equal(failed.registry.getRegistryStatus().complete, false);
  assert.equal(failed.registry.getRegistryStatus().fetchedAt, null);
  assert.equal(failed.registry.getChainDataById().size, 0);
  const empty = registryFixture();
  empty.fail('empty');
  await empty.registry.ensureRegistryLoaded('https://rpc.test');
  assert.equal(empty.registry.getRegistryStatus().complete, true);
  assert.equal(empty.registry.getRegistryStatus().stale, false);
  assert.equal(empty.registry.getChainDataById().size, 0);
});

test('metadata and consensus outages retain known names and canonical membership', async () => {
  const f = registryFixture();
  await f.registry.ensureRegistryLoaded('https://rpc.test');
  const consensus = f.registry.getConsensusIds();
  const consensusAt = f.registry.getConsensusFetchedAt();
  f.advance(61 * 60_000);
  f.fail('consensus');
  await f.registry.ensureRegistryLoaded('https://rpc.test');
  assert.equal(f.registry.getConsensusIds(), consensus);
  assert.equal(f.registry.getConsensusFetchedAt(), consensusAt);
  assert.equal(f.registry.getRegistryStatus().stale, true);
  f.advance(5 * 60_000 + 1);
  f.fail('github');
  await f.registry.ensureRegistryLoaded('https://rpc.test');
  assert.equal(f.snapshots.get('testnet').find(row => row.id === 1).name, 'Known validator');
  assert.equal(f.registry.getRegistryStatus().stale, true);
});

test('empty consensus RPC payload cannot erase an existing canonical set', async () => {
  const f = registryFixture();
  await f.registry.ensureRegistryLoaded('https://rpc.test');
  const previous = f.registry.getConsensusIds();
  const fetchedAt = f.registry.getConsensusFetchedAt();
  f.advance(61 * 60_000);
  f.fail('consensus-empty');
  await f.registry.ensureRegistryLoaded('https://rpc.test');
  assert.equal(f.registry.getConsensusIds(), previous);
  assert.equal(f.registry.getConsensusFetchedAt(), fetchedAt);
  assert.equal(f.registry.getRegistryStatus().stale, true);
});

test('public force refresh rejects before invoking any registry loader', async () => {
  let loads = 0;
  const route = loadTS('app/api/validator-registry/route.ts', {
    mocks: {
      'next/server': { NextResponse: { json: (body, init) => Response.json(body, init) } },
      '@/lib/networks': { NETWORKS: { testnet: { rpc: 'https://rpc.test' } } },
      '@/lib/validator-registry': {
        ensureRegistryLoaded: async () => { loads++; }, getRegistryEntries: () => [],
        getRegistryStatus: () => ({ complete: true, stale: false, fetchedAt: 123, error: null }),
      },
      '@/lib/validator-monikers': { registryAge: () => 123 },
      '@/lib/apiError': { apiError: () => { throw new Error('unexpected error'); } },
    },
  });
  for (const query of ['?force=1', '?force=0', '?force=']) {
    const result = await route.GET({ nextUrl: new URL('https://site.test/api/validator-registry' + query) });
    assert.equal(result.status, 403);
    assert.equal(result.headers.get('cache-control'), 'no-store');
  }
  assert.equal(loads, 0);
  const normal = await route.GET({ nextUrl: new URL('https://site.test/api/validator-registry') });
  assert.equal(normal.status, 200);
  assert.equal((await normal.json()).updatedAt, 123);
  assert.equal(loads, 1);
});

test('tip RPC failures are caught without a detached rejection and permit recovery', async () => {
  let failed = true;
  let calls = 0;
  const tip = loadTS('lib/tipCache.ts', {
    mocks: {
      './networks': { NETWORKS: { testnet: { rpc: 'https://rpc.test' } } },
      './mainnetRpcFallback': { isTransientRpcError: () => false, rpcUrlFor: () => '', rotateMainnetRpc() {} },
    },
    globals: {
      process: { env: {} },
      fetch: async () => {
        calls++;
        if (failed) throw new Error('simulated timeout');
        return response({ result: { number: '0x10', hash: '0xhash', parentHash: '0xparent', timestamp: '0x20' } });
      },
    },
  });
  await assert.rejects(tip.getTip('testnet'), /simulated timeout/);
  await new Promise(resolve => setImmediate(resolve));
  failed = false;
  const result = await tip.getTip('testnet');
  assert.equal(result.number, 16);
  assert.equal(calls, 2);
  await tip.getTip('testnet');
  assert.equal(calls, 2);
});
