// //back-end/services/memoryService.js
// const axios = require("axios");
// const mongoose = require("mongoose");
// const { createEmbedding } = require("../rag/embedder.js");
// const Memory = require("../models/MemoryModel.js");

// const MEMORY_MODEL = process.env.GROQ_MEMORY_MODEL || process.env.GROQ_FAST_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant";
// const MEMORY_TIMEOUT_MS = Number(process.env.GROQ_MEMORY_TIMEOUT_MS || 10000);
// const MEMORY_MAX_ATTEMPTS = Number(process.env.GROQ_MEMORY_MAX_ATTEMPTS || 2);
// const MEMORY_RETRIEVAL_LIMIT = Number(process.env.GROQ_MEMORY_RETRIEVAL_LIMIT || 5);
// const SHORT_TERM_MESSAGE_LIMIT = Number(process.env.MEMORY_SHORT_TERM_LIMIT || 10);

// const VOLATILE_MEMORY_TTL_DAYS = {
// 	location: 30,
// 	mood: 1,
// 	current_project: 14,
// };

// const resolveMemoryExpiry = (key) => {
// 	const ttlDays = VOLATILE_MEMORY_TTL_DAYS[normalizeMemoryKey(key)];

// 	if (!Number.isFinite(ttlDays)) {
// 		return null;
// 	}

// 	return new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
// };

// const normalizeText = (value) => String(value ?? "").trim();

// const normalizeMemoryKey = (value) => normalizeText(value)
// 	.toLowerCase()
// 	.replace(/[^a-z0-9]+/g, "_")
// 	.replace(/^_+|_+$/g, "");

// const LOCATION_KEY_PATTERN = /^(location|city|place|residence|hometown|address|region|current_location|user_location|based_in|live_in|living_in|from)$/;

// const canonicalizeMemoryKey = (rawKey) => {
// 	const normalizedKey = normalizeMemoryKey(rawKey);
// 	return LOCATION_KEY_PATTERN.test(normalizedKey) ? "location" : normalizedKey;
// };

// const getLocationSpecificity = (value) => {
// 	const normalized = normalizeText(value);
// 	if (!normalized) {
// 		return 0;
// 	}

// 	const segmentCount = normalized.split(",").map((part) => part.trim()).filter(Boolean).length;
// 	const wordCount = normalized.split(/\s+/).filter(Boolean).length;

// 	return (segmentCount * 10) + wordCount;
// };

// const isValidUserId = (value) => mongoose.Types.ObjectId.isValid(String(value ?? ""));

// const isSensitiveText = (text) => /(password|otp|pin|secret|bank|card|cvv|ssn|passcode|security\s*code)/i.test(normalizeText(text));

// const isLikelyQuestionOrCommand = (text) => {
// 	const normalized = normalizeText(text);
// 	return /\?\s*$/.test(normalized) || /^(what|who|when|where|why|how|is|are|do|does|can|could|will|would|should)\b/i.test(normalized);
// };

// const isLikelyDenialOrCorrection = (text) => {
// 	const normalized = normalizeText(text).toLowerCase();
// 	return /\b(not|isn't|is not|wrong|incorrect|that's not|thats not|never said|didn't say|did not say)\b/.test(normalized);
// };

// const hasSelfDisclosureSignal = (text) => {
// 	const normalized = normalizeText(text).toLowerCase();
// 	// Require language that plausibly states a fact about the user themself.
// 	return /\b(i am|i'm|i live|i work|i study|my name|my location|my city|i'm from|i am from|i use|i prefer|i like|i love|i hate|i want|i need)\b/.test(normalized);
// };
// const cosineSimilarity = (left, right) => {
// 	if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) {
// 		return 0;
// 	}

// 	const length = Math.min(left.length, right.length);
// 	let dotProduct = 0;
// 	let leftMagnitude = 0;
// 	let rightMagnitude = 0;

// 	for (let index = 0; index < length; index += 1) {
// 		const leftValue = Number(left[index]) || 0;
// 		const rightValue = Number(right[index]) || 0;

// 		dotProduct += leftValue * rightValue;
// 		leftMagnitude += leftValue * leftValue;
// 		rightMagnitude += rightValue * rightValue;
// 	}

// 	if (!leftMagnitude || !rightMagnitude) {
// 		return 0;
// 	}

// 	return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
// };

// const deriveMemoryKey = (memory = {}) => {
// 	const rawKey = normalizeText(memory?.key);

// 	if (rawKey) {
// 		return canonicalizeMemoryKey(rawKey);
// 	}

// 	const content = normalizeText(memory?.content || memory?.value);
// 	if (!content) {
// 		return "";
// 	}

// 	return canonicalizeMemoryKey(content.split(/\s+/).slice(0, 4).join("_"));
// };

// const buildMemoryExtractionPrompt = (message) => [
// 	"Extract only stable long-term user memories from the message.",
// 	"Return only valid JSON. No markdown. No explanation.",
// 	"Capture preferences, facts, behaviors, and context that would help personalize future replies.",
// 	"CRITICAL: Only extract a fact if the user explicitly and unambiguously stated it about themselves in this exact message.",
// 	"Do NOT infer, guess, assume, or default a location, name, or any personal fact from tone, phrasing, IP, timezone, or general knowledge.",
// 	"Do NOT extract anything from questions the user is asking, or from messages where the user is denying, correcting, or disputing a fact.",
// 	"If the message contains no explicit first-person statement of fact, return an empty memories array.",
// 	"Do not invent details. Do not store transient chit-chat, one-off tasks, or sensitive data.",
// 	"Prefer concise keys such as favorite_language, tool, learning, location, preference.",
// 	"Use content for the user-facing memory text and keep key as a compact identifier.",
// 	"Only set key to 'location' if the user explicitly named a real place they live, work, or are from (e.g. 'I live in Kolkata'). Never guess a location.",
// 	"Schema:",
// 	'{"memories":[{"type":"preference|fact|behavior|context","key":"string","content":"string","confidence":0.0,"importance":1}]}',
// 	`Message: ${JSON.stringify(normalizeText(message))}`,
// ].join("\n");

// const buildMemoryExtractionRequest = (message) => ({
// 	method: "post",
// 	url: "https://api.groq.com/openai/v1/chat/completions",
// 	headers: {
// 		Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
// 		"Content-Type": "application/json",
// 	},
// 	data: {
// 		model: MEMORY_MODEL,
// 		messages: [
// 			{
// 				role: "system",
// 				content: "You extract structured long-term memories from user messages and output only valid JSON.",
// 			},
// 			{
// 				role: "user",
// 				content: buildMemoryExtractionPrompt(message),
// 			},
// 		],
// 		temperature: 0,
// 		max_tokens: 220,
// 		response_format: { type: "json_object" },
// 	},
// 	timeout: MEMORY_TIMEOUT_MS,
// });

// const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// const requestWithRetry = async (requestFactory) => {
// 	let lastError;

// 	for (let attempt = 1; attempt <= MEMORY_MAX_ATTEMPTS; attempt += 1) {
// 		try {
// 			return await axios(requestFactory());
// 		} catch (error) {
// 			lastError = error;

// 			if (attempt < MEMORY_MAX_ATTEMPTS) {
// 				await delay(150 * attempt);
// 			}
// 		}
// 	}

// 	throw lastError;
// };

// const stripCodeFences = (value) => String(value ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

// const safeJsonParse = (value) => {
// 	const cleanedValue = stripCodeFences(value);

// 	if (!cleanedValue) {
// 		return null;
// 	}

// 	try {
// 		return JSON.parse(cleanedValue);
// 	} catch {
// 		const match = cleanedValue.match(/\{[\s\S]*\}/);
// 		if (!match) {
// 			return null;
// 		}

// 		try {
// 			return JSON.parse(match[0]);
// 		} catch {
// 			return null;
// 		}
// 	}
// };

// const normalizeExtractedMemory = (memory) => {
// 	const type = ["preference", "fact", "behavior", "context"].includes(normalizeText(memory?.type).toLowerCase())
// 		? normalizeText(memory.type).toLowerCase()
// 		: "fact";
// 	const content = normalizeText(memory?.content || memory?.value);
// 	const key = deriveMemoryKey({ key: memory?.key, content });
// 	const confidenceNumber = Number(memory?.confidence);
// 	const importanceNumber = Number(memory?.importance);

// 	if (!key || !content || isSensitiveText(content)) {
// 		return null;
// 	}

// 	return {
// 		type,
// 		key,
// 		content,
// 		value: content,
// 		confidence: Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(1, confidenceNumber)) : 0.7,
// 		importance: Number.isFinite(importanceNumber) ? Math.max(1, Math.min(5, importanceNumber)) : 1,
// 	};
// };

// const extractMemory = async (message) => {
// 	const normalizedMessage = normalizeText(message);

// 	if (!normalizedMessage || isSensitiveText(normalizedMessage)) {
// 		return [];
// 	}

// 	if (isLikelyQuestionOrCommand(normalizedMessage) || isLikelyDenialOrCorrection(normalizedMessage) || !hasSelfDisclosureSignal(normalizedMessage)) {
// 		return [];
// 	}

// 	try {
// 		const response = await requestWithRetry(() => buildMemoryExtractionRequest(normalizedMessage));
// 		const content = response.data?.choices?.[0]?.message?.content || "";
// 		const parsed = safeJsonParse(content);
// 		const rawMemories = Array.isArray(parsed?.memories)
// 			? parsed.memories
// 			: Array.isArray(parsed?.memory)
// 				? parsed.memory
// 				: [];

// 		return rawMemories.map(normalizeExtractedMemory).filter(Boolean);
// 	} catch {
// 		return [];
// 	}
// };

// const saveMemory = async (userId, memories = [], sourceMessage = "") => {
// 	if (!isValidUserId(userId) || !Array.isArray(memories) || memories.length === 0) {
// 		return;
// 	}

// 	const normalizedUserId = new mongoose.Types.ObjectId(String(userId));
// 	const normalizedSource = normalizeText(sourceMessage).slice(0, 500);

// 	for (const memory of memories) {
// 		const key = canonicalizeMemoryKey(memory?.key);
// 		const content = normalizeText(memory?.content || memory?.value);
// 		const value = content;
// 		const confidenceNumber = Number.isFinite(Number(memory?.confidence)) ? Number(memory.confidence) : 0.7;

