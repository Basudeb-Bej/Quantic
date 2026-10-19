//back-end/brain/responsePlanner.js
const axios = require("axios");
const { classifyIntent } = require("./intentClassifier.js");

const PLANNER_MODEL = process.env.GROQ_PLANNER_MODEL || process.env.GROQ_FAST_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const PLANNER_TIMEOUT_MS = Number(process.env.GROQ_PLANNER_TIMEOUT_MS || 12000);
const PLANNER_MAX_ATTEMPTS = Number(process.env.GROQ_PLANNER_MAX_ATTEMPTS || 2);

const ALLOWED_INTENTS = new Set(["general", "coding", "realtime", "personal"]);
const ALLOWED_TOOLS = new Set(["weather", "none", "calculator", "system"]);

const normalizeText = (value) => String(value ?? "").trim();

const normalizeConversation = (conversation = []) => {
	if (!Array.isArray(conversation)) {
		return [];
	}

	return conversation
		.slice(-8)
		.map((entry) => ({
			role: normalizeText(entry?.role),
			content: normalizeText(entry?.content),
		}))
		.filter((entry) => entry.role && entry.content);
};

const formatConversationForPrompt = (conversation = []) => {
	const normalizedConversation = normalizeConversation(conversation);

	if (!normalizedConversation.length) {
		return "[]";
	}

	return JSON.stringify(normalizedConversation, null, 2);
};

const buildPlannerPrompt = ({ message, conversation }) => {
	const normalizedMessage = normalizeText(message);
	const conversationText = formatConversationForPrompt(conversation);

	return [
		"Decide how Quantic AI should route the next user message.",
		"Return only valid JSON. No markdown. No explanation.",
		"Allowed intent values: general, coding, realtime, personal.",
		"Allowed tool values: weather, none, calculator, system.",
		"Rules:",
		"- Use RAG for knowledge-based questions, code questions, architecture, and explanations that benefit from retrieved context.",
		"- Use tools only when a precise computed or utility answer is required.",
		"- Use web for current or real-time public info such as news, weather, current facts, or live data.",
		"- If a tool is not needed, set tool to 'none'.",
		"- If the user is asking about weather, set intent to realtime and tool to weather.",
		"- If the user is asking for a calculation, set tool to calculator.",
		"- If the user is asking for system/time/date-style utility info, set tool to system.",
		"- Realtime questions should usually set useWeb to true.",
		"- Anything that changes over time needs useWeb true and intent realtime even when the user does not say 'today' or 'current': richest or top-ranked people, net worth, prices, rankings, sports results, who currently holds a role (CEO, captain, minister), latest versions or releases, and news.",
		"- Use the Conversation to resolve pronouns: a follow-up such as \"his current networth?\" about a person from the previous turn is a current-facts question, so useWeb is true.",
		"- Coding questions should usually set useRAG to true.",
		"Schema:",
		'{"intent":"general|coding|realtime|personal","useRAG":false,"useWeb":false,"tool":"weather|none|calculator|system"}',
		`User message: ${JSON.stringify(normalizedMessage)}`,
		`Conversation: ${conversationText}`,
	].join("\n");
};

