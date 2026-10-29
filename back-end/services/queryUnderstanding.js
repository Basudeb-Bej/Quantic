//back-end/services/queryUnderstanding.js
"use strict";
const axios = require("axios");
const { formatWebSearchContext } = require("./webSearch.js");

const logger = console;

const normalizeText = (value) => String(value ?? "").trim();
const editDistance = (left, right, max = 2) => {
	const a = String(left);
	const b = String(right);

	if (Math.abs(a.length - b.length) > max) {
		return max + 1;
	}

	let previous = new Array(b.length + 1);
	let current = new Array(b.length + 1);

	for (let j = 0; j <= b.length; j += 1) {
		previous[j] = j;
	}

	for (let i = 1; i <= a.length; i += 1) {
		current[0] = i;
		let rowMin = current[0];

		for (let j = 1; j <= b.length; j += 1) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);

			if (current[j] < rowMin) {
				rowMin = current[j];
			}
		}

		if (rowMin > max) {
			return max + 1;
		}

		[previous, current] = [current, previous];
	}

	return previous[b.length];
};

const FUZZY_TERMS = [
	"current", "currently", "latest", "minister", "president", "governor", "chairman", "secretary",
	"commissioner", "chancellor", "richest", "wealthiest", "billionaire", "election", "population",
	"weather", "forecast", "temperature", "tomorrow", "yesterday", "today", "constituency",
	"assembly", "champion", "captain", "parliament", "government",
];

const MULTIWORD_PLACES = [
	"west bengal", "new delhi", "uttar pradesh", "madhya pradesh", "tamil nadu", "andhra pradesh",
	"himachal pradesh", "arunachal pradesh", "jammu and kashmir", "sri lanka", "hong kong", "new york",
	"los angeles", "san francisco", "south africa", "new zealand", "saudi arabia", "united states",
	"united kingdom", "south korea", "north korea", "west indies", "abu dhabi",
];

const SINGLE_PLACES = [
	// Indian states and union territories
	"delhi", "bihar", "odisha", "kerala", "gujarat", "maharashtra", "karnataka", "telangana", "rajasthan",
	"punjab", "haryana", "assam", "tripura", "manipur", "meghalaya", "mizoram", "nagaland", "sikkim",
	"goa", "jharkhand", "uttarakhand", "chhattisgarh", "chandigarh", "puducherry", "ladakh", "lakshadweep",
	// Indian cities
	"kolkata", "mumbai", "chennai", "bengaluru", "bangalore", "hyderabad", "ahmedabad", "pune", "jaipur",
	"lucknow", "patna", "bhopal", "ranchi", "bhubaneswar", "guwahati", "dehradun", "srinagar", "amaravati",
	"howrah", "siliguri", "durgapur", "jhargram", "midnapore", "bardhaman", "darjeeling",
	// Countries
	"india", "pakistan", "bangladesh", "nepal", "bhutan", "china", "russia", "ukraine", "america", "canada",
	"australia", "germany", "france", "japan", "singapore", "indonesia", "malaysia", "thailand", "italy",
	"spain", "brazil", "mexico", "egypt", "turkey", "israel", "iran", "iraq", "afghanistan", "england",
	"scotland", "ireland", "sweden", "norway", "finland", "poland", "argentina", "chile", "peru", "cuba",
];

const KNOWN_PLACES = [...MULTIWORD_PLACES, ...SINGLE_PLACES];

// Only distinctive, longer names are used for fuzzy repair. Short or word-like names
// ("chile" vs "child", "peru", "cuba", "spain") would "correct" ordinary words.
const FUZZY_PLACES = [
	"delhi", "bihar", "odisha", "kerala", "gujarat", "maharashtra", "karnataka", "telangana", "rajasthan",
	"punjab", "haryana", "tripura", "manipur", "meghalaya", "mizoram", "nagaland", "sikkim", "jharkhand",
	"uttarakhand", "chhattisgarh", "chandigarh", "kolkata", "mumbai", "chennai", "bengaluru", "bangalore",
	"hyderabad", "ahmedabad", "jaipur", "lucknow", "bhopal", "ranchi", "bhubaneswar", "guwahati", "dehradun",
	"srinagar", "bengal", "pradesh", "pakistan", "bangladesh", "russia", "ukraine", "canada", "australia",
	"germany", "singapore", "indonesia", "malaysia", "thailand", "kashmir", "zealand", "arabia",
];

