import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.TEST_API_BASE || "http://localhost:5000";
const WELL = process.env.TEST_WELL_ID || "WELL_1770968672517";

function metricCount(text, metricName) {
  const regex = new RegExp(`^${metricName}(\\{[^}]*\\})?\\s+([0-9.eE+-]+)$`, "gm");
  let sum = 0;
  let m;
  while ((m = regex.exec(text)) !== null) sum += Number(m[2]);
  return sum;
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  return { status: res.status, text };
}

test("http + interpret metrics increment after traffic", async (t) => {
  const health = await fetchText(`${BASE}/api/health`);
  if (health.status !== 200) {
    t.skip("backend is not running for integration test");
    return;
  }

  const before = await fetchText(`${BASE}/metrics`);
  assert.equal(before.status, 200);
  const beforeHttp = metricCount(before.text, "http_requests_total");
  const beforeInterpret = metricCount(before.text, "interpret_duration_ms_count");

  const wd = await fetchText(
    `${BASE}/api/well/${WELL}/window-data?fromDepth=12428.6&toDepth=13333.7&metric=HC1__2`
  );
  if (wd.status === 404) {
    t.skip("window-data endpoint is not available on the running backend instance");
    return;
  }
  assert.equal(wd.status, 200);

  const interp = await fetchText(`${BASE}/api/ai/interpret`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      wellId: WELL,
      fromDepth: 12428.6,
      toDepth: 13333.7,
      curves: ["HC1__2"],
    }),
  });
  assert.equal(interp.status, 200);

  const after = await fetchText(`${BASE}/metrics`);
  assert.equal(after.status, 200);
  const afterHttp = metricCount(after.text, "http_requests_total");
  const afterInterpret = metricCount(after.text, "interpret_duration_ms_count");

  assert.ok(afterHttp > beforeHttp);
  assert.ok(afterInterpret >= beforeInterpret + 1);
});
