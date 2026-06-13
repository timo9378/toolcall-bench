# toolcall-bench

A 25-case smoke test of **tool calling on local LLMs** (Ollama), comparing two
conditions per model:

- **native** — the standard OpenAI-compatible `tools` parameter, i.e. what
  Vercel AI SDK / LangChain actually send today.
- **shim** — a simulated "repair proxy": no `tools` param; a system prompt asks
  for JSON-only output, then the response goes through fence stripping,
  `<think>`-block removal, balanced-brace extraction,
  [jsonrepair](https://github.com/josdejong/jsonrepair), ajv schema validation,
  and one retry with error feedback.

Built to validate a "tool-call repair proxy" product idea. The data killed the
idea — the 2026 model generation handles native tool calling fine, and the shim
actively *hurts* models that were trained for the native format. Full
write-up (zh-TW): link TBD.

## Cases

| Category | n | What it probes |
|---|---|---|
| simple | 5 | single-tool direct calls (incl. non-English prompts) |
| complex | 5 | nested schemas: object arrays, required fields, ISO datetimes |
| html | 4 | **HTML payloads inside JSON strings** (the BlockNote `applyDocumentOperations` shape) |
| parallel | 3 | one request that needs ≥2 calls |
| nocall | 4 | questions that must NOT trigger a call despite an available tool |
| select | 4 | picking the right tool out of four |

Scoring is strict: right tool name, arguments pass ajv validation against the
declared parameter schema, content checks (the email really went to
`bob@example.com`), parallel cases need the full set of calls, and any call at
all fails a `nocall` case.

## Results

`temperature: 0`, default Q4 quants, one pass, RTX 5060 Ti 16 GB, Ollama.
Sorted by native score:

| Model | native | shim |
|---|---|---|
| qwen3.5:4b | **25/25** | 22/25 |
| qwen3.5:9b | **25/25** | 25/25 |
| granite4.1:8b | 24/25 | 24/25 |
| ministral-3:8b | 24/25 | 24/25 |
| granite4:tiny-h | 22/25 | 12/25 |
| lfm2.5:8b | 22/25 | 5/25 |
| mistral-nemo | 22/25 | 25/25 |
| nemotron-3-nano:4b | 21/25 | 23/25 |
| qwen3.6:27b | 21/25 | 23/25 |
| gemma4:e4b | 20/25 | 24/25 |
| gemma4:e2b | 19/25 | 18/25 |
| gemma4:12b | 18/25 | 20/25 |
| hermes3:8b | 18/25 | 23/25 |
| qwen3:4b | 16/25 | 17/25 |
| phi4-mini | 12/25 | 22/25 |
| llama3.2:3b | 9/25 | 16/25 |
| functiongemma:270m | 7/25 | 0/25 |
| command-r7b | 4/25 | 11/25 |
| deepseek-r1:8b | 4/25 | 23/25 |
| glm4:9b | 4/25 | 13/25 |
| gemma3:12b | 0/25 | 23/25 |
| gemma3:4b | 0/25 | 19/25 |

Things the table shows at a glance:

- **The generation gap**: gemma3 → gemma4 goes 0→18 (gemma3's API rejects
  `tools` outright); qwen3 → qwen3.5 goes 16→25 at the same 4B size.
- **The shim helps old models and hurts new ones**: it lifts gemma3:12b from
  0 to 23, and drops qwen3.5:4b from 25 to 22, granite4:tiny-h from 22 to 12,
  lfm2.5 from 22 to 5 — models trained on a native format degrade when forced
  through a freeform-JSON dialect.
- **Thinking-model split**: deepseek-r1:8b emits almost no native tool calls
  (4/25) but speaks clean JSON when asked (23/25).
- **HTML-in-JSON is a real discriminator**: the whole gemma family scores 0/4
  on it, qwen3.5 scores 4/4.
- **Newer-but-bigger loses to smaller-but-newer on consumer hardware**:
  qwen3.6:27b (17 GB, partially CPU-offloaded on a 16 GB card, ~10× slower)
  scores 21/25 — below qwen3.5:4b's 25/25 at 3.4 GB fully in VRAM.

Caveats: 25 cases, single run, default quants — this is a smoke test for
product decisions, not a paper. The interesting signals (0/25 vs 25/25) are far
outside what noise explains.

## Run it

```sh
pnpm install
OLLAMA_URL=http://127.0.0.1:11434 node bench.mjs <model> [native|shim|both]
```

Writes `results-<model>.json` with per-case pass/fail and failure reasons, and
prints a category summary. Raw results for every model in the table are
committed in this repo.

## License

MIT
