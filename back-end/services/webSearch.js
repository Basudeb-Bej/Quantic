//back-end/services/webSearch.js
"use strict";

const logger = console;

const DDG_JSON_ENDPOINT = "https://api.duckduckgo.com/";
const DDG_HTML_ENDPOINT = "https://html.duckduckgo.com/html/";
const DDG_LITE_ENDPOINT = "https://lite.duckduckgo.com/lite/";
const WIKIPEDIA_API_ENDPOINT = "https://en.wikipedia.org/w/api.php";

const SEARCH_TIMEOUT_MS = Number(process.env.WEB_SEARCH_TIMEOUT_MS || 7000);
const FETCH_TIMEOUT_MS = Number(process.env.WEB_FETCH_TIMEOUT_MS || 5000);
const MAX_RESULTS = Number(process.env.WEB_MAX_RESULTS || process.env.WEB_SEARCH_MAX_RESULTS || 30);
const FETCH_RESULT_LIMIT = Number(process.env.WEB_FETCH_RESULT_LIMIT || 6);

// Wall-clock ceilings. Search phase and preview phase are budgeted separately so a
// slow provider can never eat the time reserved for reading the good pages.
const SEARCH_DEADLINE_MS = Number(process.env.WEB_SEARCH_DEADLINE_MS || 12000);
const PREVIEW_DEADLINE_MS = Number(process.env.WEB_PREVIEW_DEADLINE_MS || 7000);

const VARIANT_LIMIT = Number(process.env.WEB_SEARCH_VARIANT_LIMIT || 4);
const SEARCH_CONCURRENCY = Number(process.env.WEB_SEARCH_CONCURRENCY || 6);
const PREVIEW_CONCURRENCY = Number(process.env.WEB_PREVIEW_CONCURRENCY || 4);

// How much of a page we are willing to pull down and keep.
const PREVIEW_MAX_BYTES = Number(process.env.WEB_PREVIEW_MAX_BYTES || 320000);
const PREVIEW_TEXT_CHARS = Number(process.env.WEB_PREVIEW_TEXT_CHARS || 2600);

// What actually reaches the model.
const CONTEXT_SOURCE_LIMIT = Number(process.env.WEB_CONTEXT_SOURCE_LIMIT || 8);
const CONTEXT_CHAR_BUDGET = Number(process.env.WEB_CONTEXT_CHAR_BUDGET || 7000);
const EVIDENCE_CHARS = Number(process.env.WEB_EVIDENCE_CHARS || 340);

// Caching. Repeated or lightly rephrased questions reuse the same HTTP work.
const SEARCH_CACHE_TTL_MS = Number(process.env.WEB_SEARCH_CACHE_TTL_MS || 180000);
const EMPTY_CACHE_TTL_MS = Number(process.env.WEB_SEARCH_EMPTY_CACHE_TTL_MS || 30000);
const PREVIEW_CACHE_TTL_MS = Number(process.env.WEB_PREVIEW_CACHE_TTL_MS || 600000);
const CACHE_MAX_ENTRIES = Number(process.env.WEB_SEARCH_CACHE_ENTRIES || 240);

const SEARCH_DEBUG = String(process.env.WEB_SEARCH_DEBUG ?? "1") !== "0";

// Extra providers. DuckDuckGo scraping alone is fragile from a server (it often answers with a bot-check
// page), and it never returns real news headlines, so these run alongside it.
//   TAVILY_API_KEY  - optional, free 1,000 searches/month at tavily.com. Clean, current, LLM-ready results.
//   Google News RSS - keyless. Real headlines with dates and publishers. WEB_NEWS_RSS=0 turns it off.
//   Bing RSS        - keyless last resort when no other web provider returned anything.
const GOOGLE_NEWS_RSS_ENDPOINT = "https://news.google.com/rss/search";
const BING_RSS_ENDPOINT = "https://www.bing.com/search";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const TAVILY_MAX_RESULTS = Number(process.env.TAVILY_MAX_RESULTS || 8);
const TAVILY_TIMEOUT_MS = Number(process.env.TAVILY_TIMEOUT_MS || 9000);
const NEWS_RSS_ENABLED = String(process.env.WEB_NEWS_RSS ?? "1") !== "0";
const NEWS_RSS_HL = process.env.WEB_NEWS_HL || "en-IN";
const NEWS_RSS_GL = process.env.WEB_NEWS_GL || "IN";
const NEWS_RSS_CEID = process.env.WEB_NEWS_CEID || "IN:en";
const NEWS_RSS_MAX_ITEMS = Number(process.env.WEB_NEWS_MAX_ITEMS || 12);

// Read at call time so a key added to .env after this file loads is still picked up.
const getTavilyKey = () => String(process.env.TAVILY_API_KEY || "").trim();

// Enough breadth to stop early on an easy question.
const EARLY_EXIT_RESULTS = Number(process.env.WEB_SEARCH_EARLY_EXIT_RESULTS || 14);
const EARLY_EXIT_DOMAINS = Number(process.env.WEB_SEARCH_EARLY_EXIT_DOMAINS || 4);

const BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const TRACKING_PARAM_PATTERN = /^(utm_[a-z_]+|gclid|fbclid|msclkid|yclid|igshid|mc_cid|mc_eid|_ga|_gl|ref|ref_src|referrer|source|spm|scmts|cmpid|campaign_id|s_kwcid|vero_id|oly_enc_id|trk|trkid)$/i;

const BOILERPLATE_PATTERN = /(cookie|privacy policy|terms of (use|service)|subscribe|newsletter|sign in|log ?in|create an account|enable javascript|javascript is disabled|all rights reserved|advertisement|follow us on|download the app|share this)/i;

/* ------------------------------------------------------------------------- *
 * Small utilities
 * ------------------------------------------------------------------------- */

const normalizeQuery = (query) => String(query ?? "").trim();

const normalizeText = (value) =>
	String(value ?? "")
		.replace(/<[^>]*>/g, " ")
		.replace(/\s+/g, " ")
		.trim();

const STOPWORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "what", "which", "who", "whom", "whose",
	"was", "were", "are", "is", "been", "being", "has", "have", "had", "will", "would", "should",
	"can", "could", "into", "onto", "about", "there", "their", "them", "then", "than", "your",
	"you", "our", "his", "her", "its", "any", "all", "how", "why", "when", "where", "does", "did",
]);

// Tokens carry a weight: long, rare-looking words matter more than filler.
const weightedQueryTokens = (query) => {
	const seen = new Set();
	const tokens = [];

	for (const raw of String(query ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
		if (raw.length < 3 || seen.has(raw)) {
			continue;
		}

		seen.add(raw);
		const isStop = STOPWORDS.has(raw);
		tokens.push({ token: raw, weight: isStop ? 0.15 : Math.min(1, 0.4 + (raw.length / 14)) });
	}

	return tokens;
};

const normalizeQueryTokens = (query) => weightedQueryTokens(query).map((entry) => entry.token);

const normalizeUrl = (value) => {
	const raw = String(value ?? "").trim();

	try {
		const url = new URL(raw);

		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return "";
		}

		url.hash = "";

		for (const key of [...url.searchParams.keys()]) {
			if (TRACKING_PARAM_PATTERN.test(key)) {
				url.searchParams.delete(key);
			}
		}

		return url.toString();
	} catch {
		return normalizeText(raw);
	}
};

// Dedupe key: host without www, lower-cased path without a trailing slash, sorted
// query string. "site.com/a?b=1&a=2" and "www.site.com/a/?a=2&b=1#top" collapse.
const canonicalUrlKey = (value) => {
	const raw = String(value ?? "").trim();

	try {
		const url = new URL(raw);

		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return "";
		}

		const host = url.hostname.replace(/^www\./i, "").toLowerCase();
		const path = url.pathname.replace(/\/+$/, "").toLowerCase() || "/";
		const params = [...url.searchParams.entries()]
			.filter(([key]) => !TRACKING_PARAM_PATTERN.test(key))
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, val]) => `${key.toLowerCase()}=${val}`)
			.join("&");

		return params ? `${host}${path}?${params}` : `${host}${path}`;
	} catch {
		return "";
	}
};

const getDomain = (url) => {
	try {
		return new URL(String(url ?? "")).hostname.replace(/^www\./i, "").toLowerCase();
	} catch {
		return "";
	}
};

const isOfficialDomain = (domain) => {
	const normalizedDomain = String(domain ?? "").toLowerCase();
	return /(^|\.)gov\b|\.gov\.|\.gov$|(^|\.)edu\b|\.edu\.|\.edu$|(^|\.)nic\.in$|(^|\.)gov\.in$|(^|\.)ac\.in$/.test(normalizedDomain);
};

// Ads, unresolved redirects and DuckDuckGo's own pages are never evidence.
const isJunkResultUrl = (url) => {
	const raw = String(url ?? "");

	if (!raw) {
		return false;
	}

	const lower = raw.toLowerCase();

	if (lower.includes("duckduckgo.com/y.js") || lower.includes("ad_domain=") || lower.includes("ad_provider=")) {
		return true;
	}

	if (/^https?:\/\/(?:[a-z0-9-]+\.)*duckduckgo\.com\//i.test(raw) && !lower.includes("/l/?uddg=")) {
		return true;
	}

	if (lower.includes("/l/?uddg=")) {
		return true;
	}

	return !/^https?:\/\//i.test(raw);
};

const isDuckDuckGoAdResult = (url) => isJunkResultUrl(url);

const decodeHtmlEntities = (value) =>
	String(value ?? "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&#(\d+);/g, (_, code) => {
			const point = Number(code);
			return Number.isFinite(point) && point > 0 && point < 1114111 ? String.fromCodePoint(point) : " ";
		})
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => {
			const point = Number.parseInt(code, 16);
			return Number.isFinite(point) && point > 0 && point < 1114111 ? String.fromCodePoint(point) : " ";
		})
		.replace(/&quot;/gi, '"')
		.replace(/&apos;/gi, "'")
		.replace(/&#39;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&");

const cleanHtml = (html) => decodeHtmlEntities(
	String(html ?? "")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
		.replace(/<svg[\s\S]*?<\/svg>/gi, " ")
		.replace(/<template[\s\S]*?<\/template>/gi, " ")
		.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ")
		.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, ". ")
		.replace(/<[^>]+>/g, " ")
).replace(/\s+/g, " ").replace(/(?:\.\s){2,}/g, ". ").trim();

