// Run with: node --test tests/image.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const axios = require("axios");
const sharp = require("sharp");

process.env.IMAGE_MIN_REQUEST_GAP_MS = "0";
process.env.IMAGE_MAX_CONCURRENT = "2";
process.env.IMAGE_MAX_QUEUE = "1";
process.env.MAX_IMAGE_GEN_ATTEMPTS = "1";

const image = require("../services/imageService.js");

let png;
test.before(async () => {
	png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 10, g: 120, b: 200 } } }).png().toBuffer();
});

const stubAxios = (impl) => { axios.get = impl; };
const ok = (delayMs = 0) => async () => { await new Promise((r) => setTimeout(r, delayMs)); return { data: png, headers: { "content-type": "image/png" } }; };

test("output is recompressed to WebP and is smaller than the provider PNG", async () => {
	stubAxios(ok());
	const result = await image.generateImage("a blue wall", { userKey: "u:1" });
	assert.strictEqual(result.success, true);
	assert.match(result.dataUrl, /^data:image\/webp;base64,/);
	const bytes = Buffer.from(result.dataUrl.split(",")[1], "base64");
	assert.ok(bytes.length < png.length, `${bytes.length} < ${png.length}`);
	assert.strictEqual((await sharp(bytes).metadata()).format, "webp");
});

test("one user cannot have two images in flight; a different user is not blocked", async () => {
	stubAxios(ok(150));
	const first = image.generateImage("a red car", { userKey: "u:A" });
	const second = await image.generateImage("a green car", { userKey: "u:A" });
	assert.strictEqual(second.success, false);
	assert.match(second.error, /already have an image/);
	const other = await image.generateImage("a tree", { userKey: "u:B" });
	assert.strictEqual(other.success, true, "another user is served while A is busy");
	assert.strictEqual((await first).success, true);
});

test("a slow job no longer blocks the whole service, and overload answers 'busy' instead of stacking", async () => {
	stubAxios(ok(300));
	const started = Date.now();
	// 2 run concurrently, 1 waits, the 4th is rejected as busy
	const jobs = ["a", "b", "c", "d"].map((k) => image.generateImage(`draw ${k}`, { userKey: `u:${k}` }));
	const results = await Promise.all(jobs);
	assert.strictEqual(results.filter((r) => r.success).length, 3);
	assert.strictEqual(results.filter((r) => !r.success && /busy/.test(r.error)).length, 1);
	assert.ok(Date.now() - started < 900, "two ran in parallel (a serial queue would take 900ms+)");
});

test("provider failure returns a friendly error object, never throws", async () => {
	stubAxios(async () => { const e = new Error("boom"); e.response = { status: 500 }; throw e; });
	const result = await image.generateImage("a cat", { userKey: "u:Z" });
	assert.strictEqual(result.success, false);
	assert.ok(typeof result.error === "string" && result.error.length > 5);
});

test("slot and user key are released after a failure", async () => {
	stubAxios(async () => { throw new Error("x"); });
	await image.generateImage("a cat", { userKey: "u:R" });
	stubAxios(ok());
	assert.strictEqual((await image.generateImage("a dog", { userKey: "u:R" })).success, true);
});

test("intent: text tasks are not images; image asks are", () => {
	const yes = ["draw a dog", "generate an image of a red car", "show me a picture of a tiger", "design a logo for my cafe"];
	const no = ["make a todo list", "create a study plan", "generate 10 startup names", "make it shorter", "create a login page in react", "write a poem about the sea"];
	yes.forEach((m) => assert.strictEqual(image.isImageGenerationQuery(m), true, m));
	no.forEach((m) => assert.strictEqual(image.isImageGenerationQuery(m), false, m));
});