// 		if (!key || !value || isSensitiveText(value)) {
// 			continue;
// 		}

// 		const minimumConfidence = key === "location" ? 0.85 : 0.5;
// 		if (confidenceNumber < minimumConfidence) {
// 			continue;
// 		}

// 		if (key === "location" && confidenceNumber < 0.9) {
// 			const existingLocation = await Memory.findOne({ userId: normalizedUserId, key: "location" }).lean().catch(() => null);

// 			if (existingLocation) {
// 				const existingSpecificity = getLocationSpecificity(existingLocation.content || existingLocation.value);
// 				const newSpecificity = getLocationSpecificity(value);

// 				if (existingSpecificity >= newSpecificity) {
// 					continue;
// 				}
// 			}
// 		}

// 		let embedding = [];
// 		try {
// 			embedding = await createEmbedding(value);
// 		} catch {
// 			embedding = [];
// 		}

// 		try {
// 			await Memory.findOneAndUpdate(
// 				{ userId: normalizedUserId, key },
// 				{
// 					$set: {
// 						content: value,
// 						embedding,
// 						type: ["preference", "fact", "behavior", "context"].includes(memory?.type) ? memory.type : "fact",
// 						value,
// 						confidence: Math.max(0, Math.min(1, confidenceNumber)),
// 						importance: Number.isFinite(Number(memory?.importance)) ? Math.max(1, Math.min(5, Number(memory.importance))) : 1,
// 						source: normalizedSource,
// 						expiresAt: resolveMemoryExpiry(key),
// 						lastUsedAt: new Date(),
// 					},
// 				},
// 				{ upsert: true, new: true, setDefaultsOnInsert: true }
// 			);
// 		} catch {
// 			continue;
// 		}
// 	}
// };
// const deleteMemoryByKey = async (userId, key) => {
// 	const normalizedKey = normalizeMemoryKey(key);

// 	if (!isValidUserId(userId) || !normalizedKey) {
// 		return false;
// 	}

// 	const normalizedUserId = new mongoose.Types.ObjectId(String(userId));

// 	try {
// 		const result = await Memory.deleteOne({ userId: normalizedUserId, key: normalizedKey });
// 		return Boolean(result?.deletedCount);
// 	} catch {
// 		return false;
// 	}
// };

// const deleteLocationMemories = async (userId) => {
// 	if (!isValidUserId(userId)) {
// 		return false;
// 	}

// 	const normalizedUserId = new mongoose.Types.ObjectId(String(userId));

// 	try {
// 		const result = await Memory.deleteMany({
// 			userId: normalizedUserId,
// 			$or: [
// 				{ key: "location" },
// 				{ key: { $regex: /^(city|place|residence|hometown|address|region|current_location|user_location|based_in|live_in|living_in|from)$/i } },
// 			],
// 		});
// 		return Boolean(result?.deletedCount);
// 	} catch {
// 		return false;
// 	}
// };

// const deleteMemoryById = async (userId, memoryId) => {
// 	if (!isValidUserId(userId) || !mongoose.Types.ObjectId.isValid(String(memoryId ?? ""))) {
// 		return false;
// 	}

// 	const normalizedUserId = new mongoose.Types.ObjectId(String(userId));
// 	const normalizedMemoryId = new mongoose.Types.ObjectId(String(memoryId));

// 	try {
// 		const result = await Memory.deleteOne({ _id: normalizedMemoryId, userId: normalizedUserId });
// 		return Boolean(result?.deletedCount);
// 	} catch {
// 		return false;
// 	}
// };

// const listAllMemories = async (userId) => {
// 	if (!isValidUserId(userId)) {
// 		return [];
// 	}

// 	const normalizedUserId = new mongoose.Types.ObjectId(String(userId));

// 	const memories = await Memory.find({ userId: normalizedUserId })
// 		.sort({ lastUsedAt: -1, updatedAt: -1 })
// 		.lean()
// 		.catch(() => []);

// 	return memories.map((memory) => ({
// 		id: String(memory._id),
// 		key: memory.key,
// 		type: memory.type,
// 		content: memory.content || memory.value,
// 		confidence: memory.confidence,
// 		importance: memory.importance,
// 		source: memory.source || "",
// 		expiresAt: memory.expiresAt || null,
// 		lastUsedAt: memory.lastUsedAt || memory.updatedAt || null,
// 		createdAt: memory.createdAt || null,
// 	}));
// };

// const getRelevantMemories = async (userId, query = "", limit = MEMORY_RETRIEVAL_LIMIT) => {
// 	if (!isValidUserId(userId)) {
// 		return [];
// 	}

// 	const userObjectId = new mongoose.Types.ObjectId(String(userId));
// 	const CANDIDATE_POOL_LIMIT = Number(process.env.GROQ_MEMORY_CANDIDATE_POOL_LIMIT || 200);

// 	const memories = await Memory.find({ userId: userObjectId })
// 		.sort({ lastUsedAt: -1, updatedAt: -1 })
// 		.limit(CANDIDATE_POOL_LIMIT)
// 		.lean();
// 	if (!memories.length) {
// 		return [];
// 	}

// 	const normalizedLimit = Math.max(1, Number(limit) || MEMORY_RETRIEVAL_LIMIT);
// 	const normalizedQuery = normalizeText(query);

// 	if (!normalizedQuery) {
// 		return memories
// 			.sort((left, right) => {
// 				const importanceDelta = Number(right?.importance || 1) - Number(left?.importance || 1);
// 				if (importanceDelta !== 0) {
// 					return importanceDelta;
// 				}

// 				return new Date(right?.lastUsedAt || right?.updatedAt || 0) - new Date(left?.lastUsedAt || left?.updatedAt || 0);
// 			})
// 			.slice(0, normalizedLimit);
// 	}

// 	let queryEmbedding = [];
// 	try {
// 		queryEmbedding = await createEmbedding(normalizedQuery);
// 	} catch {
// 		queryEmbedding = [];
// 	}

// 	if (!queryEmbedding.length) {
// 		return memories
// 			.sort((left, right) => new Date(right?.lastUsedAt || right?.updatedAt || 0) - new Date(left?.lastUsedAt || left?.updatedAt || 0))
// 			.slice(0, normalizedLimit);
// 	}

// 	const now = Date.now();
// 	return memories
// 		.map((memory) => {
// 			const embedding = Array.isArray(memory?.embedding) ? memory.embedding : [];
// 			const similarity = cosineSimilarity(queryEmbedding, embedding);
// 			const importance = Math.max(1, Number(memory?.importance || 1));
// 			const lastUsedAt = memory?.lastUsedAt || memory?.updatedAt || memory?.createdAt || now;
// 			const ageHours = Math.max(0, (now - new Date(lastUsedAt).getTime()) / 36e5);
// 			const recencyBoost = 1 / (1 + ageHours / 24);

// 			return {
// 				...memory,
// 				_score: (similarity * 0.7) + ((importance / 5) * 0.2) + (recencyBoost * 0.1),
// 			};
// 		})
// 		.sort((left, right) => right._score - left._score)
// 		.slice(0, normalizedLimit);
// };

// const formatMemoryContext = (memories) => {
// 	if (!Array.isArray(memories) || memories.length === 0) {
// 		return "";
// 	}

// 	return memories
// 		.map((memory) => {
// 			const content = normalizeText(memory?.content || memory?.value);
// 			if (!content) {
// 				return "";
// 			}

// 			const label = normalizeText(memory?.key) || normalizeText(memory?.type) || "memory";
// 			return `- ${label}: ${content}`;
// 		})
// 		.filter(Boolean)
// 		.join("\n");
// };

// const formatShortTermConversation = (conversation = [], limit = SHORT_TERM_MESSAGE_LIMIT) => {
// 	if (!Array.isArray(conversation) || conversation.length === 0) {
// 		return "";
// 	}

// 	return conversation
// 		.slice(-Math.max(1, Number(limit) || SHORT_TERM_MESSAGE_LIMIT))
// 		.map((entry, index) => {
// 			const role = normalizeText(entry?.role).toLowerCase();
// 			const content = normalizeText(entry?.content);

// 			if (!content) {
// 				return "";
// 			}

// 			const label = role === "assistant" ? "Assistant" : role === "system" ? "System" : "User";
// 			return `${index + 1}. ${label}: ${content}`;
// 		})
// 		.filter(Boolean)
// 		.join("\n");
// };

// const buildMemoryLayerContext = async ({ userId, query = "", conversation = [], limit = MEMORY_RETRIEVAL_LIMIT } = {}) => {
// 	const shortTerm = formatShortTermConversation(conversation);
// 	const semanticMemories = await getRelevantMemories(userId, query, limit).catch(() => []);
// 	const semantic = formatMemoryContext(semanticMemories);

// 	return {
// 		shortTerm,
// 		longTerm: semantic,
// 		semantic,
// 		memories: semanticMemories,
// 	};
// };

// // module.exports = {
// // 	extractMemory,
// // 	saveMemory,
// // 	getRelevantMemories,
// // 	formatMemoryContext,
// // 	formatShortTermConversation,
// // 	buildMemoryLayerContext,
// // 	deleteMemoryByKey,
// // 	deleteLocationMemories,
// // };

// module.exports = {
// 	extractMemory,
// 	saveMemory,
// 	getRelevantMemories,
// 	formatMemoryContext,
// 	formatShortTermConversation,
// 	buildMemoryLayerContext,
// 	deleteMemoryByKey,
// 	deleteLocationMemories,
// 	deleteMemoryById,
// 	listAllMemories,
// };