const extractEntities = (text) => {
	const matches = String(text ?? "").match(/\b[A-Z][a-zA-Z0-9-]{2,}(?:\s+[A-Z][a-zA-Z0-9-]{2,}){0,2}\b/g) || [];
	return [...new Set(matches)].slice(0, 8);
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One clear warning per minute per cause, instead of a wall of identical log lines.
const warnedAt = new Map();
const warnThrottled = (key, message, details = {}, everyMs = 60000) => {
	const last = warnedAt.get(key) || 0;

	if (Date.now() - last < everyMs) {
		return;
	}

	warnedAt.set(key, Date.now());
	logger.warn(message, details);
};

/* ------------------------------------------------------------------------- *
 * Deadlines, cancellation and bounded concurrency
 * ------------------------------------------------------------------------- */

const createDeadline = (budgetMs) => {
	const controller = new AbortController();
	return { at: Date.now() + Math.max(0, Number(budgetMs) || 0), controller };
};

const remainingMs = (deadline) => {
	if (!deadline || !Number.isFinite(deadline.at)) {
		return Number.POSITIVE_INFINITY;
	}

	return Math.max(0, deadline.at - Date.now());
};

const isDeadlineExpired = (deadline) => remainingMs(deadline) <= 250;

// Mirror an external abort onto a local controller. Returns an unsubscribe function.
const linkAbortSignal = (localController, externalSignal) => {
	if (!externalSignal) {
		return () => {};
	}

	if (externalSignal.aborted) {
		localController.abort();
		return () => {};
	}

	const onAbort = () => {
		try {
			localController.abort();
		} catch {
			/* already aborted */
		}
	};

	externalSignal.addEventListener("abort", onAbort, { once: true });
	return () => externalSignal.removeEventListener("abort", onAbort);
};

const mapWithConcurrency = async (items, limit, worker) => {
	const list = Array.isArray(items) ? items : [];
	const results = new Array(list.length);
	const size = Math.max(1, Math.min(Number(limit) || 1, list.length || 1));
	let cursor = 0;

	const runners = new Array(size).fill(null).map(async () => {
		for (;;) {
			const index = cursor;
			cursor += 1;

			if (index >= list.length) {
				return;
			}

			try {
				results[index] = await worker(list[index], index);
			} catch {
				results[index] = undefined;
			}
		}
	});

	await Promise.all(runners);
	return results;
};

// Signature kept compatible with the old three-argument version; `deadline` is new.
const fetchWithTimeout = async (url, options = {}, timeoutMs = SEARCH_TIMEOUT_MS, deadline = null) => {
	const budget = Math.min(Number(timeoutMs) || SEARCH_TIMEOUT_MS, remainingMs(deadline));

	if (budget <= 250) {
		const error = new Error("deadline_exceeded");
		error.code = "DEADLINE";
		throw error;
	}

	const controller = new AbortController();
	const unlink = linkAbortSignal(controller, deadline?.controller?.signal || options?.signal || null);
	const timeoutId = setTimeout(() => controller.abort(), budget);

	try {
		const { signal: _ignoredSignal, ...rest } = options || {};
		return await fetch(url, { ...rest, signal: controller.signal });
	} finally {
		clearTimeout(timeoutId);
		unlink();
	}
};

// Read at most maxBytes so a 40 MB page cannot park itself in memory.
const readBodyCapped = async (response, maxBytes) => {
	const cap = Math.max(4096, Number(maxBytes) || PREVIEW_MAX_BYTES);

	if (!response?.body || typeof response.body.getReader !== "function") {
		const text = await response.text();
		return String(text ?? "").slice(0, cap);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder("utf-8");
	let output = "";
	let total = 0;

	for (;;) {
		const { done, value } = await reader.read();

		if (done) {
			break;
		}

		total += value?.byteLength || 0;
		output += decoder.decode(value, { stream: true });

		if (total >= cap) {
			try {
				await reader.cancel();
			} catch {
				/* stream already closed */
			}
			break;
		}
	}

	try {
		output += decoder.decode();
	} catch {
		/* nothing buffered */
	}

	return output;
};

/* ------------------------------------------------------------------------- *
 * TTL cache with in-flight coalescing
 * ------------------------------------------------------------------------- */

const createTtlCache = (maxEntries) => {
	const store = new Map();
	const pending = new Map();

	const get = (key) => {
		const entry = store.get(key);

		if (!entry) {
			return undefined;
		}

		if (entry.expiresAt <= Date.now()) {
			store.delete(key);
			return undefined;
		}

		// Touch for LRU ordering.
		store.delete(key);
		store.set(key, entry);
		return entry.value;
	};

	const set = (key, value, ttlMs) => {
		const ttl = Number(ttlMs);

		if (!key || !Number.isFinite(ttl) || ttl <= 0) {
			return value;
		}

		store.delete(key);
		store.set(key, { value, expiresAt: Date.now() + ttl });

		while (store.size > Math.max(8, Number(maxEntries) || CACHE_MAX_ENTRIES)) {
			const oldest = store.keys().next();

			if (oldest.done) {
				break;
			}

			store.delete(oldest.value);
		}

		return value;
	};

	// Two identical lookups launched in the same tick share one HTTP round trip.
	const resolve = async (key, ttlFor, producer) => {
		if (!key) {
			return producer();
		}

		const cached = get(key);

		if (cached !== undefined) {
			return cached;
		}

		if (pending.has(key)) {
			return pending.get(key);
		}

		const promise = (async () => {
			try {
				const value = await producer();
				set(key, value, ttlFor(value));
				return value;
			} finally {
				pending.delete(key);
			}
		})();

		pending.set(key, promise);
		return promise;
	};

	return {
		get,
		set,
		resolve,
		clear: () => {
			store.clear();
			pending.clear();
		},
		stats: () => ({ entries: store.size, inFlight: pending.size }),
	};
};

const searchCache = createTtlCache(CACHE_MAX_ENTRIES);
const previewCache = createTtlCache(CACHE_MAX_ENTRIES);

const clearWebSearchCache = () => {
	searchCache.clear();
	previewCache.clear();
	return true;
};

/* ------------------------------------------------------------------------- *
 * Date parsing. Freshness is only useful if the date is real.
 * ------------------------------------------------------------------------- */

const MONTHS = {
	jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
	may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8,
	september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const MS_PER_DAY = 86400000;

const clampTimestamp = (ms) => {
	if (!Number.isFinite(ms)) {
		return null;
	}

	const now = Date.now();

	// Reject nonsense: pre-1995 and more than a week in the future.
	if (ms < 788918400000 || ms > now + (7 * MS_PER_DAY)) {
		return null;
	}

	return ms;
};

const parseRelativeDate = (text) => {
	const lower = String(text ?? "").toLowerCase();
	const match = lower.match(/\b(\d{1,3})\s*(minute|min|hour|hr|day|week|month|year)s?\s+ago\b/);

	if (match) {
		const amount = Number(match[1]);
		const unitMs = {
			minute: 60000, min: 60000, hour: 3600000, hr: 3600000,
			day: MS_PER_DAY, week: 7 * MS_PER_DAY, month: 30 * MS_PER_DAY, year: 365 * MS_PER_DAY,
		}[match[2]];

		if (Number.isFinite(amount) && Number.isFinite(unitMs)) {
			return clampTimestamp(Date.now() - (amount * unitMs));
		}
	}

	if (/\b(just now|moments ago|minutes ago)\b/.test(lower)) {
		return clampTimestamp(Date.now());
	}

	if (/\btoday\b/.test(lower)) {
		return clampTimestamp(Date.now());
	}

	if (/\byesterday\b/.test(lower)) {
		return clampTimestamp(Date.now() - MS_PER_DAY);
	}

	return null;
};

const parseDateLike = (value) => {
	const text = normalizeText(value);

	if (!text) {
		return null;
	}

	// ISO first - that is what meta tags carry.
	const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
	if (isoMatch) {
		const parsed = Date.parse(isoMatch[0].replace(" ", "T"));
		const clamped = clampTimestamp(parsed);
		if (clamped !== null) {
			return clamped;
		}
	}

	// "24 August 2026" / "24 Aug 2026"
	const dmyMatch = text.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
	if (dmyMatch) {
		const month = MONTHS[dmyMatch[2].toLowerCase()];
		if (month !== undefined) {
			const clamped = clampTimestamp(Date.UTC(Number(dmyMatch[3]), month, Number(dmyMatch[1])));
			if (clamped !== null) {
				return clamped;
			}
		}
	}

	// "August 24, 2026" / "Aug 24 2026"
	const mdyMatch = text.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})\b/);
	if (mdyMatch) {
		const month = MONTHS[mdyMatch[1].toLowerCase()];
		if (month !== undefined) {
			const clamped = clampTimestamp(Date.UTC(Number(mdyMatch[3]), month, Number(mdyMatch[2])));
			if (clamped !== null) {
				return clamped;
			}
		}
	}

	// "24/08/2026" - day first, which is how Indian sources write it.
	const slashMatch = text.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{4})\b/);
	if (slashMatch) {
		const day = Number(slashMatch[1]);
		const month = Number(slashMatch[2]);
		if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
			const clamped = clampTimestamp(Date.UTC(Number(slashMatch[3]), month - 1, day));
			if (clamped !== null) {
				return clamped;
			}
		}
	}

	return parseRelativeDate(text);
};

// A bare year is weak evidence, and a copyright line is no evidence at all.
const parseYearOnly = (value) => {
	const text = String(value ?? "");

	for (const match of text.matchAll(/\b(19|20)\d{2}\b/g)) {
		const before = text.slice(Math.max(0, match.index - 14), match.index);

		if (/(?:©|copyright|\(c\)|isbn|since)\s*$/i.test(before)) {
			continue;
		}

		const year = Number(match[0]);

		if (year >= 1995 && year <= new Date().getFullYear() + 1) {
			// Mid-year, so an unknown month does not skew the age by six months.
			return clampTimestamp(Date.UTC(year, 6, 1));
		}
	}

	return null;
};

const resolvePublishedAt = (result = {}) => {
	const strong = parseDateLike(result?.published)
		|| parseDateLike(result?.modified)
		|| parseDateLike(result?.snippetDate);

	if (strong !== null) {
		return { at: strong, precision: "date" };
	}

	const inline = parseDateLike(result?.snippet) || parseDateLike(result?.title);

	if (inline !== null) {
		return { at: inline, precision: "date" };
	}

	const weak = parseYearOnly(result?.snippet) || parseYearOnly(result?.previewText);

	if (weak !== null) {
		return { at: weak, precision: "year" };
	}

	return { at: null, precision: "none" };
};

const scoreFreshness = (value) => {
	// Kept for callers that still pass a raw string.
	if (value && typeof value === "object") {
		return scoreFreshnessFromAge(value.ageDays, value.precision);
	}

	const parsed = parseDateLike(value);
	const at = parsed !== null ? parsed : parseYearOnly(value);

	if (at === null) {
		return 0.45;
	}

	return scoreFreshnessFromAge((Date.now() - at) / MS_PER_DAY, parsed !== null ? "date" : "year");
};

const scoreFreshnessFromAge = (ageDays, precision = "date") => {
	if (!Number.isFinite(ageDays)) {
		return 0.45;
	}

	const age = Math.max(0, ageDays);
	let score;

	if (age <= 1) {
		score = 1;
	} else if (age <= 7) {
		score = 0.94;
	} else if (age <= 30) {
		score = 0.84;
	} else if (age <= 120) {
		score = 0.7;
	} else if (age <= 365) {
		score = 0.55;
	} else if (age <= 730) {
		score = 0.38;
	} else {
		score = Math.max(0.15, 0.38 - ((age - 730) / 3650));
	}

	// A year-only guess should not beat a precise recent date.
	return precision === "year" ? Math.min(score, 0.6) : score;
};

