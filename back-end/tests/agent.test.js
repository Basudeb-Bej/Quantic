// Run with: node --test tests/   (uses a fake Groq server; no network or API key needed)
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

let script = [];          // queue of responses the fake Groq will give, one per request
let requests = [];        // bodies received

const sse = (res, chunks) => {
	res.writeHead(200, { "Content-Type": "text/event-stream" });
	for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
	res.write("data: [DONE]\n\n");
	res.end();
};
const text = (parts, finish = "stop") => parts.map((c, i) => ({ choices: [{ delta: { content: c }, finish_reason: i === parts.length - 1 ? finish : null }] }));
const toolCall = (calls, preface = "") => [
	...(preface ? [{ choices: [{ delta: { content: preface } }] }] : []),
	...calls.flatMap((call, index) => {
		const args = JSON.stringify(call.args);
		const mid = Math.floor(args.length / 2);
		return [
			{ choices: [{ delta: { tool_calls: [{ index, id: `call_${index}`, type: "function", function: { name: call.name, arguments: "" } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(0, mid) } }] } }] },
			{ choices: [{ delta: { tool_calls: [{ index, function: { arguments: args.slice(mid) } }] } }] },
		];
	}),
	{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

const server = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		requests.push(JSON.parse(body));
		const next = script.shift();
		if (!next) { res.writeHead(500); return res.end("{}"); }
		if (next.status) { res.writeHead(next.status, { "Content-Type": "application/json" }); return res.end(JSON.stringify(next.body || {})); }
		sse(res, next.chunks);
	});
});

let runAgent; let AgentError; let renumberSources; let executeTool; let _badModels;

test.before(async () => {
	await new Promise((resolve) => server.listen(0, resolve));
	process.env.GROQ_AGENT_URL = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
	process.env.GROQ_API_KEY = "test-key";
	process.env.AGENT_TOTAL_MS = "20000";
	({ runAgent, AgentError, renumberSources, executeTool, _badModels } = require("../services/agentService.js"));
});
test.after(() => server.close());
test.beforeEach(() => { script = []; requests = []; _badModels.clear(); });

const makeDeps = (overrides = {}) => ({
	searchWeb: async (query) => ({ query }),
	formatWebSearchContext: (bundle) => `Web evidence for: "${bundle.query}"\nSource 1 | Title: A about ${bundle.query} | Evidence: x | URL: https://a.example/${encodeURIComponent(bundle.query)}\nSource 2 | Title: Shared | Evidence: y | URL: https://shared.example/page`,
	fetchPage: async () => ({ title: "Page", previewText: "page body text" }),
	getWeather: async (loc) => `Weather in ${loc}: 30C`,
	...overrides,
});
const run = async (deps, extra = {}) => {
	const out = [];
	const result = await runAgent({
		model: "openai/gpt-oss-120b", system: "sys", history: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
		userContent: "question", write: (t) => out.push(t),
		buildSourcesMarker: (s) => (s.length ? `<!--SRC:${JSON.stringify(s)}-->\n` : ""), hasUser: true, ...extra,
	}, deps);
	return { result, out, written: out.join("") };
};

test("plain question streams an answer with no tools and no marker", async () => {
	script = [{ chunks: text(["Paris is the capital of France. ".repeat(6), "It is large."]) }];
	const { result, written } = await run(makeDeps());
	assert.match(written, /^Paris is the capital/);
	assert.strictEqual(result.sources.length, 0);
	assert.strictEqual(requests.length, 1);
	assert.ok(requests[0].tools.some((t) => t.function.name === "web_search"));
	assert.strictEqual(requests[0].reasoning_effort, "medium");
});

test("web search: split tool-call args are assembled, marker comes first, result fed back", async () => {
	script = [
		{ chunks: toolCall([{ name: "web_search", args: { query: "west bengal chief minister 2026" } }], "Let me check.") },
		{ chunks: text(["The answer is X [Source 1]. ", "More detail follows here. ".repeat(8)]) },
	];
	const { result, written } = await run(makeDeps());
	assert.ok(written.startsWith("<!--SRC:"), "marker must be the first thing written");
	assert.ok(!written.includes("Let me check"), "short preface before a tool call is dropped");
	assert.deepStrictEqual(result.toolsUsed, ["web_search"]);
	assert.strictEqual(result.sources.length, 2);
	assert.strictEqual(requests.length, 2);
	const toolMessage = requests[1].messages.find((m) => m.role === "tool");
	assert.match(toolMessage.content, /Source 1 \| Title: A about west bengal chief minister 2026/);
	const assistantCall = requests[1].messages.find((m) => m.tool_calls);
	assert.strictEqual(JSON.parse(assistantCall.tool_calls[0].function.arguments).query, "west bengal chief minister 2026");
});

