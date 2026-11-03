const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTS, createLoader } = require('./helpers/load-ts.cjs');
const metrics = loadTS('lib/validatorMetrics.ts');
const base = () => ({ blocksProduced: 0, firstBlockTs: 0, lastBlockTs: 0,
  newestTs: Math.floor(Date.now()/1000), oldestTs: Math.floor(Date.now()/1000)-150,
  windowSeconds: 150, totalBlocks: 500, producersInWindow: 170,
  stakeMon: 10_000_000, isActiveSet: true, totalActiveStake: 2_000_000_000,
  cumulativeBlocksObserved: null, cumulativeMinerBlocks: null });

test('unknown event coverage/history is distinct from measured zero', () => {
  const unknown = metrics.computeValidatorMetrics({...base(), attributionComplete:false});
  assert.equal(unknown.health,'unknown');
  assert.equal(unknown.participationPct,null);
  assert.equal(unknown.participationLong,null);
  const zero = metrics.computeValidatorMetrics({...base(),attributionComplete:true,
    cumulativeBlocksObserved:10000,cumulativeMinerBlocks:0});
  assert.equal(zero.participationPct,0);
  assert.equal(zero.participationLong,0);
  assert.equal(zero.health,'missing');
});

test('projected APR uses gross 18 MON, .3s assumption, commission once', () => {
  const input={stakeMon:10_000_000,totalActiveStake:2_000_000_000,
    commissionPct:20,participationPct:100,participationLong:null,isActiveSet:true};
  const r=metrics.computeRealizedApr(input);
  const gross=365*24*3600/.3*18/2_000_000_000*100;
  assert.equal(r.aprGross,Math.round(gross*10)/10);
  assert.equal(r.aprDelegator,Math.round(gross*.8*10)/10);
  assert.equal(r.methodology.kind,'projection');
  assert.equal(r.methodology.rewardPerBlockMon,18);
  assert.equal(metrics.computeRealizedApr({...input,participationPct:null}),null);
  assert.equal(metrics.computeRealizedApr({...input,commissionPct:null}),null);
  assert.equal(metrics.computeRealizedApr({...input,participationPct:0}).aprDelegator,0);
});

test('cached health cannot stay green and last block age uses wall clock', () => {
  const r=metrics.applyValidatorFreshness({lastBlockTs:100,ageSeconds:4,
    health:'active',aprDelegator:9,aprGross:10},110000,1_000_000);
  assert.equal(r.ageSeconds,900);
  assert.equal(r.health,'unknown');
  assert.equal(r.aprDelegator,null);
  const m=metrics.computeValidatorMetrics({...base(),blocksProduced:1,lastBlockTs:100,newestTs:104});
  assert.ok(m.ageSeconds>1000);
});

test('beneficiary observations and block IDs are isolated by network', async () => {
  const {loadTS}=createLoader({mocks:{'./config':{MONAD_RPC_URL:'https://test.invalid'},
    './networks':{NETWORKS:{mainnet:{rpc:'https://main.invalid'}}}},
    globals:{fetch:async (_url,opts)=>{
      const q=JSON.parse(opts.body);
      return {ok:true,json:async()=>({result:q.method==='eth_blockNumber'?'0x2710':[
        {blockNumber:'0x2710',topics:['0xreward','0x2','0x0000000000000000000000000000000000000000000000000000000000000000']}
      ]})};
    }}});
  const b=loadTS('lib/beneficiaryMap.ts');
  b.recordBeneficiary(2,'0xShared','testnet');
  b.recordBeneficiary(3,'0xShared','testnet');
  b.recordBeneficiary(4,'0x0000000000000000000000000000000000000000','testnet');
  assert.equal(b.getBeneficiaryForValidator(2,'mainnet'),null);
  await b.tickBeneficiaryScanner('testnet');
  assert.equal(b.getValidatorIdForBlock(10000,'testnet'),2);
  assert.equal(b.getValidatorIdForBlock(10000,'mainnet'),null);
});

test('conflicting rewarded IDs are unknown rather than first event wins', async () => {
  const {loadTS}=createLoader({mocks:{'./config':{MONAD_RPC_URL:'https://test.invalid'},
    './networks':{NETWORKS:{mainnet:{rpc:'https://main.invalid'}}}},
    globals:{fetch:async (_url,opts)=>{
      const q=JSON.parse(opts.body);
      return {ok:true,json:async()=>({result:q.method==='eth_blockNumber'?'0x2710':[
        {blockNumber:'0x2710',topics:['0xreward','0x2']},
        {blockNumber:'0x2710',topics:['0xreward','0x3']}
      ]})};
    }}});
  const b=loadTS('lib/beneficiaryMap.ts');
  await b.tickBeneficiaryScanner('testnet');
  assert.equal(b.getValidatorIdForBlock(10000,'testnet'),null);
});

test('multi-ID stake rollup keeps all IDs without merging unrelated auths', () => {
  const r=metrics.computeAuthStake('0xOwner',new Map([
    [1,{authAddress:'0xOWNER',stakeMon:10}],
    [2,{authAddress:'0xowner',stakeMon:20}],
    [3,{authAddress:'0xother',stakeMon:90}],
  ]),new Set([1,2,3]));
  assert.equal(r.stakeMon,30);
  assert.deepEqual([...r.validatorIds],[1,2]);
  assert.deepEqual([...r.activeIds],[1,2]);
});

test('RPC missing block/error is unavailable; empty transaction list is measured zero', () => {
  const ws=loadTS('lib/wsBlockStream.ts',{mocks:{ws:class{},'./config':{
    MONAD_WS_URL:'ws://invalid',MONAD_RPC_URL:'https://invalid',INFLUX_URL:'https://invalid',INFLUX_DB:'test'
  }}});
  assert.equal(ws.transactionsFromRpcResult({error:{code:-32000}}),null);
  assert.equal(ws.transactionsFromRpcResult({result:null}),null);
  assert.equal(ws.transactionsFromRpcResult({result:{}}),null);
  assert.equal(ws.transactionsFromRpcResult({result:{transactions:[]}}).length,0);
  assert.equal(ws.transactionsFromRpcResult({result:{transactions:['0xhash']}}),null);
});