/* ------------------------------------------------------------------------- *
 * Intent classification. One pass, reused by rewriting, ranking and formatting.
 * ------------------------------------------------------------------------- */

const OFFICE_STOPWORDS = new Set([
	"who", "whos", "whose", "what", "which", "name", "names", "current", "currently", "present",
	"latest", "posted", "posting", "serving", "serves", "now", "today", "the", "a", "an", "of",
	"in", "at", "for", "from", "is", "are", "was", "were", "and", "please", "tell", "me", "about",
	"ias", "ips", "officer", "officers", "district", "mla", "mp", "mayor", "sp", "dm", "collector",
	"magistrate", "price", "rate", "rates", "prices", "cost", "value", "much", "how",
]);

// Keep the capitalised / unrecognised words - those are the place or entity.
const extractLikelyPlace = (value) => {
	const words = String(value ?? "")
		.replace(/\b(19|20)\d{2}\b/g, " ")
		.replace(/[^\p{L}\p{N}\s.-]/gu, " ")
		.split(/\s+/)
		.filter(Boolean);

	const kept = [];

	for (const word of words) {
		const bare = word.replace(/[.-]+$/, "");

		if (!bare || bare.length < 3) {
			continue;
		}

		if (OFFICE_STOPWORDS.has(bare.toLowerCase())) {
			continue;
		}

		if (STOPWORDS.has(bare.toLowerCase())) {
			continue;
		}

		kept.push(bare);
	}

	return kept.slice(0, 4).join(" ").trim();
};

