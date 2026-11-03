# Measurement sources and limitations

## Validator production and participation

The staking registry supplies validator IDs, authority addresses, stake,
commission and canonical active-set membership. Block beneficiaries are not
validator identities: several operators can share a beneficiary, and an operator
can change it or use the zero address.

Short-window production is attributed using observed `ValidatorRewarded` events
and validator IDs. Conflicting rewarded IDs in a block make that block's
attribution unavailable. Statistics include attribution coverage. Missing
coverage, incomplete registry data and stale observations produce `unknown` or
`null`, rather than a measured zero. A validator absent from a short sample is
not necessarily offline.

Persisted historical totals keyed only by beneficiary cannot safely be assigned
to authority addresses. The raw stream totals remain available with their
identity basis, but per-validator long-window totals and participation remain
unavailable until identity-safe history is collected. Old totals are not
rewritten or guessed.

Testnet uses enriched WebSocket ring data when available, with a short cache.
The paced RPC fallback retains its longer cache to avoid repeated bulk requests.
Mainnet has its own registry and metadata; performance remains unavailable
without mainnet reward-event coverage. No testnet event map or execution data
is reused for mainnet.

## Projected APR

APR is a projection, not a wallet's realized annual return. The current model
uses 18 MON gross block reward and a 0.3-second assumed interval, adjusted by
observed participation and commission. These assumptions are returned in the API
and must be updated when protocol parameters change. Commission is applied once;
an already-net reward must not have commission subtracted again. Unknown
commission or participation is not treated as zero commission or perfect
participation.

## Freshness

`dataAsOf` is the measurement time. `receivedAt` is the response time. Receiving a
cached response does not make its observations fresh. Last-block ages use wall
clock time. Stale registry data or incomplete attribution invalidates derived
performance fields. The UI displays unavailable readings as a dash.

## Chain rates and epochs

TPS uses transaction portions and elapsed chain time from the same half-open
window, excluding the oldest boundary block's transactions. Un-enriched heads,
missing heights and zero-duration samples are not recorded as zero traffic.
Chain timestamps have one-second resolution; short-window block times are
estimates. Historical InfluxDB samples collected before this change retain their
original method; this release does not backfill them.

The current epoch and delay-period flag come from the staking precompile's
`getEpoch()`. Modular block-height progress only estimates the next boundary
block, not the delayed consensus epoch transition. Next-set projections disclose
uncertain rotation artifacts rather than silently counting them as confirmed
non-departures.

## Registry protection

Public forced refresh is disabled. Registry loads are coalesced per network,
failed refreshes retain the last complete snapshot, and retry backoff prevents
repeated failed scans. Returned registry timestamps identify the snapshot rather
than the time of response.

## Portfolio scans

Only successfully decoded balance reads count as scanned. Partial or failed
reads are marked explicitly and are not cached as complete portfolios. A
verified zero is distinct from a failed read. Results are scoped by network and
wallet; repeated requests share in-flight work, and the cache is bounded.

## Verification

Run `npm test` for offline regression checks, `npx tsc --noEmit --incremental false`
for types, and `npm run build` for a production build. A separate verification
server can use `MONAD_BACKGROUND_DISABLED=1` to avoid duplicating the running
background collectors. That flag must not be set on the production service.

### Current stake and BeeHive identity

Validator responses expose `currentStakeMon` separately from `stakeMon` (epoch snapshot).
The current value is summed across all owned validator IDs; an unavailable slot stays
unknown. Performance denominators continue to use the epoch snapshot, and canonical
consensus membership determines active status. Registered operators outside that set
are labelled registered/inactive rather than missing in list and detail views.
BeeHive's Testnet auth is `0x745a60bec9a50981871dcb1616869ce9139a611b` (ID 279).
The operator page reads registration, commission, stake and membership from the
network-scoped chain registry and exposes its timestamp/staleness; no stake is hardcoded.
