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

test("window-data then interpret pipeline", async (t) => {
  const health = await safeJson(`${BASE}/api/health`);
  if (health.status !== 200) {
    t.skip("backend is not running for integration test");
    return;
  }

  const windowResp = await safeJson(
    `${BASE}/api/well/${WELL}/window-data?metric=HC1__2&fromDepth=12348&toDepth=13568&pixelWidth=1200`
  );
  if (windowResp.status === 404) {
    t.skip("window-data endpoint is not available on the running backend instance");
    return;
  }
  assert.equal(windowResp.status, 200);
  assert.equal(windowResp.json?.ok, true);
  assert.equal(Array.isArray(windowResp.json?.rows), true);
  const depths = windowResp.json.rows.map((r) => Number(r.depth)).filter(Number.isFinite);
  for (let i = 1; i < depths.length; i += 1) {
    assert.ok(depths[i] >= depths[i - 1]);
  }

  const interpResp = await safeJson(`${BASE}/api/ai/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wellId: WELL,
      fromDepth: 10608.2,
      toDepth: 12584.69,
      curves: ["HC1__2", "HC2__3", "CC6"],
    }),
  });
  assert.equal(interpResp.status, 200);
  assert.equal(interpResp.json?.ok, true);
  assert.equal(typeof interpResp.json?.deterministic, "object");
  assert.equal(typeof interpResp.json?.insight, "object");
  assert.equal(typeof interpResp.json?.narrativeStatus, "string");
});
