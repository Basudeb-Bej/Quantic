// back-end/utils/announcements.js
const MAX_TEXT = 300;
const MAX_URL = 500;
const MAX_ITEMS = 100;

const SLASH_CODE = 47; // "/"
const BACKSLASH_CODE = 92; // written as a char code so no escape survives a copy/paste

// Returns "" when there is no link, a safe URL/in-app path, or null when unusable.
function sanitizeAnnouncementUrl(raw) {
	const value = String(raw ?? "").trim();
	if (!value) return "";
	if (value.length > MAX_URL) return null;

	// "//evil.com" — and the backslash variant browsers normalize the same way —
	// looks like an in-app path but navigates off-site.
	if (value.startsWith("//")) return null;
	if (value.charCodeAt(0) === SLASH_CODE && value.charCodeAt(1) === BACKSLASH_CODE) return null;

	// In-app route.
	if (value.startsWith("/")) return value;

	const candidate = value.includes("://") ? value : `https://${value}`;

	let parsed;
	try {
		parsed = new URL(candidate);
	} catch (parseError) {
		return null;
	}

	// Blocks javascript:, data:, ftp:, etc.
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

	// "https://accounts.example.com@evil.com/" — everything before the @ is only
	// a username, so the real host is the part nobody reads.
	if (parsed.username || parsed.password) return null;

	const normalized = parsed.toString();
	return normalized.length > MAX_URL ? null : normalized;
}

// Strict — use on writes. Returns { messages, invalid }; a non-empty `invalid`
// means the caller should reject the request rather than silently drop a link.
function sanitizeAnnouncementMessages(list) {
	const messages = [];
	const invalid = [];
	if (!Array.isArray(list)) return { messages, invalid };

	for (const entry of list) {
		let raw;
		if (typeof entry === "string") raw = { text: entry, url: "" };
		else if (entry && typeof entry === "object") raw = entry;
		else continue;

		const text = String(raw.text ?? "")
			.trim()
			.slice(0, MAX_TEXT);
		if (!text) continue;

		const url = sanitizeAnnouncementUrl(raw.url);
		if (url === null) {
			invalid.push(
				String(raw.url ?? "")
					.trim()
					.slice(0, 120)
			);
			continue;
		}

		messages.push({ text, url });
		if (messages.length >= MAX_ITEMS) break;
	}

	return { messages, invalid };
}

// Lenient — use on reads. Upgrades legacy plain-string announcements so the
// client always receives { text, url }.
function normalizeAnnouncementMessages(list) {
	if (!Array.isArray(list)) return [];
	return list
		.map((entry) => {
			if (typeof entry === "string") return { text: entry.trim(), url: "" };
			if (entry && typeof entry === "object") {
				return {
					text: String(entry.text ?? "").trim(),
					url: String(entry.url ?? "").trim(),
				};
			}
			return { text: "", url: "" };
		})
		.filter((entry) => entry.text);
}

module.exports = {
	sanitizeAnnouncementUrl,
	sanitizeAnnouncementMessages,
	normalizeAnnouncementMessages,
};