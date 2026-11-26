import os from 'node:os';
import type { NextFunction, Request, Response } from 'express';

interface RecentErrorEntry {
  timestamp: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
}

const startedAtMs = Date.now();
const latenciesMs: number[] = [];
const recentErrors: RecentErrorEntry[] = [];
let totalRequests = 0;
let clientErrors4xx = 0;
let serverErrors5xx = 0;

export function observabilityMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startNs = process.hrtime.bigint();
  const fullPath = (req.originalUrl || req.path || '').split('?')[0];
  res.on('finish', () => {
    if (!fullPath.startsWith('/api/')) return;
    const durationMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
    totalRequests += 1;
    latenciesMs.push(durationMs);
    if (latenciesMs.length > 500) latenciesMs.shift();

    if (res.statusCode >= 500) {
      serverErrors5xx += 1;
      recordErrorLog(req.method, fullPath, res.statusCode, durationMs);
    } else if (res.statusCode >= 400) {
      clientErrors4xx += 1;
    }
  });
  next();
}

function recordErrorLog(method: string, routePath: string, statusCode: number, durationMs: number): void {
  // Never log query tokens, cookies, request bodies, or message contents
  recentErrors.unshift({
    timestamp: new Date().toISOString(),
    method,
    path: routePath.slice(0, 160),
    statusCode,
    durationMs: Number(durationMs.toFixed(1)),
  });
  if (recentErrors.length > 50) recentErrors.pop();
}

export function getObservabilitySnapshot(activeSseClients: number) {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const avgLatencyMs =
    sorted.length > 0 ? Number((sorted.reduce((sum, v) => sum + v, 0) / sorted.length).toFixed(1)) : 0;
  const p95Idx = sorted.length > 0 ? Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95)) : 0;
  const p95LatencyMs = sorted.length > 0 ? Number(sorted[p95Idx].toFixed(1)) : 0;
  const mem = process.memoryUsage();

  return {
    uptimeSeconds: Math.floor((Date.now() - startedAtMs) / 1000),
    totalRequests,
    clientErrors4xx,
    serverErrors5xx,
    errorRatePercent: totalRequests > 0 ? Number(((serverErrors5xx / totalRequests) * 100).toFixed(2)) : 0,
    avgLatencyMs,
    p95LatencyMs,
    activeSseClients,
    memoryRssMb: Number((mem.rss / (1024 * 1024)).toFixed(1)),
    heapUsedMb: Number((mem.heapUsed / (1024 * 1024)).toFixed(1)),
    nodeVersion: process.version,
    platform: os.platform(),
    recentServerErrors: [...recentErrors].slice(0, 15),
  };
}