const FUZZY_VOCABULARY = [...new Set([...FUZZY_TERMS, ...FUZZY_PLACES])];
const FUZZY_VOCABULARY_SET = new Set(FUZZY_VOCABULARY);

const titleCase = (value) => String(value)
	.split(/\s+/)
	.map((word) => (word.toLowerCase() === "and" ? "and" : word.charAt(0).toUpperCase() + word.slice(1)))
	.join(" ");

const matchCase = (original, replacement) => {
	if (original.length > 1 && original === original.toUpperCase()) {
		return replacement.toUpperCase();
	}

	if (original.charAt(0) === original.charAt(0).toUpperCase()) {
		return replacement.charAt(0).toUpperCase() + replacement.slice(1);
	}

	return replacement;
};

const fuzzyCorrectToken = (token) => {
	const lower = token.toLowerCase();

	if (lower.length < 5 || FUZZY_VOCABULARY_SET.has(lower)) {
		return token;
	}

	const maxDistance = lower.length >= 8 ? 2 : 1;
	let best = null;
	let bestDistance = maxDistance + 1;

	for (const candidate of FUZZY_VOCABULARY) {
		// Same first letter: a slip in the first letter is rare and the main source of false positives.
		if (candidate[0] !== lower[0]) continue;

		// "frances"/"france", "indian"/"india": an extension of a known word is a different word.
		if (lower.startsWith(candidate) || candidate.startsWith(lower)) continue;

		const distance = editDistance(lower, candidate, maxDistance);

		if (distance < bestDistance) {
			best = candidate;
			bestDistance = distance;
		}
	}

	return best && bestDistance <= maxDistance ? matchCase(token, best) : token;
};

// "westbengal" -> "West Bengal", "newdelhi" -> "New Delhi"
const GLUED_PLACE_PATTERNS = MULTIWORD_PLACES
	.filter((place) => !place.includes(" and "))
	.map((place) => ({ pattern: new RegExp(`\\b${place.replace(/\s+/g, "")}\\b`, "gi"), replacement: titleCase(place) }));

const repairQueryText = (text) => {
	let repaired = String(text ?? "");

	// Code and very long messages are not search questions; leave them alone.
	if (!repaired || repaired.length > 300 || repaired.includes("```")) {
		return repaired;
	}

	for (const entry of GLUED_PLACE_PATTERNS) {
		repaired = repaired.replace(entry.pattern, entry.replacement);
	}

	return repaired.replace(/[A-Za-z]+/g, (word) => fuzzyCorrectToken(word));
};

/* ------------------------------------------------------------------------- *
 * Splitting "A and B" place lists into one query per place
 * ------------------------------------------------------------------------- */