const classifyQueryIntent = (query) => {
	const normalizedQuery = normalizeQuery(query);
	const lower = normalizedQuery.toLowerCase();

	const finance = /\b(gold|silver|crude\s+oil|oil\s+price|share\s+price|stock\s+price|stock\s+market|market\s+price|crypto|bitcoin|ethereum|nifty|sensex|exchange\s+rate|forex|currency\s+rate|usd\s+to\s+inr|inr\s+to\s+usd|commodity\s+price|gold\s+price|gold\s+rate|petrol\s+price|diesel\s+price)\b/.test(lower);
	const representative = /\b(mla|mp|member\s+of\s+legislative\s+assembly|member\s+of\s+parliament|assembly\s+constituency|legislative\s+assembly|legislative\s+council)\b/.test(lower);
	const municipal = /\b(mayor|councillor|councilor|ward)\b/.test(lower);
	const election = /\b(election|elections|result|results|winner|won|counting|vote\s+share|votes?)\b/.test(lower)
		&& /\b(assembly\s+constituency|constituency|mla|mp|member\s+of\s+legislative\s+assembly|member\s+of\s+parliament|minister|mayor|ward|district|west\s+bengal|india)\b/.test(lower);
	const docs = /\b(api|sdk|docs|documentation|install|setup|tutorial|reference|changelog|release\s+notes)\b/.test(lower);
	// Title mentions count, not just the cadre name: "who is the DM of X" is an
	// officer question even though it never says IAS.
	const officerIas = /\b(ias|district\s+magistrate|dm|collector|deputy\s+commissioner)\b/.test(lower);
	const officerIps = /\b(ips|superintendent\s+of\s+police|sp|police\s+commissioner|commissioner\s+of\s+police)\b/.test(lower);
	const officer = (officerIas || officerIps)
		&& /\b(who\s+is|who's|whos|name\s+of|name|current|present|latest|posted|serving)\b/.test(lower);
	const education = /\b(education|school|university|college|admission|syllabus|entrance)\b/.test(lower);
	const officialish = /\b(gov|government|official|policy|scheme|notification|admission|result|exam|guideline|guidelines|rules|circular|tender)\b/.test(lower);
	const indiaBias = /\b(india|indian|west\s+bengal|bengal|kolkata|bihar|odisha|delhi|mumbai|chennai|purba|paschim|medinipur|inr|rupee|rupees|₹)\b/.test(lower)
		|| finance || representative || municipal || election || officer;

	const news = /\b(news|headlines?|breaking|top\s+stories|what'?s\s+happening|happening\s+(now|today)|latest\s+on|updates?\s+(on|about|from))\b/.test(lower);

	const timeSensitive = finance
		|| election
		|| /\b(today|now|current|currently|latest|live|recent|recently|this\s+(week|month|year)|breaking|news|update|updates|as\s+of|right\s+now|score|weather|forecast|price|rate|richest|wealthiest|net\s?worth|billionaires?|market\s?cap(?:italization)?|leaderboard|who\s+won|standings|points\s+table|box\s+office|release\s+date)\b/.test(lower);

	const urlLike = /^https?:\/\//i.test(normalizedQuery)
		|| /^www\./i.test(normalizedQuery)
		|| /^([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(normalizedQuery);

	// Encyclopedic questions are where Wikipedia earns its slot; live prices are not.
	const encyclopedic = !finance
		&& !urlLike
		&& (/\b(who|what|when|where|history|biography|meaning|definition|born|died|founded|capital|population|explain)\b/.test(lower) || representative || municipal || officer);

	return {
		query: normalizedQuery,
		lower,
		finance,
		representative,
		municipal,
		election,
		officer,
		officerIas,
		officerIps,
		docs,
		education,
		officialish,
		indiaBias,
		timeSensitive,
		news,
		urlLike,
		encyclopedic,
		place: (officer || representative || municipal || election || finance) ? extractLikelyPlace(normalizedQuery) : "",
		publicOffice: officer || representative || municipal || election,
	};
};

/* ------------------------------------------------------------------------- *
 * Query rewriting. Same coverage as before, expressed as a priority list and
 * capped hard, because every extra variant used to cost a serial round trip.
 * ------------------------------------------------------------------------- */

// Stored as source strings, not RegExp literals: a shared /g regex carries
// `lastIndex` between calls, so `.test()` would alternate true/false per query.
const TRANSLITERATION_ALIASES = [
	["\\bpurba\\b", "East"],
	["\\bpaschim\\b", "West"],
	["\\bmedinipur\\b", "Midnapore"],
	["\\bhoogly\\b", "Hooghly"],
	["\\bburdwan\\b", "Bardhaman"],
];

const buildVariantCandidates = (intent) => {
	const base = intent.query;
	const place = intent.place;
	const candidates = [];

	const push = (text, priority) => {
		const normalized = normalizeQuery(text);

		if (normalized) {
			candidates.push({ text: normalized, priority });
		}
	};

	// The user's own wording always runs first and always survives the cap.
	push(base, 100);

	if (intent.officer && intent.officerIas) {
		push(place ? `District Magistrate ${place} current` : `${base} district magistrate`, 92);
		push(place ? `Collector ${place} ${new Date().getFullYear()}` : `${base} district collector`, 78);
	}

	if (intent.officer && intent.officerIps) {
		push(place ? `Superintendent of Police ${place} current` : `${base} superintendent of police`, 92);
		push(place ? `SP ${place} police official` : `${base} SP name`, 78);
	}

	if (intent.representative) {
		push(place ? `current MLA of ${place}` : `${base} current MLA`, 90);
		push(place ? `${place} assembly constituency MLA` : `${base} assembly constituency`, 76);
	}

	if (intent.municipal) {
		push(place ? `current mayor of ${place}` : `${base} current mayor`, 88);
		push(place ? `${place} municipal corporation mayor` : `${base} municipal corporation`, 72);
	}

	if (intent.election) {
		push(place ? `${place} election result official` : `${base} official result`, 86);
		push(`${base} results election commission of india`, 70);
	}

	if (intent.finance) {
		if (/\bgold\b/.test(intent.lower)) {
			push(place ? `gold price today in ${place} 22k 24k` : "gold price today India 22k 24k", 94);
			push(`${base} mcx live rate`, 74);
		}

		if (/\bsilver\b/.test(intent.lower)) {
			push(place ? `silver price today in ${place}` : "silver price today India", 94);
		}

		if (/\b(exchange\s+rate|forex|currency\s+rate|usd\s+to\s+inr|inr\s+to\s+usd)\b/.test(intent.lower)) {
			push("usd to inr exchange rate today live", 94);
			push(`${base} rbi reference rate`, 76);
		}

		if (/\b(nifty|sensex|stock\s+market|share\s+price)\b/.test(intent.lower)) {
			push(`${base} live today nse bse`, 92);
		}

		if (/\b(crypto|bitcoin|ethereum)\b/.test(intent.lower)) {
			push(`${base} price today usd live`, 92);
		}

		if (/\b(petrol|diesel)\b/.test(intent.lower)) {
			push(place ? `petrol diesel price today in ${place}` : "petrol diesel price today India", 92);
		}
	}

	// Official-source filters. gov.in / nic.in stay first because that is where the
	// authoritative answer for a public-office question actually lives.
	if (intent.publicOffice || intent.officialish) {
		push(`${base} site:gov.in`, 84);
		push(`${base} site:nic.in`, 66);

		if (/\b(west\s+bengal|bengal|kolkata|purba|paschim|medinipur|howrah|hooghly)\b/.test(intent.lower)) {
			push(`${base} site:wb.gov.in`, 80);
		}

		push(`${base} official`, 58);
	}

	if (intent.docs) {
		push(`${base} official documentation`, 82);
	}

	if (intent.education) {
		push(`${base} site:ac.in`, 60);
	}

	if (intent.timeSensitive && !intent.finance) {
		push(`${base} ${new Date().getFullYear()} latest`, 68);
	}

	for (const [aliasSource, replacement] of TRANSLITERATION_ALIASES) {
		// A fresh RegExp per call keeps `lastIndex` at 0.
		if (new RegExp(aliasSource, "i").test(base)) {
			push(base.replace(new RegExp(aliasSource, "gi"), replacement), 64);
		}
	}

	return candidates;
};

const rewriteQueryVariants = (query, limit = VARIANT_LIMIT) => {
	const intent = classifyQueryIntent(query);

	if (!intent.query) {
		return [];
	}

	const cap = Math.max(1, Number(limit) || VARIANT_LIMIT);
	const seen = new Set();
	const ordered = buildVariantCandidates(intent)
		.map((candidate, index) => ({ ...candidate, index }))
		.sort((left, right) => (right.priority - left.priority) || (left.index - right.index));

	const variants = [];

	for (const candidate of ordered) {
		const key = candidate.text.toLowerCase();

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		variants.push(candidate.text);

		if (variants.length >= cap) {
			break;
		}
	}

	return variants;
};

/* ------------------------------------------------------------------------- *
 * Providers
 * ------------------------------------------------------------------------- */

const searchWikipedia = async (query, deadline) => {
	const normalizedQuery = normalizeQuery(query);

	if (!normalizedQuery) {
		return [];
	}

	try {
		const url = new URL(WIKIPEDIA_API_ENDPOINT);
		url.searchParams.set("action", "query");
		url.searchParams.set("list", "search");
		url.searchParams.set("srsearch", normalizedQuery);
		url.searchParams.set("srlimit", String(Math.max(3, Math.min(8, MAX_RESULTS))));
		url.searchParams.set("srprop", "snippet|timestamp");
		url.searchParams.set("format", "json");
		url.searchParams.set("utf8", "1");
		url.searchParams.set("origin", "*");

		const response = await fetchWithTimeout(url, {
			headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/json" },
		}, SEARCH_TIMEOUT_MS, deadline);

		if (!response.ok) {
			return [];
		}

		const payload = await response.json();
		const results = Array.isArray(payload?.query?.search) ? payload.query.search : [];

		return results
			.map((item) => {
				const title = normalizeText(decodeHtmlEntities(item?.title || ""));
				const snippet = normalizeText(decodeHtmlEntities(item?.snippet || ""));
				const urlValue = title
					? `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/\s+/g, "_"))}`
					: "";

				return {
					title,
					url: normalizeUrl(urlValue),
					snippet,
					published: normalizeText(item?.timestamp || ""),
					source: "wikipedia",
				};
			})
			.filter((result) => result.title && result.url);
	} catch (error) {
		if (error?.code !== "DEADLINE" && error?.name !== "AbortError") {
			logger.warn("[webSearch] Wikipedia search failed", { message: error?.message || String(error) });
		}

		return [];
	}
};

const searchDuckDuckGoJson = async (query, deadline) => {
	try {
		const url = new URL(DDG_JSON_ENDPOINT);
		url.searchParams.set("q", query);
		url.searchParams.set("format", "json");
		url.searchParams.set("no_html", "1");
		url.searchParams.set("no_redirect", "1");
		url.searchParams.set("skip_disambig", "1");

		const response = await fetchWithTimeout(url, {
			headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/json" },
		}, SEARCH_TIMEOUT_MS, deadline);

		if (!response.ok) {
			return [];
		}

		const payload = await response.json();
		const results = [];

		const abstractText = normalizeText(payload?.AbstractText || payload?.Answer || payload?.Definition || "");
		const abstractUrl = normalizeUrl(payload?.AbstractURL || payload?.DefinitionURL || "");
		const abstractHeading = normalizeText(payload?.Heading || payload?.AnswerType || payload?.Type || "");

		if (abstractText && abstractUrl) {
			results.push({
				title: abstractHeading || abstractText.slice(0, 80),
				url: abstractUrl,
				snippet: abstractText,
				source: "ddg-instant",
			});
		}

		const collectRelatedTopics = (topics = [], depth = 0) => {
			if (depth > 3) {
				return;
			}

			for (const topic of topics) {
				if (!topic) {
					continue;
				}

				if (Array.isArray(topic.Topics) && topic.Topics.length) {
					collectRelatedTopics(topic.Topics, depth + 1);
					continue;
				}

				const snippet = normalizeText(topic.Text || topic.Result || "");
				const urlValue = normalizeUrl(topic.FirstURL || "");

				if (!urlValue) {
					continue;
				}

				results.push({
					title: normalizeText(topic.Name || snippet.slice(0, 80)),
					url: urlValue,
					snippet,
					source: "ddg",
				});
			}
		};

		collectRelatedTopics(payload?.RelatedTopics || []);
		return results;
	} catch (error) {
		if (error?.code !== "DEADLINE" && error?.name !== "AbortError") {
			logger.warn("[webSearch] DuckDuckGo JSON search failed", { message: error?.message || String(error) });
		}

		return [];
	}
};

const unwrapDuckDuckGoRedirect = (href) => {
	const rawHref = String(href ?? "").trim();

	if (!rawHref) {
		return "";
	}

	try {
		const url = new URL(rawHref, DDG_HTML_ENDPOINT);
		const uddg = url.searchParams.get("uddg");

		if (uddg) {
			try {
				return decodeURIComponent(uddg);
			} catch {
				return uddg;
			}
		}

		return url.toString();
	} catch {
		return rawHref;
	}
};

const extractHtmlResults = (html, sourceLabel = "ddg-html") => {
	const results = [];
	const content = String(html ?? "");
	const anchorRegex = /<a[^>]*class="[^"]*result(?:__a|-link)[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
	const anchors = [];
	let match;

	while ((match = anchorRegex.exec(content))) {
		anchors.push({ index: match.index, href: match[1], rawTitle: match[2] });

		if (anchors.length >= MAX_RESULTS * 2) {
			break;
		}
	}

	// The Lite endpoint has no result__a class, so fall back to its redirect links.
	if (!anchors.length) {
		const liteRegex = /<a[^>]*href="((?:https?:)?\/\/duckduckgo\.com\/l\/\?uddg=[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

		while ((match = liteRegex.exec(content))) {
			anchors.push({ index: match.index, href: match[1], rawTitle: match[2] });

			if (anchors.length >= MAX_RESULTS * 2) {
				break;
			}
		}
	}

	for (let i = 0; i < anchors.length && results.length < MAX_RESULTS; i += 1) {
		const current = anchors[i];
		const next = anchors[i + 1];
		const block = content.slice(current.index, next ? next.index : Math.min(content.length, current.index + 4000));
		const snippetMatch =
			block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span|td)>/i)
			|| block.match(/<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i);

		const title = normalizeText(decodeHtmlEntities(current.rawTitle || "").replace(/<[^>]*>/g, " "));
		const snippet = normalizeText(decodeHtmlEntities(snippetMatch?.[1] || "").replace(/<[^>]*>/g, " "));
		const url = normalizeUrl(unwrapDuckDuckGoRedirect(decodeHtmlEntities(current.href || "")));

		if (!url || isJunkResultUrl(url)) {
			continue;
		}

		results.push({ title, snippet, url, source: sourceLabel });
	}

	return results;
};

const searchDuckDuckGoHtml = async (query, deadline, { lite = false } = {}) => {
	try {
		const url = new URL(lite ? DDG_LITE_ENDPOINT : DDG_HTML_ENDPOINT);

		const response = await fetchWithTimeout(url, {
			method: "POST",
			headers: {
				"User-Agent": BROWSER_USER_AGENT,
				"Content-Type": "application/x-www-form-urlencoded",
				Accept: "text/html,application/xhtml+xml",
				"Accept-Language": "en-US,en;q=0.9",
			},
			body: new URLSearchParams({ q: query, kl: "wt-wt", df: "" }).toString(),
		}, SEARCH_TIMEOUT_MS, deadline);

		if (!response.ok) {
			return [];
		}

		const html = await readBodyCapped(response, PREVIEW_MAX_BYTES);
		const parsed = extractHtmlResults(html, lite ? "ddg-lite" : "ddg-html");

		if (!parsed.length && (response.status === 202 || /anomaly|captcha|unusual traffic|challenge-form/i.test(html.slice(0, 30000)))) {
			warnThrottled(
				"ddg-bot-check",
				"[webSearch] DuckDuckGo answered with a bot-check page instead of results, so this server's IP is being rate-limited. Google News / Tavily / Bing are used instead. Setting TAVILY_API_KEY makes this reliable.",
				{ status: response.status }
			);
		}

		return parsed;
	} catch (error) {
		if (error?.code !== "DEADLINE" && error?.name !== "AbortError") {
			logger.warn(`[webSearch] DuckDuckGo ${lite ? "Lite" : "HTML"} search failed`, { message: error?.message || String(error) });
		}

		return [];
	}
};

const searchDirectFetch = async (query, deadline) => {
	const trimmedQuery = normalizeQuery(query);

	if (!/^https?:\/\//i.test(trimmedQuery) && !/^www\./i.test(trimmedQuery) && !/^([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?$/i.test(trimmedQuery)) {
		return [];
	}

	const candidateUrl = /^https?:\/\//i.test(trimmedQuery) ? trimmedQuery : `https://${trimmedQuery}`;

	try {
		const response = await fetchWithTimeout(candidateUrl, {
			headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "text/html,application/xhtml+xml" },
			redirect: "follow",
		}, FETCH_TIMEOUT_MS, deadline);

		if (!response.ok) {
			return [];
		}

		const html = await readBodyCapped(response, PREVIEW_MAX_BYTES);
		const meta = extractPageMetadata(html);

		return [{
			title: meta.title || candidateUrl,
			url: normalizeUrl(candidateUrl) || candidateUrl,
			snippet: meta.description,
			published: meta.published,
			modified: meta.modified,
			previewText: meta.previewText,
			source: "direct",
		}];
	} catch {
		return [];
	}
};

/* ------------------------------------------------------------------------- *
 * Additional providers: Tavily (keyed), Google News RSS, Bing RSS
 * ------------------------------------------------------------------------- */

const stripCdata = (value) => String(value ?? "").replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1");

const readXmlTag = (block, tag) => {
	const match = String(block ?? "").match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
	return match ? decodeHtmlEntities(stripCdata(match[1])).trim() : "";
};

const parseRssItems = (xml, limit = NEWS_RSS_MAX_ITEMS) => {
	const content = String(xml ?? "");
	const items = [];
	const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
	let match;

	while ((match = itemRegex.exec(content)) && items.length < limit) {
		const block = match[1];
		const sourceMatch = block.match(/<source\b([^>]*)>([\s\S]*?)<\/source>/i);
		const pubDate = readXmlTag(block, "pubDate");
		const parsedDate = Date.parse(pubDate);

		items.push({
			title: normalizeText(readXmlTag(block, "title")),
			link: readXmlTag(block, "link"),
			description: normalizeText(readXmlTag(block, "description")),
			publishedIso: Number.isFinite(parsedDate) ? new Date(parsedDate).toISOString() : "",
			sourceName: sourceMatch ? normalizeText(decodeHtmlEntities(stripCdata(sourceMatch[2]))) : "",
			sourceUrl: sourceMatch ? (sourceMatch[1].match(/url="([^"]+)"/i)?.[1] || "") : "",
		});
	}

	return items;
};

// "Headline text - The Telegraph" -> "Headline text"
const cleanNewsTitle = (title, publisher) => {
	const text = normalizeText(title);

	if (publisher && text.endsWith(` - ${publisher}`)) {
		return text.slice(0, -(publisher.length + 3)).trim();
	}

	return text;
};

const searchGoogleNews = async (query, deadline) => {
	const normalizedQuery = normalizeQuery(query);

	if (!normalizedQuery || !NEWS_RSS_ENABLED) {
		return [];
	}

	try {
		const url = new URL(GOOGLE_NEWS_RSS_ENDPOINT);
		url.searchParams.set("q", normalizedQuery);
		url.searchParams.set("hl", NEWS_RSS_HL);
		url.searchParams.set("gl", NEWS_RSS_GL);
		url.searchParams.set("ceid", NEWS_RSS_CEID);

		const response = await fetchWithTimeout(url, {
			headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" },
		}, SEARCH_TIMEOUT_MS, deadline);

		if (!response.ok) {
			return [];
		}

		const xml = await readBodyCapped(response, PREVIEW_MAX_BYTES);

		return parseRssItems(xml, NEWS_RSS_MAX_ITEMS)
			.map((item) => {
				const title = cleanNewsTitle(item.title, item.sourceName);

				return {
					title,
					url: normalizeUrl(item.link),
					snippet: item.sourceName ? `${title} - ${item.sourceName}` : title,
					published: item.publishedIso,
					source: "google-news",
					publisher: item.sourceName,
					publisherUrl: normalizeUrl(item.sourceUrl),
				};
			})
			.filter((result) => result.title && result.url);
	} catch (error) {
		if (error?.code !== "DEADLINE" && error?.name !== "AbortError") {
			logger.warn("[webSearch] Google News search failed", { message: error?.message || String(error) });
		}

		return [];
	}
};

const searchBingRss = async (query, deadline) => {
	const normalizedQuery = normalizeQuery(query);

	if (!normalizedQuery) {
		return [];
	}

	try {
		const url = new URL(BING_RSS_ENDPOINT);
		url.searchParams.set("q", normalizedQuery);
		url.searchParams.set("format", "rss");

		const response = await fetchWithTimeout(url, {
			headers: { "User-Agent": BROWSER_USER_AGENT, Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5" },
		}, SEARCH_TIMEOUT_MS, deadline);

		if (!response.ok) {
			return [];
		}

		const xml = await readBodyCapped(response, PREVIEW_MAX_BYTES);

		return parseRssItems(xml, 12)
			.map((item) => ({
				title: item.title,
				url: normalizeUrl(item.link),
				snippet: item.description,
				published: item.publishedIso,
				source: "bing-rss",
			}))
			.filter((result) => result.title && result.url && !isJunkResultUrl(result.url));
	} catch (error) {
		if (error?.code !== "DEADLINE" && error?.name !== "AbortError") {
			logger.warn("[webSearch] Bing RSS search failed", { message: error?.message || String(error) });
		}

		return [];
	}
};

const searchTavily = async (query, deadline, { news = false } = {}) => {
	const key = getTavilyKey();
	const normalizedQuery = normalizeQuery(query);

	if (!key || !normalizedQuery) {
		return [];
	}

	try {
		const response = await fetchWithTimeout(TAVILY_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: JSON.stringify({
				query: normalizedQuery,
				topic: news ? "news" : "general",
				search_depth: "basic",
				max_results: TAVILY_MAX_RESULTS,
				include_answer: false,
				include_raw_content: false,
			}),
		}, TAVILY_TIMEOUT_MS, deadline);

		if (!response.ok) {
			if (response.status === 401 || response.status === 403) {
				warnThrottled("tavily-auth", "[webSearch] Tavily rejected TAVILY_API_KEY (check the key in .env).", { status: response.status });
			} else if (response.status === 429 || response.status === 432 || response.status === 433) {
				warnThrottled("tavily-limit", "[webSearch] Tavily rate/credit limit reached; falling back to the other providers.", { status: response.status });
			} else {
				warnThrottled("tavily-http", "[webSearch] Tavily request failed.", { status: response.status });
			}

			return [];
		}

		const payload = await response.json();
		const results = Array.isArray(payload?.results) ? payload.results : [];

		return results
			.map((item) => ({
				title: normalizeText(item?.title),
				url: normalizeUrl(item?.url),
				snippet: normalizeText(item?.content),
				published: normalizeText(item?.published_date || ""),
				source: "tavily",
			}))
			.filter((result) => result.url && !isJunkResultUrl(result.url));
	} catch (error) {
		if (error?.code !== "DEADLINE" && error?.name !== "AbortError") {
			logger.warn("[webSearch] Tavily search failed", { message: error?.message || String(error) });
		}

		return [];
	}
};

/* ------------------------------------------------------------------------- *
 * Page reading
 * ------------------------------------------------------------------------- */

const pickMainRegion = (html) => {
	const content = String(html ?? "");
	const candidates = [];
	const patterns = [
		/<article\b[^>]*>([\s\S]*?)<\/article>/gi,
		/<main\b[^>]*>([\s\S]*?)<\/main>/gi,
		/<div[^>]*(?:id|class)="[^"]*(?:article|story|content|post|entry|price|rate)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
	];

	for (const pattern of patterns) {
		let match;

		while ((match = pattern.exec(content))) {
			if (match[1] && match[1].length > 400) {
				candidates.push(match[1]);
			}

			if (candidates.length >= 4) {
				break;
			}
		}

		if (candidates.length) {
			break;
		}
	}

	if (!candidates.length) {
		return content;
	}

	return candidates.sort((left, right) => right.length - left.length)[0];
};