test("two parallel searches get unique, de-duplicated source numbers", async () => {
	script = [
		{ chunks: toolCall([{ name: "web_search", args: { query: "alpha" } }, { name: "web_search", args: { query: "beta" } }]) },
		{ chunks: text(["Done [Source 1] [Source 3] [Source 2]. ", "x".repeat(130)]) },
	];
	const { result } = await run(makeDeps());
	const urls = result.sources.map((s) => s.url);
	assert.strictEqual(new Set(urls).size, urls.length, "no duplicate URLs");
	assert.deepStrictEqual(result.sources.map((s) => s.n), [1, 2, 3]);
	const tools = requests[1].messages.filter((m) => m.role === "tool");
	assert.match(tools[0].content, /Source 1 \| Title: A about alpha/);
	assert.match(tools[1].content, /Source 3 \| Title: A about beta/);
	assert.match(tools[1].content, /Source 2 \| Title: Shared/, "shared URL reuses its earlier number");
});

test("calculator runs exactly and bad input returns an error string, not a crash", async () => {
	const ctx = { sources: [] };
	assert.strictEqual(await executeTool("calculator", { expression: "1250*(1+0.07)^5" }, ctx, makeDeps()), "1250*(1+0.07)^5 = 1753.18966...".replace("1753.18966...", String(Number((1250 * 1.07 ** 5).toPrecision(12)))));
	assert.match(await executeTool("calculator", { expression: "process.exit(1)" }, ctx, makeDeps()), /^Error: calculator failed/);
	assert.match(await executeTool("calculator", "{not json", ctx, makeDeps()), /not valid JSON/);
	assert.match(await executeTool("nope", {}, ctx, makeDeps()), /unknown tool/);
});

test("fetch_url refuses private addresses (SSRF) and never calls the fetcher", async () => {
	let called = false;
	const deps = makeDeps({ fetchPage: async () => { called = true; return { title: "x", previewText: "secret" }; } });
	for (const url of ["http://127.0.0.1:8000/admin", "http://169.254.169.254/latest/meta-data", "http://localhost/x", "file:///etc/passwd", "http://[::1]/"]) {
		assert.match(await executeTool("fetch_url", { url }, { sources: [] }, deps), /^Error: fetch_url failed/, url);
	}
	assert.strictEqual(called, false);
});

test("a failed search is reported to the model so it can retry or say it could not verify", async () => {
	const out = await executeTool("web_search", { query: "zzz" }, { sources: [] }, makeDeps({ searchWeb: async () => null }));
	assert.match(out, /No usable results/);
});

test("malformed tool call (400 tool_use_failed) is retried and succeeds", async () => {
	script = [
		{ status: 400, body: { error: { code: "tool_use_failed", message: "Failed to call a function" } } },
		{ chunks: text(["Recovered answer. ", "y".repeat(130)]) },
	];
	const { written } = await run(makeDeps());
	assert.match(written, /^Recovered answer/);
	assert.strictEqual(requests.length, 2);
});

test("unsupported model -> AgentError with safeToFallback, nothing written, model remembered as bad", async () => {
	script = [{ status: 404, body: { error: { message: "The model `x` does not exist" } } }];
	const out = [];
	await assert.rejects(
		runAgent({ model: "bad/model", system: "s", userContent: "q", write: (t) => out.push(t) }, makeDeps()),
		(error) => error instanceof AgentError && error.safeToFallback === true
	);
	assert.strictEqual(out.length, 0);
	assert.ok(_badModels.has("bad/model"));
	await assert.rejects(runAgent({ model: "bad/model", system: "s", userContent: "q", write() {} }, makeDeps()), (e) => e.safeToFallback);
	assert.strictEqual(requests.length, 1, "second call is refused without hitting the API");
});

test("answer cut off by the token limit is continued", async () => {
	script = [
		{ chunks: text(["First part of a long answer that was cut ", "off mid ".repeat(20)], "length") },
		{ chunks: text(["and here is the rest."]) },
	];
	const { written } = await run(makeDeps());
	assert.match(written, /and here is the rest\.$/);
	assert.strictEqual(requests.length, 2);
	assert.match(requests[1].messages.at(-1).content, /Continue exactly where you stopped/);
});

test("on the final round tools are withheld so the model must answer", async () => {
	process.env.AGENT_MAX_ROUNDS = "2";
	delete require.cache[require.resolve("../services/agentService.js")];
	const fresh = require("../services/agentService.js");
	script = [
		{ chunks: toolCall([{ name: "calculator", args: { expression: "2+2" } }]) },
		{ chunks: text(["Final: 4. ", "z".repeat(130)]) },
	];
	const out = [];
	await fresh.runAgent({ model: "openai/gpt-oss-120b", system: "s", userContent: "q", write: (t) => out.push(t) }, makeDeps());
	assert.ok(requests[0].tools);
	assert.strictEqual(requests[1].tools, undefined);
	delete process.env.AGENT_MAX_ROUNDS;
});

test("empty model output with nothing emitted is a safe fallback", async () => {
	script = [{ chunks: [{ choices: [{ delta: {}, finish_reason: "stop" }] }] }];
	await assert.rejects(run(makeDeps()), (e) => e instanceof AgentError && e.safeToFallback);
});

test("renumberSources leaves non-source lines alone", () => {
	const sources = [];
	const out = renumberSources("Summary: hi\nSource 4 | Title: T | URL: https://t.example/", sources);
	assert.match(out, /^Summary: hi\nSource 1 \| Title: T/);
	assert.deepStrictEqual(sources, [{ n: 1, url: "https://t.example/", title: "T" }]);
});