const PLACE_ALTERNATION = [...KNOWN_PLACES]
	.sort((left, right) => right.length - left.length)
	.map((place) => place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	.join("|");

const PLACE_LIST_PATTERN = new RegExp(
	`\\b(?:${PLACE_ALTERNATION})(?:\\s*(?:,|&|\\band\\b|\\bor\\b)\\s*(?:${PLACE_ALTERNATION}))+(?![A-Za-z])`,
	"i"
);
const SINGLE_PLACE_PATTERN = new RegExp(`\\b(?:${PLACE_ALTERNATION})(?![A-Za-z])`, "gi");

// Matchups and relationships are about the pair, not about each place separately.
const PAIR_QUESTION_PATTERN = /\b(match|score|scores|vs\.?|versus|fixture|series|trade|relations?|war|border|conflict|treaty|between|compare|comparison|distance|flight|route|train)\b/i;

const decomposeByPlaces = (message) => {
	const text = normalizeText(message);
	const empty = { queries: [text].filter(Boolean), labels: [text].filter(Boolean) };

	if (!text || PAIR_QUESTION_PATTERN.test(text)) {
		return empty;
	}

	const span = text.match(PLACE_LIST_PATTERN);

	if (!span) {
		return empty;
	}

	const names = [];

	for (const match of span[0].matchAll(SINGLE_PLACE_PATTERN)) {
		const name = titleCase(match[0].toLowerCase());

		if (!names.some((existing) => existing.toLowerCase() === name.toLowerCase())) {
			names.push(name);
		}
	}

	if (names.length < 2) {
		return empty;
	}

	const before = text.slice(0, span.index);
	const after = text.slice(span.index + span[0].length);
	const capped = names.slice(0, 4);

	return {
		queries: capped.map((name) => `${before}${name}${after}`.replace(/\s+/g, " ").trim()),
		labels: capped,
	};
};

/* ------------------------------------------------------------------------- *
 * LLM planner: spelling repair and decomposition for everything the rules cannot see
 * ("net worth of Messi and Ronaldo", "who is the CEO of Tata and Reliance")
 * ------------------------------------------------------------------------- */

const PLAN_MODEL = process.env.GROQ_SEARCH_QUERY_MODEL || process.env.GROQ_FAST_MODEL || "llama-3.1-8b-instant";
const PLAN_TIMEOUT_MS = Number(process.env.GROQ_SEARCH_PLAN_TIMEOUT_MS || 6000);
const MAX_SUBQUERIES = 4;

const PLAN_SYSTEM_PROMPT = [
	"You prepare web search queries from a user's question.",
	"1. Fix spelling mistakes and typos (for example 'currant chif menester' means 'current chief minister').",
	"2. If the question asks about several independent subjects (people, places, companies, products) that need separate lookups, return one standalone query per subject. Otherwise return exactly one query.",
	"3. Every query must keep the original intent (current, latest, price, net worth, who is ...), name its subject in full, and be 3 to 14 plain words with no search operators and no quotes.",
	"4. Do not answer the question and do not invent facts. Return at most 4 queries.",
	'Reply with JSON only, in exactly this shape: {"corrected":"<the question with typos fixed>","queries":["..."]}',
	"",
	"Examples:",
	'Question: who is the currant chif menester in westbengal and delhi?',
	'{"corrected":"Who is the current chief minister in West Bengal and Delhi?","queries":["current chief minister of West Bengal","current chief minister of Delhi"]}',
	'Question: net worth of messi and ronaldo',
	'{"corrected":"Net worth of Messi and Ronaldo","queries":["Lionel Messi net worth","Cristiano Ronaldo net worth"]}',
	'Question: who is the richst man in the wrld',
	'{"corrected":"Who is the richest man in the world","queries":["richest man in the world current"]}',
].join("\n");

const safeParseJson = (value) => {
	const text = String(value ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

	if (!text) return null;

	try {
		return JSON.parse(text);
	} catch {
		const match = text.match(/\{[\s\S]*\}/);

		if (!match) return null;

		try {
			return JSON.parse(match[0]);
		} catch {
			return null;
		}
	}
};

const cleanPlannedQuery = (value) => normalizeText(value)
	.replace(/^["'`]+|["'`]+$/g, "")
	.replace(/\s+/g, " ");

const llmPlanQueries = async (message) => {
	const question = normalizeText(message);

	if (!question || !process.env.GROQ_API_KEY) {
		return null;
	}

	try {
		const response = await axios({
			method: "post",
			url: "https://api.groq.com/openai/v1/chat/completions",
			headers: {
				Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
				"Content-Type": "application/json",
			},
			data: {
				model: PLAN_MODEL,
				messages: [
					{ role: "system", content: PLAN_SYSTEM_PROMPT },
					{ role: "user", content: `Question: ${question.slice(0, 400)}` },
				],
				temperature: 0,
				max_tokens: 300,
				response_format: { type: "json_object" },
			},
			timeout: PLAN_TIMEOUT_MS,
		});

		const parsed = safeParseJson(response.data?.choices?.[0]?.message?.content);
		const rawQueries = Array.isArray(parsed?.queries) ? parsed.queries : [];
		const queries = [];

		for (const raw of rawQueries) {
			const query = cleanPlannedQuery(raw);

			if (query.length >= 3 && query.length <= 180 && !queries.some((existing) => existing.toLowerCase() === query.toLowerCase())) {
				queries.push(query);
			}

			if (queries.length >= MAX_SUBQUERIES) break;
		}

		if (!queries.length) {
			return null;
		}

		return { corrected: cleanPlannedQuery(parsed?.corrected).slice(0, 400), queries };
	} catch (error) {
		logger.warn("[queryUnderstanding] LLM plan failed", { message: error?.response?.data?.error?.message || error?.message || String(error) });
		return null;
	}
};

const CONJUNCTION_PATTERN = /(?:,|&|\band\b|\bor\b|\bvs\.?\b|\bversus\b|\bcompare\b|\bbetween\b)/i;

// Only spend a model call when the question could plausibly cover more than one subject.
const shouldTryLlmDecompose = (text) => {
	const value = normalizeText(text);

	return value.length <= 300
		&& !value.includes("```")
		&& value.split(/\s+/).length >= 5
		&& CONJUNCTION_PATTERN.test(value);
};

/* ------------------------------------------------------------------------- *
 * Public: decide which searches to run
 * ------------------------------------------------------------------------- */

// Returns { corrected, queries, labels, via }. `queries.length > 1` means several subjects.
const planSearchQueries = async (message) => {
	const repaired = repairQueryText(normalizeText(message));
	const byPlaces = decomposeByPlaces(repaired);

	if (byPlaces.queries.length > 1) {
		return { corrected: repaired, queries: byPlaces.queries, labels: byPlaces.labels, via: "places" };
	}

	if (shouldTryLlmDecompose(repaired)) {
		const planned = await llmPlanQueries(repaired);

		if (planned) {
			return {
				corrected: planned.corrected || repaired,
				queries: planned.queries,
				labels: planned.queries,
				via: "llm",
			};
		}
	}

	return { corrected: repaired, queries: [repaired], labels: [repaired], via: "single" };
};

/* ------------------------------------------------------------------------- *
 * Merging the evidence of several searches into one context block
 * ------------------------------------------------------------------------- */

// parts: [{ label, bundle }]  (bundle is null when that subject's search found nothing).
// Source numbers are renumbered continuously so "[Source N]" stays unique across the whole answer,
// which is what the citation badges and the sources marker rely on.
const buildMultiWebContext = (parts) => {
	const list = Array.isArray(parts) ? parts : [];
	const count = list.length;
	const perPart = count <= 2 ? 4 : (count === 3 ? 3 : 2);

	let offset = 0;
	let usable = 0;
	let instruction = "";
	const blocks = [];

	list.forEach((part, index) => {
		const heading = `### Subject ${index + 1}: ${part.label}`;
		const bundle = part.bundle;

		if (!bundle) {
			blocks.push(`${heading}\nNo usable web sources were found for this subject.`);
			return;
		}

		const limited = {
			...bundle,
			rankedSources: (Array.isArray(bundle.rankedSources) ? bundle.rankedSources : []).slice(0, perPart),
			sources: (Array.isArray(bundle.sources) ? bundle.sources : []).slice(0, perPart),
		};
		const text = formatWebSearchContext(limited);

		if (text === "WEB_SEARCH_FAILED") {
			blocks.push(`${heading}\nNo usable web sources were found for this subject.`);
			return;
		}

		usable += 1;
		let highest = 0;
		const lines = [];

		for (const line of text.split(/\r?\n/)) {
			const match = line.match(/^Source (\d+)(\s*\|.*)$/);

			if (match) {
				const number = Number(match[1]);
				highest = Math.max(highest, number);
				lines.push(`Source ${offset + number}${match[2]}`);
				continue;
			}

			if (/^Use only the sources above/.test(line)) {
				if (!instruction) instruction = line;
				continue;
			}

			lines.push(line);
		}

		offset += highest;
		blocks.push(`${heading}\n${lines.join("\n")}`);
	});

	if (!usable) {
		return "WEB_SEARCH_FAILED";
	}

	const header = `Multi-subject web evidence: the question covers ${count} separate subjects. Answer each subject in its own short paragraph with a bold label, use only the sources listed under that subject, and say so plainly for any subject whose block has no usable source (do not let that hide the subjects that do have evidence).`;

	return [header, ...blocks, instruction].filter(Boolean).join("\n\n");
};

module.exports = {
	repairQueryText,
	decomposeByPlaces,
	planSearchQueries,
	llmPlanQueries,
	buildMultiWebContext,
	editDistance,
};