const extractPageMetadata = (html) => {
	const content = String(html ?? "");

	const metaContent = (pattern) => normalizeText(decodeHtmlEntities(content.match(pattern)?.[1] || ""));

	const title = metaContent(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i)
		|| normalizeText(decodeHtmlEntities(content.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""));

	const description = metaContent(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i)
		|| metaContent(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i);

	let published = metaContent(/<meta[^>]*(?:property|name)=["'](?:article:published_time|datePublished|pubdate|publish-date|date)["'][^>]*content=["']([^"']+)["']/i)
		|| normalizeText(content.match(/<time[^>]*datetime=["']([^"']+)["']/i)?.[1] || "");

	let modified = metaContent(/<meta[^>]*(?:property|name)=["'](?:article:modified_time|og:updated_time|dateModified|last-modified)["'][^>]*content=["']([^"']+)["']/i);

	// JSON-LD usually carries the most trustworthy date.
	if (!published || !modified) {
		const ldMatches = content.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];

		for (const block of ldMatches.slice(0, 4)) {
			const body = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "");
			const publishedMatch = body.match(/"datePublished"\s*:\s*"([^"]+)"/i);
			const modifiedMatch = body.match(/"dateModified"\s*:\s*"([^"]+)"/i);

			if (!published && publishedMatch) {
				published = normalizeText(publishedMatch[1]);
			}

			if (!modified && modifiedMatch) {
				modified = normalizeText(modifiedMatch[1]);
			}

			if (published && modified) {
				break;
			}
		}
	}

	const previewText = cleanHtml(pickMainRegion(content)).slice(0, PREVIEW_TEXT_CHARS);

	return { title, description, published, modified, previewText };
};

const fetchPagePreview = async (url, deadline) => {
	const target = normalizeUrl(url);

	if (!target) {
		return null;
	}

	const key = canonicalUrlKey(target) || target;

	return previewCache.resolve(
		key,
		(value) => (value ? PREVIEW_CACHE_TTL_MS : EMPTY_CACHE_TTL_MS),
		async () => {
			try {
				const response = await fetchWithTimeout(target, {
					headers: {
						"User-Agent": BROWSER_USER_AGENT,
						Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
						"Accept-Language": "en-US,en;q=0.9",
					},
					redirect: "follow",
				}, FETCH_TIMEOUT_MS, deadline);

				if (!response.ok) {
					return null;
				}

				// Never decode a PDF or an image as text.
				const contentType = String(response.headers?.get?.("content-type") || "").toLowerCase();

				if (contentType && !/text\/html|application\/xhtml|text\/plain|application\/json/.test(contentType)) {
					return null;
				}

				const html = await readBodyCapped(response, PREVIEW_MAX_BYTES);
				const meta = extractPageMetadata(html);

				if (!meta.previewText && !meta.description) {
					return null;
				}

				return meta;
			} catch {
				return null;
			}
		}
	);
};

/* ------------------------------------------------------------------------- *
 * Collection: parallel fan-out with early exit
 * ------------------------------------------------------------------------- */

const buildSearchLanes = (variants, intent) => {
	const lanes = [];
	const first = variants[0];

	// The higher-signal providers go first, so a concurrency limit never starves them.
	if (first && getTavilyKey()) {
		lanes.push({ variant: first, provider: "tavily", isPrimary: true, news: Boolean(intent.news) });
	}

	if (first && NEWS_RSS_ENABLED && (intent.news || intent.timeSensitive)) {
		lanes.push({ variant: first, provider: "google-news", isPrimary: true });
	}

	variants.forEach((variant, index) => {
		const isPrimary = index === 0;

		lanes.push({ variant, provider: "ddg-html", isPrimary });

		// The instant-answer endpoint only ever helps the user's own phrasing.
		if (isPrimary) {
			lanes.push({ variant, provider: "ddg-json", isPrimary });
		}

		// Wikipedia is signal for encyclopedic questions and noise for live prices.
		if (intent.encyclopedic && index < 2) {
			lanes.push({ variant, provider: "wikipedia", isPrimary });
		}
	});

	return lanes;
};

const runLane = async (lane, deadline) => {
	const cacheKey = `${lane.provider}${lane.news ? "-news" : ""}::${lane.variant.toLowerCase()}`;

	return searchCache.resolve(
		cacheKey,
		(value) => (Array.isArray(value) && value.length ? SEARCH_CACHE_TTL_MS : EMPTY_CACHE_TTL_MS),
		async () => {
			if (lane.provider === "tavily") {
				return searchTavily(lane.variant, deadline, { news: lane.news });
			}

			if (lane.provider === "google-news") {
				return searchGoogleNews(lane.variant, deadline);
			}

			if (lane.provider === "bing-rss") {
				return searchBingRss(lane.variant, deadline);
			}

			if (lane.provider === "ddg-json") {
				return searchDuckDuckGoJson(lane.variant, deadline);
			}

			if (lane.provider === "wikipedia") {
				return searchWikipedia(lane.variant, deadline);
			}

			if (lane.provider === "ddg-lite") {
				return searchDuckDuckGoHtml(lane.variant, deadline, { lite: true });
			}

			return searchDuckDuckGoHtml(lane.variant, deadline);
		}
	);
};

const collectSearchResults = async (query, intent = classifyQueryIntent(query), deadline = createDeadline(SEARCH_DEADLINE_MS)) => {
	const variants = rewriteQueryVariants(intent.query, VARIANT_LIMIT);

	if (!variants.length) {
		return { variants, collected: [], lanesRun: 0, lanesOk: 0, providerCounts: {} };
	}

	const lanes = buildSearchLanes(variants, intent);
	const collected = [];
	const domains = new Set();
	let lanesRun = 0;
	let lanesOk = 0;
	let primaryHtmlCount = 0;
	const providerCounts = {};

	await mapWithConcurrency(lanes, SEARCH_CONCURRENCY, async (lane) => {
		if (isDeadlineExpired(deadline) || deadline.controller.signal.aborted) {
			return;
		}

		lanesRun += 1;
		const results = await runLane(lane, deadline);

		if (!Array.isArray(results) || !results.length) {
			providerCounts[lane.provider] = providerCounts[lane.provider] || 0;
			return;
		}

		lanesOk += 1;
		providerCounts[lane.provider] = (providerCounts[lane.provider] || 0) + results.length;

		if (lane.isPrimary && lane.provider === "ddg-html") {
			primaryHtmlCount = results.length;
		}

		for (const result of results) {
			if (!result || isJunkResultUrl(result.url)) {
				continue;
			}

			collected.push(result);

			const domain = getDomain(result.url);

			if (domain) {
				domains.add(domain);
			}
		}

		// Enough breadth already: stop paying for the remaining lanes.
		if (!intent.timeSensitive && collected.length >= EARLY_EXIT_RESULTS && domains.size >= EARLY_EXIT_DOMAINS) {
			deadline.controller.abort();
		}
	});

	// HTML scraping is the one provider we cannot lose; Lite is the same index,
	// different markup, so it rescues a blocked or reshaped response.
	if (!primaryHtmlCount && !isDeadlineExpired(deadline)) {
		const liteResults = await runLane({ variant: variants[0], provider: "ddg-lite", isPrimary: true }, deadline);

		if (Array.isArray(liteResults) && liteResults.length) {
			lanesOk += 1;

			for (const result of liteResults) {
				if (result && !isJunkResultUrl(result.url)) {
					collected.push(result);
				}
			}
		}
	}

	// Nothing but (at most) news headlines so far: try Bing's RSS feed as a last keyless resort.
	const enoughHeadlines = intent.news && collected.length >= 3;

	if (!enoughHeadlines && !collected.some((result) => result?.source !== "google-news") && !isDeadlineExpired(deadline)) {
		const bingResults = await runLane({ variant: variants[0], provider: "bing-rss", isPrimary: true }, deadline);
		providerCounts["bing-rss"] = Array.isArray(bingResults) ? bingResults.length : 0;

		if (Array.isArray(bingResults) && bingResults.length) {
			lanesOk += 1;
			collected.push(...bingResults);
		}
	}

	if (intent.urlLike) {
		const direct = await searchDirectFetch(intent.query, deadline);
		collected.unshift(...direct);
	}

	return { variants, collected, lanesRun, lanesOk, providerCounts };
};

/* ------------------------------------------------------------------------- *
 * Dedupe, relevance, evidence
 * ------------------------------------------------------------------------- */

const dedupeKeyFor = (result = {}) =>
	canonicalUrlKey(result?.url)
	|| `${normalizeText(result?.title).toLowerCase()}|${normalizeText(result?.snippet).toLowerCase().slice(0, 120)}`;

// Merges duplicates instead of dropping them, so a snippet from one provider and a
// date from another end up on the same source.
const uniqByUrl = (results = []) => {
	const merged = new Map();

	for (const result of Array.isArray(results) ? results : []) {
		if (!result || isJunkResultUrl(result.url)) {
			continue;
		}

		const key = dedupeKeyFor(result);

		if (!key) {
			continue;
		}

		const existing = merged.get(key);

		if (!existing) {
			merged.set(key, { ...result });
			continue;
		}

		merged.set(key, {
			...existing,
			title: existing.title || result.title,
			snippet: (existing.snippet || "").length >= (result.snippet || "").length ? existing.snippet : result.snippet,
			description: existing.description || result.description,
			published: existing.published || result.published,
			modified: existing.modified || result.modified,
			previewText: (existing.previewText || "").length >= (result.previewText || "").length ? existing.previewText : result.previewText,
			source: existing.source || result.source,
			providers: [...new Set([...(existing.providers || [existing.source]), result.source].filter(Boolean))],
		});
	}

	return [...merged.values()];
};

const scoreRelevance = (result, query) => {
	const tokens = weightedQueryTokens(query);

	if (!tokens.length) {
		return 0.5;
	}

	const title = String(result?.title ?? "").toLowerCase();
	const body = [result?.snippet, result?.description, result?.previewText].filter(Boolean).join(" ").toLowerCase();
	const haystack = `${title} ${body}`;
	const totalWeight = tokens.reduce((sum, entry) => sum + entry.weight, 0) || 1;

	let matched = 0;

	for (const entry of tokens) {
		if (title.includes(entry.token)) {
			matched += entry.weight;
		} else if (body.includes(entry.token)) {
			matched += entry.weight * 0.8;
		}
	}

	let score = matched / totalWeight;

	// Whole-phrase hits are much stronger evidence than scattered tokens.
	const phrase = normalizeQuery(query).toLowerCase();

	if (phrase.length > 12 && haystack.includes(phrase)) {
		score = Math.min(1, score + 0.18);
	}

	const contentTokens = tokens.filter((entry) => entry.weight > 0.2);
	const missing = contentTokens.filter((entry) => !haystack.includes(entry.token)).length;

	if (contentTokens.length >= 2 && missing === contentTokens.length) {
		score = Math.min(score, 0.15);
	}

	return Math.max(0, Math.min(1, score));
};

const scoreCredibility = (url, source = "") => {
	const domain = getDomain(url);
	const normalizedSource = String(source ?? "").toLowerCase();

	if (!domain) {
		return 0.25;
	}

	if (isOfficialDomain(domain)) {
		return 0.98;
	}

	if (/^(docs|developer|learn|support|api)\./.test(domain) || /wikipedia\.org$/.test(domain)) {
		return 0.88;
	}

	if (/(reuters|apnews|bbc|thehindu|indianexpress|hindustantimes|timesofindia|livemint|moneycontrol|economictimes|business-standard|ndtv|rbi\.org\.in|nseindia|bseindia|kitco|xe)\.(com|in|org|co\.uk)$/.test(domain)) {
		return 0.86;
	}

	if (normalizedSource === "ddg-instant") {
		return 0.8;
	}

	if (normalizedSource === "ddg-html" || normalizedSource === "ddg-lite") {
		return 0.7;
	}

	return 0.68;
};

const splitSentences = (text) =>
	String(text ?? "")
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?;])\s+|\s\|\s|\s•\s/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);

