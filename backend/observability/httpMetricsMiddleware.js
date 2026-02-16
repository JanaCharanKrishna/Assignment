import { apiErrors, httpDuration, httpRequestsTotal } from "./metrics.js";

function normalizeRoute(req) {
  const base = req.baseUrl || "";
  const path = req.route?.path || req.path || "unknown";
  return `${base}${path}` || "unknown";
}

export function httpMetricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const end = process.hrtime.bigint();
    const ms = Number(end - start) / 1e6;
    const route = normalizeRoute(req);
    const method = req.method || "GET";
    const status = String(res.statusCode || 0);
    httpDuration.labels(route, method, status).observe(ms);
    httpRequestsTotal.labels(route, method, status).inc();
    if (res.statusCode >= 400) {
      apiErrors.labels(route, status).inc();
    }
  });
  next();
}
