# PHASE3 Signoff

Date: 2026-02-16

## Scope
Validated the requested additional checks after Phase 3 hardening:
1. Cold-start after Redis flush
2. Concurrency smoke (parallel burst)
3. Cache invalidation via version bump
4. Large-window guardrail behavior

## Artifacts
- `testing/postman/newman-phase3-after-flush.xml`
- `testing/postman/newman-phase3-after-flush.json`
- `testing/postman/concurrency-smoke.json`
- `testing/postman/cache-invalidation-check.json`
- `testing/postman/large-window-guardrail.json`

## 1) Cold-Start After Redis Flush
Command outcome: `redis-cli FLUSHDB` => `OK`

Hardened suite after flush:
- Requests: 9
- Assertions: 57
- Assertion failures: 0
- Total failures: 0
- Cold broad request: 372 ms
- Warm repeat request: 13 ms

Result: PASS

## 2) Concurrency Smoke (100 calls, concurrency 30)
Summary:
- total: 100
- concurrency: 30
- httpFail: 0
- notOk: 0
- unsorted responses: 0
- duplicate-depth responses: 0
- latency ms: min=25, p50=66, p95=102, max=111, avg=67.89

Result: PASS

## 3) Cache Invalidation / Version Test
Method:
- Warmed cache on version 1
- Bumped well version to 2
- Cleared metric meta key
- Re-ran same request twice

Observed:
- Keys with old version before bump: 7
- Keys with new version after bump: 7
- First request after bump: source=mongo, hit=0, miss=7, completeness=partial
- Second request after bump: source=redis, hit=7, miss=0, completeness=complete

Result: PASS

## 4) Large-Window Guardrail Test
Request used:
- `/api/well/WELL_1770968672517/window-data?metric=HC1__2&fromDepth=9000&toDepth=17000&pixelWidth=4000`

First call:
- status=200, ok=true, source=mixed
- pointsReturned=8001, underMax12000=true
- sorted=true, noDuplicateDepths=true
- range returned: minDepth=9000, maxDepth=17000
- tiles hit/miss=7/33

Second call:
- status=200, ok=true, source=redis
- tiles hit/miss=40/0
- pointsReturned=8001

Result: PASS

## Completion Note
## Phase 3 - Performance Architecture (Completed)

### Delivered
- Multi-resolution pyramid serving (overview uses coarse, zoom uses finer levels)
- Tile-based cache keyed by (wellId, metric, level, tile window, version/hash)
- Query planner endpoint returning source/level/estimated points/tile hit-miss
- Frontend/backend guardrails for point budget and efficient rendering path

### Validation
- Hardened test suite: PASS
- 5 consecutive stability runs: PASS (0 failures, 57 assertions each)
- Warm-cache behavior: PASS (warm << cold latency)
- Boundary stitching and crop correctness: PASS
- Sparse/null quality gate safety: PASS (no crash, explicit warnings)
- Multi-curve evidence behavior: PASS (support>=2 intervals present)

### Additional hardening
- Concurrency smoke: PASS
- Cache invalidation by version/hash: PASS
- Post-flush cold-start recovery: PASS
- Large-window guardrail enforcement: PASS

## Notes
- `window-data` endpoint currently accepts single `metric` query parameter (not `metrics`). Concurrency and guardrail checks used `metric=HC1__2` accordingly.
