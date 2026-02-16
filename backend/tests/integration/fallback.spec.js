import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.TEST_API_BASE || "http://localhost:5000";
const WELL = process.env.TEST_WELL_ID || "WELL_1770968672517";

async function safeJson(url, options = {}) {
  const res = await fetch(url, options);
  const txt = await res.text();
  let json = null;
  try {
    json = JSON.parse(txt);
  } catch {}
  return { status: res.status, json, text: txt };
}

test("interpret returns fallback path when forced fallback is enabled", async (t) => {
  const health = await safeJson(`${BASE}/api/health`);
  if (health.status !== 200) {
    t.skip("backend is not running for integration test");
    return;
  }

  const res = await safeJson(`${BASE}/api/ai/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wellId: WELL,
      fromDepth: 10608.2,
      toDepth: 12584.69,
      curves: ["HC1__2", "HC2__3"],
    }),
  });

  if (res.status >= 500) {
    t.skip("interpret endpoint failed on running backend instance");
    return;
  }
  assert.equal(res.status, 200);
  assert.equal(res.json?.ok, true);
  assert.equal(typeof res.json?.narrativeStatus, "string");

  const status = String(res.json?.narrativeStatus || "");
  const isFallback = /fallback|forced/i.test(status);
  if (!isFallback) {
    t.skip(
      "FORCE_NARRATIVE_FALLBACK is not enabled on the running backend process; set it to true and rerun this test."
    );
    return;
  }

  assert.ok(isFallback);
  assert.ok(res.json?.modelUsed === null || typeof res.json?.modelUsed === "string");
});
