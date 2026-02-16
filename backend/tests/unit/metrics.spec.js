import test from "node:test";
import assert from "node:assert/strict";
import { register } from "../../observability/metrics.js";

test("metrics registry exposes core phase-6 metrics", async () => {
  const txt = await register.metrics();
  assert.ok(txt.includes("http_request_duration_ms"));
  assert.ok(txt.includes("cache_tile_requests_total"));
  assert.ok(txt.includes("interpret_duration_ms"));
  assert.ok(txt.includes("narrative_fallback_total"));
  assert.ok(txt.includes("api_errors_total"));
});

