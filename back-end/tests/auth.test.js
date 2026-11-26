// Run with: node --test tests/auth.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const crypto = require("crypto");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "unit-test-secret-0123456789abcdef";
const mongoose = require("mongoose");
mongoose.set("bufferCommands", false);

const { __test } = require("../controllers/login.Controller.js");
const { getJwtSecret } = require("../middleware/auth.js");

test.after(() => setTimeout(() => process.exit(0), 50).unref());

test("hash is async, uses 210k iterations, verifies, and rejects wrong passwords", async () => {
	const hash = await __test.hashPassword("correct horse");
	assert.match(hash, /^pbkdf2\$210000\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
	assert.strictEqual(await __test.verifyPassword("correct horse", hash), true);
	assert.strictEqual(await __test.verifyPassword("wrong", hash), false);
	assert.strictEqual(__test.needsRehash(hash), false);
});

test("old 120k hashes still verify and are flagged for upgrade; garbage never throws", async () => {
	const salt = "ab".repeat(16);
	const key = crypto.pbkdf2Sync("legacy-pass", salt, 120000, 64, "sha512").toString("hex");
	const legacy = `pbkdf2$120000$${salt}$${key}`;
	assert.strictEqual(await __test.verifyPassword("legacy-pass", legacy), true);
	assert.strictEqual(__test.needsRehash(legacy), true);
	for (const bad of ["", null, undefined, "x$y", "bcrypt$1$a$b", "pbkdf2$1$aa$bb", "pbkdf2$210000$aa$zz"]) {
		assert.strictEqual(await __test.verifyPassword("p", bad), false, String(bad));
	}
});

test("hashing does not block the event loop", async () => {
	let ticks = 0;
	const timer = setInterval(() => ticks++, 5);
	await Promise.all([__test.hashPassword("a"), __test.hashPassword("b"), __test.hashPassword("c")]);
	clearInterval(timer);
	assert.ok(ticks >= 5, `event loop kept running (${ticks} ticks)`);
});

test("production refuses a missing/short JWT secret; accepts a real one", () => {
	const original = { ...process.env };
	process.env.NODE_ENV = "production";
	delete process.env.JWT_SECRET;
	assert.throws(() => getJwtSecret(), /JWT_SECRET must be set/);
	process.env.JWT_SECRET = "short";
	assert.throws(() => getJwtSecret(), /JWT_SECRET must be set/);
	process.env.JWT_SECRET = "a-long-enough-production-secret-123";
	assert.strictEqual(getJwtSecret(), "a-long-enough-production-secret-123");
	Object.assign(process.env, original);
});