//back-end/services/memoryService.js
// Quantic AI - long-term memory layer.
//
// Rewritten 2026-08-24. Public surface is unchanged; the eight original exports
// keep their names, argument order and return shapes:
//   extractMemory(message)                       -> array of normalized memories
//   saveMemory(userId, memories, sourceMessage)  -> (now also returns a write report)
//   getRelevantMemories(userId, query, limit)    -> array of memory documents
//   formatMemoryContext(memories)                -> string
//   formatShortTermConversation(conversation, limit) -> string
//   buildMemoryLayerContext({ userId, query, conversation, limit }) -> object
//   deleteMemoryByKey(userId, key)               -> boolean
//   deleteLocationMemories(userId)               -> boolean
//
// No schema change is required. Only fields the MemoryModel already declares are
// written: key, type, content, value, confidence, importance, source, expiresAt,
// lastUsedAt, embedding.
//
// What changed, in one line each:
//   1. A deterministic rule extractor runs before Groq, so most turns cost no call.
//   2. A trailing "?" no longer discards the declarative half of a message.
//   3. Contradiction handling is generalised beyond location, with key aliasing and
//      semantic dedupe, so near-duplicate rows stop accumulating.
//   4. Retrieval is hybrid (vector + lexical + importance + recency + confidence),
//      capped, expiry-filtered and floored, instead of loading every row every turn.
//   5. Context lines carry a confidence tag, so an unconfirmed fact cannot be
//      asserted back to the user as if it were verified.
const axios = require("axios");
const mongoose = require("mongoose");
const { createEmbedding } = require("../rag/embedder.js");
const Memory = require("../models/MemoryModel.js");

/* ------------------------------------------------------------------------- *
 * Configuration. Every previously supported env var still works.
 * ------------------------------------------------------------------------- */

const MEMORY_MODEL = process.env.GROQ_MEMORY_MODEL || process.env.GROQ_FAST_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const MEMORY_TIMEOUT_MS = Number(process.env.GROQ_MEMORY_TIMEOUT_MS || 10000);
const MEMORY_MAX_ATTEMPTS = Number(process.env.GROQ_MEMORY_MAX_ATTEMPTS || 2);
const MEMORY_RETRIEVAL_LIMIT = Number(process.env.GROQ_MEMORY_RETRIEVAL_LIMIT || 5);
const SHORT_TERM_MESSAGE_LIMIT = Number(process.env.MEMORY_SHORT_TERM_LIMIT || 10);

// Retrieval shaping.
const MEMORY_CANDIDATE_LIMIT = Number(process.env.MEMORY_CANDIDATE_LIMIT || 60);
const MEMORY_SCORE_FLOOR = Number(process.env.MEMORY_SCORE_FLOOR || 0.12);
const MEMORY_DEDUPE_SIMILARITY = Number(process.env.MEMORY_DEDUPE_SIMILARITY || 0.93);

// Context budgets. A memory block must never be the reason a turn blows the
// model's token ceiling.
const MEMORY_CONTEXT_CHAR_BUDGET = Number(process.env.MEMORY_CONTEXT_CHAR_BUDGET || 1400);
const SHORT_TERM_MESSAGE_CHARS = Number(process.env.MEMORY_SHORT_TERM_MESSAGE_CHARS || 700);
const SHORT_TERM_TOTAL_CHARS = Number(process.env.MEMORY_SHORT_TERM_TOTAL_CHARS || 4000);

// Extraction gating.
const MEMORY_LLM_EXTRACTION = String(process.env.MEMORY_LLM_EXTRACTION ?? "1") !== "0";
const MEMORY_EXTRACTION_MAX_CHARS = Number(process.env.MEMORY_EXTRACTION_MAX_CHARS || 900);
const MEMORY_DEBUG = String(process.env.MEMORY_DEBUG ?? "0") !== "0";

// Short-lived caches. Both are invalidated for a user whenever that user writes.
const MEMORY_CANDIDATE_CACHE_TTL_MS = Number(process.env.MEMORY_CANDIDATE_CACHE_TTL_MS || 8000);
const MEMORY_QUERY_EMBED_CACHE_TTL_MS = Number(process.env.MEMORY_QUERY_EMBED_CACHE_TTL_MS || 60000);

const VOLATILE_MEMORY_TTL_DAYS = {
	location: 30,
	mood: 1,
	current_project: 14,
	current_task: 3,
	schedule: 7,
};

const logger = console;

/* ------------------------------------------------------------------------- *
 * Text helpers
 * ------------------------------------------------------------------------- */

const normalizeText = (value) => String(value ?? "").trim();

const normalizeMemoryKey = (value) => normalizeText(value)
	.toLowerCase()
	.replace(/[^a-z0-9]+/g, "_")
	.replace(/^_+|_+$/g, "");

const LOCATION_KEY_PATTERN = /^(location|city|place|residence|hometown|home_town|address|region|current_location|user_location|based_in|live_in|living_in|lives_in|from|country|state)$/;

// Aliases collapse the many names a model invents for the same idea. Without this
// a user ends up with job, profession and occupation rows that all disagree.
const MEMORY_KEY_ALIASES = {
	name: "name",
	user_name: "name",
	username: "name",
	full_name: "name",
	first_name: "name",
	preferred_name: "name",
	nickname: "name",
	job: "occupation",
	profession: "occupation",
	occupation: "occupation",
	work: "occupation",
	works_as: "occupation",
	role: "occupation",
	job_title: "occupation",
	employer: "employer",
	company: "employer",
	works_at: "employer",
	mood: "mood",
	current_mood: "mood",
	feeling: "mood",
	feelings: "mood",
	emotion: "mood",
	project: "current_project",
	current_project: "current_project",
	working_on: "current_project",
	side_project: "current_project",
	task: "current_task",
	current_task: "current_task",
	todo: "current_task",
	favorite_language: "favorite_language",
	favourite_language: "favorite_language",
	preferred_language: "favorite_language",
	programming_language: "favorite_language",
	coding_language: "favorite_language",
	language: "favorite_language",
	tech_stack: "tech_stack",
	stack: "tech_stack",
	tools: "tech_stack",
	tool: "tech_stack",
	framework: "tech_stack",
	learning: "learning",
	studying: "learning",
	study: "learning",
	course: "learning",
	likes: "likes",
	like: "likes",
	interest: "likes",
	interests: "likes",
	hobby: "likes",
	hobbies: "likes",
	dislikes: "dislikes",
	dislike: "dislikes",
	preference: "preference",
	preferences: "preference",
	style: "preference",
	communication_style: "preference",
	timezone: "timezone",
	time_zone: "timezone",
	birthday: "birthday",
	date_of_birth: "birthday",
	dob: "birthday",
	goal: "goal",
	goals: "goal",
	education: "education",
	school: "education",
	college: "education",
	university: "education",
	degree: "education",
};

const canonicalizeMemoryKey = (rawKey) => {
	const normalizedKey = normalizeMemoryKey(rawKey);

	if (!normalizedKey) {
		return "";
	}

	if (LOCATION_KEY_PATTERN.test(normalizedKey)) {
		return "location";
	}

	return MEMORY_KEY_ALIASES[normalizedKey] || normalizedKey;
};

const resolveMemoryExpiry = (key) => {
	const ttlDays = VOLATILE_MEMORY_TTL_DAYS[canonicalizeMemoryKey(key)];

	if (!Number.isFinite(ttlDays)) {
		return null;
	}

	return new Date(Date.now() + (ttlDays * 24 * 60 * 60 * 1000));
};

const getLocationSpecificity = (value) => {
	const normalized = normalizeText(value);

	if (!normalized) {
		return 0;
	}

	const segmentCount = normalized.split(",").map((part) => part.trim()).filter(Boolean).length;
	const wordCount = normalized.split(/\s+/).filter(Boolean).length;

	return (segmentCount * 10) + wordCount;
};

const isValidUserId = (value) => mongoose.Types.ObjectId.isValid(String(value ?? ""));

// Strictly stronger than before: every original trigger is retained, plus long
// digit runs that look like an account, card or ID number.
const isSensitiveText = (text) => {
	const normalized = normalizeText(text);

	if (/(password|otp|pin|secret|bank|card|cvv|ssn|passcode|security\s*code)/i.test(normalized)) {
		return true;
	}

	if (/\b\d[\d\s-]{10,}\b/.test(normalized)) {
		return true;
	}

	return /\b(aadhaar|aadhar|passport\s*(?:no|number)|account\s*(?:no|number)|routing\s*number|api[_\s-]?key|access\s*token|private\s*key)\b/i.test(normalized);
};

const titleCaseWords = (value) => normalizeText(value)
	.split(/\s+/)
	.filter(Boolean)
	.map((word) => (word.length <= 3 && word === word.toUpperCase() ? word : word.charAt(0).toUpperCase() + word.slice(1)))
	.join(" ");

/* ------------------------------------------------------------------------- *
 * Clause analysis. This is what stops a single "?" from throwing away a real
 * disclosure such as "I live in Kolkata, do you know it?".
 * ------------------------------------------------------------------------- */

const INTERROGATIVE_START = /^(what|whats|what's|who|whos|who's|whom|whose|when|where|why|how|which|is|are|am|was|were|do|does|did|can|could|will|would|should|shall|may|might|must|have|has|had|please|tell|give|show|explain|write|make|create|find|search|list|summarize|translate|calculate|generate|help|let)\b/i;

