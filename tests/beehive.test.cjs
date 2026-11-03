const test = require('node:test');
const assert = require('node:assert/strict');
const {loadTS} = require('./helpers/load-ts.cjs');

test('BeeHive page API distinguishes registration, live stake and consensus snapshot', async () => {
  const address='0x745a60bec9a50981871dcb1616869ce9139a611b';
  const route=loadTS('app/api/beehive/route.ts', {mocks:{
    'next/server': {NextResponse:{json:(body,options)=>({body,...options})}},
    '@/lib/validator-registry':{
      ensureRegistryLoaded:async()=>{},
      getChainDataById:()=>new Map([[279,{authAddress:address,stakeMon:0,activeStakeMon:100000,commissionPct:5}]]),
      getConsensusIds:()=>new Set(),
      getRegistryStatus:()=>({complete:true,stale:false,fetchedAt:1234})
    },
    '@/lib/prom-parser':{parsePrometheus:()=>[],findLatest:()=>null},
    '@/lib/config':{NODE_METRICS_URL:'http://metrics.invalid'},
  },globals:{fetch:async()=>({ok:true,text:async()=>'',json:async()=>({result:'0x1'})})}});
  const result=await route.GET({nextUrl:new URL('https://example.invalid/api/beehive?network=testnet')});
  assert.equal(result.body.configured.validatorAddress,address);
  assert.equal(result.body.validator.currentStakeMon,100000);
  assert.equal(result.body.validator.snapshotStakeMon,0);
  assert.equal(result.body.validator.registered,true);
  assert.equal(result.body.validator.isActiveSet,false);
  assert.equal(result.body.validator.commissionPct,5);
  const mainnet=await route.GET({nextUrl:new URL('https://example.invalid/api/beehive?network=mainnet')});
  assert.equal(mainnet.body.validator,undefined);
  assert.equal(mainnet.body.network,'mainnet');
});
