/**
 * Tool-calling benchmark cases — six categories that mirror real-world
 * failure modes (including the xl-ai HTML-in-JSON case from the blog war).
 *
 * Each case: { id, category, tools, user, expect }
 * expect: { call: false } | { call: true, name, args?: validator-checked, parallel?: n }
 */

const weather = {
  type: "function",
  function: {
    name: "get_weather",
    description: "Get the current weather for a city",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string", description: "City name" },
        unit: { type: "string", enum: ["celsius", "fahrenheit"] },
      },
      required: ["city"],
    },
  },
};

const search = {
  type: "function",
  function: {
    name: "search_web",
    description: "Search the web for information",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
};

const createEvent = {
  type: "function",
  function: {
    name: "create_event",
    description: "Create a calendar event",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601 datetime" },
        durationMinutes: { type: "integer", minimum: 1 },
        attendees: {
          type: "array",
          items: {
            type: "object",
            properties: {
              email: { type: "string" },
              required: { type: "boolean" },
            },
            required: ["email"],
          },
        },
      },
      required: ["title", "start", "attendees"],
    },
  },
};

const sendEmail = {
  type: "function",
  function: {
    name: "send_email",
    description: "Send an email",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
};

// the xl-ai killer: operations array with HTML payloads
const applyDocumentOperations = {
  type: "function",
  function: {
    name: "applyDocumentOperations",
    description:
      "Apply edit operations to the document. Each operation updates, adds, or deletes a block. The block field contains the new HTML content.",
    parameters: {
      type: "object",
      properties: {
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { type: "string", enum: ["update", "add", "delete"] },
              id: { type: "string" },
              block: { type: "string", description: "HTML content of the block" },
            },
            required: ["type", "id"],
          },
          minItems: 1,
        },
      },
      required: ["operations"],
    },
  },
};

const sqlQuery = {
  type: "function",
  function: {
    name: "run_sql",
    description: "Run a read-only SQL query against the analytics database",
    parameters: {
      type: "object",
      properties: { sql: { type: "string" } },
      required: ["sql"],
    },
  },
};