const FIRST_PERSON_DECLARATIVE = /\b(i|i'm|im|my|mine|me)\b/i;

// Tag questions ("..., do you know it?") are their own clause, otherwise the
// question text gets swallowed into the fact captured from the first half.
const CLAUSE_SPLIT_PATTERN = /(?<=[.!?;])\s+|,\s+(?=(?:do|does|did|is|are|am|was|were|can|could|will|would|shall|should|have|has|had|what|who|when|where|why|how|which|tell|please|right|correct|okay|ok|yeah|yes|no)\b)|\s*(?:,\s*)?\b(?:but|however|although|though|and also)\b\s*|\s*\|\s*|\n+/i;

const splitClauses = (text) => normalizeText(text)
	.replace(/\s+/g, " ")
	.split(CLAUSE_SPLIT_PATTERN)
	.map((clause) => clause.trim())
	.filter(Boolean);

const isInterrogativeClause = (clause) => {
	const normalized = normalizeText(clause);

	if (!normalized) {
		return true;
	}

	if (INTERROGATIVE_START.test(normalized)) {
		return true;
	}

	// A trailing "?" only makes the clause a question when nothing in it is a
	// first-person statement of fact.
	return /\?\s*$/.test(normalized) && !FIRST_PERSON_DECLARATIVE.test(normalized);
};

// Kept for backward compatibility: true only when the WHOLE message is a
// question or command, i.e. when no declarative clause survives.
const isLikelyQuestionOrCommand = (text) => {
	const clauses = splitClauses(text);

	if (!clauses.length) {
		return true;
	}

	return clauses.every(isInterrogativeClause);
};

const extractDeclarativeText = (text) => splitClauses(text)
	.filter((clause) => !isInterrogativeClause(clause))
	.join(" ")
	.trim();

// A denial is about a previously stated fact ("that's not right", "I never said").
// A plain negated preference ("I don't like Java") is NOT a denial - it is a
// dislike, and the rule extractor below stores it as one.
const isLikelyDenialOrCorrection = (text) => {
	const normalized = normalizeText(text).toLowerCase();

	if (/\b(that's not|thats not|that is not|never said|didn't say|did not say|you're wrong|youre wrong|that's wrong|thats wrong|that's incorrect|thats incorrect|not correct|not true|stop saying|i never|actually,? i)\b/.test(normalized)) {
		return true;
	}

	return /\b(wrong|incorrect|mistaken)\b/.test(normalized) && /\b(you|your|it|that|this)\b/.test(normalized);
};

const SELF_DISCLOSURE_PATTERN = /\b(i am|i'm|im |i live|i'?ve lived|i stay|i reside|i moved|i work|i study|i studied|i graduated|i use|i used to|i prefer|i like|i love|i hate|i enjoy|i dislike|i want|i need|i own|i speak|i code|i build|i'?m building|i'?m learning|i'?ve been|i'?ll be|my name|my location|my city|my job|my role|my birthday|my timezone|my goal|my project|my team|my favorite|my favourite|call me|remember that i|note that i)\b/;

// "I don't like X" is still a disclosure - it states a dislike.
const NEGATED_DISCLOSURE_PATTERN = /\bi (?:do not|don'?t|dont|never|can'?t|cannot|won'?t|would not|wouldn'?t)\s+(?:really\s+)?(?:like|love|enjoy|prefer|use|want|need|watch|read|drink|eat|work|live|stand|touch)\b/;

const hasSelfDisclosureSignal = (text) => {
	const normalized = normalizeText(text).toLowerCase();
	return SELF_DISCLOSURE_PATTERN.test(normalized) || NEGATED_DISCLOSURE_PATTERN.test(normalized);
};

/* ------------------------------------------------------------------------- *
 * Deterministic extraction. Most real disclosures are one of a dozen shapes;
 * matching them locally removes a Groq round trip from the common path.
 * ------------------------------------------------------------------------- */

const CLAUSE_BREAKERS = /\b(and|but|so|because|since|which|that|while|however|though|although|when|where|if|also|too|then|plus|as well)\b/i;

// A trailing tag question is not part of the fact.
const TAIL_BREAKERS = /\b(?:do|does|did|is|are|am|was|were|can|could|will|would|shall|should|have|has|had|right|okay|ok|yeah|yes|no|please|tell|let|give|show|explain)\s+(?:you|i|me|it|that|this|we|they|us)\b/i;

const trimCapturedValue = (value, { allowComma = false, maxWords = 6, maxChars = 70 } = {}) => {
	let text = normalizeText(value)
		.replace(/^["'`(\[{\s]+/, "")
		.replace(/["'`)\]}\s]+$/, "");

	if (!text) {
		return "";
	}

	// Cut at the first sentence break.
	const stopIndex = text.search(allowComma ? /[.!?;]/ : /[.!?;,]/);

	if (stopIndex > 0) {
		text = text.slice(0, stopIndex);
	}

	// Cut at the first conjunction, which is where the clause stopped being about
	// this fact.
	const breaker = text.match(CLAUSE_BREAKERS);

	if (breaker && breaker.index > 0) {
		text = text.slice(0, breaker.index);
	}

	const tail = text.match(TAIL_BREAKERS);

	if (tail && tail.index > 0) {
		text = text.slice(0, tail.index);
	}

	text = text
		.replace(/\b(right now|currently|now|these days|at the moment|nowadays|anymore|any more)\b/gi, " ")
		.replace(/\s+/g, " ")
		.replace(/[\s,.;:-]+$/, "")
		.trim();

	if (allowComma) {
		const segments = text.split(",").map((part) => part.trim()).filter(Boolean).slice(0, 2);
		text = segments.join(", ");
	}

	const words = text.split(/\s+/).filter(Boolean).slice(0, maxWords);
	return words.join(" ").slice(0, maxChars).trim();
};

const NEGATION_WINDOW = /\b(not|never|no longer|dont|don't|doesnt|doesn't|didnt|didn't|isnt|isn't|wasnt|wasn't|arent|aren't|cant|can't|wont|won't|hardly|barely)\b[^.!?]{0,18}$/i;

const NEGATION_WORD = /\b(not|never|no longer|dont|don't|doesnt|doesn't|didnt|didn't|isnt|isn't|cant|can't|cannot|wont|won't|wouldnt|wouldn't|hardly|barely)\b/i;

const hasNegationBefore = (text, index) => NEGATION_WINDOW.test(String(text ?? "").slice(Math.max(0, index - 40), index));

// The negation can also sit inside the match itself ("I don't like X"), between
// the subject and the verb the pattern anchored on.
const hasNegationInMatch = (match) => {
	const whole = String(match?.[0] ?? "");
	const captured = String(match?.[1] ?? "");
	const captureStart = captured ? whole.indexOf(captured) : -1;
	const prefix = captureStart > 0 ? whole.slice(0, captureStart) : "";

	return Boolean(prefix) && NEGATION_WORD.test(prefix);
};

const PLACE_REJECT = /^(here|there|a|an|the|this|that|it|home|somewhere|anywhere|india|world|earth|city|town|place|country|state|my|your|his|her|their|our|peace|trouble|love|hope|fear|debt|charge|touch|contact|need|order|time|line|person|people|general|fact|case|future|past|way|process|progress|charge)$/i;

const isPlausiblePlace = (value) => {
	const text = normalizeText(value);

	if (text.length < 3 || text.length > 60) {
		return false;
	}

	if (PLACE_REJECT.test(text)) {
		return false;
	}

	if (/\d/.test(text)) {
		return false;
	}

	// A real place name is written with at least one capitalised word.
	return /(^|\s)[A-Z][\p{L}'-]{2,}/u.test(text);
};

const NAME_REJECT = /^(sorry|sure|fine|ok|okay|good|great|glad|happy|sad|tired|busy|here|there|back|done|new|old|working|trying|using|going|looking|asking|wondering|confused|curious|interested|not|a|an|the|just|still|really|very|so|too|also|from|in|on|at|with|about|user|human|developer|engineer|student|teacher|indian|bengali)$/i;

const isPlausibleName = (value) => {
	const text = normalizeText(value);

	if (text.length < 2 || text.length > 40) {
		return false;
	}

	const words = text.split(/\s+/);

	if (words.length > 3) {
		return false;
	}

	if (words.some((word) => NAME_REJECT.test(word))) {
		return false;
	}

	return words.every((word) => /^[A-Z][\p{L}.'-]{1,}$/u.test(word));
};

// Each rule owns its key, how confident a literal match makes us, and how the
// captured value is turned into user-facing memory text.
const EXTRACTION_RULES = [
	{
		key: "name",
		type: "fact",
		importance: 5,
		confidence: 0.95,
		negationDrops: true,
		captureOptions: { maxWords: 3, maxChars: 40 },
		validate: isPlausibleName,
		format: (value) => `User's name is ${titleCaseWords(value)}`,
		patterns: [
			/\bmy name is\s+(.{2,50})/i,
			/\b(?:you can |please |just )?call me\s+(.{2,50})/i,
			/\bi(?:'m| am) called\s+(.{2,50})/i,
			/\bmy (?:preferred |nick)?name(?:'s| is)\s+(.{2,50})/i,
		],
	},
	{
		// 0.88 clears the 0.85 floor but stays below 0.9, so the specificity guard
		// still applies. Only the explicit correction flow writes >= 0.9.
		key: "location",
		type: "fact",
		importance: 4,
		confidence: 0.88,
		negationDrops: true,
		captureOptions: { allowComma: true, maxWords: 6, maxChars: 60 },
		validate: isPlausiblePlace,
		format: (value) => `Lives in ${value}`,
		patterns: [
			/\bi live in\s+(.{3,70})/i,
			/\bi(?:'m| am) (?:living|staying|based|situated) in\s+(.{3,70})/i,
			/\bi reside in\s+(.{3,70})/i,
			/\bi(?:'m| am) from\s+(.{3,70})/i,
			/\bi(?:'ve| have) (?:just )?moved to\s+(.{3,70})/i,
			/\bmy (?:home ?town|city|location|address|place) is\s+(.{3,70})/i,
			/\b[Ii](?:'m| am) (?:currently )?in\s+([A-Z].{2,60})/,
		],
	},
	{
		key: "occupation",
		type: "fact",
		importance: 4,
		confidence: 0.85,
		negationDrops: true,
		captureOptions: { maxWords: 6, maxChars: 60 },
		format: (value) => `Works as ${value}`,
		patterns: [
			/\bi work as (?:a |an |the )?(.{3,60})/i,
			/\bi(?:'m| am) (?:a|an) ((?:senior |junior |lead |chief |full[- ]?stack |front[- ]?end |back[- ]?end )?(?:software |web |data |mechanical |civil |electrical |devops |cloud |ml |ai )?(?:engineer|developer|programmer|designer|analyst|scientist|teacher|professor|lawyer|doctor|accountant|manager|consultant|founder|student|researcher|architect|administrator|technician|writer|editor|marketer)\b.{0,30})/i,
			/\bmy (?:job|role|profession|designation) is\s+(.{3,60})/i,
			/\bi(?:'m| am) (?:working|employed) as (?:a |an )?(.{3,60})/i,
		],
	},
	{
		key: "employer",
		type: "fact",
		importance: 3,
		confidence: 0.82,
		negationDrops: true,
		captureOptions: { maxWords: 5, maxChars: 50 },
		validate: (value) => /[A-Za-z]{3,}/.test(value) && !/^(home|remote|office|a|an|the)$/i.test(value),
		format: (value) => `Works at ${value}`,
		patterns: [
			/\bi work (?:at|for)\s+(.{2,60})/i,
			/\bi(?:'m| am) (?:employed|working) (?:at|for|with)\s+(.{2,60})/i,
		],
	},
	{
		key: "education",
		type: "fact",
		importance: 3,
		confidence: 0.82,
		negationDrops: true,
		captureOptions: { maxWords: 8, maxChars: 70 },
		format: (value) => `Studies ${value}`,
		patterns: [
			/\bi(?:'m| am) (?:a )?studying\s+(.{3,70})/i,
			/\bi study\s+(.{3,70})/i,
			/\bi(?:'m| am) doing (?:my )?(.{3,70})/i,
			/\bi graduated (?:in|from|with)\s+(.{3,70})/i,
			/\bmy (?:degree|major|course|branch|stream) is\s+(.{3,70})/i,
		],
	},
	{
		key: "learning",
		type: "context",
		importance: 3,
		confidence: 0.8,
		negationDrops: true,
		captureOptions: { maxWords: 8, maxChars: 70 },
		format: (value) => `Currently learning ${value}`,
		patterns: [
			/\bi(?:'m| am) learning\s+(.{2,70})/i,
			/\bi(?:'ve| have) been learning\s+(.{2,70})/i,
			/\bi(?:'m| am) trying to learn\s+(.{2,70})/i,
			/\bi want to learn\s+(.{2,70})/i,
		],
	},
	{
		key: "current_project",
		type: "context",
		importance: 3,
		confidence: 0.8,
		negationDrops: true,
		captureOptions: { maxWords: 10, maxChars: 80 },
		format: (value) => `Working on ${value}`,
		patterns: [
			/\bi(?:'m| am) (?:currently )?(?:building|developing|creating|making)\s+(.{3,80})/i,
			/\bi(?:'m| am) working on\s+(.{3,80})/i,
			/\bmy (?:current )?project is\s+(.{3,80})/i,
		],
	},
	{
		key: "favorite_language",
		type: "preference",
		importance: 3,
		confidence: 0.85,
		negationDrops: true,
		captureOptions: { maxWords: 4, maxChars: 40 },
		format: (value) => `Prefers ${value}`,
		patterns: [
			/\bmy favou?rite (?:programming |coding )?language is\s+(.{2,40})/i,
			/\bi (?:mostly |mainly |usually )?code in\s+(.{2,40})/i,
			/\bi (?:mostly |mainly |usually )?write\s+(javascript|typescript|python|java|c\+\+|c#|go|golang|rust|php|ruby|kotlin|swift|dart|sql|bash)\b/i,
		],
	},
	{
		key: "tech_stack",
		type: "preference",
		importance: 3,
		confidence: 0.78,
		negationDrops: true,
		captureOptions: { maxWords: 8, maxChars: 70 },
		format: (value) => `Uses ${value}`,
		patterns: [
			/\bi (?:mostly |mainly |usually |always )?use\s+(.{2,70})/i,
			/\bmy (?:tech )?stack is\s+(.{2,70})/i,
			/\bi work with\s+(react|node|express|mongodb|mongoose|next\.?js|vue|angular|django|flask|spring|laravel|postgres|mysql|redis|docker|kubernetes)\b.{0,40}/i,
		],
	},
	{
		key: "likes",
		type: "preference",
		importance: 2,
		confidence: 0.75,
		negationKey: "dislikes",
		captureOptions: { maxWords: 8, maxChars: 70 },
		format: (value) => `Likes ${value}`,
		negatedFormat: (value) => `Dislikes ${value}`,
		patterns: [
			/\bi (?:really )?(?:(?:do not|don'?t|dont|never|can'?t|cannot) (?:really )?)?(?:like|love|enjoy|prefer)\s+(?!(?:your |you to )?(?:answers?|replies|responses?)\b)(.{2,70})/i,
			/\bmy favou?rite (?!(?:programming |coding )?language\b)(.{3,70})/i,
		],
	},
	{
		key: "dislikes",
		type: "preference",
		importance: 2,
		confidence: 0.75,
		captureOptions: { maxWords: 8, maxChars: 70 },
		format: (value) => `Dislikes ${value}`,
		patterns: [
			/\bi (?:really )?(?:hate|dislike|can't stand|cannot stand|avoid)\s+(.{2,70})/i,
		],
	},
	{
		key: "preference",
		type: "preference",
		importance: 3,
		confidence: 0.8,
		captureOptions: { maxWords: 14, maxChars: 110 },
		format: (value) => `Prefers that replies ${value}`,
		patterns: [
			/\b(?:always|please) (?:answer|reply|respond|explain|write)\s+(.{3,110})/i,
			/\bi (?:want|prefer) (?:you to |your )?(?:answers?|replies|responses?) (?:to be )?(.{3,110})/i,
			/\bkeep (?:your )?(?:answers?|replies|responses?)\s+(.{3,110})/i,
		],
	},
	{
		key: "timezone",
		type: "fact",
		importance: 2,
		confidence: 0.85,
		captureOptions: { maxWords: 4, maxChars: 40 },
		format: (value) => `Timezone: ${value}`,
		patterns: [
			/\bmy time ?zone is\s+(.{2,40})/i,
			/\b[Ii](?:'m| am) in (?:the )?([A-Z]{2,5}T)\b/,
			/\bi(?:'m| am) on (.{2,30}) time\b/i,
		],
	},
	{
		key: "goal",
		type: "context",
		importance: 3,
		confidence: 0.78,
		negationDrops: true,
		captureOptions: { maxWords: 12, maxChars: 90 },
		format: (value) => `Goal: ${value}`,
		patterns: [
			/\bmy goal is (?:to )?(.{3,90})/i,
			/\bi want to become (?:a |an )?(.{3,90})/i,
			/\bi(?:'m| am) preparing for\s+(.{3,90})/i,
		],
	},
	{
		key: "mood",
		type: "context",
		importance: 1,
		confidence: 0.55,
		captureOptions: { maxWords: 3, maxChars: 30 },
		format: (value) => `Currently feeling ${value.toLowerCase()}`,
		patterns: [
			/\bi(?:'m| am) (?:feeling )?(exhausted|tired|frustrated|stressed|anxious|excited|happy|sad|angry|bored|confused|overwhelmed|motivated|relieved)\b/i,
			/\bi feel (exhausted|tired|frustrated|stressed|anxious|excited|happy|sad|angry|bored|confused|overwhelmed|motivated|relieved)\b/i,
		],
	},
];

const extractMemoryLocally = (message) => {
	const declarative = extractDeclarativeText(message);

	if (!declarative) {
		return [];
	}

	const found = new Map();

	for (const rule of EXTRACTION_RULES) {
		for (const pattern of rule.patterns) {
			const match = declarative.match(pattern);

			if (!match || !match[1]) {
				continue;
			}

			const negated = hasNegationBefore(declarative, match.index) || hasNegationInMatch(match);

			if (negated && rule.negationDrops) {
				continue;
			}

			if (negated && !rule.negationKey) {
				continue;
			}

			const value = trimCapturedValue(match[1], rule.captureOptions);

			if (!value) {
				continue;
			}

			if (typeof rule.validate === "function" && !rule.validate(value)) {
				continue;
			}

			const key = negated && rule.negationKey ? rule.negationKey : rule.key;
			const content = negated && typeof rule.negatedFormat === "function"
				? rule.negatedFormat(value)
				: rule.format(value);

			if (!content || isSensitiveText(content)) {
				continue;
			}

			// First matching pattern for a key wins; earlier patterns are the more
			// explicit ones.
			if (!found.has(key)) {
				found.set(key, {
					type: rule.type,
					key,
					content,
					value: content,
					confidence: rule.confidence,
					importance: rule.importance,
					extractedBy: "rule",
				});
			}

			break;
		}
	}

	return [...found.values()];
};

/* ------------------------------------------------------------------------- *
 * LLM extraction (fallback for anything the rules did not catch)
 * ------------------------------------------------------------------------- */

const buildMemoryExtractionPrompt = (message) => [
	"Extract only stable long-term user memories from the message.",
	"Return only valid JSON. No markdown. No explanation.",
	"Capture preferences, facts, behaviors, and context that would help personalize future replies.",
	"CRITICAL: Only extract a fact if the user explicitly and unambiguously stated it about themselves in this exact message.",
	"Do NOT infer, guess, assume, or default a location, name, or any personal fact from tone, phrasing, IP, timezone, or general knowledge.",
	"Do NOT extract anything from questions the user is asking, or from messages where the user is denying, correcting, or disputing a fact.",
	"If the message contains no explicit first-person statement of fact, return an empty memories array.",
	"Do not invent details. Do not store transient chit-chat, one-off tasks, or sensitive data.",
	"Prefer concise keys such as favorite_language, tech_stack, learning, location, occupation, preference.",
	"Use content for the user-facing memory text and keep key as a compact identifier.",
	"Only set key to 'location' if the user explicitly named a real place they live, work, or are from (e.g. 'I live in Kolkata'). Never guess a location.",
	"Set confidence to how literally the message states the fact: 0.9+ only for an explicit first-person statement, 0.6 or lower for anything implied.",
	"Ignore code blocks, pasted logs, and quoted text; they are not statements about the user.",
	"Schema:",
	'{"memories":[{"type":"preference|fact|behavior|context","key":"string","content":"string","confidence":0.0,"importance":1}]}',
	`Message: ${JSON.stringify(normalizeText(message))}`,
].join("\n");

const buildMemoryExtractionRequest = (message) => ({
	method: "post",
	url: "https://api.groq.com/openai/v1/chat/completions",
	headers: {
		Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
		"Content-Type": "application/json",
	},
	data: {
		model: MEMORY_MODEL,
		messages: [
			{
				role: "system",
				content: "You extract structured long-term memories from user messages and output only valid JSON.",
			},
			{
				role: "user",
				content: buildMemoryExtractionPrompt(message),
			},
		],
		temperature: 0,
		max_tokens: 220,
		response_format: { type: "json_object" },
	},
	timeout: MEMORY_TIMEOUT_MS,
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const resolveRetryAfterMs = (error) => {
	const header = error?.response?.headers?.["retry-after"] ?? error?.response?.headers?.["Retry-After"];
	const seconds = Number(header);

	if (Number.isFinite(seconds) && seconds > 0) {
		return Math.min(4000, seconds * 1000);
	}

	return 0;
};

// Retrying a 400/401/403/404 cannot help and burns quota on a free tier.
const isRetryableMemoryError = (error) => {
	const status = Number(error?.response?.status);

	if (!Number.isFinite(status)) {
		return true;
	}

	return status === 408 || status === 409 || status === 429 || status >= 500;
};

const requestWithRetry = async (requestFactory) => {
	let lastError;

	for (let attempt = 1; attempt <= MEMORY_MAX_ATTEMPTS; attempt += 1) {
		try {
			return await axios(requestFactory());
		} catch (error) {
			lastError = error;

			if (!isRetryableMemoryError(error)) {
				break;
			}

			if (attempt < MEMORY_MAX_ATTEMPTS) {
				await delay(resolveRetryAfterMs(error) || (150 * attempt));
			}
		}
	}

	throw lastError;
};

const stripCodeFences = (value) => String(value ?? "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

const safeJsonParse = (value) => {
	const cleanedValue = stripCodeFences(value);

	if (!cleanedValue) {
		return null;
	}

	try {
		return JSON.parse(cleanedValue);
	} catch {
		const match = cleanedValue.match(/\{[\s\S]*\}/);

		if (!match) {
			return null;
		}

		try {
			return JSON.parse(match[0]);
		} catch {
			return null;
		}
	}
};

const deriveMemoryKey = (memory = {}) => {
	const rawKey = normalizeText(memory?.key);

	if (rawKey) {
		return canonicalizeMemoryKey(rawKey);
	}

	const content = normalizeText(memory?.content || memory?.value);

	if (!content) {
		return "";
	}

	return canonicalizeMemoryKey(content.split(/\s+/).slice(0, 4).join("_"));
};

const normalizeExtractedMemory = (memory) => {
	const type = ["preference", "fact", "behavior", "context"].includes(normalizeText(memory?.type).toLowerCase())
		? normalizeText(memory.type).toLowerCase()
		: "fact";
	const content = normalizeText(memory?.content || memory?.value);
	const key = deriveMemoryKey({ key: memory?.key, content });
	const confidenceNumber = Number(memory?.confidence);
	const importanceNumber = Number(memory?.importance);

	if (!key || !content || isSensitiveText(content)) {
		return null;
	}

	let confidence = Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(1, confidenceNumber)) : 0.7;

	// A model-claimed location never gets to bypass the specificity guard in
	// saveMemory; only the explicit correction flow writes >= 0.9 directly.
	if (key === "location" && memory?.extractedBy !== "rule") {
		confidence = Math.min(confidence, 0.88);
	}

	return {
		type,
		key,
		content,
		value: content,
		confidence,
		importance: Number.isFinite(importanceNumber) ? Math.max(1, Math.min(5, importanceNumber)) : 1,
		extractedBy: memory?.extractedBy || "llm",
	};
};

// Pasted code and logs are not statements about the user, and they are the most
// common source of junk memories.
const looksLikePastedContent = (text) => {
	const normalized = String(text ?? "");

	if (/```/.test(normalized)) {
		return true;
	}

	if (normalized.split("\n").length > 8) {
		return true;
	}

	return /[{};]\s*$/m.test(normalized) && /\b(const|let|var|function|=>|import|require|class|def|public|private)\b/.test(normalized);
};

const extractMemory = async (message, options = {}) => {
	const normalizedMessage = normalizeText(message);

	if (!normalizedMessage || isSensitiveText(normalizedMessage)) {
		return [];
	}

	if (isLikelyDenialOrCorrection(normalizedMessage)) {
		return [];
	}

	const declarative = extractDeclarativeText(normalizedMessage);

	if (!declarative || !hasSelfDisclosureSignal(declarative)) {
		return [];
	}

	// Free work first.
	const localMemories = extractMemoryLocally(declarative)
		.map(normalizeExtractedMemory)
		.filter(Boolean);

	const pasted = looksLikePastedContent(normalizedMessage);
	const tooLong = declarative.length > MEMORY_EXTRACTION_MAX_CHARS;
	const llmAllowed = MEMORY_LLM_EXTRACTION
		&& options?.useLlm !== false
		&& Boolean(process.env.GROQ_API_KEY)
		&& !pasted
		&& !tooLong;

	// A clean single-fact disclosure is fully handled by the rules, so no call.
	const localIsSufficient = localMemories.length > 0
		&& declarative.length <= 180
		&& splitClauses(declarative).length <= 2;

	if (!llmAllowed || localIsSufficient) {
		if (MEMORY_DEBUG) {
			logger.log(`[memory] extract source=rule keys=${localMemories.map((entry) => entry.key).join(",") || "-"} llm=skipped`);
		}

		return localMemories;
	}

	let llmMemories = [];

	try {
		const response = await requestWithRetry(() => buildMemoryExtractionRequest(declarative.slice(0, MEMORY_EXTRACTION_MAX_CHARS)));
		const content = response.data?.choices?.[0]?.message?.content || "";
		const parsed = safeJsonParse(content);
		const rawMemories = Array.isArray(parsed?.memories)
			? parsed.memories
			: Array.isArray(parsed?.memory)
				? parsed.memory
				: [];

		llmMemories = rawMemories
			.map((entry) => normalizeExtractedMemory({ ...entry, extractedBy: "llm" }))
			.filter(Boolean);
	} catch (error) {
		if (MEMORY_DEBUG) {
			logger.warn(`[memory] extract llm failed reason=${error?.response?.status || error?.code || error?.message || "unknown"}`);
		}

		llmMemories = [];
	}

	// The rules read the literal text, so on a key collision they win.
	const merged = new Map();

	for (const memory of llmMemories) {
		merged.set(memory.key, memory);
	}

	for (const memory of localMemories) {
		merged.set(memory.key, memory);
	}

	const result = [...merged.values()];

	if (MEMORY_DEBUG) {
		logger.log(`[memory] extract source=rule+llm keys=${result.map((entry) => entry.key).join(",") || "-"}`);
	}

	return result;
};

/* ------------------------------------------------------------------------- *
 * Vector + cache helpers
 * ------------------------------------------------------------------------- */

const cosineSimilarity = (left, right) => {
	if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) {
		return 0;
	}

	const length = Math.min(left.length, right.length);
	let dotProduct = 0;
	let leftMagnitude = 0;
	let rightMagnitude = 0;

	for (let index = 0; index < length; index += 1) {
		const leftValue = Number(left[index]) || 0;
		const rightValue = Number(right[index]) || 0;

		dotProduct += leftValue * rightValue;
		leftMagnitude += leftValue * leftValue;
		rightMagnitude += rightValue * rightValue;
	}

	if (!leftMagnitude || !rightMagnitude) {
		return 0;
	}

	return dotProduct / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
};

const candidateCache = new Map();
const queryEmbeddingCache = new Map();

const readCache = (store, key) => {
	const entry = store.get(key);

	if (!entry) {
		return undefined;
	}

	if (entry.expiresAt <= Date.now()) {
		store.delete(key);
		return undefined;
	}

	return entry.value;
};

const writeCache = (store, key, value, ttlMs) => {
	if (!key || !Number.isFinite(ttlMs) || ttlMs <= 0) {
		return value;
	}

	store.set(key, { value, expiresAt: Date.now() + ttlMs });

	while (store.size > 200) {
		const oldest = store.keys().next();

		if (oldest.done) {
			break;
		}

		store.delete(oldest.value);
	}

	return value;
};

const invalidateUserMemoryCache = (userId) => {
	candidateCache.delete(String(userId ?? ""));
	return true;
};

const embedText = async (text) => {
	const normalized = normalizeText(text);

	if (!normalized) {
		return [];
	}

	const cacheKey = normalized.slice(0, 300).toLowerCase();
	const cached = readCache(queryEmbeddingCache, cacheKey);

	if (cached !== undefined) {
		return cached;
	}

	try {
		const embedding = await createEmbedding(normalized);
		const safeEmbedding = Array.isArray(embedding) ? embedding : [];
		return writeCache(queryEmbeddingCache, cacheKey, safeEmbedding, MEMORY_QUERY_EMBED_CACHE_TTL_MS);
	} catch {
		return [];
	}
};

/* ------------------------------------------------------------------------- *
 * Writes
 * ------------------------------------------------------------------------- */

// Keys that hold exactly one current value. Everything else may accumulate.
const SINGLE_VALUE_KEYS = new Set([
	"name", "location", "occupation", "employer", "timezone", "birthday",
	"mood", "current_project", "current_task", "education", "goal",
	"favorite_language",
]);

const MULTI_VALUE_KEYS = new Set(["likes", "dislikes", "tech_stack", "preference", "learning", "skills"]);

const MULTI_VALUE_MAX_CHARS = 320;

const mergeMultiValueContent = (existingContent, incomingContent) => {
	const existing = normalizeText(existingContent);
	const incoming = normalizeText(incomingContent);

	if (!existing) {
		return incoming;
	}

	if (!incoming) {
		return existing;
	}

	const parts = existing.split(/\s*;\s*/).map((part) => part.trim()).filter(Boolean);
	const fingerprints = new Set(parts.map((part) => part.toLowerCase()));

	if (fingerprints.has(incoming.toLowerCase())) {
		return existing;
	}

	// Skip an addition already implied by an existing entry.
	for (const part of parts) {
		if (part.toLowerCase().includes(incoming.toLowerCase()) || incoming.toLowerCase().includes(part.toLowerCase())) {
			return existing.length >= incoming.length ? existing : incoming;
		}
	}

	parts.push(incoming);

	while (parts.join("; ").length > MULTI_VALUE_MAX_CHARS && parts.length > 1) {
		parts.shift();
	}

	return parts.join("; ");
};

const resolveMinimumConfidence = (key) => {
	if (key === "location") {
		return 0.85;
	}

	if (key === "name") {
		return 0.8;
	}

	if (key === "mood") {
		return 0.4;
	}

	return 0.5;
};

// Generalises what used to exist only for location: a vaguer or less confident
// value must never silently replace a better one.
const resolveWriteDecision = (key, existing, incoming) => {
	if (!existing) {
		return { action: "insert", content: incoming.content, confidence: incoming.confidence };
	}

	const existingContent = normalizeText(existing.content || existing.value);
	const existingConfidence = Number.isFinite(Number(existing.confidence)) ? Number(existing.confidence) : 0.5;

	if (existingContent.toLowerCase() === incoming.content.toLowerCase()) {
		// Same fact restated: reinforce it rather than rewriting it.
		return {
			action: "reinforce",
			content: existingContent,
			confidence: Math.min(1, Math.max(existingConfidence, incoming.confidence) + 0.03),
		};
	}

	if (key === "location" && incoming.confidence < 0.9) {
		if (getLocationSpecificity(existingContent) >= getLocationSpecificity(incoming.content)) {
			return { action: "skip", reason: "less_specific_location" };
		}
	}

	if (MULTI_VALUE_KEYS.has(key)) {
		const mergedContent = mergeMultiValueContent(existingContent, incoming.content);

		if (mergedContent === existingContent) {
			return { action: "skip", reason: "already_known" };
		}

		return { action: "merge", content: mergedContent, confidence: Math.max(existingConfidence, incoming.confidence) };
	}

	if (SINGLE_VALUE_KEYS.has(key) && incoming.confidence + 0.1 < existingConfidence) {
		return { action: "skip", reason: "weaker_than_stored" };
	}

	return { action: "supersede", content: incoming.content, confidence: incoming.confidence };
};

const buildMemorySetDocument = ({ content, embedding, type, confidence, importance, source, key }) => ({
	content,
	value: content,
	embedding: Array.isArray(embedding) ? embedding : [],
	type: ["preference", "fact", "behavior", "context"].includes(type) ? type : "fact",
	confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
	importance: Number.isFinite(Number(importance)) ? Math.max(1, Math.min(5, Number(importance))) : 1,
	source,
	expiresAt: resolveMemoryExpiry(key),
	lastUsedAt: new Date(),
});

const saveMemory = async (userId, memories = [], sourceMessage = "") => {
	if (!isValidUserId(userId) || !Array.isArray(memories) || memories.length === 0) {
		return [];
	}

	const normalizedUserId = new mongoose.Types.ObjectId(String(userId));
	const normalizedSource = normalizeText(sourceMessage).slice(0, 500);

	// One pass to clean and collapse the batch before touching the database.
	const staged = new Map();

	for (const memory of memories) {
		const key = canonicalizeMemoryKey(memory?.key);
		const content = normalizeText(memory?.content || memory?.value);
		const confidence = Number.isFinite(Number(memory?.confidence)) ? Number(memory.confidence) : 0.7;

		if (!key || !content || isSensitiveText(content)) {
			continue;
		}

		if (confidence < resolveMinimumConfidence(key)) {
			continue;
		}

		const existingStaged = staged.get(key);

		if (existingStaged && existingStaged.confidence >= confidence) {
			continue;
		}

		staged.set(key, {
			key,
			content,
			confidence: Math.max(0, Math.min(1, confidence)),
			type: memory?.type,
			importance: memory?.importance,
		});
	}

	if (!staged.size) {
		return [];
	}

	const incomingList = [...staged.values()];

	let existingRows = [];

	try {
		existingRows = await Memory.find({ userId: normalizedUserId }).lean();
	} catch {
		existingRows = [];
	}

	const existingByKey = new Map();

	for (const row of Array.isArray(existingRows) ? existingRows : []) {
		const rowKey = canonicalizeMemoryKey(row?.key) || normalizeText(row?.key);

		if (rowKey && !existingByKey.has(rowKey)) {
			existingByKey.set(rowKey, row);
		}
	}

	// Embeddings in parallel instead of one await per memory inside the loop.
	const embeddings = await Promise.all(incomingList.map((entry) => embedText(entry.content)));

	const operations = [];
	const report = [];

	for (const [index, incoming] of incomingList.entries()) {
		const embedding = embeddings[index] || [];
		let targetKey = incoming.key;
		let existing = existingByKey.get(targetKey) || null;

		// Semantic dedupe: if this content already exists under a different key,
		// update that row instead of creating a near-duplicate.
		if (!existing && embedding.length) {
			let bestRow = null;
			let bestSimilarity = 0;

			for (const row of Array.isArray(existingRows) ? existingRows : []) {
				const similarity = cosineSimilarity(embedding, Array.isArray(row?.embedding) ? row.embedding : []);

				if (similarity > bestSimilarity) {
					bestSimilarity = similarity;
					bestRow = row;
				}
			}

			if (bestRow && bestSimilarity >= MEMORY_DEDUPE_SIMILARITY) {
				targetKey = normalizeText(bestRow.key) || targetKey;
				existing = bestRow;
			}
		}

		const decision = resolveWriteDecision(incoming.key, existing, incoming);

		if (decision.action === "skip") {
			report.push({ key: targetKey, action: "skip", reason: decision.reason });
			continue;
		}

		const setDocument = buildMemorySetDocument({
			content: decision.content,
			embedding: decision.content === incoming.content ? embedding : (await embedText(decision.content)),
			type: incoming.type,
			confidence: decision.confidence,
			importance: incoming.importance,
			source: normalizedSource,
			key: incoming.key,
		});

		operations.push({
			updateOne: {
				filter: { userId: normalizedUserId, key: targetKey },
				update: { $set: setDocument },
				upsert: true,
			},
		});

		report.push({ key: targetKey, action: decision.action });
	}

	if (!operations.length) {
		return report;
	}

	// One round trip for the whole batch when the driver supports it.
	try {
		if (typeof Memory.bulkWrite === "function") {
			await Memory.bulkWrite(operations, { ordered: false });
		} else {
			for (const operation of operations) {
				await Memory.findOneAndUpdate(
					operation.updateOne.filter,
					operation.updateOne.update,
					{ upsert: true, new: true, setDefaultsOnInsert: true }
				);
			}
		}
	} catch (error) {
		if (MEMORY_DEBUG) {
			logger.warn(`[memory] save failed reason=${error?.message || "unknown"}`);
		}

		// Fall back to per-row writes so one bad document cannot lose the batch.
		for (const operation of operations) {
			try {
				await Memory.findOneAndUpdate(
					operation.updateOne.filter,
					operation.updateOne.update,
					{ upsert: true, new: true, setDefaultsOnInsert: true }
				);
			} catch {
				continue;
			}
		}
	}

	invalidateUserMemoryCache(userId);

	if (MEMORY_DEBUG) {
		logger.log(`[memory] save ${report.map((entry) => `${entry.key}:${entry.action}`).join(" ")}`);
	}

	return report;
};

const deleteMemoryByKey = async (userId, key) => {
	const normalizedKey = normalizeMemoryKey(key);

	if (!isValidUserId(userId) || !normalizedKey) {
		return false;
	}

	const normalizedUserId = new mongoose.Types.ObjectId(String(userId));
	const canonicalKey = canonicalizeMemoryKey(normalizedKey);
	const keysToDelete = [...new Set([normalizedKey, canonicalKey].filter(Boolean))];

	try {
		const result = await Memory.deleteMany({ userId: normalizedUserId, key: { $in: keysToDelete } });
		invalidateUserMemoryCache(userId);
		return Boolean(result?.deletedCount);
	} catch {
		return false;
	}
};

const deleteLocationMemories = async (userId) => {
	if (!isValidUserId(userId)) {
		return false;
	}

	const normalizedUserId = new mongoose.Types.ObjectId(String(userId));

	try {
		const result = await Memory.deleteMany({
			userId: normalizedUserId,
			$or: [
				{ key: "location" },
				{ key: { $regex: /^(city|place|residence|hometown|home_town|address|region|current_location|user_location|based_in|live_in|living_in|lives_in|from|country|state)$/i } },
			],
		});
		invalidateUserMemoryCache(userId);
		return Boolean(result?.deletedCount);
	} catch {
		return false;
	}
};

const deleteMemoryById = async (userId, memoryId) => {
	if (!isValidUserId(userId) || !mongoose.Types.ObjectId.isValid(String(memoryId ?? ""))) {
		return false;
	}

	const normalizedUserId = new mongoose.Types.ObjectId(String(userId));
	const normalizedMemoryId = new mongoose.Types.ObjectId(String(memoryId));

	try {
		const result = await Memory.deleteOne({ _id: normalizedMemoryId, userId: normalizedUserId });
		invalidateUserMemoryCache(userId);
		return Boolean(result?.deletedCount);
	} catch {
		return false;
	}
};

const listAllMemories = async (userId) => {
	if (!isValidUserId(userId)) {
		return [];
	}

	const normalizedUserId = new mongoose.Types.ObjectId(String(userId));

	const memories = await Memory.find({ userId: normalizedUserId })
		.sort({ lastUsedAt: -1, updatedAt: -1 })
		.lean()
		.catch(() => []);

	return (Array.isArray(memories) ? memories : []).map((memory) => ({
		id: String(memory._id),
		key: memory.key,
		type: memory.type,
		content: memory.content || memory.value,
		confidence: memory.confidence,
		importance: memory.importance,
		source: memory.source || "",
		expiresAt: memory.expiresAt || null,
		lastUsedAt: memory.lastUsedAt || memory.updatedAt || null,
		createdAt: memory.createdAt || null,
	}));
};

/* ------------------------------------------------------------------------- *
 * Retrieval
 * ------------------------------------------------------------------------- */

// Topic synonyms let "where do I live" hit the location row even when the
// embedder is weak, which pure cosine similarity does not reliably do.
const KEY_TOPIC_TERMS = {
	location: ["where", "live", "living", "city", "place", "location", "from", "hometown", "address", "based", "near", "weather", "local"],
	name: ["name", "call", "called", "who am i", "myself"],
	occupation: ["job", "work", "working", "profession", "career", "role", "occupation", "office"],
	employer: ["company", "employer", "office", "firm", "startup", "work"],
	education: ["study", "studying", "college", "school", "university", "degree", "course", "semester", "exam"],
	learning: ["learn", "learning", "study", "practice", "tutorial", "course", "beginner"],
	current_project: ["project", "building", "build", "app", "working on", "feature", "repo"],
	current_task: ["task", "todo", "deadline", "due"],
	favorite_language: ["language", "code", "coding", "programming", "syntax", "script"],
	tech_stack: ["stack", "tool", "tools", "framework", "library", "database", "deploy"],
	likes: ["like", "likes", "love", "enjoy", "favorite", "favourite", "interest", "hobby", "recommend", "suggest"],
	dislikes: ["hate", "dislike", "avoid", "annoy", "prefer not"],
	preference: ["prefer", "style", "format", "tone", "shorter", "longer", "explain", "answer"],
	timezone: ["time", "timezone", "schedule", "clock", "hour", "morning", "evening"],
	birthday: ["birthday", "born", "age", "birth"],
	goal: ["goal", "aim", "target", "plan", "future", "become", "prepare"],
	mood: ["feel", "feeling", "mood", "tired", "stressed", "happy", "sad"],
};

const lexicalOverlapScore = (memory, queryTokens, queryLower) => {
	if (!queryTokens.length) {
		return 0;
	}

	const key = canonicalizeMemoryKey(memory?.key);
	const haystack = `${normalizeText(memory?.key)} ${normalizeText(memory?.content || memory?.value)}`.toLowerCase();

	let hits = 0;

	for (const token of queryTokens) {
		if (haystack.includes(token)) {
			hits += 1;
		}
	}

	let score = hits / queryTokens.length;

	const topicTerms = KEY_TOPIC_TERMS[key];

	if (Array.isArray(topicTerms) && topicTerms.some((term) => queryLower.includes(term))) {
		score = Math.min(1, score + 0.55);
	}

	return score;
};

const tokenizeQuery = (query) => {
	const seen = new Set();
	const tokens = [];

	for (const raw of normalizeText(query).toLowerCase().split(/[^a-z0-9]+/)) {
		if (raw.length < 3 || seen.has(raw)) {
			continue;
		}

		seen.add(raw);
		tokens.push(raw);
	}

	return tokens;
};

const isLiveMemory = (memory, now) => {
	const expiresAt = memory?.expiresAt;

	if (!expiresAt) {
		return true;
	}

	const expiryTime = new Date(expiresAt).getTime();
	return !Number.isFinite(expiryTime) || expiryTime > now;
};

const loadMemoryCandidates = async (userId) => {
	const cacheKey = String(userId);
	const cached = readCache(candidateCache, cacheKey);

	if (cached !== undefined) {
		return cached;
	}

	const userObjectId = new mongoose.Types.ObjectId(String(userId));
	const now = new Date();

	let rows = [];

	try {
		// Expiry filter at the database, so a row whose TTL sweep has not run yet
		// can no longer resurface as a current fact.
		rows = await Memory.find({
			userId: userObjectId,
			$or: [
				{ expiresAt: null },
				{ expiresAt: { $exists: false } },
				{ expiresAt: { $gt: now } },
			],
		})
			.sort({ importance: -1, lastUsedAt: -1, updatedAt: -1 })
			.limit(Math.max(10, MEMORY_CANDIDATE_LIMIT))
			.lean();
	} catch {
		try {
			rows = await Memory.find({ userId: userObjectId }).lean();
		} catch {
			rows = [];
		}
	}

	const live = (Array.isArray(rows) ? rows : []).filter((row) => isLiveMemory(row, Date.now()));
	return writeCache(candidateCache, cacheKey, live, MEMORY_CANDIDATE_CACHE_TTL_MS);
};

const getRelevantMemories = async (userId, query = "", limit = MEMORY_RETRIEVAL_LIMIT) => {
	if (!isValidUserId(userId)) {
		return [];
	}

	const memories = await loadMemoryCandidates(userId);

	if (!memories.length) {
		return [];
	}

	const normalizedLimit = Math.max(1, Number(limit) || MEMORY_RETRIEVAL_LIMIT);
	const normalizedQuery = normalizeText(query);
	const now = Date.now();

	const confidenceFactor = (memory) => {
		const confidence = Number(memory?.confidence);
		return 0.6 + (0.4 * (Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.7));
	};

	const recencyBoost = (memory) => {
		const lastUsedAt = memory?.lastUsedAt || memory?.updatedAt || memory?.createdAt || now;
		const ageHours = Math.max(0, (now - new Date(lastUsedAt).getTime()) / 36e5);
		return 1 / (1 + (ageHours / 24));
	};

	if (!normalizedQuery) {
		return memories
			.map((memory) => ({
				...memory,
				_score: Number((((Number(memory?.importance || 1) / 5) * 0.7) + (recencyBoost(memory) * 0.3)) * confidenceFactor(memory)),
			}))
			.sort((left, right) => right._score - left._score)
			.slice(0, normalizedLimit);
	}

	const queryTokens = tokenizeQuery(normalizedQuery);
	const queryLower = normalizedQuery.toLowerCase();
	const queryEmbedding = await embedText(normalizedQuery);

	const scored = memories.map((memory) => {
		const embedding = Array.isArray(memory?.embedding) ? memory.embedding : [];
		const similarity = queryEmbedding.length ? cosineSimilarity(queryEmbedding, embedding) : 0;
		const lexical = lexicalOverlapScore(memory, queryTokens, queryLower);
		const importance = Math.max(1, Number(memory?.importance || 1));

		// Hybrid: vector similarity alone is unreliable for three-word questions,
		// and lexical alone misses paraphrases. Both vote.
		const base = (similarity * 0.5)
			+ (lexical * 0.28)
			+ ((importance / 5) * 0.14)
			+ (recencyBoost(memory) * 0.08);

		return {
			...memory,
			similarity: Number(similarity.toFixed(4)),
			lexical: Number(lexical.toFixed(4)),
			_score: Number((base * confidenceFactor(memory)).toFixed(4)),
		};
	});

	// A memory below the floor is noise, and injecting noise is how the wrong
	// fact ends up being asserted.
	const filtered = scored.filter((memory) => memory._score >= MEMORY_SCORE_FLOOR);
	const pool = filtered.length ? filtered : scored;

	return pool
		.sort((left, right) => right._score - left._score)
		.slice(0, normalizedLimit);
};

const touchMemories = async (memories = []) => {
	const ids = (Array.isArray(memories) ? memories : [])
		.map((memory) => memory?._id)
		.filter((id) => id && mongoose.Types.ObjectId.isValid(String(id)));

	if (!ids.length) {
		return false;
	}

	try {
		await Memory.updateMany(
			{ _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(String(id))) } },
			{ $set: { lastUsedAt: new Date() } }
		);
		return true;
	} catch {
		return false;
	}
};

/* ------------------------------------------------------------------------- *
 * Formatting
 * ------------------------------------------------------------------------- */

const describeConfidence = (memory) => {
	const confidence = Number(memory?.confidence);
	const value = Number.isFinite(confidence) ? confidence : 0.7;

	if (value >= 0.9) {
		return "confirmed";
	}

	if (value >= 0.75) {
		return "likely";
	}

	return "unconfirmed - ask before relying on it";
};

const formatMemoryContext = (memories) => {
	if (!Array.isArray(memories) || memories.length === 0) {
		return "";
	}

	const lines = [];
	let used = 0;

	for (const memory of memories) {
		const content = normalizeText(memory?.content || memory?.value);

		if (!content) {
			continue;
		}

		const label = normalizeText(memory?.key) || normalizeText(memory?.type) || "memory";
		// The confidence tag is the fix for facts being asserted as certain when
		// they were only inferred.
		const line = `- ${label}: ${content} (${describeConfidence(memory)})`;

		if (used + line.length + 1 > MEMORY_CONTEXT_CHAR_BUDGET && lines.length) {
			break;
		}

		lines.push(line);
		used += line.length + 1;
	}

	if (!lines.length) {
		return "";
	}

	return [
		"Known facts about this user (use only when relevant; never state anything not listed here):",
		...lines,
		"If a fact is marked unconfirmed, ask instead of asserting it. If the user corrects a fact, trust the correction.",
	].join("\n");
};

const formatShortTermConversation = (conversation = [], limit = SHORT_TERM_MESSAGE_LIMIT) => {
	if (!Array.isArray(conversation) || conversation.length === 0) {
		return "";
	}

	const window = conversation.slice(-Math.max(1, Number(limit) || SHORT_TERM_MESSAGE_LIMIT));
	const rendered = [];
	let used = 0;

	// Walk backwards so that when the budget runs out it is the oldest turn that
	// gets dropped, not the most recent one.
	for (let index = window.length - 1; index >= 0; index -= 1) {
		const entry = window[index];
		const role = normalizeText(entry?.role).toLowerCase();
		const content = normalizeText(entry?.content);

		if (!content) {
			continue;
		}

		const clipped = content.length > SHORT_TERM_MESSAGE_CHARS
			? `${content.slice(0, SHORT_TERM_MESSAGE_CHARS).trim()}… [truncated]`
			: content;

		const label = role === "assistant" ? "Assistant" : role === "system" ? "System" : "User";
		const line = `${index + 1}. ${label}: ${clipped}`;

		if (used + line.length + 1 > SHORT_TERM_TOTAL_CHARS && rendered.length) {
			break;
		}

		rendered.push(line);
		used += line.length + 1;
	}

	return rendered.reverse().join("\n");
};

const buildMemoryLayerContext = async ({ userId, query = "", conversation = [], limit = MEMORY_RETRIEVAL_LIMIT } = {}) => {
	const shortTerm = formatShortTermConversation(conversation);
	const semanticMemories = await getRelevantMemories(userId, query, limit).catch(() => []);
	const semantic = formatMemoryContext(semanticMemories);

	// Reinforce what was actually used, so the recency term in retrieval means
	// something. Fire and forget: a failed touch must never fail a chat turn.
	if (semanticMemories.length) {
		touchMemories(semanticMemories).catch(() => false);
	}

	const facts = {};

	for (const memory of semanticMemories) {
		const key = canonicalizeMemoryKey(memory?.key);
		const content = normalizeText(memory?.content || memory?.value);

		if (key && content && !facts[key]) {
			facts[key] = content;
		}
	}

	return {
		shortTerm,
		longTerm: semantic,
		semantic,
		memories: semanticMemories,
		// Additive: nothing existing reads these.
		facts,
		confidenceByKey: semanticMemories.reduce((accumulator, memory) => {
			const key = canonicalizeMemoryKey(memory?.key);

			if (key && accumulator[key] === undefined) {
				accumulator[key] = Number(memory?.confidence) || 0;
			}

			return accumulator;
		}, {}),
	};
};

module.exports = {
	extractMemory,
	saveMemory,
	getRelevantMemories,
	formatMemoryContext,
	formatShortTermConversation,
	buildMemoryLayerContext,
	deleteMemoryByKey,
	deleteLocationMemories,
	// Previously defined but never exported, so unreachable from routes.
	deleteMemoryById,
	listAllMemories,
	// Additive helpers.
	extractMemoryLocally,
	canonicalizeMemoryKey,
	normalizeExtractedMemory,
	isSensitiveText,
	isLikelyQuestionOrCommand,
	isLikelyDenialOrCorrection,
	hasSelfDisclosureSignal,
	cosineSimilarity,
	touchMemories,
	invalidateUserMemoryCache,
};