const CURRENCY_TEST = /(?:₹|rs\.?|inr|\$|usd|€|£)\s?\d/i;
const DATE_TEST = /\b(?:\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\b/;
const RECENCY_TEST = /\b(today|now|current|currently|live|as of|updated|latest)\b/i;

const scoreSentence = (sentence, tokens, intent) => {
	const lower = sentence.toLowerCase();
	let score = 0;

	for (const entry of tokens) {
		if (lower.includes(entry.token)) {
			score += entry.weight;
		}
	}

	if (/\d/.test(sentence)) {
		score += 0.3;
	}

	if (CURRENCY_TEST.test(sentence)) {
		score += intent.finance ? 0.9 : 0.35;
	}

	if (DATE_TEST.test(sentence)) {
		score += 0.3;
	}

	if (intent.timeSensitive && RECENCY_TEST.test(sentence)) {
		score += 0.5;
	}

	if (sentence.length < 40) {
		score -= 0.35;
	}

	if (sentence.length > 320) {
		score -= 0.25;
	}

	if (BOILERPLATE_PATTERN.test(lower)) {
		score -= 2.5;
	}

	return score;
};

// The single biggest accuracy win: hand the model the sentences that plausibly
// contain the answer instead of the first 520 characters of a page.
const extractEvidence = (result, query, intent, maxChars = EVIDENCE_CHARS) => {
	const tokens = weightedQueryTokens(query);
	const pool = [
		...splitSentences(result?.snippet),
		...splitSentences(result?.description),
		...splitSentences(result?.previewText),
	];

	if (!pool.length) {
		return "";
	}

	const seen = new Set();
	const scored = [];

	for (const sentence of pool) {
		const fingerprint = sentence.toLowerCase().slice(0, 90);

		if (seen.has(fingerprint)) {
			continue;
		}

		seen.add(fingerprint);
		scored.push({ sentence, score: scoreSentence(sentence, tokens, intent) });
	}

	scored.sort((left, right) => right.score - left.score);

	const chosen = [];
	let used = 0;

	for (const candidate of scored) {
		if (candidate.score <= 0.2) {
			break;
		}

		const clipped = candidate.sentence.length > maxChars
			? `${candidate.sentence.slice(0, maxChars - 1).trim()}…`
			: candidate.sentence;

		if (used + clipped.length > maxChars && chosen.length) {
			break;
		}

		chosen.push(clipped);
		used += clipped.length + 1;

		if (chosen.length >= 3 || used >= maxChars) {
			break;
		}
	}

	if (!chosen.length) {
		const fallback = normalizeText(result?.snippet || result?.description || result?.previewText);
		return fallback.slice(0, maxChars);
	}

	return chosen.join(" ");
};

/* ------------------------------------------------------------------------- *
 * Ranking
 * ------------------------------------------------------------------------- */

const resolveWeights = (intent) => (intent.timeSensitive
	? { relevance: 0.40, credibility: 0.22, freshness: 0.30, depth: 0.08 }
	: { relevance: 0.52, credibility: 0.30, freshness: 0.10, depth: 0.08 });

const resolveSourceBoost = (result, intent) => {
	const source = String(result?.source ?? "").toLowerCase();

	if (source === "wikipedia") {
		// Wikipedia lags on who currently holds an office.
		return intent.publicOffice ? -0.05 : 0.04;
	}

	if (source === "ddg-instant") {
		return 0.05;
	}

	if (source === "ddg-html" || source === "ddg-lite") {
		return 0.03;
	}

	if (source === "direct") {
		return 0.03;
	}

	if (source === "tavily") {
		return 0.06;
	}

	if (source === "google-news") {
		return intent.news ? 0.05 : 0;
	}

	return 0;
};

const rankResults = (results, query, intent = classifyQueryIntent(query)) => {
	const weights = resolveWeights(intent);

	return (Array.isArray(results) ? results : [])
		.map((result) => {
			const { at: publishedAtMs, precision } = resolvePublishedAt(result);
			const ageDays = publishedAtMs === null ? null : Math.max(0, (Date.now() - publishedAtMs) / MS_PER_DAY);

			const credibilityScore = scoreCredibility(result?.publisherUrl || result?.url, result?.source);
			const relevanceScore = scoreRelevance(result, query);
			const freshnessScore = scoreFreshnessFromAge(ageDays === null ? Number.NaN : ageDays, precision);

			const domain = getDomain(result?.publisherUrl) || getDomain(result?.url);
			const officialBoost = isOfficialDomain(domain) ? (intent.publicOffice ? 0.22 : 0.07) : 0;
			const evidence = extractEvidence(result, query, intent);
			const depthScore = Math.min(1, (evidence.length || 0) / 260);

			// Multiple providers surfacing the same page is weak independent support.
			const providerBoost = Array.isArray(result?.providers) && result.providers.length > 1 ? 0.03 : 0;

			let stalenessPenalty = 0;

			if (intent.timeSensitive && ageDays !== null) {
				if (ageDays > 400) {
					stalenessPenalty = 0.16;
				} else if (ageDays <= 2) {
					stalenessPenalty = -0.07;
				}
			}

			const score = (relevanceScore * weights.relevance)
				+ (credibilityScore * weights.credibility)
				+ (freshnessScore * weights.freshness)
				+ (depthScore * weights.depth)
				+ resolveSourceBoost(result, intent)
				+ officialBoost
				+ providerBoost
				- stalenessPenalty;

			return {
				...result,
				domain,
				evidence,
				publishedAt: publishedAtMs === null ? null : new Date(publishedAtMs).toISOString(),
				datePrecision: precision,
				ageDays: ageDays === null ? null : Number(ageDays.toFixed(1)),
				entities: extractEntities([result?.title, result?.snippet, evidence].filter(Boolean).join(" ")),
				credibilityScore: Number(credibilityScore.toFixed(3)),
				freshnessScore: Number(freshnessScore.toFixed(3)),
				relevanceScore: Number(relevanceScore.toFixed(3)),
				score: Number(Math.max(0, score).toFixed(3)),
			};
		})
		.sort((left, right) => right.score - left.score);
};

/* ------------------------------------------------------------------------- *
 * Cross-source corroboration
 * ------------------------------------------------------------------------- */

const NAME_HEAD_BLOCKLIST = new Set([
	"The", "This", "That", "These", "Those", "There", "Here", "It", "He", "She", "They", "We", "You",
	"India", "News", "Home", "About", "Read", "More", "Also", "According", "However", "But", "And",
	"Source", "Sources", "Update", "Updated", "Latest", "Live", "Photo", "Video", "Share", "Follow",
	"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
	"January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December",
]);

const normalizeAtom = (kind, raw) => {
	const text = String(raw ?? "").trim();

	if (kind === "money" || kind === "number") {
		const digits = text.replace(/[^\d.]/g, "");
		const value = Number(digits);

		if (!Number.isFinite(value) || value === 0) {
			return "";
		}

		return String(value);
	}

	return text.replace(/\s+/g, " ").toLowerCase();
};

const extractAtoms = (text, intent) => {
	const atoms = [];
	const content = String(text ?? "");

	if (!content) {
		return atoms;
	}

	for (const match of content.matchAll(/(?:₹|rs\.?\s?|inr\s?|\$|us\$|€|£)\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?(?:lakh|crore|thousand|k|mn|million|bn|billion))?/gi)) {
		atoms.push({ kind: "money", display: normalizeText(match[0]) });
	}

	if (intent.publicOffice || intent.encyclopedic) {
		for (const match of content.matchAll(/\b[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{1,}){1,2}\b/g)) {
			const head = match[0].split(/\s+/)[0];

			if (NAME_HEAD_BLOCKLIST.has(head)) {
				continue;
			}

			atoms.push({ kind: "name", display: match[0] });
		}
	}

	for (const match of content.matchAll(new RegExp(DATE_TEST.source, "g"))) {
		atoms.push({ kind: "date", display: normalizeText(match[0]) });
	}

	return atoms;
};

