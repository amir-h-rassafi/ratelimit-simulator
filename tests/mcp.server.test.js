const assert = require("assert");
const { spawn } = require("child_process");
const path = require("path");
const { createInterface } = require("readline");

function runServer(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "mcp", "server.js")], {
      stdio: ["pipe", "pipe", "inherit"]
    });
    const responses = [];
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        responses.push(JSON.parse(trimmed));
      } catch (err) {
        reject(new Error(`non-JSON line from server: ${line}`));
      }
    });
    child.on("error", reject);
    child.on("close", () => resolve(responses));
    for (const req of requests) child.stdin.write(`${JSON.stringify(req)}\n`);
    child.stdin.end();
  });
}

(async () => {
  const responses = await runServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "default_simulation_config", arguments: {} } }
  ]);

  const byId = new Map(responses.filter((r) => r.id != null).map((r) => [r.id, r]));

  const init = byId.get(1);
  assert(init, "initialize response missing");
  assert.strictEqual(init.result.protocolVersion, "2025-11-25");
  assert(init.result.serverInfo?.name, "serverInfo.name required");

  const list = byId.get(2);
  assert(Array.isArray(list.result.tools), "tools/list must return array");
  const names = list.result.tools.map((t) => t.name);
  for (const needed of ["simulate_scenario", "compare_scenarios", "review_component_path", "default_simulation_config"]) {
    assert(names.includes(needed), `missing tool: ${needed}`);
  }

  const call = byId.get(3);
  assert(call.result.content?.[0]?.type === "text", "tool result must include text content");
  assert(call.result.structuredContent, "tool result must include structuredContent");
  assert.strictEqual(call.result.structuredContent.limiterType, "sliding");

  const legacyResponses = await runServer([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "legacy-test", version: "0" } } }
  ]);
  assert.strictEqual(legacyResponses[0].result.protocolVersion, "2024-11-05");

  console.log("mcp server stdio framing tests passed");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
