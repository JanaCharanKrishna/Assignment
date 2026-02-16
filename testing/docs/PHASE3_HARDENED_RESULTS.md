# Phase 3 Hardened Test Results

Date: 2026-02-16

## Artifacts
- JUnit: `testing/postman/newman-phase3-hardened.xml`
- JSON (detailed): `testing/postman/newman-phase3-hardened.json`
- 5-run JSON reports: `testing/postman/newman-phase3-hardened-run1.json` .. `testing/postman/newman-phase3-hardened-run5.json`

## Single Hardened Run Summary
- Requests: 9
- Assertions: 57
- Assertion failures: 0
- Request failures: 0
- Total failures: 0
- Average response time: 324.22 ms

## Request Results (Single Run)
| Request | Status | Response Time (ms) |
|---|---:|---:|
| A) R1 Cold broad window-data | 200 | 35 |
| B) R1 Warm broad repeat | 200 | 14 |
| C) R2 Nested range crop test | 200 | 6 |
| D) Boundary stitch test | 200 | 7 |
| E) R3 Zoom detail test | 200 | 6 |
| F) window-plan overview low pixel budget | 200 | 8 |
| G) window-plan zoom high pixel budget | 200 | 5 |
| H) Sparse/null quality gate via interpret | 200 | 1203 |
| I) Multi-curve evidence test I2 via interpret | 200 | 1634 |

## Stability Loop (5 Consecutive Runs)
| Run | Total Failures | Assertions | Assertion Failures | Avg Response (ms) |
|---:|---:|---:|---:|---:|
| 1 | 0 | 57 | 0 | 231.44 |
| 2 | 0 | 57 | 0 | 235 |
| 3 | 0 | 57 | 0 | 215.44 |
| 4 | 0 | 57 | 0 | 236.89 |
| 5 | 0 | 57 | 0 | 119.22 |

## Pass Criteria Check
- All tests pass for 5 consecutive runs: PASS
- Warm repeat latency comparable/better than cold: PASS
- Boundary test has no duplicate depths: PASS
- Planner monotonicity (high px => finer/equal level): PASS
- Multi-curve evidence has at least one interval with support >= 2: PASS
- Sparse/null quality gate returns warnings without crash: PASS
