# Expected Results Notes

## For R1/R2/R3:
- `ok` should be true
- `rows` must be array with depth-sorted points
- depths must lie in requested window

## For repeated R1:
- response should be faster or comparable
- cache indicators (if present) should show higher hits

## For sparse metric:
- service returns structured response
- warnings/limitations indicate low finite ratio or high null ratio

## Red flags:
- 500 errors
- unsorted depth
- rows outside requested window
- repeated cold-cache behavior (no cache reuse)
