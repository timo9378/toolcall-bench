/**
 * Tool-calling benchmark: native Ollama tool support (= what an OpenAI-compat
 * client like the Vercel AI SDK gets today) vs. a quick-and-dirty repair shim
 * (prompt strategy + JSON extraction/repair + schema validation + one retry).
 *
 * Usage: node bench.mjs <model> [native|shim|both]
 * Output: results-<model>.json + console summary
 */

import Ajv from "ajv";
import { jsonrepair } from "jsonrepair";
import { writeFileSync } from "node:fs";
import { CASES } from "./cases.mjs";

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const model = process.argv[2];
const mode = process.argv[3] ?? "both";
if (!model) {
  console.error("usage: node bench.mjs <model> [native|shim|both]");
  process.exit(1);
}

const ajv = new Ajv({ allowUnionTypes: true });

async function chat(messages, tools) {
  const res = await fetch(`${OLLAMA}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      ...(tools ? { tools } : {}),
      temperature: 0,
      max_tokens: 1024,
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()).choices[0].message;
}

// ── scoring ───────────────────────────────────────────────
function scoreCalls(calls, testCase) {
  const { expect } = testCase;
  if (!expect.call) {
    return calls.length === 0
      ? { pass: true }
      : { pass: false, reason: `eager call: ${calls.map((c) => c.name).join(",")}` };
  }
  if (calls.length === 0) return { pass: false, reason: "no tool call" };

  if (expect.parallel) {
    if (calls.length < expect.parallel)
      return { pass: false, reason: `expected ${expect.parallel} calls, got ${calls.length}` };
    if (expect.names) {
      for (const n of expect.names)
        if (!calls.some((c) => c.name === n))
          return { pass: false, reason: `missing call to ${n}` };
    }
  }

  const primary = expect.name ? calls.find((c) => c.name === expect.name) : calls[0];
  if (expect.name && !primary)
    return { pass: false, reason: `wrong tool: ${calls.map((c) => c.name).join(",")}` };

  // schema validation against the tool's declared parameters
  const toolDef = testCase.tools.find((t) => t.function.name === primary.name);
  if (toolDef) {
    const validate = ajv.compile(toolDef.function.parameters);
    if (!validate(primary.args))
      return { pass: false, reason: `schema: ${ajv.errorsText(validate.errors)}` };
  }

  if (expect.check && !expect.check(primary.args))
    return { pass: false, reason: `content check failed: ${JSON.stringify(primary.args).slice(0, 120)}` };

  return { pass: true };
}

// ── condition 1: native tools (status quo) ────────────────
async function runNative(testCase) {
  const msg = await chat([{ role: "user", content: testCase.user }], testCase.tools);
  const calls = (msg.tool_calls ?? []).map((tc) => {
    let args = {};
    try {
      args = typeof tc.function.arguments === "string"
        ? JSON.parse(tc.function.arguments)
        : tc.function.arguments ?? {};
    } catch { /* malformed arguments JSON — counts as schema failure downstream */ }
    return { name: tc.function.name, args };
  });
  return scoreCalls(calls, testCase);
}

// ── condition 2: shim (prompt strategy + repair + retry) ──
function shimSystemPrompt(tools) {
  const specs = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
  return [
    "You can use tools. Decide whether the user's request needs a tool.",
    "Respond with ONLY a JSON object, no prose, no markdown fences:",
    '- To call tools: {"tool_calls":[{"name":"<tool>","arguments":{...}}]} (multiple entries allowed)',
    '- To answer directly without a tool: {"text":"<your answer>"}',
    "Available tools:",
    JSON.stringify(specs, null, 1),
  ].join("\n");
}

function extractJson(text) {
  // strip <think> blocks (qwen3 style), fences, then find first balanced object
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = t.indexOf("{");
  if (start === -1) throw new Error("no JSON object found");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const ch = t[i];
    if (esc) { esc = false; continue; }
    if (ch === "\\") { esc = true; continue; }
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === "{") depth++;
    if (ch === "}") { depth--; if (depth === 0) return t.slice(start, i + 1); }
  }
  return t.slice(start); // unbalanced — let jsonrepair try
}

function parseShimOutput(text) {
  const raw = extractJson(text);
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch {
    obj = JSON.parse(jsonrepair(raw)); // the repair step
  }
  if (obj.tool_calls) {
    return obj.tool_calls.map((c) => ({ name: c.name, args: c.arguments ?? c.args ?? {} }));
  }
  return [];
}

async function runShim(testCase, allowRetry = true) {
  const messages = [
    { role: "system", content: shimSystemPrompt(testCase.tools) },
    { role: "user", content: testCase.user },
  ];
  const msg = await chat(messages, undefined);
  let calls;
  try {
    calls = parseShimOutput(msg.content ?? "");
  } catch (e) {
    if (!allowRetry) return { pass: false, reason: `unparseable: ${e.message}` };
    // retry once with error feedback — what the product's validate+retry loop does
    messages.push({ role: "assistant", content: msg.content ?? "" });
    messages.push({ role: "user", content: `Your output was not valid JSON (${e.message}). Respond again with ONLY the JSON object.` });
    const retry = await chat(messages, undefined);
    try {
      calls = parseShimOutput(retry.content ?? "");
    } catch (e2) {
      return { pass: false, reason: `unparseable after retry: ${e2.message}` };
    }
  }

  // schema-validate; on failure retry once with the validation error
  let result = scoreCalls(calls, testCase);
  if (!result.pass && allowRetry && /schema:/.test(result.reason ?? "")) {
    messages.push({ role: "assistant", content: msg.content ?? "" });
    messages.push({ role: "user", content: `Your tool arguments failed validation: ${result.reason}. Respond again with ONLY corrected JSON.` });
    const retry = await chat(messages, undefined);
    try {
      calls = parseShimOutput(retry.content ?? "");
      result = scoreCalls(calls, testCase);
      if (result.pass) result.viaRetry = true;
    } catch { /* keep original failure */ }
  }
  return result;
}

// ── main ──────────────────────────────────────────────────
const results = { model, native: {}, shim: {} };
for (const testCase of CASES) {
  if (mode !== "shim") {
    try {
      results.native[testCase.id] = await runNative(testCase);
    } catch (e) {
      results.native[testCase.id] = { pass: false, reason: `error: ${e.message.slice(0, 80)}` };
    }
    process.stderr.write(`native ${testCase.id}: ${results.native[testCase.id].pass ? "✓" : "✗"}\n`);
  }
  if (mode !== "native") {
    try {
      results.shim[testCase.id] = await runShim(testCase);
    } catch (e) {
      results.shim[testCase.id] = { pass: false, reason: `error: ${e.message.slice(0, 80)}` };
    }
    process.stderr.write(`shim   ${testCase.id}: ${results.shim[testCase.id].pass ? "✓" : "✗"}\n`);
  }
}

const summarize = (r) => {
  const byCat = {};
  let pass = 0;
  for (const c of CASES) {
    const res = r[c.id];
    if (!res) continue;
    byCat[c.category] ??= { pass: 0, total: 0 };
    byCat[c.category].total++;
    if (res.pass) { byCat[c.category].pass++; pass++; }
  }
  return { total: `${pass}/${CASES.length}`, byCat };
};

const summary = {
  model,
  native: mode !== "shim" ? summarize(results.native) : null,
  shim: mode !== "native" ? summarize(results.shim) : null,
};
console.log(JSON.stringify(summary, null, 2));
writeFileSync(`results-${model.replace(/[:\/]/g, "_")}.json`, JSON.stringify(results, null, 2));
