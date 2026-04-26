#!/usr/bin/env node
const {
  compareScenarios,
  reviewComponentPath,
  simulateScenario
} = require("../mcp/review.js");

const iterations = Number.parseInt(process.env.BENCH_ITERATIONS || "1000", 10);

const samplePath = {
  traffic: { rps: 120, burstiness: 0.2 },
  components: [
    {
      kind: "waf",
      name: "WAF",
      latencyMs: 3,
      jitterMs: 1,
      rateLimiter: { type: "sliding", windows: [{ windowMs: 1000, limit: 40 }] }
    },
    { kind: "api_gateway", name: "Gateway", latencyMs: 5, jitterMs: 2 },
    { kind: "app", name: "App", latencyMs: 80, jitterMs: 10, maxConcurrent: 20, queueCapacity: 200, timeoutMs: 1000 },
    { kind: "db", name: "DB", latencyMs: 240, jitterMs: 30, maxConcurrent: 4, queueCapacity: 40, timeoutMs: 300 }
  ]
};

const stressConfig = {
  durationSec: 30,
  stepMs: 50,
  rps: 250,
  burstiness: 0.35,
  trafficNoise: true,
  maxConcurrent: 40,
  queueCapacity: 400,
  maxQueueWaitMs: 1200,
  limiterType: "sliding",
  windows: [{ windowMs: 1000, limit: 80 }],
  rlLatencyDist: "uniform",
  rlLatA: 2,
  rlLatB: 12,
  latencyDist: "normal",
  latA: 70,
  latB: 20,
  depMaxConcurrent: 8,
  depLatencyDist: "normal",
  depLatA: 180,
  depLatB: 45
};

function bench(label, fn) {
  let last;
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) last = fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const opsPerSec = (iterations / elapsedMs) * 1000;
  console.log(`${label}: ${iterations} runs in ${elapsedMs.toFixed(1)}ms (${opsPerSec.toFixed(1)} ops/sec)`);
  return last;
}

if (!Number.isInteger(iterations) || iterations <= 0) {
  console.error("BENCH_ITERATIONS must be a positive integer");
  process.exit(1);
}

console.log(`Node ${process.version}`);
console.log(`Iterations: ${iterations}`);

const review = bench("review_component_path", () => reviewComponentPath(samplePath));
const simulation = bench("simulate_scenario stress", () => simulateScenario({ config: stressConfig }));
const comparison = bench("compare_scenarios stress", () => compareScenarios({
  base: { ...stressConfig, windows: [] },
  candidate: stressConfig
}));

console.log("Sample review summary:", JSON.stringify(review.summary));
console.log("Stress simulation summary:", JSON.stringify(simulation.summary));
console.log("Stress comparison delta:", JSON.stringify(comparison.delta));
