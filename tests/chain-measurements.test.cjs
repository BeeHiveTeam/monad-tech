const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTS } = require('./helpers/load-ts.cjs');
const { computeChainStats } = loadTS('lib/chainStats.ts');
const blocks = () => Array.from({ length: 10 }, (_, i) => ({ number: 100-i, ts: 1000-i, txCount: 100, gasUsed: 50, gasLimit: 100 }));
test('TPS counts nine portions across nine seconds, not ten portions', () => {
 const r=computeChainStats(blocks()); assert.equal(r.tps,100); assert.equal(r.tpsTransactions,900); assert.equal(r.avgBlockTime,1);
});
test('oldest boundary transactions do not inflate the rate', () => { const r=blocks();r[9].txCount=999999;assert.equal(computeChainStats(r).tps,100); });
test('un-enriched heads are not measured zero; incomplete interior windows remain unknown', () => {
 const r=blocks();r[0].txCount=null;assert.equal(computeChainStats(r).tps,100);r[3].txCount=null;assert.equal(computeChainStats(r).tps,null);
});
test('gaps and same-second timestamps are unavailable, while measured zero remains zero', () => {
 const r=blocks();r[3].number=50;assert.equal(computeChainStats(r).tps,null);assert.equal(computeChainStats(r).avgBlockTime,null);
 assert.equal(computeChainStats(blocks().map(b=>({...b,ts:1}))).tps,null);
 assert.equal(computeChainStats(blocks().map(b=>({...b,txCount:0}))).tps,0);
});
function epochLoader(fetch, clock={now:100000}) {
 class Clock extends Date { static now(){return clock.now;} }
 return loadTS('lib/epochState.ts',{globals:{fetch,Date:Clock},mocks:{'./mainnetRpcFallback':{rpcUrlFor:n=>`https://${n}.invalid`}}});
}
const encoded=(n,delay)=>'0x'+BigInt(n).toString(16).padStart(64,'0')+BigInt(delay).toString(16).padStart(64,'0');
test('epoch decoder uses contract delay, rejects malformed ABI', () => {
 const {decodeEpochState}=epochLoader(()=>{});const r=decodeEpochState(encoded(42,1));assert.equal(r.current,42);assert.equal(r.inEpochDelayPeriod,true);
 assert.equal(decodeEpochState('0x'),null);assert.equal(decodeEpochState(encoded(42,2)),null);
});
test('concurrent epoch reads coalesce and network caches remain isolated', async () => {
 let calls=0;const {getEpochState}=epochLoader(async url=>{calls++;return Response.json({result:encoded(url.includes('mainnet')?90:42,1)});});
 const r=await Promise.all(Array.from({length:20},()=>getEpochState('testnet')));assert.equal(calls,1);assert.ok(r.every(x=>x.current===42));
 assert.equal((await getEpochState('mainnet')).current,90);assert.equal(calls,2);
});
test('failed epoch reads never invent values, recover after bounded failure cache', async () => {
 const clock={now:100000};let fail=true;const {getEpochState}=epochLoader(async()=>{if(fail)throw Error('offline');return Response.json({result:encoded(43,0)});},clock);
 assert.equal((await getEpochState('testnet')).current,null);fail=false;clock.now+=5001;assert.equal((await getEpochState('testnet')).current,43);
});
test('local-only history and execution endpoints never serve testnet under mainnet', async () => {
 for(const file of ['app/api/history/route.ts','app/api/exec-stats/route.ts','app/api/top-contracts/route.ts']) {
  let accessed=false;const route=loadTS(file,{globals:{fetch:()=>{accessed=true;throw Error('must not fetch');}},mocks:{
   'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},'@/lib/apiError':{},'@/lib/execStats':{},'@/lib/topContracts':{},
   '@/lib/networks':{NETWORKS:{testnet:{active:true},mainnet:{active:true}}},
  }});const r=await route.GET({nextUrl:new URL('http://localhost/api?network=mainnet')});const body=await r.json();assert.equal(r.status,200);assert.equal(body.available,false);assert.equal(accessed,false);
 }
});

test('stats endpoint leaves un-enriched latest transaction count null and omits it from persistence', async () => {
 const rows=blocks().map((b,i)=>({number:b.number,timestamp:b.ts,txCount:i===0?null:b.txCount,gasUsed:b.gasUsed,gasLimit:b.gasLimit}));
 let persisted=''; class Clock extends Date{static now(){return 1001*1000;}}
 const route=loadTS('app/api/stats/route.ts',{globals:{Date:Clock,fetch:async(_url,o)=>{persisted=o.body;return {ok:true};},process:{env:{}}},mocks:{
  'next/server':{NextResponse:{json:(b,o)=>Response.json(b,o)}},'@/lib/apiError':{apiError:()=>Response.json({error:true},{status:500})},
  '@/lib/rpc':{getGasPrice:async()=>102000000000n,getLatestBlocksBatched:async()=>[]},
  '@/lib/tipCache':{getTipNumber:async()=>100},
  '@/lib/networks':{NETWORKS:{testnet:{active:true,blocksPerEpoch:50000},mainnet:{active:true,blocksPerEpoch:50000}}},
  '@/lib/wsBlockStream':{getLatestBlocks:()=>rows,getTipNumber:()=>100},
  '@/lib/epochState':{getEpochState:async()=>({current:42,inEpochDelayPeriod:true,source:'staking-precompile',fetchedAt:1001000})},
 }});
 const r=await route.GET({nextUrl:new URL('http://localhost/api/stats?network=testnet')});const body=await r.json();
 assert.equal(r.status,200);assert.equal(body.txInLatestBlock,null);assert.equal(body.tps,100);assert.equal(body.epoch.current,42);
 assert.equal(body.epoch.inEpochDelayPeriod,true);assert.ok(!persisted.includes('txs_in_block='));
});
