// Regression tests for the classic (fallback) pipeline's live-info routing.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const mongoose = require("mongoose");
mongoose.set("bufferCommands", false);
const { __test } = require("../controllers/chatController.js");
test.after(() => setTimeout(() => process.exit(0), 50).unref());

test("conceptual questions are not treated as live-info searches", () => {
	for (const q of ["what is Newton's third law", "explain version control", "what is a pure function", "define the law of supply and demand"]) {
		assert.strictEqual(__test.isLiveInfoQuestion(q), false, q);
	}
});

test("genuinely time-sensitive questions still are", () => {
	for (const q of ["latest iphone price", "who won the match yesterday", "current bitcoin price", "news today"]) {
		assert.strictEqual(__test.isLiveInfoQuestion(q), true, q);
	}
});
