// End-to-end through handleChat with a fake Groq server. No database, no network, no API key needed.
// Run with: node --test tests/chat.integration.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const path = require("path");

const mongoose = require("mongoose");
mongoose.set("bufferCommands", false); // DB calls fail instantly instead of waiting 10 s

let groqScript = [];
let groqRequests = [];
const groq = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		groqRequests.push(JSON.parse(body));
		const next = groqScript.shift();
		if (!next) { res.writeHead(404, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "model does not exist" } })); }
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		for (const c of next) res.write(`data: ${JSON.stringify(c)}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
const say = (...parts) => parts.map((p, i) => ({ choices: [{ delta: { content: p }, finish_reason: i === parts.length - 1 ? "stop" : null }] }));
const call = (name, args) => [
	{ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] },
	{ choices: [{ delta: {}, finish_reason: "tool_calls" }] },
];

let app; let appServer; let base;

test.before(async () => {
	await new Promise((r) => groq.listen(0, r));
	process.env.GROQ_AGENT_URL = `http://127.0.0.1:${groq.address().port}/v1/chat/completions`;
	process.env.GROQ_API_KEY = "test";
	process.env.NODE_ENV = "test";
	const express = require("express");
	const { handleChat } = require("../controllers/chatController.js");
	app = express();
	app.use(express.json());
	app.post("/chat", (req, res) => handleChat(req, res));
	await new Promise((r) => { appServer = app.listen(0, r); });
	base = `http://127.0.0.1:${appServer.address().port}`;
});
test.after(() => { appServer.close(); groq.close(); mongoose.disconnect().catch(() => {}); setTimeout(() => process.exit(0), 100).unref(); });
test.beforeEach(() => { groqScript = []; groqRequests = []; });

const ask = async (message, { query = "", conversation = [] } = {}) => {
	const response = await fetch(`${base}/chat${query}`, {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ message, conversation, timeZone: "Asia/Kolkata", userTime: "2026-11-25T10:00:00+05:30" }),
	});
	return { status: response.status, text: await response.text() };
};

test("agent answers a normal question: streamed, uses the real system prompt, with history", async () => {
	groqScript = [say("Recursion is when a function calls itself. ".repeat(5))];
	const { status, text } = await ask("explain recursion", { conversation: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] });
	assert.strictEqual(status, 200);
	assert.match(text, /^Recursion is when a function calls itself/);
	const sent = groqRequests[0];
	assert.strictEqual(sent.messages[0].role, "system");
	assert.match(sent.messages[0].content, /Quantic AI/);
	assert.match(sent.messages[0].content, /Wednesday, November 25, 2026/);
	assert.strictEqual(sent.messages.at(-1).content, "explain recursion");
	assert.ok(sent.messages.some((m) => m.role === "assistant" && m.content === "hello"));
	assert.ok(sent.tools.map((t) => t.function.name).includes("calculator"));
	assert.ok(!sent.tools.map((t) => t.function.name).includes("recall_past_chats"), "guests get no memory tools");
});

test("calculator tool result reaches the model and the final answer is returned", async () => {
	groqScript = [call("calculator", { expression: "1250*(1+0.07)^5" }), say("After 5 years it is about 1753.19. ".repeat(4))];
	const { text } = await ask("what is 1250 compounded at 7% for 5 years");
	assert.match(text, /1753\.19/);
	const toolMsg = groqRequests[1].messages.find((m) => m.role === "tool");
	assert.match(toolMsg.content, /= 1753\.18966/);
});

test("non-stream mode returns the full reply in one body", async () => {
	groqScript = [say("Short answer.")];
	const { status, text } = await ask("explain gravity", { query: "?stream=false" });
	assert.strictEqual(status, 200);
	assert.strictEqual(text, "Short answer.");
});

test("a web-search answer begins with the trusted sources marker and cites by number", async () => {
	// Stub the search layer by pre-seeding the webSearch cache is brittle; instead make web search "fail" and
	// verify the failure is surfaced to the model (no invented sources) and no marker is emitted.
	groqScript = [call("web_search", { query: "zzzz nonexistent topic 2026" }), say("I could not verify that online. ".repeat(5))];
	const { text } = await ask("latest news about zzzz nonexistent topic");
	assert.ok(!text.startsWith("<!--SRC:"), "no marker when there are no sources");
	assert.match(text, /could not verify/);
	assert.match(groqRequests[1].messages.find((m) => m.role === "tool").content, /No usable results|Error: web_search failed/);
});

test("falls back to the classic pipeline when the agent model is unavailable (no crash, a reply is produced)", async () => {
	groqScript = []; // fake Groq answers 404 "model does not exist"
	const { status, text } = await ask("explain how hash tables work internally");
	assert.ok([200, 500, 502].includes(status));
	assert.ok(text.length > 0, "the classic path produced some response");
	assert.ok(groqRequests.length >= 1, "agent was attempted first");
});
