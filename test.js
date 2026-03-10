import { enhancePrompt } from "./index.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(label, fn) {
  process.stdout.write(`  ${label} ... `);
  try {
    await fn();
    console.log("PASS");
    passed++;
  } catch (err) {
    console.log(`FAIL\n    ${err.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

// ─── Tests ────────────────────────────────────────────────────────────────────
console.log("\nprompt-enhancer test suite\n");

// Basic enhancement
console.log("Basic enhancement:");
await test("returns a non-empty string", async () => {
  const result = await enhancePrompt("fix the login bug");
  assert(typeof result === "string" && result.length > 20, `Expected non-empty string, got: ${JSON.stringify(result)}`);
});

await test("does not return raw error string", async () => {
  const result = await enhancePrompt("fix the login bug");
  assert(!result.startsWith("Error:"), `Got error: ${result}`);
});

await test("enhances a vague prompt into something longer", async () => {
  const input = "add dark mode";
  const result = await enhancePrompt(input);
  assert(result.length > input.length * 2, `Enhanced prompt too short (${result.length} chars)`);
});

await test("works with a longer, more specific prompt", async () => {
  const result = await enhancePrompt("refactor the authentication module to use JWT instead of sessions");
  assert(typeof result === "string" && result.length > 50);
});

// Edge cases
console.log("\nEdge cases:");
await test("handles empty-ish prompt gracefully", async () => {
  const result = await enhancePrompt("fix bug");
  assert(typeof result === "string");
});

await test("result does not contain meta-commentary", async () => {
  const result = await enhancePrompt("add search feature");
  const metaPhrases = ["here is the enhanced", "here's the improved", "enhanced prompt:", "improved prompt:"];
  const lower = result.toLowerCase();
  const found = metaPhrases.find(p => lower.startsWith(p));
  assert(!found, `Result starts with meta-commentary: "${found}"`);
});

// Summary
console.log(`\n${"─".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