// An answer that three independent domains state is worth far more than the
// top-ranked page's guess. Disagreement is reported rather than hidden.
const buildConsensus = (rankedSources, intent) => {
	const groups = new Map();

	for (const result of rankedSources.slice(0, CONTEXT_SOURCE_LIMIT)) {
		const domain = result?.domain || getDomain(result?.url);

		if (!domain) {
			continue;
		}

		const haystack = [result?.title, result?.evidence, result?.snippet].filter(Boolean).join(" ");

		for (const atom of extractAtoms(haystack, intent)) {
			const key = `${atom.kind}::${normalizeAtom(atom.kind, atom.display)}`;

			if (key.endsWith("::")) {
				continue;
			}

			const entry = groups.get(key) || { kind: atom.kind, display: atom.display, domains: new Set() };
			entry.domains.add(domain);
			groups.set(key, entry);
		}
	}

	const supported = [...groups.values()]
		.map((entry) => ({ kind: entry.kind, display: entry.display, support: entry.domains.size, domains: [...entry.domains] }))
		.filter((entry) => entry.support >= 2)
		.sort((left, right) => right.support - left.support);

	const agreed = supported.slice(0, 3);
	const conflicts = [];

	for (const kind of ["money", "name"]) {
		const sameKind = supported.filter((entry) => entry.kind === kind);

		if (sameKind.length >= 2 && sameKind[0].support === sameKind[1].support) {
			conflicts.push({ kind, options: sameKind.slice(0, 2).map((entry) => entry.display) });
		}
	}

	return { agreed, conflicts };
};

/* ------------------------------------------------------------------------- *
 * Formatting for the model
 * ------------------------------------------------------------------------- */

const describeAge = (result) => {
	if (!result?.publishedAt) {
		return "";
	}

	const ageDays = Number(result?.ageDays);

	if (!Number.isFinite(ageDays)) {
		return result.publishedAt.slice(0, 10);
	}

	if (ageDays < 1) {
		return `${result.publishedAt.slice(0, 10)} (today)`;
	}

	if (ageDays < 45) {
		return `${result.publishedAt.slice(0, 10)} (${Math.round(ageDays)}d old)`;
	}

	return `${result.publishedAt.slice(0, 10)}${result.datePrecision === "year" ? " (year only)" : ""}`;
};

const formatWebSearchContext = (bundle = {}) => {
	const rankedSources = Array.isArray(bundle?.rankedSources) ? bundle.rankedSources : [];
	const fallbackSources = Array.isArray(bundle?.sources) ? bundle.sources : [];
	const sources = rankedSources.length ? rankedSources : fallbackSources;
	const summary = normalizeText(bundle?.summary);

	// Sentinel is unchanged - llmService.js branches on this exact string.
	if (!summary && !sources.length) {
		return "WEB_SEARCH_FAILED";
	}

	const lines = [];
	const today = new Date().toISOString().slice(0, 10);

	lines.push(`Web evidence for: "${normalizeText(bundle?.query) || "query"}" | retrieved ${today}${Number.isFinite(Number(bundle?.confidence)) ? ` | confidence ${Number(bundle.confidence).toFixed(2)}` : ""}`);

	const agreed = Array.isArray(bundle?.consensus?.agreed) ? bundle.consensus.agreed : [];
	const conflicts = Array.isArray(bundle?.consensus?.conflicts) ? bundle.consensus.conflicts : [];

	for (const entry of agreed) {
		lines.push(`Corroborated (${entry.support} independent domains: ${entry.domains.slice(0, 4).join(", ")}): ${entry.display}`);
	}

	for (const conflict of conflicts) {
		lines.push(`Conflicting ${conflict.kind} values across sources: ${conflict.options.join(" vs ")} - say the sources disagree instead of picking one.`);
	}

	if (summary) {
		lines.push(`Summary: ${summary}`);
	}

	let used = lines.join("\n").length;

	for (const [index, result] of sources.slice(0, CONTEXT_SOURCE_LIMIT).entries()) {
		const parts = [`Source ${index + 1}`];

		if (result?.title) parts.push(`Title: ${normalizeText(result.title)}`);
		if (result?.domain) parts.push(`Domain: ${result.domain}`);
		if (result?.publisher) parts.push(`Publisher: ${result.publisher}`);

		const age = describeAge(result);
		if (age) parts.push(`Date: ${age}`);

		if (Number.isFinite(Number(result?.score))) parts.push(`Score: ${Number(result.score).toFixed(3)}`);

		const evidence = normalizeText(result?.evidence) || normalizeText(result?.snippet).slice(0, EVIDENCE_CHARS);
		if (evidence) parts.push(`Evidence: ${evidence}`);

		if (result?.url) parts.push(`URL: ${result.url}`);

		const line = parts.join(" | ");

		// Hard character budget: a search block must never be the reason a turn
		// blows the model's token ceiling.
		if (used + line.length + 1 > CONTEXT_CHAR_BUDGET && index > 0) {
			break;
		}

		lines.push(line);
		used += line.length + 1;
	}

	lines.push("Use only the sources above for facts that could have changed; cite the domain when you state one. Mark claims only with the bare tag [Source N] (for example \"... [Source 2]\"); never paste, repeat or print a source URL in the answer unless the user explicitly asks for a link. If they disagree or none answers the question, say so plainly.");

	return lines.join("\n");
};

/* ------------------------------------------------------------------------- *
 * Entry points
 * ------------------------------------------------------------------------- */

const emptyBundle = (query, status) => ({
	query,
	rewrittenQueries: [],
	summary: "",
	sources: [],
	rankedSources: [],
	consensus: { agreed: [], conflicts: [] },
	entities: [],
	confidence: 0,
	status,
});

// `options` is optional and inert unless a caller passes it, so existing
// call sites (`searchWebDetailed(query)`) behave exactly as before.
/* ------------------------------------------------------------------------- *
 * Clickable links: resolve + verify every source URL before the model (and the
 * user) ever sees it.
 *
 * Google News RSS items link to opaque "news.google.com/rss/articles/<id>"
 * redirects that often 404 outside a perfectly-warmed browser session. Each
 * source goes through, in order:
 *   1. decode the Google News link to the publisher's real article URL
 *   2. GET it - a 404/410 means dead
 *   3. dead / undecodable -> the publisher's own site (right website, can't 404)
 *   4. nothing trustworthy -> no URL at all (the badge renders unlinked)
 * ------------------------------------------------------------------------- */

const LINK_VERIFY_ENABLED = process.env.WEB_LINK_VERIFY !== "0";
const LINK_CHECK_TIMEOUT_MS = Number(process.env.WEB_LINK_CHECK_TIMEOUT_MS || 3500);
const LINK_RESOLVE_BUDGET_MS = Number(process.env.WEB_LINK_RESOLVE_BUDGET_MS || 6500);
const LINK_RESOLVE_CONCURRENCY = 6;
const LINK_CACHE_TTL_MS = 30 * 60 * 1000;
const LINK_CACHE_MAX = 500;
const DEAD_LINK_STATUSES = new Set([404, 410]);
const GOOGLE_NEWS_BATCH_ENDPOINT = "https://news.google.com/_/DotsSplashUi/data/batchexecute";

const linkCache = new Map();

const isGoogleNewsArticleUrl = (value) => /^https?:\/\/news\.google\.com\/(?:rss\/)?(?:articles|read)\//i.test(String(value || ""));

