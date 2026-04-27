const assert = require("assert");
const {
  defaultSimulationConfig,
  makeUiUrl,
  reviewComponentPath,
  compareScenarios
} = require("../mcp/review.js");

{
  const defaults = defaultSimulationConfig();
  assert.strictEqual(defaults.limiterType, "sliding");
  assert(Array.isArray(defaults.windows));
}

{
  const review = reviewComponentPath({
    traffic: { rps: 120, burstiness: 0.2 },
    components: [
      { kind: "waf", name: "WAF", latencyMs: 3, jitterMs: 1, rateLimiter: { type: "sliding", windows: [{ windowMs: 1000, limit: 40 }] } },
      { kind: "api_gateway", name: "Gateway", latencyMs: 5, jitterMs: 2 },
      { kind: "app", name: "App", latencyMs: 80, jitterMs: 10, maxConcurrent: 20, queueCapacity: 200, timeoutMs: 1000 },
      { kind: "db", name: "DB", latencyMs: 240, jitterMs: 30, maxConcurrent: 4, queueCapacity: 40, timeoutMs: 300 }
    ]
  });
  assert.strictEqual(review.normalizedConfig.rlLatA, 8);
  assert.strictEqual(review.normalizedConfig.maxConcurrent, 20);
  assert.strictEqual(review.normalizedConfig.depMaxConcurrent, 4);
  assert(review.summary.arrived > 0);
  assert(review.assumptions.length >= 4);
}

{
  const review = reviewComponentPath({
    uiBaseUrl: "https://example.test/simulator/",
    traffic: { rps: 90, burstiness: 0.4 },
    components: [
      { kind: "nginx", name: "Nginx", maxConcurrent: 500, queueCapacity: 2000, queueTimeoutMs: 750, requestTimeoutMs: 2500 },
      { kind: "api_gateway", name: "Gateway", latencyMs: 8, jitterMs: 1, maxConcurrent: 100, queueCapacity: 400, timeoutMs: 250, rateLimiter: { type: "sliding", windows: [{ windowMs: 1000, limit: 30 }] } },
      { kind: "app", name: "App", latencyMs: 80, jitterMs: 10, maxConcurrent: 20, queueCapacity: 200, timeoutMs: 1000 },
      { kind: "db", name: "DB", latencyMs: 240, jitterMs: 30, maxConcurrent: 4 }
    ]
  });
  assert.strictEqual(review.normalizedConfig.wsMaxConcurrent, 500);
  assert.strictEqual(review.normalizedConfig.wsQueueCapacity, 2000);
  assert.strictEqual(review.normalizedConfig.wsMaxQueueWaitMs, 750);
  assert.strictEqual(review.normalizedConfig.wsRequestTimeoutMs, 2500);
  assert.strictEqual(review.normalizedConfig.rlMaxConcurrent, 100);
  assert.strictEqual(review.normalizedConfig.rlQueueCapacity, 400);
  assert.strictEqual(review.normalizedConfig.rlMaxQueueWaitMs, 250);
  assert.strictEqual(review.collapse.webserver.componentCount, 1);
  assert(review.summary.enteredWebserver > 0);
  assert("peakWsQueue" in review.summary);
  assert(review.uiUrl.startsWith("https://example.test/simulator/?state="), "component review should include a configurable shareable UI URL");
}

{
  const url = makeUiUrl({ ...defaultSimulationConfig(), windows: [{ windowMs: 1000, limit: 25 }] }, "https://docs.example.local/tools/ratelimit");
  const parsed = new URL(url);
  assert.strictEqual(parsed.origin, "https://docs.example.local");
  assert.strictEqual(parsed.pathname, "/tools/ratelimit");
  assert(parsed.searchParams.get("state"), "shareable UI URL should include encoded state");
}

{
  const shared = {
    rps: 120, depMaxConcurrent: 2,
    depLatA: 300, depLatB: 0, depLatencyDist: "constant",
    latencyDist: "constant", latA: 40, latB: 0
  };
  const comparison = compareScenarios({
    uiBaseUrl: "https://preview.example.test/",
    base: { ...shared, windows: [] },
    candidate: { ...shared, windows: [{ windowMs: 1000, limit: 20 }], limiterType: "sliding" }
  });
  assert(comparison.baseUiUrl.startsWith("https://preview.example.test/?state="), "comparison should include configurable base UI URL");
  assert(comparison.candidateUiUrl.startsWith("https://preview.example.test/?state="), "comparison should include configurable candidate UI URL");
  assert(comparison.candidate.rate429 > comparison.base.rate429);
  assert(comparison.candidate.rate503 <= comparison.base.rate503);
  // Sign regression: candidate has a limiter, base does not. Candidate should
  // avoid strictly more backend load than base → positive delta.
  assert(comparison.delta.appLoadAvoidedVsNoLimiter > 0, `expected positive app-load-avoided delta, got ${comparison.delta.appLoadAvoidedVsNoLimiter}`);
  assert(comparison.delta.depLoadAvoidedVsNoLimiter > 0, `expected positive dep-load-avoided delta, got ${comparison.delta.depLoadAvoidedVsNoLimiter}`);
}

console.log("mcp review tests passed");
