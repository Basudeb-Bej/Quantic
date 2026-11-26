// back-end/services/urlSafety.js
// SSRF guard for tools that fetch model-chosen URLs.
"use strict";
const dns = require("dns").promises;
const net = require("net");

const isPrivateIPv4 = (ip) => {
	const [a, b] = ip.split(".").map(Number);
	return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
		|| (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
};

const isPrivateAddress = (address) => {
	if (net.isIPv4(address)) return isPrivateIPv4(address);
	if (net.isIPv6(address)) {
		const lower = address.toLowerCase();
		if (lower === "::1" || lower === "::" || lower.startsWith("fe80") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
		const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
		return mapped ? isPrivateIPv4(mapped[1]) : false;
	}
	return true;
};

// Returns the normalised URL string when it is a public http(s) address, otherwise throws.
const assertPublicUrl = async (value) => {
	let url;
	try { url = new URL(String(value ?? "").trim()); } catch { throw new Error("Invalid URL"); }

	if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only http(s) URLs are allowed");
	if (url.username || url.password) throw new Error("URLs with credentials are not allowed");

	const host = url.hostname.replace(/^\[|\]$/g, "");
	if (!host || host === "localhost" || host.endsWith(".local") || host.endsWith(".internal")) throw new Error("Private addresses are not allowed");

	if (net.isIP(host)) {
		if (isPrivateAddress(host)) throw new Error("Private addresses are not allowed");
		return url.toString();
	}

	const records = await dns.lookup(host, { all: true });
	if (!records.length || records.some((record) => isPrivateAddress(record.address))) throw new Error("Private addresses are not allowed");
	return url.toString();
};

module.exports = { assertPublicUrl, isPrivateAddress };
