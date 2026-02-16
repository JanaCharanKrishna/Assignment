import pino from "pino";

export function buildLogPayload(obj = {}) {
  return {
    timestamp: new Date().toISOString(),
    ...obj,
  };
}

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});
