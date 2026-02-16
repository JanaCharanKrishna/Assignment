import test from "node:test";
import assert from "node:assert/strict";
import { buildLogPayload } from "../../observability/logger.js";

test("buildLogPayload includes requestId and runId", () => {
  const payload = buildLogPayload({
    level: "info",
    message: "interpret completed",
    requestId: "req-123",
    runId: "run-456",
    route: "/api/ai/interpret",
  });

  assert.equal(payload.requestId, "req-123");
  assert.equal(payload.runId, "run-456");
  assert.equal(payload.message, "interpret completed");
  assert.equal(payload.route, "/api/ai/interpret");
  assert.ok(typeof payload.timestamp === "string");
});