const buildPlannerRequest = (message, conversation) => ({
	method: "post",
	url: "https://api.groq.com/openai/v1/chat/completions",
	headers: {
		Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
		"Content-Type": "application/json",
	},
	data: {
		model: PLANNER_MODEL,
		messages: [
			{
				role: "system",
				content: "You are a routing planner for Quantic AI. Output only valid JSON matching the requested schema.",
			},
			{
				role: "user",
				content: buildPlannerPrompt({ message, conversation }),
			},
		],
		temperature: 0,
		max_tokens: 120,
		response_format: { type: "json_object" },
	},
	timeout: PLANNER_TIMEOUT_MS,
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestWithRetry = async (requestFactory) => {
	let lastError;

	for (let attempt = 1; attempt <= PLANNER_MAX_ATTEMPTS; attempt += 1) {
		try {
			return await axios(requestFactory());
		} catch (error) {
			lastError = error;
			console.warn("[responsePlanner] planner request failed", {
				attempt,
				message: error?.message || String(error),
			});

			if (attempt < PLANNER_MAX_ATTEMPTS) {
				await delay(200 * attempt);
			}
		}
	}

	throw lastError;
};

const stripCodeFences = (value) =>
	String(value ?? "")
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();

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

const normalizeTool = (tool) => {
	const normalizedTool = normalizeText(tool).toLowerCase();
	return ALLOWED_TOOLS.has(normalizedTool) ? normalizedTool : "none";
};

const buildLayerPlan = (classification, message, conversation = []) => {
	const normalizedMessage = normalizeText(message).toLowerCase();
	const hasPersonalSignal = classification.intent === "personal";
	const hasRealtimeSignal = classification.intent === "realtime";
	const hasCodingSignal = classification.intent === "coding";
	const hasComplexSignal = classification.intent === "complex" || classification.confidence >= 0.7 || /\b(explain|architecture|design|refactor|deep dive|thorough)\b/i.test(normalizedMessage);
	const hasToolSignal = /\b(calculate|solve|date|time|system info|server info|machine info|process info|weather|forecast|temperature)\b/i.test(normalizedMessage);
	const layers = ["orchestration"];

	if (hasPersonalSignal) {
		layers.push("memory");
	}

	if (hasCodingSignal) {
		layers.push("knowledge");
	}

	if (hasRealtimeSignal) {
		layers.push("web");
	}

	if (hasToolSignal) {
		layers.push("tool");
	}

	if (hasComplexSignal || layers.length > 2) {
		layers.push("reasoning");
	}

	if (!layers.includes("knowledge") && !layers.includes("web") && !layers.includes("tool") && !hasPersonalSignal) {
		layers.push("knowledge");
	}

	return [...new Set(layers)];
};

const normalizePlannerDecision = (decision) => {
	const intent = ALLOWED_INTENTS.has(normalizeText(decision?.intent).toLowerCase())
		? normalizeText(decision.intent).toLowerCase()
		: "general";
	const confidenceNumber = Number(decision?.confidence);
	const confidence = Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(1, confidenceNumber)) : 0.5;
	const reasoningChecks = Array.isArray(decision?.reasoningChecks)
		? decision.reasoningChecks.map((item) => normalizeText(item)).filter(Boolean).slice(0, 5)
		: ["factual", "complete", "direct", "no_contradictions"];
	const layerPlan = Array.isArray(decision?.layerPlan)
		? decision.layerPlan.map((item) => normalizeText(item)).filter(Boolean).slice(0, 6)
		: [];

	return {
		intent,
		useRAG: Boolean(decision?.useRAG),
		useWeb: Boolean(decision?.useWeb),
		tool: normalizeTool(decision?.tool),
		confidence,
		reasoningChecks,
		layerPlan,
		nextStep: normalizeText(decision?.nextStep),
	};
};

const buildFallbackDecision = (message, conversation) => {
	const classification = classifyIntent(message);
	const baseIntent = ALLOWED_INTENTS.has(classification.intent) ? classification.intent : "general";
	const normalizedMessage = normalizeText(message).toLowerCase();
	const normalizedConversation = normalizeConversation(conversation);
	const recentContext = normalizedConversation.map((entry) => entry.content).join(" ").toLowerCase();
	const hasWeatherSignal = /\b(weather|forecast|temperature|rain|sunny|hot|cold)\b/i.test(normalizedMessage);
	const hasFinanceSignal = /\b(gold|silver|crude\s+oil|oil\s+price|share\s+price|stock\s+price|stock\s+market|market\s+price|crypto|bitcoin|ethereum|nifty|sensex|sensex\s+today|nifty\s+today|exchange\s+rate|forex|currency\s+rate|usd\s+to\s+inr|inr\s+to\s+usd|today\s+gold\s+price|gold\s+rate|commodity\s+price)\b/i.test(normalizedMessage);
	const hasPublicOfficeEntitySignal = /\b(mla|mp|member\s+of\s+legislative\s+assembly|member\s+of\s+parliament|assembly\s+constituency|legislative\s+assembly|legislative\s+council|minister|mayor|councillor|district\s+magistrate|district\s+collector|collector|superintendent\s+of\s+police|sp\.?|dm\.?)\b/i.test(normalizedMessage);
	const hasPublicOfficeQuestionSignal = /\b(who\s+is|who's|what\s+is|which\s+person\s+is|name\s+of|current|present|latest|posted|serving|represents|holds)\b/i.test(normalizedMessage);
	const hasElectionResultSignal = /\b(election|elections|result|results|winner|won|counting|vote\s+share|votes?)\b/i.test(normalizedMessage)
		&& /\b(assembly\s+constituency|constituency|mla|mp|member\s+of\s+legislative\s+assembly|member\s+of\s+parliament|minister|mayor|ward|district|west\s+bengal|india)\b/i.test(normalizedMessage);
	const hasCurrentPublicOfficeSignal =
		/\b(current|present|latest|as of|right now|now)\b/i.test(normalizedMessage) &&
		(hasPublicOfficeEntitySignal || /\b(cm|chief\s+minister|prime\s+minister|president|governor|minister)\b/i.test(normalizedMessage));
	const hasPublicOfficeJoiningDateSignal =
		/\b(cm|chief\s+minister|prime\s+minister|president|governor|minister)\b/i.test(normalizedMessage) &&
		/\b(joining\s+date|took\s+oath|oath\s+date|sworn\s+in|assumed\s+office|term\s+started|took\s+office)\b/i.test(normalizedMessage);
	const hasPublicOfficeLookupSignal = hasPublicOfficeEntitySignal && (hasPublicOfficeQuestionSignal || hasCurrentPublicOfficeSignal || hasPublicOfficeJoiningDateSignal);
	const shouldUseRealtime = hasCurrentPublicOfficeSignal || hasPublicOfficeJoiningDateSignal || hasPublicOfficeLookupSignal || hasElectionResultSignal || hasFinanceSignal;
	const intent = shouldUseRealtime && baseIntent !== "personal" && baseIntent !== "coding" ? "realtime" : baseIntent;
	const hasArithmeticExpression = /^[0-9\s+\-*/().]+$/.test(normalizedMessage) && /[+\-*/]/.test(normalizedMessage);
	const hasCalculatorSignal = /\b(calculate|solve|sum|add|subtract|multiply|divide|convert)\b/i.test(normalizedMessage) || hasArithmeticExpression;
	const hasSystemSignal = /\b(system info|server info|machine info|process info|current date|current time|what('?s| is)? the date|what('?s| is)? the time|time now|date now)\b/i.test(normalizedMessage);
	const layerPlan = buildLayerPlan(classification, normalizedMessage, normalizedConversation);

	return normalizePlannerDecision({
		intent,
		useRAG: (hasCurrentPublicOfficeSignal || hasPublicOfficeJoiningDateSignal)
			? false
			: intent === "coding" || /\b(what is|who is|explain|define|how does|architecture|refactor)\b/i.test(normalizedMessage),
		useWeb: intent === "realtime" || hasWeatherSignal || hasFinanceSignal || hasCurrentPublicOfficeSignal || hasPublicOfficeJoiningDateSignal || hasPublicOfficeLookupSignal || hasElectionResultSignal,
		tool: hasWeatherSignal ? "weather" : hasCalculatorSignal ? "calculator" : hasSystemSignal ? "system" : "none",
		confidence: classification.confidence,
		reasoningChecks: ["factual", "complete", "direct", "no_contradictions"],
		layerPlan,
		nextStep: layerPlan.includes("web") ? "fetch_web" : layerPlan.includes("memory") ? "hydrate_memory" : "retrieve_knowledge",
	});
};

const planResponse = async (message, conversation = []) => {
	const normalizedMessage = normalizeText(message);
	const normalizedConversation = normalizeConversation(conversation);

	if (!normalizedMessage) {
		return buildFallbackDecision(normalizedMessage, normalizedConversation);
	}

	try {
		const response = await requestWithRetry(() => buildPlannerRequest(normalizedMessage, normalizedConversation));
		const content = response.data?.choices?.[0]?.message?.content || "";
		const parsed = safeJsonParse(content);

		if (!parsed) {
			console.warn("[responsePlanner] invalid planner JSON", { content: String(content).slice(0, 200) });
			return buildFallbackDecision(normalizedMessage, normalizedConversation);
		}

		return normalizePlannerDecision(parsed);
	} catch (error) {
		console.warn("[responsePlanner] planner fallback", { message: error?.message || String(error) });
		return buildFallbackDecision(normalizedMessage, normalizedConversation);
	}
};

module.exports = {
	responsePlanner: planResponse,
	createResponsePlan: planResponse,
};