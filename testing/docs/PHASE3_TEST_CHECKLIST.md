# Phase 3 Test Checklist

## Cold vs Warm
- [ ] R1 first call succeeds
- [ ] R1 repeat call succeeds
- [ ] Warm latency <= 1.5x cold latency (ideally much lower)
- [ ] Warm call returns consistent row count

## Tile Reuse
- [ ] Nested R2 mostly reuses cached tiles
- [ ] Rows cropped strictly within [from,to]
- [ ] No out-of-range depths

## Zoom Behavior
- [ ] R3 returns detailed data
- [ ] Planner picks finer level on zoom

## Quality Gate
- [ ] Sparse metric call does not crash
- [ ] Warning/limitation is present when applicable

## Integrity
- [ ] Depth sorted ascending
- [ ] No duplicate depth artifacts in chart
- [ ] No HTTP 500 during repeated runs