export const CASES = [
  // ── simple ──────────────────────────────────────────────
  { id: "simple-1", category: "simple", tools: [weather], user: "What's the weather in Tokyo right now?", expect: { call: true, name: "get_weather", check: (a) => /tokyo/i.test(a.city) } },
  { id: "simple-2", category: "simple", tools: [weather], user: "台北今天氣溫如何？用攝氏。", expect: { call: true, name: "get_weather", check: (a) => /taipei|台北/i.test(a.city) } },
  { id: "simple-3", category: "simple", tools: [search], user: "Find the latest news about the Rust 2026 edition.", expect: { call: true, name: "search_web", check: (a) => /rust/i.test(a.query) } },
  { id: "simple-4", category: "simple", tools: [sendEmail], user: "Email bob@example.com with subject 'Standup moved' and tell him standup is now at 10am.", expect: { call: true, name: "send_email", check: (a) => a.to === "bob@example.com" && /standup/i.test(a.subject) } },
  { id: "simple-5", category: "simple", tools: [sqlQuery], user: "How many users signed up last week? The signups table is `signups(id, created_at)`.", expect: { call: true, name: "run_sql", check: (a) => /select/i.test(a.sql) } },

  // ── complex schema ──────────────────────────────────────
  { id: "complex-1", category: "complex", tools: [createEvent], user: "Schedule a 'Q3 planning' meeting tomorrow 2026-06-13 at 14:00 for 90 minutes with alice@corp.com (required) and bob@corp.com (optional).", expect: { call: true, name: "create_event", check: (a) => /q3/i.test(a.title) && Array.isArray(a.attendees) && a.attendees.length === 2 } },
  { id: "complex-2", category: "complex", tools: [createEvent], user: "建立一個會議：標題「產品評審」，2026-06-20 上午十點開始，60 分鐘，參加者 pm@corp.com 和 dev@corp.com，兩位都必須出席。", expect: { call: true, name: "create_event", check: (a) => Array.isArray(a.attendees) && a.attendees.length === 2 } },
  { id: "complex-3", category: "complex", tools: [createEvent, sendEmail, weather], user: "Set up a 30 minute 1:1 with carol@corp.com titled 'Career chat' on 2026-06-16 09:00.", expect: { call: true, name: "create_event", check: (a) => Array.isArray(a.attendees) && a.attendees.some((x) => /carol/.test(x.email)) } },
  { id: "complex-4", category: "complex", tools: [applyDocumentOperations], user: 'Update block "blk-1$" to say: The launch is scheduled for Friday.', expect: { call: true, name: "applyDocumentOperations", check: (a) => a.operations?.[0]?.type === "update" && /friday/i.test(a.operations[0].block ?? "") } },
  { id: "complex-5", category: "complex", tools: [sqlQuery, search], user: "Query the orders table `orders(id, total, created_at)` for the average order total in May 2026.", expect: { call: true, name: "run_sql", check: (a) => /avg/i.test(a.sql) } },

  // ── HTML-in-JSON (the xl-ai war) ────────────────────────
  { id: "html-1", category: "html", tools: [applyDocumentOperations], user: 'Rewrite block "blk-7$" as an HTML paragraph that says: He said "ship it" and we did.', expect: { call: true, name: "applyDocumentOperations", check: (a) => /ship it/.test(a.operations?.[0]?.block ?? "") } },
  { id: "html-2", category: "html", tools: [applyDocumentOperations], user: 'Replace block "blk-2$" with a paragraph containing a bold word: The deadline is <b>final</b>. Keep the <b> tag.', expect: { call: true, name: "applyDocumentOperations", check: (a) => /<b>\s*final\s*<\/b>/i.test(a.operations?.[0]?.block ?? "") } },
  { id: "html-3", category: "html", tools: [applyDocumentOperations], user: 'Add a new block after "blk-3$" with a link to https://example.com?a=1&b=2 labeled "docs".', expect: { call: true, name: "applyDocumentOperations", check: (a) => a.operations?.some((o) => /href=/.test(o.block ?? "")) } },
  { id: "html-4", category: "html", tools: [applyDocumentOperations], user: 'Update blocks "blk-1$" and "blk-2$": first becomes "Step 1: install", second becomes "Step 2: run". Two operations in one call.', expect: { call: true, name: "applyDocumentOperations", check: (a) => (a.operations?.length ?? 0) >= 2 } },

  // ── parallel calls ──────────────────────────────────────
  { id: "parallel-1", category: "parallel", tools: [weather], user: "Compare the weather in Tokyo and London for me.", expect: { call: true, name: "get_weather", parallel: 2 } },
  { id: "parallel-2", category: "parallel", tools: [weather, search], user: "What's the weather in Paris, and also search for the best croissant bakery there.", expect: { call: true, parallel: 2, names: ["get_weather", "search_web"] } },
  { id: "parallel-3", category: "parallel", tools: [sendEmail], user: "Send 'Meeting at 3pm' (subject: Reminder) to both alice@x.com and bob@x.com as separate emails.", expect: { call: true, name: "send_email", parallel: 2 } },

  // ── should NOT call ─────────────────────────────────────
  { id: "nocall-1", category: "nocall", tools: [weather], user: "What's the difference between weather and climate?", expect: { call: false } },
  { id: "nocall-2", category: "nocall", tools: [sendEmail], user: "What makes a good email subject line? Give me three tips.", expect: { call: false } },
  { id: "nocall-3", category: "nocall", tools: [sqlQuery], user: "Explain the difference between INNER JOIN and LEFT JOIN.", expect: { call: false } },
  { id: "nocall-4", category: "nocall", tools: [createEvent, weather, search], user: "謝謝你昨天的幫忙！", expect: { call: false } },

  // ── tool selection ──────────────────────────────────────
  { id: "select-1", category: "select", tools: [weather, search, sendEmail, sqlQuery], user: "Look up who won the 2026 World Cup.", expect: { call: true, name: "search_web" } },
  { id: "select-2", category: "select", tools: [weather, search, sendEmail, sqlQuery], user: "Will it rain in Kaohsiung tomorrow?", expect: { call: true, name: "get_weather" } },
  { id: "select-3", category: "select", tools: [weather, search, sendEmail, createEvent], user: "Book 'Dentist' in my calendar for 2026-06-18 16:00, just me.", expect: { call: true, name: "create_event" } },
  { id: "select-4", category: "select", tools: [weather, search, sendEmail, sqlQuery], user: "Tell dave@x.com via email (subject: Logs) that the staging logs are clean.", expect: { call: true, name: "send_email" } },
];
