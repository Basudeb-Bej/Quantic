// back-end/services/usageLimiter.js
// Small in-memory daily quota counter (per server instance; resets on restart).
// Use a shared store such as Redis if you run several instances and need exact limits.
"use strict";

const buckets = new Map();
const today = () => new Date().toISOString().slice(0, 10);

const consumeDaily = (scope, key, limit) => {
	const id = `${scope}:${key}`;
	const day = today();
	const entry = buckets.get(id);
	const current = entry && entry.day === day ? entry.count : 0;

	if (current >= limit) {
		return { allowed: false, remaining: 0, limit };
	}

	buckets.set(id, { day, count: current + 1 });
	return { allowed: true, remaining: limit - current - 1, limit };
};

const cleanup = setInterval(() => {
	const day = today();
	for (const [id, entry] of buckets) if (entry.day !== day) buckets.delete(id);
}, 60 * 60 * 1000);
cleanup.unref?.();

module.exports = { consumeDaily };
