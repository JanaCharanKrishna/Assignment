import client from "prom-client";

const register = new client.Registry();
client.collectDefaultMetrics({ register });

const httpDuration = new client.Histogram({
  name: "http_request_duration_ms",
  help: "HTTP request duration in ms",
  labelNames: ["route", "method", "status"],
  buckets: [5, 10, 20, 50, 100, 250, 500, 1000, 2000, 5000],
});

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["route", "method", "status"],
});

const cacheTileRequests = new client.Counter({
  name: "cache_tile_requests_total",
  help: "Total tile cache lookups",
  labelNames: ["result"], // hit|miss
});

const interpretDuration = new client.Histogram({
  name: "interpret_duration_ms",
  help: "Interpret API duration in ms",
  labelNames: ["status"], // ok|error
  buckets: [50, 100, 200, 400, 800, 1200, 2000, 4000, 8000],
});

const narrativeFallback = new client.Counter({
  name: "narrative_fallback_total",
  help: "Narrative fallback occurrences",
  labelNames: ["reason"],
});

const apiErrors = new client.Counter({
  name: "api_errors_total",
  help: "API errors by code and route",
  labelNames: ["route", "code"],
});

const intervalDiffDuration = new client.Histogram({
  name: "interval_diff_duration_ms",
  help: "Interval diff API duration in ms",
  labelNames: ["status"],
  buckets: [20, 50, 100, 200, 400, 800, 1500, 3000, 6000],
});

const eventTimelineDuration = new client.Histogram({
  name: "event_timeline_duration_ms",
  help: "Event timeline API duration in ms",
  labelNames: ["status"],
  buckets: [10, 20, 50, 100, 200, 400, 800, 1500, 3000],
});

const crossplotDuration = new client.Histogram({
  name: "crossplot_duration_ms",
  help: "Crossplot API duration in ms",
  labelNames: ["status"],
  buckets: [20, 50, 100, 250, 500, 1000, 2000, 4000, 8000],
});

const feedbackWriteTotal = new client.Counter({
  name: "feedback_write_total",
  help: "Feedback write attempts by status",
  labelNames: ["status"],
});

const feedbackReadTotal = new client.Counter({
  name: "feedback_read_total",
  help: "Feedback read operations by status and kind",
  labelNames: ["status", "kind"],
});

const featureErrorTotal = new client.Counter({
  name: "feature_error_total",
  help: "Feature errors by feature and code",
  labelNames: ["feature", "code"],
});

register.registerMetric(httpDuration);
register.registerMetric(httpRequestsTotal);
register.registerMetric(cacheTileRequests);
register.registerMetric(interpretDuration);
register.registerMetric(narrativeFallback);
register.registerMetric(apiErrors);
register.registerMetric(intervalDiffDuration);
register.registerMetric(eventTimelineDuration);
register.registerMetric(crossplotDuration);
register.registerMetric(feedbackWriteTotal);
register.registerMetric(feedbackReadTotal);
register.registerMetric(featureErrorTotal);

export {
  register,
  httpDuration,
  httpRequestsTotal,
  cacheTileRequests,
  interpretDuration,
  narrativeFallback,
  apiErrors,
  intervalDiffDuration,
  eventTimelineDuration,
  crossplotDuration,
  feedbackWriteTotal,
  feedbackReadTotal,
  featureErrorTotal,
};