const googleNewsArticleId = (value) => {
	try {
		const match = new URL(String(value)).pathname.match(/\/(?:rss\/)?(?:articles|read)\/([^/?#]+)/i);
		return match ? match[1] : "";
	} catch {
		return "";
	}
};

const originOf = (value) => {
	try {
		const url = new URL(String(value || ""));
		return url.protocol === "http:" || url.protocol === "https:" ? url.origin : "";
	} catch {
		return "";
	}
};

// Older Google News ids are base64 protobuf with the article URL embedded:
//   08 13 22 <varint length> <url> d2 01 00
// Those decode offline. Newer ids ("AU_yqL...") need the network call below.
const decodeEmbeddedGoogleNewsUrl = (id) => {
	try {
		const bytes = Buffer.from(String(id).replace(/-/g, "+").replace(/_/g, "/"), "base64");

		if (bytes.length < 6 || bytes[0] !== 0x08 || bytes[1] !== 0x13 || bytes[2] !== 0x22) {
			return "";
		}

		let offset = 3;
		let length = bytes[offset];

		if (length >= 0x80) {
			length = (bytes[offset] & 0x7f) | (bytes[offset + 1] << 7);
			offset += 2;
		} else {
			offset += 1;
		}

		const decoded = bytes.slice(offset, offset + length).toString("utf8");
		return /^https?:\/\//i.test(decoded) ? decoded : "";
	} catch {
		return "";
	}
};

const parseGoogleNewsBatchResponse = (text) => {
	const body = String(text || "");

	try {
		const segment = body.split("\n\n")[1] || "";
		let parsed;

		try {
			parsed = JSON.parse(segment);
		} catch {
			parsed = JSON.parse(segment.slice(0, -2));
		}

		const inner = JSON.parse(parsed[0][2]);

		if (typeof inner?.[1] === "string" && /^https?:\/\//i.test(inner[1])) {
			return inner[1];
		}
	} catch {
		// fall through to the pattern match
	}

	const loose = body.match(/garturlres\\*",\\*"(https?:[^"\\]+(?:\\u[0-9a-f]{4}[^"\\]*)*)/i);

	if (loose?.[1]) {
		try {
			return JSON.parse(`"${loose[1]}"`);
		} catch {
			return loose[1];
		}
	}

	return "";
};

const decodeGoogleNewsViaNetwork = async (id) => {
	const pageResponse = await fetchWithTimeout(`https://news.google.com/rss/articles/${id}?hl=en-US&gl=US&ceid=US:en`, {
		headers: { "User-Agent": BROWSER_USER_AGENT, "Accept-Language": "en-US,en;q=0.9" },
		redirect: "follow",
	}, LINK_CHECK_TIMEOUT_MS, null);

	if (!pageResponse.ok) {
		return "";
	}

	const html = await readBodyCapped(pageResponse, PREVIEW_MAX_BYTES);
	const signature = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
	const timestamp = html.match(/data-n-a-ts="([^"]+)"/)?.[1];

	if (!signature || !timestamp) {
		return "";
	}

	const inner = JSON.stringify([
		"garturlreq",
		[["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1, null, null, null, null, null, 0, 1], "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0],
		id,
		Number(timestamp),
		signature,
	]);

	const response = await fetchWithTimeout(GOOGLE_NEWS_BATCH_ENDPOINT, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
			"User-Agent": BROWSER_USER_AGENT,
		},
		body: `f.req=${encodeURIComponent(JSON.stringify([[["Fbv4je", inner]]]))}`,
	}, LINK_CHECK_TIMEOUT_MS, null);

	if (!response.ok) {
		return "";
	}

	return parseGoogleNewsBatchResponse(await response.text());
};

const decodeGoogleNewsUrl = async (value) => {
	const id = googleNewsArticleId(value);

	if (!id) {
		return "";
	}

	const embedded = decodeEmbeddedGoogleNewsUrl(id);

	if (embedded) {
		return embedded;
	}

	try {
		const decoded = await decodeGoogleNewsViaNetwork(id);
		return decoded && !isGoogleNewsArticleUrl(decoded) ? decoded : "";
	} catch {
		return "";
	}
};

// "dead" only for a definite 404/410. A timeout or a bot-block (403/429) proves
// nothing about what a real browser sees, so those keep the exact link.
const verifyLiveUrl = async (value) => {
	try {
		const response = await fetchWithTimeout(value, {
			method: "GET",
			headers: {
				"User-Agent": BROWSER_USER_AGENT,
				Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
				"Accept-Language": "en-US,en;q=0.9",
			},
			redirect: "follow",
		}, LINK_CHECK_TIMEOUT_MS, null);

		try {
			await response.body?.cancel?.();
		} catch {
			// body already consumed/closed
		}

		return DEAD_LINK_STATUSES.has(response.status) ? "dead" : "ok";
	} catch {
		return "unknown";
	}
};

const resolveOneSourceLink = async (original, publisherUrl) => {
	const cached = linkCache.get(original);

	if (cached && cached.expires > Date.now()) {
		return cached.value;
	}

	let target = original;

	if (isGoogleNewsArticleUrl(original)) {
		target = await decodeGoogleNewsUrl(original);
	}

	let resolved = { url: "", kind: "none" };

	if (target) {
		const status = await verifyLiveUrl(target);

		if (status !== "dead") {
			resolved = { url: target, kind: "article" };
		}
	}

	if (!resolved.url) {
		const fallback = originOf(publisherUrl) || (isGoogleNewsArticleUrl(original) ? "" : originOf(original));

		if (fallback) {
			resolved = { url: fallback, kind: "publisher" };
		}
	}

	
	if (linkCache.size >= LINK_CACHE_MAX) {
		linkCache.delete(linkCache.keys().next().value);
	}

	linkCache.set(original, { value: resolved, expires: Date.now() + LINK_CACHE_TTL_MS });
	return resolved;
};

// Mutates the given result objects. Whatever happens (budget hit, network down),
// no unresolved Google redirect link is ever left in place.
const resolveSourceLinks = async (sources) => {
	if (!LINK_VERIFY_ENABLED || !Array.isArray(sources) || !sources.length) {
		return sources;
	}

	const state = { closed: false };

	const apply = (result, resolved) => {
		result.rawUrl = result.rawUrl || result.url;
		result.url = resolved.url;
		result.linkKind = resolved.kind;
	};

	const work = mapWithConcurrency(sources, LINK_RESOLVE_CONCURRENCY, async (result) => {
		if (!result?.url) return;

		const resolved = await resolveOneSourceLink(result.url, result.publisherUrl);

		if (!state.closed) {
			apply(result, resolved);
		}
	});

	let timer;
	await Promise.race([
		work,
		new Promise((resolve) => {
			timer = setTimeout(resolve, LINK_RESOLVE_BUDGET_MS);
		}),
	]);
	clearTimeout(timer);
	state.closed = true;

	for (const result of sources) {
		if (result?.url && !result.linkKind) {
			const fallback = originOf(result.publisherUrl) || (isGoogleNewsArticleUrl(result.url) ? "" : result.url);
			apply(result, fallback ? { url: fallback, kind: fallback === result.url ? "article" : "publisher" } : { url: "", kind: "none" });
		}
	}

	return sources;
};

const searchWebDetailed = async (query, options = {}) => {
	const normalizedQuery = normalizeQuery(query);
	const startedAt = Date.now();

	if (!normalizedQuery) {
		return { ...emptyBundle(normalizedQuery, "empty"), sources: [], rankedSources: [] };
	}

	try {
		const intent = classifyQueryIntent(normalizedQuery);
		const searchDeadline = createDeadline(Number(options?.searchDeadlineMs) || SEARCH_DEADLINE_MS);
		const { variants, collected, lanesRun, lanesOk, providerCounts } = await collectSearchResults(normalizedQuery, intent, searchDeadline);

		const deduped = uniqByUrl(collected);

		if (!deduped.length) {
			if (SEARCH_DEBUG) {
				logger.warn(`[webSearch] q="${normalizedQuery.slice(0, 90)}" variants=${variants.length} lanes=${lanesRun}/${lanesOk} providers=${JSON.stringify(providerCounts)} results=0 status=no_results ms=${Date.now() - startedAt}`);
			}

			return { ...emptyBundle(normalizedQuery, "no_results"), rewrittenQueries: variants, entities: extractEntities(normalizedQuery) };
		}

		// Rank before fetching so the fetch budget is spent on the best candidates,
		// not on whichever URLs happened to be parsed first.
		const preRanked = rankResults(deduped, normalizedQuery, intent);
		const previewBudget = Math.max(1, Math.min(Number(options?.fetchLimit) || FETCH_RESULT_LIMIT, preRanked.length));
		const previewTargets = preRanked
			.filter((result) => normalizeUrl(result?.url) && !/\.(pdf|docx?|xlsx?|pptx?|zip|jpe?g|png|gif|mp4|mp3)(\?|$)/i.test(result.url) && !/^https?:\/\/news\.google\.com\//i.test(result.url))
			.slice(0, previewBudget);

		const previewDeadline = createDeadline(Number(options?.previewDeadlineMs) || PREVIEW_DEADLINE_MS);
		const previews = await mapWithConcurrency(previewTargets, PREVIEW_CONCURRENCY, async (result) => {
			const preview = await fetchPagePreview(result.url, previewDeadline);

			if (!preview) {
				return result;
			}

			return {
				...result,
				title: result.title || preview.title,
				description: preview.description || result.description,
				published: result.published || preview.published,
				modified: preview.modified || result.modified,
				previewText: preview.previewText || result.previewText,
			};
		});

		const enriched = uniqByUrl([
			...previews.filter(Boolean),
			...preRanked,
		]);

		const rankedSources = rankResults(enriched, normalizedQuery, intent).slice(0, MAX_RESULTS);

		// Only the sources the model will actually see/cite need clickable links.
		await resolveSourceLinks(rankedSources.slice(0, CONTEXT_SOURCE_LIMIT));

		const consensus = buildConsensus(rankedSources, intent);

		const best = rankedSources[0];
		const summary = normalizeText(best?.evidence || best?.snippet || best?.description || "").slice(0, 600);

		// Confidence now reflects agreement and evidence quality, not just the top score.
		const agreementBoost = consensus.agreed.length ? Math.min(0.12, 0.04 * consensus.agreed[0].support) : 0;
		const conflictPenalty = consensus.conflicts.length ? 0.1 : 0;
		const confidence = rankedSources.length
			? Math.max(0.15, Math.min(0.98, Number(best?.score || 0) + agreementBoost - conflictPenalty))
			: 0;

		const bundle = {
			query: normalizedQuery,
			rewrittenQueries: variants,
			summary,
			sources: deduped.slice(0, MAX_RESULTS),
			rankedSources,
			consensus,
			entities: extractEntities([normalizedQuery, summary].join(" ")),
			confidence: Number(confidence.toFixed(3)),
			status: rankedSources.length ? "ok" : "no_results",
			timings: { totalMs: Date.now() - startedAt, lanesRun, lanesOk, previews: previewTargets.length },
		};

		if (SEARCH_DEBUG) {
			logger.log(`[webSearch] q="${normalizedQuery.slice(0, 90)}" variants=${variants.length} lanes=${lanesOk}/${lanesRun} providers=${JSON.stringify(providerCounts)} unique=${deduped.length} previews=${previewTargets.length} agreed=${consensus.agreed.length} conf=${bundle.confidence} status=ok ms=${bundle.timings.totalMs}`);
		}

		return bundle;
	} catch (error) {
		logger.warn("[webSearch] search failed", { message: error?.message || String(error) });
		return emptyBundle(normalizedQuery, "failed");
	}
};

const searchWeb = async (query, options = {}) => {
	const detailedResult = await searchWebDetailed(query, options);
	return formatWebSearchContext(detailedResult);
};

module.exports = {
	searchWeb,
	searchWebDetailed,
	formatWebSearchContext,
	resolveSourceLinks,
	decodeGoogleNewsUrl,
	// Additive exports - nothing existing depends on them.
	rewriteQueryVariants,
	classifyQueryIntent,
	extractEvidence,
	buildConsensus,
	rankResults,
	uniqByUrl,
	scoreFreshness,
	clearWebSearchCache,
	searchGoogleNews,
	searchTavily,
	searchBingRss,
	parseRssItems,
};

