#!/usr/bin/env node
const { createInterface } = require("readline");
const {
  compareScenarios,
  defaultSimulationConfig,
  reviewComponentPath,
  simulateScenario
} = require("./review.js");

const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05"
];

// MCP stdio transport is newline-delimited JSON-RPC (NDJSON),
// not LSP-style Content-Length framing.
function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

const TOOLS = [
  {
    name: "simulate_scenario",
    description: "Run the current flat rate-limit and queueing simulator with explicit numeric parameters.",
    inputSchema: {
      type: "object",
      properties: {
        config: { type: "object", description: "Flat simulation config. Omit to use defaults.", additionalProperties: true },
        uiBaseUrl: { type: "string", description: "Optional browser simulator base URL for generated share links. Defaults to RATELIMITER_SIMULATOR_UI_URL or the public demo URL." }
      },
      additionalProperties: false
    }
  },
  {
    name: "compare_scenarios",
    description: "Compare a baseline configuration and a candidate configuration to see how 429, 503, latency, and queue peaks change.",
    inputSchema: {
      type: "object",
      properties: {
        base: { type: "object", additionalProperties: true },
        candidate: { type: "object", additionalProperties: true },
        uiBaseUrl: { type: "string", description: "Optional browser simulator base URL for generated share links. Defaults to RATELIMITER_SIMULATOR_UI_URL or the public demo URL." }
      },
      required: ["base", "candidate"],
      additionalProperties: false
    }
  },
  {
    name: "review_component_path",
    description: "Normalize a component-oriented path like webserver -> WAF -> API gateway -> app -> DB into simulator assumptions, then run the simulator and explain the assumptions.",
    inputSchema: {
      type: "object",
      properties: {
        traffic: { type: "object", additionalProperties: true },
        defaults: { type: "object", additionalProperties: true },
        uiBaseUrl: { type: "string", description: "Optional browser simulator base URL for generated share links. Defaults to RATELIMITER_SIMULATOR_UI_URL or the public demo URL." },
        components: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              kind: { type: "string" },
              latencyMs: { type: "number" },
              jitterMs: { type: "number" },
              latencyDist: { type: "string" },
              maxConcurrent: { type: "number" },
              queueCapacity: { type: "number" },
              queueTimeoutMs: { type: "number" },
              requestTimeoutMs: { type: "number" },
              timeoutMs: { type: "number" },
              rateLimiter: { type: "object", additionalProperties: true }
            },
            required: ["kind"],
            additionalProperties: true
          }
        }
      },
      required: ["components"],
      additionalProperties: false
    }
  },
  {
    name: "default_simulation_config",
    description: "Return the simulator's default configuration so an agent can start from a known baseline.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }
  }
];

const TOOL_HANDLERS = {
  simulate_scenario: simulateScenario,
  compare_scenarios: compareScenarios,
  review_component_path: reviewComponentPath,
  default_simulation_config: () => defaultSimulationConfig()
};

const asToolResult = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  structuredContent: data
});

function handleRequest(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    const requestedVersion = params?.protocolVersion;
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)
      ? requestedVersion
      : SUPPORTED_PROTOCOL_VERSIONS[0];
    return reply(id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: "rate-limit-simulator-mcp", version: "0.1.0" }
    });
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    return reply(id, { tools: TOOLS });
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    const handler = TOOL_HANDLERS[name];
    if (!handler) return fail(id, -32601, `Unknown tool: ${name}`);
    try {
      return reply(id, asToolResult(handler(args)));
    } catch (error) {
      return fail(id, -32000, error?.message || "Tool execution failed");
    }
  }

  return fail(id, -32601, `Unknown method: ${method}`);
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }
  handleRequest(msg);
});
rl.on("close", () => process.exit(0));
