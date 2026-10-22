//back-end/services/llmService.js
const axios = require("axios");
const logger = console;

const envNumber = (name, fallback) => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const envFlag = (name, fallback = false) => {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
};

const envList = (name, fallback = "") => String(process.env[name] || fallback)
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";

const MAX_ATTEMPTS = envNumber("GROQ_MAX_ATTEMPTS", 2);
const REQUEST_TIMEOUT_MS = envNumber("GROQ_REQUEST_TIMEOUT_MS", 30000);
const STREAM_IDLE_TIMEOUT_MS = envNumber("GROQ_STREAM_IDLE_TIMEOUT_MS", 20000);
const STREAM_MAX_MS = envNumber("GROQ_STREAM_MAX_MS", 180000);

const MAX_PROMPT_TOKENS = envNumber("GROQ_MAX_PROMPT_TOKENS", 6000);
const MAX_TURN_TOKENS = envNumber("GROQ_MAX_TURN_TOKENS", 14000);

const MAX_CONTINUE_ROUNDS = envNumber("GROQ_MAX_CONTINUE_ROUNDS", 3);
const CONTINUATION_TAIL_CHARS = envNumber("GROQ_CONTINUATION_TAIL_CHARS", 1800);
const CONTEXT_DIGEST_CHARS = envNumber("GROQ_CONTEXT_DIGEST_CHARS", 1500);

const FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
const REASONING_MODEL = process.env.GROQ_REASONING_MODEL || CHAT_MODEL;
const CREATIVE_MODEL = process.env.GROQ_CREATIVE_MODEL || CHAT_MODEL;
const FAST_MODEL = process.env.GROQ_FAST_MODEL || "llama-3.1-8b-instant";
const REFLECTION_MODEL = process.env.GROQ_REFLECTION_MODEL || FAST_MODEL;

const REFLECTION_MAX_TOKENS = envNumber("GROQ_REFLECTION_MAX_TOKENS", 900);
const SMALLTALK_MAX_TOKENS = envNumber("GROQ_SMALLTALK_MAX_TOKENS", 160);
const TERSE_MAX_TOKENS = envNumber("GROQ_TERSE_MAX_TOKENS", 320);
const MAIN_MAX_TOKENS = envNumber("GROQ_MAIN_MAX_TOKENS", 1200);
const COMPLEX_MAIN_MAX_TOKENS = envNumber("GROQ_COMPLEX_MAIN_MAX_TOKENS", 2000);
const CREATIVE_MAIN_MAX_TOKENS = envNumber("GROQ_CREATIVE_MAIN_MAX_TOKENS", 3000);
const ATTACHMENT_MAIN_MAX_TOKENS = envNumber("GROQ_ATTACHMENT_MAIN_MAX_TOKENS", 2000);
const CODE_MAIN_MAX_TOKENS = envNumber("GROQ_CODE_MAIN_MAX_TOKENS", 4000);

const REFLECTION_ENABLED = envFlag("GROQ_REFLECTION_ENABLED", true);

const MODEL_LIMITS = {
  "llama-3.1-8b-instant": { context: 131072, maxCompletion: 8192 },
  "llama-3.3-70b-versatile": { context: 131072, maxCompletion: 32768 },
  "openai/gpt-oss-20b": { context: 131072, maxCompletion: 32768 },
  "openai/gpt-oss-120b": { context: 131072, maxCompletion: 32768 },
};
const DEFAULT_CONTEXT_TOKENS = envNumber("GROQ_DEFAULT_CONTEXT_TOKENS", 131072);
const DEFAULT_MAX_COMPLETION_TOKENS = envNumber("GROQ_DEFAULT_MAX_COMPLETION_TOKENS", 8192);
const PROMPT_TOKEN_SAFETY_MARGIN = 512;
const CHARS_PER_TOKEN_ESTIMATE = 3.3;

const logEvent = (event, details = {}) => {
  logger.info(`[llmService] ${event}`, details);
};

const serializeError = (error) => ({
  message: error?.message || "Unknown error",
  code: error?.code || null,
  status: error?.response?.status || null,
  groqCode: error?.response?.data?.error?.code || null,
  groqMessage: error?.response?.data?.error?.message || null,
});

const logRequestError = (label, error) => {
  logEvent(`${label}:error`, serializeError(error));
};

const isAbortError = (error) => error?.code === "ERR_CANCELED"
  || error?.name === "CanceledError"
  || error?.name === "AbortError"
  || String(error?.message || "").toLowerCase() === "canceled";

const parseRetryAfterMs = (error) => {
  const header = error?.response?.headers?.["retry-after"];
  const headerSeconds = Number(header);

  if (Number.isFinite(headerSeconds) && headerSeconds > 0) {
    return Math.round(headerSeconds * 1000);
  }

  // Groq usually states the wait inside the message: "try again in 27.5s".
  const message = String(error?.response?.data?.error?.message || "");
  const match = message.match(/try again in ([\d.]+)\s*(ms|s|m)\b/i);

  if (!match) {
    return 0;
  }

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;

  const unit = match[2].toLowerCase();
  if (unit === "ms") return Math.round(value);
  if (unit === "m") return Math.round(value * 60000);
  return Math.round(value * 1000);
};

const describeGroqFailure = (error) => {
  const status = error?.response?.status || 0;
  const groqCode = String(error?.response?.data?.error?.code || "");
  const groqMessage = String(error?.response?.data?.error?.message || "");
  const retryAfterMs = parseRetryAfterMs(error);

  if (isAbortError(error)) {
    return { reason: "client-aborted", retryable: false, retryAfterMs: 0, deadModel: false };
  }

  if (error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT" || /timeout/i.test(error?.message || "")) {
    return { reason: "timeout", retryable: true, retryAfterMs: 0, deadModel: false };
  }

  if (error?.code === "ENOTFOUND" || error?.code === "EAI_AGAIN" || error?.code === "ECONNREFUSED" || error?.code === "ECONNRESET") {
    return { reason: "network", retryable: true, retryAfterMs: 0, deadModel: false };
  }

  if (status === 401 || status === 403) {
    return { reason: "auth", retryable: false, retryAfterMs: 0, deadModel: false };
  }

  if (status === 404 || groqCode === "model_not_found" || /does not exist|decommissioned/i.test(groqMessage)) {
    return { reason: "model-unavailable", retryable: false, retryAfterMs: 0, deadModel: true };
  }

  if (status === 429 || groqCode === "rate_limit_exceeded") {
    return { reason: "rate-limit", retryable: false, retryAfterMs, deadModel: false };
  }

  if (status === 413 || groqCode === "request_too_large" || groqCode === "context_length_exceeded") {
    return { reason: "request-too-large", retryable: false, retryAfterMs: 0, deadModel: false };
  }

  if (status >= 500) {
    return { reason: "groq-server", retryable: true, retryAfterMs: 0, deadModel: false };
  }

  if (status === 400) {
    return { reason: "bad-request", retryable: false, retryAfterMs: 0, deadModel: false };
  }

  return { reason: "unknown", retryable: true, retryAfterMs: 0, deadModel: false };
};

const logGroqFailure = (label, error) => {
  const failure = describeGroqFailure(error);
  logEvent(`${label} [groq:${failure.reason}]`, {
    reason: failure.reason,
    retryAfterMs: failure.retryAfterMs,
    ...serializeError(error),
  });
  return failure;
};

// The old single fallback string told the user nothing and told us nothing.
// Each reason now maps to a message that is true and actionable.
const buildFallbackReply = (failure = null) => {
  const reason = failure?.reason || "unknown";

  if (reason === "rate-limit") {
    const seconds = failure?.retryAfterMs ? Math.ceil(failure.retryAfterMs / 1000) : 0;
    return seconds
      ? `I have hit my request limit for the moment. Please try again in about ${seconds} second${seconds === 1 ? "" : "s"}.`
      : "I have hit my request limit for the moment. Please try again in a few seconds.";
  }

  if (reason === "request-too-large") {
    return "That request is too large for me to process in one go. Try shortening the message or removing part of the attachment, then send it again.";
  }

  if (reason === "auth") {
    return "I cannot authenticate with the AI service right now. This usually means the API key needs attention.";
  }

  if (reason === "model-unavailable") {
    return "The model I was configured to use is not available right now. Please try again in a moment.";
  }

  if (reason === "timeout" || reason === "network" || reason === "groq-server") {
    return "I could not reach the AI service just now. Please try again in a moment.";
  }

  return "I ran into a problem generating that answer. Please try again in a moment.";
};

/* ------------------------------------------------------------------ *
 * 3. Text helpers
 * ------------------------------------------------------------------ */

const normalizeText = (value) => String(value ?? "").trim();

const estimateTokenCount = (text) => Math.ceil(String(text ?? "").length / CHARS_PER_TOKEN_ESTIMATE);

const getModelLimits = (model) => {
  const normalizedModel = String(model || "").toLowerCase();

  if (MODEL_LIMITS[normalizedModel]) {
    return MODEL_LIMITS[normalizedModel];
  }

  return { context: DEFAULT_CONTEXT_TOKENS, maxCompletion: DEFAULT_MAX_COMPLETION_TOKENS };
};

// Clamping the completion request is the safe way to respect a model's output
// ceiling. The old code shrank the *prompt* instead, which silently threw away
// the user's own content to make room for tokens the model was never going to
// emit.
const clampCompletionTokens = (model, requestedTokens) => {
  const { maxCompletion } = getModelLimits(model);
  const requested = Number(requestedTokens) || MAIN_MAX_TOKENS;
  return Math.max(64, Math.min(requested, maxCompletion));
};

const countCodeFences = (text) => (String(text ?? "").match(/```/g) || []).length;

const hasUnbalancedCodeFence = (text) => countCodeFences(text) % 2 === 1;

const TERMINAL_TAIL_PATTERN = /[.!?:;)\]}"'”’`|*_~%>。．！？；：、…।॥؟؛۔】」』）］》→✓]$/;

const DANGLING_TAIL_PATTERN = /(?:\b(?:and|or|but|the|to|of|with|for|from|that|which|is|are|was|were|be|been|being|has|have|had|will|would|could|should|because|into|via|such|than|if|when|while|where|whose|although|however|therefore)\s*)$|[,;:\-–—(\[{/+=<&]$/i;

const endsMidSentence = (text) => {
  const trimmed = String(text ?? "").replace(/\s+$/, "");
  if (!trimmed) return false;
  if (TERMINAL_TAIL_PATTERN.test(trimmed)) return false;
  if (DANGLING_TAIL_PATTERN.test(trimmed)) return true;

  const lastLine = trimmed.slice(trimmed.lastIndexOf("\n") + 1).trim();
  if (!lastLine) return false;

  // Headings, list items, table rows and fences are complete lines by design.
  if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\||```)/.test(lastLine)) return false;

  const wordCount = lastLine.split(/\s+/).filter(Boolean).length;
  return lastLine.length > 40 && wordCount >= 6 && !/[.!?…।。]/.test(lastLine);
};

const looksIncomplete = (text) => hasUnbalancedCodeFence(text) || endsMidSentence(text);

const findOverlapLength = (base, addition, maxOverlap = 400) => {
  const baseStr = String(base ?? "");
  const addStr = String(addition ?? "");
  const limit = Math.min(maxOverlap, baseStr.length, addStr.length);

  for (let size = limit; size >= 24; size -= 1) {
    if (baseStr.endsWith(addStr.slice(0, size))) {
      return size;
    }
  }

  return 0;
};

const stitchContinuation = (base, addition) => {
  const baseStr = String(base ?? "");
  let addStr = String(addition ?? "").replace(/\s+$/, "");

  if (!addStr) return baseStr;
  if (!baseStr) return addStr.replace(/^\s+/, "");

  const overlap = findOverlapLength(baseStr, addStr.replace(/^\s+/, ""));
  if (overlap) {
    addStr = addStr.replace(/^\s+/, "").slice(overlap);
    if (!addStr) return baseStr;
  }

  const startedWithBlockBreak = /^\s*\n/.test(addStr);
  const trimmedAddition = addStr.replace(/^[ \t]+/, "").replace(/^\n+/, "");

  if (!trimmedAddition) return baseStr;

  const startsNewBlock = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|```|\|)/.test(trimmedAddition);
  const baseEndsBlock = /\n$/.test(baseStr);

  if (startsNewBlock || startedWithBlockBreak) {
    const separator = baseEndsBlock ? "" : "\n\n";
    return `${baseStr.replace(/\s+$/, "")}${separator}${trimmedAddition}`;
  }

  const baseTail = baseStr.slice(-1);
  const additionHead = trimmedAddition.slice(0, 1);
  const needsSpace = /[.!?,;:)\]"'’”]/.test(baseTail) || (/\w/.test(baseTail) && /[("'“]/.test(additionHead));

  if (/\s/.test(baseTail)) {
    return `${baseStr}${trimmedAddition}`;
  }

  return `${baseStr}${needsSpace ? " " : ""}${trimmedAddition}`;
};

// Cheap similarity check used to stop a continuation loop that has started
// repeating itself rather than making progress.
const isMostlyRepeat = (tail, addition) => {
  const a = String(tail ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const b = String(addition ?? "").replace(/\s+/g, " ").trim().toLowerCase();

  if (!b) return true;
  if (b.length < 24) return a.includes(b);

  const probe = b.slice(0, Math.min(160, b.length));
  return a.includes(probe);
};

const squeezeText = (text, maxChars, note = "content trimmed to fit the token budget") => {
  const str = String(text ?? "");
  if (str.length <= maxChars) return str;

  const headChars = Math.floor(maxChars * 0.55);
  const tailChars = Math.max(0, maxChars - headChars);

  return [
    str.slice(0, headChars),
    `\n\n...[${str.length - maxChars} characters omitted — ${note}]...\n\n`,
    str.slice(str.length - tailChars),
  ].join("");
};

const truncatePromptForModel = (prompt, model, reservedCompletionTokens = 0) => {
  const normalizedPrompt = String(prompt ?? "");
  const { context } = getModelLimits(model);
  const contextBudget = Math.max(1000, context - reservedCompletionTokens - PROMPT_TOKEN_SAFETY_MARGIN);
  const tokenBudget = Math.max(1000, Math.min(contextBudget, MAX_PROMPT_TOKENS));
  const charBudget = Math.floor(tokenBudget * CHARS_PER_TOKEN_ESTIMATE);

  if (estimateTokenCount(normalizedPrompt) <= tokenBudget) {
    return normalizedPrompt;
  }

  const sectionMatch = normalizedPrompt.match(/(Attachment Analysis\n)([\s\S]*?)(\n\n[A-Z][^\n]*\n|$)/);

  if (sectionMatch) {
    const [fullMatch, header, sectionBody, tail] = sectionMatch;
    const sectionStart = normalizedPrompt.indexOf(fullMatch);
    const before = normalizedPrompt.slice(0, sectionStart);
    const after = normalizedPrompt.slice(sectionStart + fullMatch.length);
    const nonSectionChars = before.length + after.length + header.length + tail.length;
    const allowedSectionChars = Math.max(2000, charBudget - nonSectionChars);

    if (sectionBody.length > allowedSectionChars) {
      const squeezedBody = squeezeText(
        sectionBody,
        allowedSectionChars,
        "the attachment is larger than shown"
      );

      logEvent("truncatePromptForModel:attachment-section", {
        model,
        omittedChars: sectionBody.length - allowedSectionChars,
        tokenBudget,
      });

      const rebuilt = before + header + squeezedBody + tail + after;

      if (estimateTokenCount(rebuilt) <= tokenBudget) {
        return rebuilt;
      }

      return squeezeText(rebuilt, charBudget, "input longer than the token budget");
    }
  }

  logEvent("truncatePromptForModel:whole-prompt", {
    model,
    originalChars: normalizedPrompt.length,
    charBudget,
    tokenBudget,
  });

  return squeezeText(normalizedPrompt, charBudget, "input longer than the token budget");
};

/* ------------------------------------------------------------------ *
 * 4. Understanding what the user actually asked for
 * ------------------------------------------------------------------ */

const SCRIPT_RANGES = [
  { language: "Bengali", pattern: /[ঀ-৿]/ },
  { language: "Hindi", pattern: /[ऀ-ॿ]/ },
  { language: "Tamil", pattern: /[஀-௿]/ },
  { language: "Telugu", pattern: /[ఀ-౿]/ },
  { language: "Gujarati", pattern: /[઀-૿]/ },
  { language: "Arabic", pattern: /[؀-ۿ]/ },
  { language: "Hebrew", pattern: /[֐-׿]/ },
  { language: "Russian", pattern: /[Ѐ-ӿ]/ },
  { language: "Greek", pattern: /[Ͱ-Ͽ]/ },
  { language: "Japanese", pattern: /[぀-ヿ]/ },
  { language: "Korean", pattern: /[가-힯]/ },
  { language: "Chinese", pattern: /[一-鿿]/ },
];

const NAMED_LANGUAGES = [
  "bengali", "bangla", "hindi", "hinglish", "marathi", "tamil", "telugu", "kannada",
  "malayalam", "gujarati", "punjabi", "urdu", "odia", "assamese", "english",
  "spanish", "french", "german", "italian", "portuguese", "dutch", "russian",
  "arabic", "hebrew", "japanese", "korean", "chinese", "mandarin", "turkish",
  "indonesian", "vietnamese", "thai", "polish", "swedish", "greek",
];

const titleCaseWord = (word) => String(word ?? "").charAt(0).toUpperCase() + String(word ?? "").slice(1).toLowerCase();

// Two signals, in priority order: an explicit "answer in X" instruction beats
// script detection, because a user can ask in English for a Bengali answer.
const detectLanguageDirective = (query) => {
  const text = normalizeText(query);

  if (!text) {
    return { requested: "", detected: "", romanised: false };
  }

  const namedPattern = new RegExp(
    `\\b(?:in|reply in|answer in|respond in|translate (?:it |this )?(?:in|to|into)|write (?:it |this )?in)\\s+(${NAMED_LANGUAGES.join("|")})\\b`,
    "i"
  );
  const namedMatch = text.match(namedPattern);
  const requestedRaw = namedMatch ? namedMatch[1].toLowerCase() : "";
  const requested = requestedRaw === "bangla" ? "Bengali" : (requestedRaw ? titleCaseWord(requestedRaw) : "");

  const scriptHit = SCRIPT_RANGES.find((entry) => entry.pattern.test(text));
  const detected = scriptHit ? scriptHit.language : "";

  const romanised = !detected && /\b(kemon|acho|ache|ki|keno|kothay|tumi|ami|amar|tomar|nahi|kya|kaise|kyun|hai|hoon|mera|tera|aap|nahin)\b/i.test(text);

  return { requested, detected, romanised };
};

const parseCountDirective = (text) => {
  const wordMatch = text.match(/\bin\s+(?:about\s+|around\s+|roughly\s+|under\s+|no more than\s+|at most\s+)?(\d{1,4})\s*(words?|sentences?|lines?|bullets?|bullet points?|points?|paragraphs?)\b/i);

  if (wordMatch) {
    return { count: Number(wordMatch[1]), unit: wordMatch[2].toLowerCase().replace(/s$/, "") };
  }

  const spelledMatch = text.match(/\bin\s+(one|two|three|four|five|six|seven|eight|nine|ten)\s+(words?|sentences?|lines?|bullets?|bullet points?|points?|paragraphs?)\b/i);

  if (spelledMatch) {
    const words = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
    return { count: words[spelledMatch[1].toLowerCase()], unit: spelledMatch[2].toLowerCase().replace(/s$/, "") };
  }

  return { count: 0, unit: "" };
};

const extractOutputDirectives = (query) => {
  const text = normalizeText(query);
  const lower = text.toLowerCase();

  const wantsTerse = /\b(briefly|be brief|in brief|concise|concisely|short answer|shortly|keep it short|one line|one-liner|in a nutshell|tl;?dr|summar(?:y|ise|ize) (?:it )?(?:in )?short|just the answer|straight answer|yes or no|quick(?:ly)? answer)\b/i.test(lower);
  const wantsDetail = /\b(in detail|in-depth|detailed|comprehensive|thorough(?:ly)?|deep dive|deep-dive|elaborate|at length|full explanation|explain everything|exhaustive|long answer|as much detail)\b/i.test(lower);

  const { count, unit } = parseCountDirective(lower);

  const wantsTable = /\b(as a table|in a table|tabular|table format|comparison table|side by side|side-by-side)\b/i.test(lower);
  const wantsBullets = /\b(bullet(?:ed)? (?:points?|list)|as bullets|in bullets|point(?:-| )wise|pointwise|as a list|in list form)\b/i.test(lower);
  const wantsSteps = /\b(step by step|step-by-step|steps to|walk me through|numbered (?:steps|list)|how to)\b/i.test(lower);
  const wantsJson = /\b(as json|in json|json format|json only|return json)\b/i.test(lower);
  const wantsPlainText = /\b(plain text|no markdown|without markdown|no formatting|no bullet points|no bullets|in prose|paragraph form|without headings)\b/i.test(lower);
  const wantsCodeOnly = /\b(code only|only code|just the code|just code|no explanation|without explanation|no commentary)\b/i.test(lower);
  const wantsNoCode = /\b(no code|without code|don'?t (?:give|write|show) (?:me )?code|explain without code|conceptually only)\b/i.test(lower);
  const wantsSimple = /\b(explain like i'?m (?:five|5)|eli5|in simple terms|simply|layman'?s terms|for a beginner|beginner friendly|beginner-friendly|like i'?m new)\b/i.test(lower);
  const wantsExamples = /\b(with examples?|give (?:me )?examples?|for example|include examples?|with a sample)\b/i.test(lower);
  const wantsCitations = /\b(with sources?|cite sources?|with citations?|with links?|include links?|where did you|according to)\b/i.test(lower);

  const language = detectLanguageDirective(text);

  const rules = [];

  if (count && unit) {
    rules.push(`The user asked for the answer in ${count} ${unit}${count === 1 ? "" : "s"}. Respect that limit exactly — it overrides every other length guidance.`);
  } else if (wantsTerse) {
    rules.push("The user explicitly asked for a short answer. Give the direct answer in at most two or three sentences, with no preamble, no headings, and no closing summary.");
  } else if (wantsDetail) {
    rules.push("The user explicitly asked for detail. Be thorough: cover the reasoning, the edge cases, and the caveats, and use headings to keep it readable.");
  }

  if (wantsTable) rules.push("Present the core of the answer as a Markdown table.");
  if (wantsBullets) rules.push("Present the core of the answer as a bulleted list.");
  if (wantsSteps) rules.push("Present the core of the answer as numbered steps in the order they must be performed.");
  if (wantsJson) rules.push("Return valid JSON only, with no prose outside the JSON and no code fence unless asked.");
  if (wantsPlainText) rules.push("Write in plain prose. Do not use Markdown headings, bold, bullets, or numbered lists.");
  if (wantsCodeOnly) rules.push("Return only the code inside a single fenced code block, with no explanation before or after it.");
  if (wantsNoCode) rules.push("Explain this conceptually. Do not include any code blocks or code snippets.");
  if (wantsSimple) rules.push("Explain in plain, simple language a beginner can follow. Avoid jargon, and define any term you must use.");
  if (wantsExamples) rules.push("Include at least one concrete worked example.");
  if (wantsCitations) rules.push("Attribute each factual claim to the specific source it came from in the provided context. If a claim has no source in the context, say so instead of guessing.");

  if (language.requested) {
    rules.push(`Write the entire answer in ${language.requested}. Keep code, identifiers, and command names in their original form.`);
  } else if (language.detected) {
    rules.push(`The user wrote in ${language.detected}. Reply in ${language.detected} using the same script, unless they asked for another language. Keep code, identifiers, and command names in their original form.`);
  } else if (language.romanised) {
    rules.push("The user wrote an Indic language using Latin letters. Reply in that same romanised style rather than switching to a native script or to formal English.");
  }

  return {
    rules,
    lengthMode: count && unit ? "exact" : (wantsTerse ? "terse" : (wantsDetail ? "expansive" : "default")),
    exactCount: count,
    exactUnit: unit,
    wantsTable,
    wantsBullets,
    wantsSteps,
    wantsJson,
    wantsPlainText,
    wantsCodeOnly,
    wantsNoCode,
    wantsSimple,
    wantsExamples,
    wantsCitations,
    language,
  };
};

// A single message can carry several questions. Answering only the first is the
// most common way an assistant feels inattentive.
const countQuestionParts = (query) => {
  const text = normalizeText(query);
  if (!text) return 0;

  const questionMarks = (text.match(/\?/g) || []).length;
  const numbered = (text.match(/(?:^|\n)\s*(?:\d+[.)]|[-*•])\s+\S/g) || []).length;
  const connectives = (text.match(/\b(?:and also|also,? (?:what|how|why|when|where|who|can|could|is|are|do|does)|as well as|plus,? |secondly|second,|thirdly|third,|finally,|lastly,)\b/gi) || []).length;

  return Math.max(questionMarks, numbered, connectives ? connectives + 1 : 0);
};

const buildMultiPartDirective = (partCount) => (partCount >= 2
  ? `The user asked ${partCount} separate things in one message. Answer every one of them, in the order asked, each under its own short bold label or heading. Do not merge them into a single paragraph and do not silently skip any.`
  : "");

const SMALLTALK_PATTERN = /^(?:ok(?:ay)?|kk|k|yes|yep|yeah|yup|no|nope|nah|sure|right|correct|got it|understood|thanks?|thank you|thx|ty|cool|nice|great|perfect|awesome|good|fine|hmm+|hi|hey|hello|yo|bye|goodbye|good (?:morning|afternoon|evening|night)|np|no problem|welcome|sorry|please|continue|go on|next)[\s!.,?]*$/i;

const isSmallTalkQuery = (query) => {
  const text = normalizeText(query);
  if (!text || text.length > 40) return false;
  return SMALLTALK_PATTERN.test(text);
};

// The old isCreativeGenerationQuery matched the bare noun, so "how should I
// structure a cover letter" was treated as a creative writing job and given a
// 3000-token budget. Requiring a generative verb near the noun fixes that.
const CREATIVE_NOUNS = "song|lyrics|poem|poetry|haiku|sonnet|rap|story|short story|screenplay|script|dialogue|monologue|joke|limerick|essay|caption|slogan|tagline|jingle|bio|toast|vows|greeting|letter|cover letter|email|tweet|post|speech";
const CREATIVE_VERBS = "write|compose|create|make|generate|draft|craft|pen|come up with|give me|invent";

const isCreativeGenerationQuery = (query) => {
  const text = normalizeText(query);
  if (!text) return false;

  const verbThenNoun = new RegExp(`\\b(?:${CREATIVE_VERBS})\\b[^.?!]{0,40}?\\b(?:${CREATIVE_NOUNS})\\b`, "i");
  const nounThenAbout = new RegExp(`\\b(?:${CREATIVE_NOUNS})\\b\\s+(?:about|on|for|regarding)\\b`, "i");

  return verbThenNoun.test(text) || nounThenAbout.test(text);
};

const CODE_LANGUAGES = "javascript|typescript|jsx|tsx|node(?:\\.js)?|react|next(?:\\.js)?|vue|angular|svelte|express|mongoose|mongodb|sql|postgres|mysql|sqlite|python|django|flask|fastapi|java|kotlin|swift|ruby|rails|sinatra|erb|php|laravel|golang|rust|c\\+\\+|c#|dotnet|bash|shell|powershell|html|css|sass|tailwind|docker|kubernetes|nginx|graphql|redis|regex|git";
const CODE_VERBS = "implement|refactor|debug|fix|resolve|optimi[sz]e|migrate|deploy|configure|integrate|write|build|create|add|remove|rename|convert|parse|validate|authenticate|parse|handle";
const CODE_NOUNS = "code|snippet|function|method|class|component|hook|module|package|library|dependency|api|endpoint|route|controller|middleware|schema|model|migration|query|script|config|environment variable|env var|stack trace|traceback|error|exception|bug|test|unit test|compiler|build|bundle|cli|command|repo|repository|branch|commit|pull request|regex|algorithm|data structure|complexity";

const isCodeQuery = (query) => {
  const text = normalizeText(query);
  if (!text) return false;

  if (/```/.test(text)) return true;
  if (/\.(?:js|jsx|ts|tsx|py|rb|java|kt|swift|go|rs|php|cs|cpp|c|h|css|scss|html|json|yml|yaml|toml|sql|sh|env)\b/i.test(text)) return true;
  if (/\b(?:npm|npx|yarn|pnpm|pip|pipenv|poetry|cargo|gradle|maven|composer|apt|brew|docker|kubectl|git)\s+\w/i.test(text)) return true;
  if (/(?:=>|===|!==|\{\s*\}|\(\)\s*=>|<\/\w+>|\w+\(\)|process\.env|console\.log|async\s+function)/.test(text)) return true;

  const languagePattern = new RegExp(`\\b(?:${CODE_LANGUAGES})\\b`, "i");
  const nounPattern = new RegExp(`\\b(?:${CODE_NOUNS})\\b`, "i");
  const verbPattern = new RegExp(`\\b(?:${CODE_VERBS})\\b`, "i");

  if (languagePattern.test(text) && (nounPattern.test(text) || verbPattern.test(text))) return true;
  if (nounPattern.test(text) && verbPattern.test(text)) return true;

  return false;
};

const isMathQuery = (query) => {
  const text = normalizeText(query);
  if (!text) return false;

  if (/\b(?:calculate|compute|solve|evaluate|simplify|factorise|factorize|differentiate|derivative|integral|integrate|probability|permutation|combination|matrix|determinant|logarithm|equation|inequality|percentage|compound interest|square root|cube root|standard deviation)\b/i.test(text)) return true;

  const asksForAValue = /\b(?:what(?:'s| is| are)|how much|how many|find|work out)\b/i.test(text);

  // "17% of 340" — a percentage with something to apply it to, not a passing
  // mention like "the 20% rule".
  if (asksForAValue && /\b\d+(?:\.\d+)?\s*(?:%|percent)\s+(?:of|off)\s+[\d$₹£€]/i.test(text)) return true;
  if (asksForAValue && /\d\s*[+\-*/^]\s*\d/.test(text)) return true;

  return /^[\d\s+\-*/^().]+=?\s*\??$/.test(text) && /\d\s*[+\-*/^]\s*\d/.test(text);
};

const isTranslationQuery = (query) => /\b(translate|translation|how do you say|what does .{1,40} mean in|meaning of .{1,40} in)\b/i.test(normalizeText(query));

const classifyQuery = (query, options = {}) => {
  const text = normalizeText(query);
  const declaredComplexity = String(options?.complexity ?? "").toLowerCase();
  const intent = String(options?.intent ?? "").toLowerCase();
  const hasAttachmentAnalysis = Boolean(options?.hasAttachmentAnalysis);
  const directives = extractOutputDirectives(text);
  const partCount = countQuestionParts(text);

  let kind = "general";

  if (isSmallTalkQuery(text)) {
    kind = "smalltalk";
  } else if (isCodeQuery(text)) {
    kind = "code";
  } else if (isMathQuery(text)) {
    kind = "math";
  } else if (isCreativeGenerationQuery(text)) {
    kind = "creative";
  } else if (isTranslationQuery(text)) {
    kind = "translation";
  } else if (intent === "realtime") {
    kind = "realtime";
  } else if (hasAttachmentAnalysis) {
    kind = "attachment";
  } else if (declaredComplexity === "complex" || partCount >= 2) {
    kind = "analysis";
  }

  const isComplex = declaredComplexity === "complex"
    || kind === "analysis"
    || partCount >= 2
    || directives.lengthMode === "expansive";

  return {
    query: text,
    kind,
    intent,
    complexity: declaredComplexity,
    isComplex,
    hasAttachmentAnalysis,
    partCount,
    multiPartDirective: buildMultiPartDirective(partCount),
    directives,
    isSmallTalk: kind === "smalltalk",
  };
};

const resolveSampling = (profile) => {
  switch (profile?.kind) {
    case "code":
      return { temperature: 0.15, top_p: 0.9 };
    case "math":
      return { temperature: 0.1, top_p: 0.9 };
    case "translation":
      return { temperature: 0.2, top_p: 0.9 };
    case "realtime":
      return { temperature: 0.2, top_p: 0.9 };
    case "attachment":
      return { temperature: 0.25, top_p: 0.9 };
    case "analysis":
      return { temperature: 0.4, top_p: 0.95 };
    case "creative":
      return { temperature: 0.85, top_p: 0.95 };
    case "smalltalk":
      return { temperature: 0.5, top_p: 1 };
    default:
      return { temperature: 0.35, top_p: 0.95 };
  }
};

const resolveMaxTokens = (profile) => {
  const directives = profile?.directives || { lengthMode: "default" };

  // An explicit instruction from the user outranks any topic heuristic.
  if (directives.lengthMode === "exact") {
    const unit = directives.exactUnit;
    const count = directives.exactCount || 1;
    const perUnit = unit === "word" ? 2 : (unit === "sentence" || unit === "line" ? 40 : (unit === "paragraph" ? 130 : 60));
    return Math.max(96, Math.min(CODE_MAIN_MAX_TOKENS, Math.round(count * perUnit) + 120));
  }

  if (profile?.isSmallTalk) return SMALLTALK_MAX_TOKENS;
  if (directives.lengthMode === "terse") return TERSE_MAX_TOKENS;

  if (profile?.kind === "code") return CODE_MAIN_MAX_TOKENS;
  if (profile?.kind === "creative") return CREATIVE_MAIN_MAX_TOKENS;
  if (directives.lengthMode === "expansive") return Math.max(COMPLEX_MAIN_MAX_TOKENS, CREATIVE_MAIN_MAX_TOKENS);
  if (profile?.hasAttachmentAnalysis) {
    return Math.max(ATTACHMENT_MAIN_MAX_TOKENS, COMPLEX_MAIN_MAX_TOKENS);
  }

  if (profile?.isComplex) return COMPLEX_MAIN_MAX_TOKENS;

  return MAIN_MAX_TOKENS;
};

const resolveReflectionMaxTokens = (profile) => {
  const mainTokens = resolveMaxTokens(profile);
  return Math.max(REFLECTION_MAX_TOKENS, Math.ceil(mainTokens * 1.15));
};

const resolveContinuationMaxTokens = (profile) => Math.max(700, Math.ceil(resolveMaxTokens(profile) * 0.75));

const deadModels = new Set();

const markModelDead = (model, reason) => {
  const normalized = normalizeText(model);
  if (!normalized || deadModels.has(normalized)) return;

  deadModels.add(normalized);
  logEvent("model:disabled-for-process", { model: normalized, reason });
};

const isModelUsable = (model) => {
  const normalized = normalizeText(model);
  return Boolean(normalized) && !deadModels.has(normalized);
};

let availableModelsPromise = null;

const fetchAvailableModels = async () => {
  if (!process.env.GROQ_API_KEY) {
    return null;
  }

  if (!availableModelsPromise) {
    availableModelsPromise = axios({
      method: "get",
      url: GROQ_MODELS_URL,
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      timeout: REQUEST_TIMEOUT_MS,
    })
      .then((response) => {
        const ids = (response.data?.data || [])
          .map((entry) => normalizeText(entry?.id))
          .filter(Boolean);

        logEvent("fetchAvailableModels:ok", { count: ids.length });
        return new Set(ids);
      })
      .catch((error) => {
        // A failed probe must never block generation — fall back to trying the
        // configured models directly.
        logGroqFailure("fetchAvailableModels", error);
        return null;
      });
  }

  return availableModelsPromise;
};

const buildModelPreferences = (profile, requestedModel) => {
  const preferred = [];

  if (requestedModel) preferred.push(requestedModel);

  switch (profile?.kind) {
    case "code":
    case "math":
    case "analysis":
    case "attachment":
      preferred.push(REASONING_MODEL, CHAT_MODEL, FALLBACK_MODEL, FAST_MODEL);
      break;
    case "creative":
      preferred.push(CREATIVE_MODEL, CHAT_MODEL, FALLBACK_MODEL, FAST_MODEL);
      break;
    case "smalltalk":
      preferred.push(FAST_MODEL, FALLBACK_MODEL, CHAT_MODEL);
      break;
    case "realtime":
    case "translation":
      preferred.push(CHAT_MODEL, FALLBACK_MODEL, FAST_MODEL);
      break;
    default:
      preferred.push(CHAT_MODEL, FALLBACK_MODEL, FAST_MODEL);
      break;
  }

  if (profile?.isComplex) {
    preferred.unshift(requestedModel || REASONING_MODEL);
  }

  return preferred
    .map((entry) => normalizeText(entry))
    .filter(Boolean)
    .filter((entry, index, list) => list.indexOf(entry) === index);
};

const resolveModelChain = async (profile, requestedModel) => {
  const preferences = buildModelPreferences(profile, requestedModel);
  const available = await fetchAvailableModels();

  const usable = preferences.filter((model) => {
    if (!isModelUsable(model)) return false;
    if (available && !available.has(model)) {
      markModelDead(model, "not listed by GET /v1/models");
      return false;
    }
    return true;
  });

  if (usable.length) {
    return usable;
  }

  // Everything was filtered out — the probe may be wrong or stale, so try the
  // configured chain anyway rather than refusing to answer.
  logEvent("resolveModelChain:no-verified-model", { preferences });
  return preferences.length ? preferences : [FALLBACK_MODEL];
};

// Images must never fall back to a text-only model: that produces misleading
// "I cannot access the image" answers or repeated API errors. Keep this chain
// restricted to known vision-capable Groq models only.
const resolveVisionModelChain = async (requestedModel) => {
  const configured = normalizeText(requestedModel);
  const preferences = [
    configured,
    "qwen/qwen3.8-27b",
  ].filter((model, index, list) => model && list.indexOf(model) === index);
  const available = await fetchAvailableModels();

  const usable = preferences.filter((model) => {
    if (!isModelUsable(model)) return false;
    if (available && !available.has(model)) {
      markModelDead(model, "vision model not listed by GET /v1/models");
      return false;
    }
    return true;
  });

  if (usable.length) return usable;
  if (!available) {
    // If the model-list probe itself failed, try the documented vision model.
    return ["qwen/qwen3.8-27b"];
  }

  const error = new Error("No available vision-capable model is configured. Set GROQ_VISION_MODEL to an active Groq vision model.");
  error.code = "QUANTIC_VISION_MODEL_UNAVAILABLE";
  throw error;
};

const createTurnBudget = (limit = MAX_TURN_TOKENS) => ({
  limit,
  spent: 0,
  charge(promptText, completionTokens) {
  
    const promptTokens = Math.min(
      estimateTokenCount(promptText),
      MAX_PROMPT_TOKENS + PROMPT_TOKEN_SAFETY_MARGIN
    );
    this.spent += promptTokens + Number(completionTokens || 0);
    return this.spent;
  },
  remaining() {
    return Math.max(0, this.limit - this.spent);
  },
  canAfford(estimatedTokens) {
    return this.spent + Number(estimatedTokens || 0) <= this.limit;
  },
});

const BASE_SYSTEM_RULES = [
  "You are Quantic AI, a production-style assistant.",
  "Quantic AI was created and is developed by Basudeb Bej. If asked who built, created, or founded Quantic AI, always answer with this fact and never invent another name.",
  "Answer the question that was actually asked. Lead with the direct answer, then support it.",
  "Interpret obvious spelling mistakes and phonetic typos from context when the intended word or entity is unambiguous (for example, 'Rassia' means 'Russia'); answer the intended question instead of treating the typo as an unknown entity. If genuinely ambiguous, ask one short clarification question.",
  "When a user asks to detect, check, or correct spelling errors, explicitly proofread the supplied text and any successfully extracted attachment text. Report the original phrase, correction, and a short reason; never claim to have checked content that could not be extracted.",
  "Treat User Profile and Conversation Context as trusted context before guessing.",
  "Treat Web Search as trusted current public context when it is provided.",
  "If Web Context is missing or says WEB_SEARCH_FAILED, do not fabricate current facts — say you could not find reliable recent information.",
  "Resolve follow-ups such as 'me', 'about me', 'say my name', 'that one', or 'the second option' from the prior conversation instead of asking what the user means.",
  "If the context does not answer the question, say so plainly and still give the best answer you can from general knowledge, labelling which part is general knowledge.",
  "Never invent a fact, a number, a citation, an API, or a configuration option. If you are unsure, say which part you are unsure about.",
  "Do not open with filler such as 'Great question', 'Certainly', or a restatement of the question. Start with the substance.",
  "Do not end with an offer to help further unless the user asked what to do next.",
  "Avoid disclaimer-heavy hedging. Be direct and specific.",
  "Do not use emojis or decorative symbols unless the user explicitly asks for them.",
  "Finish every answer completely. Never stop mid-sentence, mid-code-block, or mid-list.",
].join(" ");

const FORMAT_SYSTEM_RULES = [
  "Match the length of your answer to the question: a factual or yes/no question gets one to three sentences, and only a genuinely multi-part or complex question earns headings and sections.",
  "Use Markdown structure — ## headings, **bold**, tables, and numbered or bulleted lists — only when it makes a longer answer easier to read, never as decoration on a short one.",
  "Put every code sample in a fenced block with its language tag, and make it complete enough to run or paste as-is.",
  "If the user's message is a short acknowledgement such as yes, ok, thanks, or right, use the recent conversation to decide whether it confirms something or simply acknowledges the last answer, then reply in one or two sentences without restating the previous answer.",
  "Do not ask a clarifying question unless the request is genuinely ambiguous and the context cannot resolve it. If you must ask, give your best attempt first and then ask.",
].join(" ");

const KIND_SYSTEM_RULES = {
  code: [
    "This is a programming request. Be precise about names, versions, and file paths.",
    "Give working code rather than pseudocode, and state which file each block belongs in.",
    "Call out the specific line or condition that causes a bug when you are diagnosing one.",
    "Mention a caveat only when it would actually bite in practice.",
  ].join(" "),
  math: [
    "This is a quantitative question. Work through it step by step, keep the arithmetic explicit, and state the final answer on its own line.",
    "Re-check the calculation before answering. If the problem is underdetermined, say which value is missing.",
  ].join(" "),
  creative: [
    "This is a creative writing request. Commit to a voice and produce the finished piece.",
    "Do not explain your creative choices, do not add a preface, and do not offer alternatives unless asked.",
  ].join(" "),
  analysis: [
    "This is a multi-part or analytical question. Cover each part, and make the structure of the answer mirror the structure of the question.",
    "Where there is a trade-off, name both sides and then give your recommendation.",
  ].join(" "),
  realtime: [
    "This question is about current information. Rely on the provided web context and attribute specific claims to it.",
    "State the date or recency of the information when it matters, and say plainly if the context is not current enough to answer.",
  ].join(" "),
  attachment: [
    "The user has supplied a file or pasted content. Ground the answer in that content and quote the relevant part when it helps.",
    "If the supplied content was truncated, say which part you could not see rather than guessing at it.",
  ].join(" "),
  translation: [
    "This is a translation or wording request. Give the translation first, then a short note on nuance only if it is genuinely useful.",
  ].join(" "),
  smalltalk: "This is small talk or a brief acknowledgement. Reply in one or two natural sentences. Do not add headings, lists, or a summary of anything.",
};

const buildSystemMessages = (profile, options = {}) => {
  const messages = [
    { role: "system", content: BASE_SYSTEM_RULES },
    { role: "system", content: FORMAT_SYSTEM_RULES },
  ];

  const kindRules = KIND_SYSTEM_RULES[profile?.kind];
  if (kindRules) {
    messages.push({ role: "system", content: kindRules });
  }

  if (profile?.multiPartDirective) {
    messages.push({ role: "system", content: profile.multiPartDirective });
  }

  // The user's own instructions go last so they are the most recent thing the
  // model reads, and they are labelled as non-negotiable.
  const rules = profile?.directives?.rules || [];
  if (rules.length) {
    messages.push({
      role: "system",
      content: `The user gave explicit instructions about the output. These override every other formatting or length guideline above: ${rules.join(" ")}`,
    });
  }

  const extras = Array.isArray(options?.systemExtras) ? options.systemExtras.filter(Boolean) : [];
  for (const extra of extras) {
    messages.push({ role: "system", content: String(extra) });
  }

  return messages;
};

const applyReasoningControls = (data, model, profile = null) => {
  const normalizedModel = String(model || "").toLowerCase();

  if (normalizedModel.includes("gpt-oss")) {
    const configured = normalizeText(process.env.GROQ_REASONING_EFFORT).toLowerCase();
    const effort = ["low", "medium", "high"].includes(configured)
      ? configured
      : (profile?.isComplex || profile?.kind === "code" || profile?.kind === "math" ? "medium" : "low");

    data.reasoning_effort = effort;
    return data;
  }

  if (/qwen3|deepseek-r1|reasoning|thinking/.test(normalizedModel)) {
    // Without this the model's chain of thought streams straight to the user.
    data.reasoning_format = "hidden";
  }

  return data;
};

const buildChatMessages = ({ prompt, profile, options = {} }) => {
  const systemMessages = buildSystemMessages(profile, options);
  const history = Array.isArray(options?.messages) ? options.messages : null;

  // OCR is useful for text in a picture, but it cannot answer visual questions
  // such as counting people or identifying objects. Pass the original image data
  // to a vision-capable model as multimodal user content as well.
  const visionImages = Array.isArray(options?.visionImages)
    ? options.visionImages
        .filter((image) => typeof image?.dataUrl === "string" && /^data:image\/(?:png|jpe?g|webp|gif|bmp|tiff?);base64,/i.test(image.dataUrl))
        .slice(0, 3)
    : [];

  const currentUserContent = visionImages.length
    ? [
        { type: "text", text: prompt },
        ...visionImages.map((image) => ({
          type: "image_url",
          image_url: { url: image.dataUrl, detail: "auto" },
        })),
      ]
    : prompt;

  if (history && history.length) {
    const cleaned = history
      .filter((entry) => entry && typeof entry.content === "string" && entry.content.trim())
      .filter((entry) => entry.role === "user" || entry.role === "assistant")
      .map((entry) => ({ role: entry.role, content: entry.content }));

    if (cleaned.length) {
      // Do not let the history fast-path discard the current turn's images.
      return [...systemMessages, ...cleaned, { role: "user", content: currentUserContent }];
    }
  }

  return [...systemMessages, { role: "user", content: currentUserContent }];
};

const buildChatRequest = ({ prompt, stream, model, maxTokens, profile, options = {}, signal = null }) => {
  const resolvedModel = model || CHAT_MODEL;
  const requestedMaxTokens = clampCompletionTokens(resolvedModel, maxTokens || resolveMaxTokens(profile));
  const safePrompt = truncatePromptForModel(prompt, resolvedModel, requestedMaxTokens);
  const sampling = resolveSampling(profile);

  const data = applyReasoningControls(
    {
      model: resolvedModel,
      messages: buildChatMessages({ prompt: safePrompt, profile, options }),
      stream: Boolean(stream),
      temperature: sampling.temperature,
      top_p: sampling.top_p,
      max_tokens: requestedMaxTokens,
    },
    resolvedModel,
    profile
  );

  const request = {
    method: "post",
    url: GROQ_URL,
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    data,
    timeout: stream ? STREAM_MAX_MS : REQUEST_TIMEOUT_MS,
    responseType: stream ? "stream" : "json",
  };

  if (signal) {
    request.signal = signal;
  }

  return request;
};

/* ------------------------------------------------------------------ *
 * 9. Request execution
 * ------------------------------------------------------------------ */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const requestWithRetry = async (requestFactory, label) => {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const request = requestFactory();

    try {
      return await axios(request);
    } catch (error) {
      lastError = error;
      const failure = logGroqFailure(`${label}:attempt-${attempt}`, error);

      if (failure.reason === "client-aborted") {
        throw error;
      }

      if (failure.deadModel) {
        markModelDead(request?.data?.model, failure.reason);
        throw error;
      }

      // A rate limit or an oversized request cannot be fixed by trying the same
      // model again a moment later — Groq states a wait far longer than this
      // loop. Surface it so the caller can switch models instead.
      if (!failure.retryable) {
        throw error;
      }

      if (attempt < MAX_ATTEMPTS) {
        const wait = failure.retryAfterMs && failure.retryAfterMs <= 2000
          ? failure.retryAfterMs
          : 250 * attempt;
        await delay(wait);
      }
    }
  }

  throw lastError;
};

// Walks the model chain. Because Groq's rate limits are per model, a 429 on the
// preferred model is a reason to try the next one immediately rather than to
// give up on the turn — which is what the old single-fallback path did.
const requestWithModelChain = async ({ models, label, buildRequest }) => {
  const chain = (models || []).filter(isModelUsable);
  const candidates = chain.length ? chain : [FALLBACK_MODEL];
  let lastError;

  for (const model of candidates) {
    try {
      const response = await requestWithRetry(() => buildRequest(model), `${label}:${model}`);
      return { response, model };
    } catch (error) {
      lastError = error;
      const failure = describeGroqFailure(error);

      if (failure.reason === "client-aborted") {
        throw error;
      }

      if (failure.deadModel) {
        markModelDead(model, failure.reason);
      }

      if (failure.reason === "auth") {
        // Every model shares the key. Trying more of them cannot help.
        throw error;
      }

      logEvent(`${label}:model-failed`, { model, reason: failure.reason, next: candidates[candidates.indexOf(model) + 1] || null });
    }
  }

  throw lastError;
};

/* ------------------------------------------------------------------ *
 * 10. Finishing a cut-off answer
 * ------------------------------------------------------------------ */

// The old continuation prompt re-sent the entire original prompt AND the entire
// draft on every one of up to six rounds, so token use grew quadratically and
// tripped the rate limit on exactly the long answers it was trying to rescue.
// Only the tail of the draft is needed to continue from.
const buildContinuationMessages = ({ query, contextDigest, draftAnswer, profile }) => {
  const tail = String(draftAnswer ?? "").slice(-CONTINUATION_TAIL_CHARS);
  const openFence = hasUnbalancedCodeFence(draftAnswer);

  return [
    {
      role: "system",
      content: [
        "You are continuing an answer that was cut off mid-generation.",
        "Output only the missing continuation — no preamble, no apology, and no repetition of text already shown.",
        "Continue from the exact character where the excerpt ends, even if that is mid-sentence or mid-line.",
        "Preserve the same tone, language, formatting, and heading level.",
        openFence
          ? "The excerpt ends inside an unclosed fenced code block. Continue the code and close the fence with ``` when the block is complete."
          : "Close any structure you open.",
        "Stop when the answer is genuinely complete.",
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Original question: ${normalizeText(query)}`,
        contextDigest ? `Relevant context: ${contextDigest}` : "",
        "",
        "End of the answer so far (continue directly after this):",
        "<<<",
        tail,
        ">>>",
      ].filter((line) => line !== null).join("\n"),
    },
  ];
};

const buildContinuationRequest = ({ query, contextDigest, draftAnswer, model, profile, signal }) => {
  const resolvedModel = model || CHAT_MODEL;
  const maxTokens = clampCompletionTokens(resolvedModel, resolveContinuationMaxTokens(profile));
  const sampling = resolveSampling(profile);

  const request = {
    method: "post",
    url: GROQ_URL,
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    data: applyReasoningControls(
      {
        model: resolvedModel,
        messages: buildContinuationMessages({ query, contextDigest, draftAnswer, profile }),
        temperature: Math.min(sampling.temperature, 0.4),
        top_p: sampling.top_p,
        max_tokens: maxTokens,
      },
      resolvedModel,
      profile
    ),
    timeout: REQUEST_TIMEOUT_MS,
  };

  if (signal) {
    request.signal = signal;
  }

  return request;
};

const buildContextDigest = (prompt) => {
  const text = String(prompt ?? "");
  if (!text) return "";
  if (text.length <= CONTEXT_DIGEST_CHARS) return text;
  // The tail of a formatted prompt holds the real question and the answer cue.
  return `...${text.slice(text.length - CONTEXT_DIGEST_CHARS)}`;
};

const completeResponse = async ({ query, prompt, initialContent, model, profile, budget, signal }) => {
  let fullContent = String(initialContent ?? "").replace(/\s+$/, "");

  if (!fullContent) {
    return "";
  }

  const contextDigest = buildContextDigest(prompt);

  for (let round = 0; round < MAX_CONTINUE_ROUNDS; round += 1) {
    const estimatedCost = estimateTokenCount(contextDigest) + resolveContinuationMaxTokens(profile);

    if (budget && !budget.canAfford(estimatedCost)) {
      logEvent("completeResponse:budget-exhausted", { round, spent: budget.spent, limit: budget.limit });
      break;
    }

    let continuation = "";
    let finishReason = "";

    try {
      const { response } = await requestWithModelChain({
        models: [model, CHAT_MODEL, FALLBACK_MODEL, FAST_MODEL],
        label: "completeResponse",
        buildRequest: (candidateModel) => buildContinuationRequest({
          query,
          contextDigest,
          draftAnswer: fullContent,
          model: candidateModel,
          profile,
          signal,
        }),
      });

      const choice = response.data?.choices?.[0] || {};
      continuation = String(choice.message?.content ?? "");
      finishReason = choice.finish_reason || "";

      if (budget) {
        budget.charge(contextDigest + fullContent.slice(-CONTINUATION_TAIL_CHARS), estimateTokenCount(continuation));
      }
    } catch (error) {
      // A continuation failure must never discard content that already
      // generated successfully. Keep what we have and stop extending it.
      if (isAbortError(error)) throw error;
      logGroqFailure("completeResponse:continue", error);
      break;
    }

    const trimmedContinuation = continuation.replace(/^\s+|\s+$/g, "");

    if (!trimmedContinuation) {
      break;
    }

    const tail = fullContent.slice(-CONTINUATION_TAIL_CHARS);

    if (isMostlyRepeat(tail, trimmedContinuation)) {
      logEvent("completeResponse:repetition-stop", { round });
      break;
    }

    const stitched = stitchContinuation(fullContent, continuation);

    if (stitched.length <= fullContent.length) {
      break;
    }

    fullContent = stitched;

    if (finishReason !== "length" && !looksIncomplete(fullContent)) {
      break;
    }
  }

  return fullContent;
};

/* ------------------------------------------------------------------ *
 * 11. Reflection — now gated, budgeted, and reversible
 * ------------------------------------------------------------------ */

const META_PREFIX_PATTERN = /^(?:here(?:'s| is)(?: the)?(?: improved| revised| final| corrected)?(?: answer|version|response)?|improved answer|revised answer|final answer|corrected answer|sure[,!.]|certainly[,!.]|okay[,!.])\b[:\-—]?\s*/i;

const stripMetaPreamble = (text) => String(text ?? "").replace(META_PREFIX_PATTERN, "").replace(/^\s+/, "");

// A local audit decides whether a second round-trip is worth spending. If the
// draft has no detectable problem there is nothing for reflection to fix, and on
// a free-tier key that saved call is the difference between an answer and a 429.
const auditDraft = (draft, profile) => {
  const text = String(draft ?? "");
  const issues = [];

  if (!text.trim()) {
    issues.push("empty");
    return issues;
  }

  if (hasUnbalancedCodeFence(text)) issues.push("unclosed-code-fence");
  if (endsMidSentence(text)) issues.push("ends-mid-sentence");
  if (/\b(?:as an ai|i'?m just an ai|i cannot browse|i don'?t have access to real-?time)\b/i.test(text)) issues.push("boilerplate-disclaimer");
  if (/\b(?:it depends|varies|hard to say)\b/i.test(text) && text.length < 400) issues.push("evasive");
  if (/^(?:great question|good question|certainly|sure[,!])/i.test(text.trim())) issues.push("filler-opening");

  const directives = profile?.directives || {};

  // Did the model actually obey the user's explicit instructions?
  if (directives.lengthMode === "terse" && text.length > 900) issues.push("ignored-terse-request");
  if (directives.lengthMode === "exact" && directives.exactUnit === "sentence" && directives.exactCount) {
    const sentences = (text.match(/[.!?](?:\s|$)/g) || []).length;
    if (sentences > directives.exactCount + 1) issues.push("ignored-sentence-count");
  }
  if (directives.wantsTable && !/\|.*\|/.test(text)) issues.push("missing-requested-table");
  if (directives.wantsBullets && !/(?:^|\n)\s*[-*+]\s+\S/.test(text)) issues.push("missing-requested-bullets");
  if (directives.wantsSteps && !/(?:^|\n)\s*\d+[.)]\s+\S/.test(text)) issues.push("missing-requested-steps");
  if (directives.wantsJson && !/[{[]/.test(text)) issues.push("missing-requested-json");
  if (directives.wantsNoCode && /```/.test(text)) issues.push("included-unwanted-code");
  if (directives.wantsPlainText && /(?:^|\n)#{1,6}\s|\*\*/.test(text)) issues.push("ignored-plain-text-request");

  // Every part of a multi-part question should be visible in the answer.
  if (profile?.partCount >= 3) {
    const answerSegments = (text.match(/(?:^|\n)(?:#{1,6}\s|\*\*|\d+[.)]\s|[-*+]\s)/g) || []).length;
    if (answerSegments < profile.partCount) issues.push("possibly-incomplete-multipart");
  }

  return issues;
};

const shouldReflectAnswer = (profile, { issues = [], budget = null, streaming = false } = {}) => {
  if (!REFLECTION_ENABLED) return false;

  // Reflecting a streamed answer is pointless: the bytes are already on the
  // user's screen and the response has ended. Doing it anyway is what made the
  // stored message differ from the displayed one.
  if (streaming) return false;

  if (profile?.isSmallTalk) return false;
  if (!issues.length) return false;

  const estimatedCost = resolveReflectionMaxTokens(profile) * 2;
  if (budget && !budget.canAfford(estimatedCost)) {
    logEvent("shouldReflectAnswer:budget-exhausted", { spent: budget.spent, limit: budget.limit });
    return false;
  }

  return true;
};

const buildReflectionMessages = ({ query, draftAnswer, contextDigest, profile, issues }) => {
  const rules = profile?.directives?.rules || [];

  return [
    {
      role: "system",
      content: [
        "You are a revision pass for Quantic AI. You return a corrected answer, never a critique.",
        "Return only the final answer text. No preamble, no 'here is the improved answer', no notes about what you changed.",
        "Preserve every fenced code block byte-for-byte unless the code itself is wrong. Never drop, summarise, or reformat code.",
        "Preserve existing Markdown structure — headings, tables, and lists — unless the user asked for something different.",
        "Do not add facts that are not supported by the draft or the provided context.",
        "If the draft is already correct and complete, return it unchanged and verbatim.",
        rules.length
          ? `The user's explicit instructions, which the answer must obey: ${rules.join(" ")}`
          : "",
      ].filter(Boolean).join(" "),
    },
    {
      role: "user",
      content: [
        `Question: ${normalizeText(query)}`,
        contextDigest ? `Context: ${contextDigest}` : "",
        issues.length ? `Problems detected in the draft: ${issues.join(", ")}. Fix these specifically.` : "",
        "",
        "Draft answer:",
        String(draftAnswer ?? ""),
      ].filter(Boolean).join("\n"),
    },
  ];
};

const buildReflectionRequest = ({ query, draftAnswer, contextDigest, profile, issues, model, signal }) => {
  const resolvedModel = model || REFLECTION_MODEL;
  const maxTokens = clampCompletionTokens(resolvedModel, resolveReflectionMaxTokens(profile));

  const request = {
    method: "post",
    url: GROQ_URL,
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    data: applyReasoningControls(
      {
        model: resolvedModel,
        messages: buildReflectionMessages({ query, draftAnswer, contextDigest, profile, issues }),
        temperature: 0.15,
        top_p: 0.9,
        max_tokens: maxTokens,
      },
      resolvedModel,
      profile
    ),
    timeout: REQUEST_TIMEOUT_MS,
  };

  if (signal) {
    request.signal = signal;
  }

  return request;
};

// Reflection used to be trusted unconditionally, so a truncated or over-trimmed
// revision could silently replace a perfectly good answer. Now a revision has to
// earn the swap.
const acceptReflection = (draft, revised, profile) => {
  const draftText = String(draft ?? "");
  const revisedText = String(revised ?? "");

  if (!revisedText.trim()) {
    return { accepted: false, reason: "empty-revision" };
  }

  if (revisedText === draftText) {
    return { accepted: false, reason: "identical" };
  }

  if (hasUnbalancedCodeFence(revisedText) && !hasUnbalancedCodeFence(draftText)) {
    return { accepted: false, reason: "broke-code-fence" };
  }

  const draftFences = countCodeFences(draftText);
  if (draftFences > 0 && countCodeFences(revisedText) < draftFences) {
    return { accepted: false, reason: "dropped-code-block" };
  }

  if (/^\s*(?:i (?:have|'ve) (?:revised|improved|corrected)|the draft|this answer|no changes? (?:are |were )?need)/i.test(revisedText)) {
    return { accepted: false, reason: "returned-a-critique" };
  }

  const shrinkAllowed = profile?.directives?.lengthMode === "terse" ? 0.85 : 0.4;
  if (draftText.length > 400 && revisedText.length < draftText.length * (1 - shrinkAllowed)) {
    return { accepted: false, reason: "over-compressed" };
  }

  if (endsMidSentence(revisedText) && !endsMidSentence(draftText)) {
    return { accepted: false, reason: "revision-truncated" };
  }

  return { accepted: true, reason: "improved" };
};

const reflectAnswer = async ({
  query,
  draftAnswer,
  context = "",
  model,
  complexity = "",
  hasAttachmentAnalysis = false,
  intent = "",
  profile = null,
  budget = null,
  signal = null,
  issues = null,
}) => {
  const draft = String(draftAnswer ?? "").replace(/\s+$/, "");

  if (!draft) {
    return "";
  }

  const resolvedProfile = profile || classifyQuery(query, { complexity, hasAttachmentAnalysis, intent });
  const detectedIssues = Array.isArray(issues) ? issues : auditDraft(draft, resolvedProfile);

  if (!detectedIssues.length) {
    return draft;
  }

  const contextDigest = buildContextDigest(context);

  try {
    const { response, model: usedModel } = await requestWithModelChain({
      models: [model || REFLECTION_MODEL, CHAT_MODEL, FALLBACK_MODEL, FAST_MODEL],
      label: "reflectAnswer",
      buildRequest: (candidateModel) => buildReflectionRequest({
        query,
        draftAnswer: draft,
        contextDigest,
        profile: resolvedProfile,
        issues: detectedIssues,
        model: candidateModel,
        signal,
      }),
    });

    const choice = response.data?.choices?.[0] || {};
    const revised = stripMetaPreamble(String(choice.message?.content ?? "").replace(/\s+$/, ""));
    const finishReason = choice.finish_reason || "";

    if (budget) {
      budget.charge(contextDigest + draft, estimateTokenCount(revised));
    }

    // A revision cut off by the token ceiling is worse than the draft. Do not
    // spend more calls stitching it — just keep the draft.
    if (finishReason === "length") {
      logEvent("reflectAnswer:rejected", { reason: "revision-hit-token-limit", model: usedModel });
      return draft;
    }

    const verdict = acceptReflection(draft, revised, resolvedProfile);

    if (!verdict.accepted) {
      logEvent("reflectAnswer:rejected", { reason: verdict.reason, model: usedModel });
      return draft;
    }

    logEvent("reflectAnswer:accepted", {
      model: usedModel,
      issues: detectedIssues,
      draftChars: draft.length,
      revisedChars: revised.length,
    });

    return revised;
  } catch (error) {
    if (isAbortError(error)) return draft;
    logGroqFailure("reflectAnswer", error);
    return draft;
  }
};

/* ------------------------------------------------------------------ *
 * 12. Reasoning-token leak filter
 * ------------------------------------------------------------------ */

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

// Reasoning models sometimes emit their chain of thought inline even with
// reasoning_format set. Streaming that straight to the user looks like a bug, so
// strip it as it arrives — including tags split across two chunks.
const createThinkFilter = (model) => {
  const enabled = /qwen3|deepseek-r1|reasoning|thinking/.test(String(model || "").toLowerCase());
  let pending = "";
  let inside = false;

  const heldTagLength = (text) => {
    const maxTag = Math.max(THINK_OPEN.length, THINK_CLOSE.length) - 1;

    for (let size = Math.min(maxTag, text.length); size > 0; size -= 1) {
      const tail = text.slice(text.length - size);
      if (THINK_OPEN.startsWith(tail) || THINK_CLOSE.startsWith(tail)) {
        return size;
      }
    }

    return 0;
  };

  return {
    enabled,
    push(chunk) {
      if (!enabled) {
        return String(chunk ?? "");
      }

      pending += String(chunk ?? "");
      let visible = "";
      let guard = 0;

      while (guard < 2000) {
        guard += 1;

        if (inside) {
          const closeIndex = pending.indexOf(THINK_CLOSE);
          if (closeIndex === -1) break;
          pending = pending.slice(closeIndex + THINK_CLOSE.length);
          inside = false;
          continue;
        }

        const openIndex = pending.indexOf(THINK_OPEN);
        if (openIndex === -1) break;
        visible += pending.slice(0, openIndex);
        pending = pending.slice(openIndex + THINK_OPEN.length);
        inside = true;
      }

      if (inside) {
        // Keep only enough to catch a closing tag split across chunks.
        if (pending.length >= THINK_CLOSE.length) {
          pending = pending.slice(-(THINK_CLOSE.length - 1));
        }
        return visible;
      }

      const hold = heldTagLength(pending);
      visible += pending.slice(0, pending.length - hold);
      pending = pending.slice(pending.length - hold);

      return visible;
    },
    flush() {
      if (!enabled) return "";
      if (inside) {
        pending = "";
        return "";
      }
      const remaining = pending;
      pending = "";
      return remaining;
    },
  };
};

/* ------------------------------------------------------------------ *
 * 13. Public API — non-streaming
 * ------------------------------------------------------------------ */

const extractChoiceText = (response) => {
  const choice = response?.data?.choices?.[0] || {};
  return {
    content: String(choice.message?.content ?? ""),
    finishReason: choice.finish_reason || "",
  };
};

const generateGroqResponse = async (prompt, query, model, options = {}) => {
  const profile = classifyQuery(query, options);
  const budget = createTurnBudget(options?.maxTurnTokens || MAX_TURN_TOKENS);
  const signal = options?.signal || null;

  logEvent("generateGroqResponse:start", {
    query: normalizeText(query).slice(0, 120),
    kind: profile.kind,
    lengthMode: profile.directives.lengthMode,
    parts: profile.partCount,
    language: profile.directives.language.requested || profile.directives.language.detected || "default",
  });

  let lastFailure = null;

  try {
    const models = options?.visionOnly ? await resolveVisionModelChain(model) : await resolveModelChain(profile, model);
    const maxTokens = resolveMaxTokens(profile);

    const { response, model: usedModel } = await requestWithModelChain({
      models,
      label: "generateGroqResponse",
      buildRequest: (candidateModel) => buildChatRequest({
        prompt,
        stream: false,
        model: candidateModel,
        maxTokens,
        profile,
        options,
        signal,
      }),
    });

    let { content, finishReason } = extractChoiceText(response);
    budget.charge(prompt, estimateTokenCount(content));

    // A reasoning model can spend its whole completion allowance on hidden
    // reasoning and return an empty message. Retry once on the fast model
    // rather than handing the user a blank reply.
    if (!content.trim() && isModelUsable(FAST_MODEL) && FAST_MODEL !== usedModel) {
      logEvent("generateGroqResponse:empty-content-retry", { from: usedModel, to: FAST_MODEL, finishReason });

      const retry = await requestWithModelChain({
        models: [FAST_MODEL, FALLBACK_MODEL],
        label: "generateGroqResponse:retry",
        buildRequest: (candidateModel) => buildChatRequest({
          prompt,
          stream: false,
          model: candidateModel,
          maxTokens,
          profile,
          options,
          signal,
        }),
      });

      const retried = extractChoiceText(retry.response);
      content = retried.content;
      finishReason = retried.finishReason;
      budget.charge(prompt, estimateTokenCount(content));
    }

    logEvent("generateGroqResponse:success", {
      model: usedModel,
      contentLength: content.length,
      finishReason,
      spentTokens: budget.spent,
    });

    let answer = content.replace(/\s+$/, "");

    if (answer && (finishReason === "length" || looksIncomplete(answer))) {
      answer = await completeResponse({
        query,
        prompt,
        initialContent: answer,
        model: usedModel,
        profile,
        budget,
        signal,
      });
    }

    if (!answer.trim()) {
      return buildFallbackReply({ reason: "unknown" });
    }

    const issues = auditDraft(answer, profile);

    if (!shouldReflectAnswer(profile, { issues, budget, streaming: false })) {
      logEvent("generateGroqResponse:no-reflection", { issues, spentTokens: budget.spent });
      return answer;
    }

    const improved = await reflectAnswer({
      query,
      draftAnswer: answer,
      context: prompt,
      model: REFLECTION_MODEL,
      profile,
      budget,
      signal,
      issues,
    });

    logEvent("generateGroqResponse:reflected", {
      changed: improved !== answer,
      contentLength: improved.length,
      spentTokens: budget.spent,
    });

    return improved || answer;
  } catch (error) {
    if (isAbortError(error)) {
      logEvent("generateGroqResponse:aborted", {});
      return "";
    }

    lastFailure = logGroqFailure("generateGroqResponse:final", error);
    return buildFallbackReply(lastFailure);
  }
};

/* ------------------------------------------------------------------ *
 * 14. Public API — streaming
 * ------------------------------------------------------------------ */

// Returns exactly the text that was written to the response, so whatever is
// persisted matches what the user actually saw. The previous version reflected
// the answer *after* res.end(), returning improved text that had never been
// sent — which is why a message could change on reload.
const streamGroqResponse = async (prompt, res, query, model, options = {}) => {
  const profile = classifyQuery(query, options);
  const budget = createTurnBudget(options?.maxTurnTokens || MAX_TURN_TOKENS);
  const controller = new AbortController();

  logEvent("streamGroqResponse:start", {
    query: normalizeText(query).slice(0, 120),
    kind: profile.kind,
    lengthMode: profile.directives.lengthMode,
    parts: profile.partCount,
    language: profile.directives.language.requested || profile.directives.language.detected || "default",
  });

  let clientGone = false;

  // Without this, closing the tab or pressing stop left the generation running
  // and kept spending tokens against the rate limit.
  const onClientClose = () => {
    if (clientGone) return;
    clientGone = true;
    logEvent("streamGroqResponse:client-disconnected", {});
    controller.abort();
  };

  res.on("close", onClientClose);

  try {
    const models = options?.visionOnly ? await resolveVisionModelChain(model) : await resolveModelChain(profile, model);
    const maxTokens = resolveMaxTokens(profile);

    const { response, model: usedModel } = await requestWithModelChain({
      models,
      label: "streamGroqResponse",
      buildRequest: (candidateModel) => buildChatRequest({
        prompt,
        stream: true,
        model: candidateModel,
        maxTokens,
        profile,
        options,
        signal: controller.signal,
      }),
    });

    const streamed = await new Promise((resolve) => {
      const thinkFilter = createThinkFilter(usedModel);
      let fullContent = "";
      let lastFinishReason = "";
      let buffer = "";
      let streamError = null;
      let finished = false;
      let continuing = false;
      let idleTimer = null;
      let hardTimer = null;

      const clearTimers = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = null;
        if (hardTimer) clearTimeout(hardTimer);
        hardTimer = null;
      };

      // The only place bytes leave this function. fullContent advances *only*
      // when the write really happened, so the string returned for persistence
      // can never drift from what the browser was shown.
      const emit = (text) => {
        if (!text || clientGone || res.writableEnded) return false;
        res.write(text);
        fullContent += text;
        return true;
      };

      const finish = (fallbackText = "") => {
        if (finished) return;
        finished = true;
        clearTimers();

        emit(thinkFilter.flush());

        if (!res.writableEnded) {
          res.end();
        }

        resolve(fullContent || fallbackText);
      };

      // Only what was actually appended gets written, so the returned string and
      // the bytes on the wire stay identical.
      const appendContinuation = (completed) => {
        // If the user hit stop while the continuation was in flight, drop it
        // rather than storing text that was never displayed.
        if (clientGone || res.writableEnded) return;
        if (!completed || completed.length <= fullContent.length) return;

        let delta;
        if (completed.startsWith(fullContent)) {
          delta = completed.slice(fullContent.length);
        } else {
          let index = 0;
          while (index < fullContent.length && index < completed.length && fullContent[index] === completed[index]) {
            index += 1;
          }
          delta = completed.slice(index);
        }

        if (!delta) return;

        emit(delta);
      };

      const settle = async ({ timedOut = false } = {}) => {
        if (finished || continuing) return;

        if (clientGone) {
          finish();
          return;
        }

        const incomplete = Boolean(fullContent) && (timedOut || lastFinishReason === "length" || looksIncomplete(fullContent));

        if (incomplete) {
          continuing = true;

          try {
            const completed = await completeResponse({
              query,
              prompt,
              initialContent: fullContent,
              model: usedModel,
              profile,
              budget,
              signal: controller.signal,
            });

            appendContinuation(completed);
          } catch (error) {
            if (!isAbortError(error)) {
              logGroqFailure("streamGroqResponse:continue", error);
            }
          }

          continuing = false;
        }

        if (!fullContent && streamError) {
          const failure = describeGroqFailure(streamError);
          const fallback = buildFallbackReply(failure);
          emit(fallback);
          finish(fallback);
          return;
        }

        finish(fullContent ? "" : buildFallbackReply({ reason: "unknown" }));
      };

      hardTimer = setTimeout(() => {
        logEvent("streamGroqResponse:hard-timeout", { model: usedModel, contentLength: fullContent.length });
        void settle({ timedOut: true });
      }, STREAM_MAX_MS);

      // An idle timer, not a total-duration timer. The old 45s cap cut off long
      // but perfectly healthy answers and forced an unnecessary continuation.
      const armIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          logEvent("streamGroqResponse:idle-timeout", { model: usedModel, contentLength: fullContent.length });
          void settle({ timedOut: true });
        }, STREAM_IDLE_TIMEOUT_MS);
      };

      armIdleTimer();

      response.data.on("data", (chunk) => {
        armIdleTimer();
        buffer += chunk.toString("utf8");
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmedLine = line.trim();
          if (!trimmedLine || !trimmedLine.startsWith("data:")) continue;

          const payload = trimmedLine.slice(5).trim();

          if (payload === "[DONE]") {
            logEvent("streamGroqResponse:done", { model: usedModel, contentLength: fullContent.length });
            void settle();
            return;
          }

          let parsed;

          try {
            parsed = JSON.parse(payload);
          } catch {
            logEvent("streamGroqResponse:unparsable-chunk", { model: usedModel, sample: payload.slice(0, 120) });
            continue;
          }

          // Groq can deliver a mid-stream error frame. The old catch-all
          // swallowed it as an "ignored chunk" and the user got a truncated
          // answer with no explanation anywhere.
          if (parsed?.error) {
            streamError = { response: { status: parsed.error.status || 0, data: { error: parsed.error } } };
            logEvent("streamGroqResponse:error-frame", { model: usedModel, error: parsed.error });
            void settle();
            return;
          }

          const choice = Array.isArray(parsed?.choices) ? parsed.choices[0] : null;
          if (!choice) continue;

          if (choice.finish_reason) {
            lastFinishReason = choice.finish_reason;
          }

          const delta = choice.delta?.content;
          if (!delta) continue;

          const visible = thinkFilter.push(delta);
          if (!visible) continue;

          emit(visible);
        }
      });

      response.data.on("end", () => {
        logEvent("streamGroqResponse:end", {
          model: usedModel,
          contentLength: fullContent.length,
          finishReason: lastFinishReason,
        });
        void settle();
      });

      response.data.on("error", (error) => {
        if (isAbortError(error) || clientGone) {
          logEvent("streamGroqResponse:aborted-mid-stream", { contentLength: fullContent.length });
          finish();
          return;
        }

        streamError = error;
        logGroqFailure("streamGroqResponse:stream-error", error);
        void settle();
      });

      if (clientGone) {
        response.data.destroy();
        finish();
      }
    });

    budget.charge(prompt, estimateTokenCount(streamed));

    logEvent("streamGroqResponse:complete", {
      model: usedModel,
      contentLength: streamed.length,
      spentTokens: budget.spent,
      reflected: false,
    });

    return streamed || buildFallbackReply({ reason: "unknown" });
  } catch (error) {
    if (isAbortError(error) || clientGone) {
      logEvent("streamGroqResponse:aborted", {});
      if (!res.writableEnded) res.end();
      return "";
    }

    const failure = logGroqFailure("streamGroqResponse:final", error);
    const fallback = buildFallbackReply(failure);

    if (!res.writableEnded) {
      res.write(fallback);
      res.end();
    }

    return fallback;
  } finally {
    res.removeListener("close", onClientClose);
  }
};

/* ------------------------------------------------------------------ *
 * 15. Sidebar titles
 * ------------------------------------------------------------------ */

const TITLE_MODEL = process.env.GROQ_TITLE_MODEL || FAST_MODEL;
const TITLE_MAX_TOKENS = envNumber("GROQ_TITLE_MAX_TOKENS", 512);
const TITLE_FALLBACK_MODELS = envList("GROQ_TITLE_FALLBACK_MODELS", "llama-3.1-8b-instant,llama-3.3-70b-versatile");

const TITLE_SYSTEM_PROMPT = [
  "You write the sidebar title for a chat conversation.",
  "Read the user's message and reply with ONLY a 3-6 word title in Title Case that names the actual subject of the request.",
  "Never answer the question, never explain, never add commentary. Output the title and nothing else.",
  "Plain text only: no quotes, no trailing punctuation, no 'Title:' prefix, no markdown, no links, no [text](url) syntax, no #, * or _ characters.",
  "",
  "Examples:",
  "how do JWT refresh tokens work in express -> Express JWT Refresh Tokens",
  "what's the weather in kolkata tomorrow -> Kolkata Weather Tomorrow",
  "write me a short rap about my cat -> Short Rap About My Cat",
  "my sidebar titles aren't generating, here's my controller -> Sidebar Title Generation Bug",
].join("\n");

const buildTitleRequest = (message, model) => {
  const resolvedModel = model || TITLE_MODEL;

  return {
    method: "post",
    url: GROQ_URL,
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    data: applyReasoningControls(
      {
        model: resolvedModel,
        messages: [
          { role: "system", content: TITLE_SYSTEM_PROMPT },
          {
            role: "user",
            content: `Write the sidebar title for this message:\n\n${String(message ?? "").trim().slice(0, 500)}`,
          },
        ],
        temperature: 0.2,
        max_tokens: clampCompletionTokens(resolvedModel, TITLE_MAX_TOKENS),
      },
      resolvedModel
    ),
    timeout: REQUEST_TIMEOUT_MS,
  };
};

// Some models preface or trail the title with chatter. Prefer the first short line.
const pickTitleLine = (value) => {
  const lines = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (!lines.length) {
    return "";
  }

  return lines.find((line) => line.split(/\s+/).filter(Boolean).length <= 10) || lines[0];
};

const sanitizeGeneratedTitle = (value) => normalizeText(value)
  .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  .replace(/^#{1,6}\s+/, "")
  .replace(/^[-*+]\s+/, "")
  .replace(/^\d+\.\s+/, "")
  .replace(/\*\*(.*?)\*\*/g, "$1")
  .replace(/\*(.*?)\*/g, "$1")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/_([^_]+)_/g, "$1")
  .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
  .replace(/^\s*(?:chat\s+)?title\s*[:\-–—]\s*/i, "")
  .replace(/^[-–—>\s]+/, "")
  .replace(/[.!?]+$/g, "")
  .replace(/\s+/g, " ")
  .trim();

const clampTitleWords = (value, maxWords = 6) => normalizeText(value)
  .split(/\s+/)
  .filter(Boolean)
  .slice(0, maxWords)
  .join(" ");

const TITLE_STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "if", "of", "for", "to", "in", "on", "at", "by",
  "with", "from", "about", "into", "over", "after", "is", "are", "was", "were", "be",
  "do", "does", "did", "can", "could", "should", "would", "will", "may", "might",
  "have", "has", "had", "i", "me", "my", "you", "your", "we", "our", "us", "it", "its",
  "this", "that", "these", "those", "vs",
]);

const toTitleCase = (value) => normalizeText(value)
  .split(/\s+/)
  .filter(Boolean)
  .map((word, index) => (index === 0 || !TITLE_STOP_WORDS.has(word.toLowerCase())
    ? word.charAt(0).toUpperCase() + word.slice(1)
    : word.toLowerCase()))
  .join(" ");

// Last-resort local headline: strips the filler opener off the question and
// title-cases the remaining subject.
const buildHeuristicTitle = (message) => {
  const normalizedMessage = normalizeText(message);

  if (!normalizedMessage) {
    return "";
  }

  const firstSentence = normalizedMessage.split(/\r?\n|(?<=[.?!])\s+/)[0] || normalizedMessage;
  const cleaned = sanitizeGeneratedTitle(firstSentence)
    .replace(/^(?:hey|hi|hello)\b[\s,]*/i, "")
    .replace(/^(?:please|kindly)\s+/i, "")
    .replace(/^(?:can|could|would|will)\s+(?:you\s+)?(?:please\s+)?/i, "")
    .replace(/^i\s+(?:want|need|would\s+like)\s+(?:to\s+)?(?:know\s+)?(?:about\s+)?/i, "")
    .replace(/^(?:tell|explain|show|give|help|write|make|create|build|fix)\s+(?:me\s+)?(?:about\s+|with\s+)?/i, "")
    .replace(/^(?:what|which|who|whose|when|where|why|how)\s+(?:is|are|was|were|do|does|did|can|should|would)?\s*/i, "")
    .replace(/^(?:the|a|an)\s+/i, "")
    .trim();

  const subject = clampTitleWords(cleaned || normalizedMessage);
  return subject ? toTitleCase(subject) : "";
};

const requestTitleFromModel = async (message, model, label) => {
  const response = await requestWithRetry(() => buildTitleRequest(message, model), label);
  const choice = response.data?.choices?.[0] || {};
  const title = clampTitleWords(sanitizeGeneratedTitle(pickTitleLine(choice.message?.content || "")));

  if (!title) {
    // Empty content with finish_reason "length" is the reasoning-token symptom.
    logEvent(`${label}:empty-content`, { model, finishReason: choice.finish_reason || "" });
  }

  return title;
};

const generateChatTitle = async (message, preferredModel = "") => {
  const normalizedMessage = normalizeText(message);

  if (!normalizedMessage) {
    return "";
  }

  const candidateModels = [preferredModel, TITLE_MODEL, ...TITLE_FALLBACK_MODELS, FAST_MODEL, FALLBACK_MODEL]
    .map((entry) => normalizeText(entry))
    .filter(Boolean)
    .filter((entry, index, list) => list.indexOf(entry) === index)
    .filter(isModelUsable);

  for (const candidateModel of candidateModels) {
    try {
      const title = await requestTitleFromModel(normalizedMessage, candidateModel, "generateChatTitle");

      if (title) {
        logEvent("generateChatTitle:success", { model: candidateModel, title });
        return title;
      }
    } catch (error) {
      const failure = logGroqFailure(`generateChatTitle:${candidateModel}`, error);

      if (failure.deadModel) {
        markModelDead(candidateModel, failure.reason);
      }

      if (failure.reason === "auth") {
        break;
      }
    }
  }

  const heuristicTitle = buildHeuristicTitle(normalizedMessage);
  logEvent("generateChatTitle:heuristic-fallback", { title: heuristicTitle });
  return heuristicTitle;
};


const SEARCH_QUERY_MODEL = process.env.GROQ_SEARCH_QUERY_MODEL || TITLE_MODEL;
const SEARCH_QUERY_TIMEOUT_MS = envNumber("GROQ_SEARCH_QUERY_TIMEOUT_MS", 6000);

const SEARCH_QUERY_SYSTEM_PROMPT = [
  "You turn a chat message into ONE web search query.",
  "Use the recent conversation to replace pronouns and vague references (he, she, it, they, his, their, that, there, 'the second one') with the real names they refer to.",
  "Keep everything the user is asking for: names, places, dates, numbers, and words such as current, latest, today, net worth, price.",
  "Prefer plain keywords a search engine handles well. Do not answer the question, add facts, add quotes, or add search operators.",
  "Reply with ONLY the query on one line, 3 to 14 words.",
  "",
  "Examples:",
  "Recent conversation:",
  "user: who is the richest person in the world?",
  "assistant: The person most often cited is Elon Musk.",
  "Message: his current networth?",
  "Search query: Elon Musk current net worth",
  "",
  "Recent conversation:",
  "user: tell me about the iPhone 16",
  "assistant: The iPhone 16 is Apple's 2024 flagship phone.",
  "Message: what's the price in India?",
  "Search query: iPhone 16 price in India",
  "",
  "Recent conversation:",
  "(none)",
  "Message: today's news from west bengal?",
  "Search query: West Bengal news today",
].join("\n");

const formatConversationForQuery = (conversation, message) => {
  const turns = (Array.isArray(conversation) ? conversation : [])
    .map((entry) => ({ role: normalizeText(entry?.role).toLowerCase(), content: normalizeText(entry?.content) }))
    .filter((entry) => entry.content && (entry.role === "user" || entry.role === "assistant"));

  // The current message is sometimes already the last turn of the history.
  const last = turns[turns.length - 1];
  if (last && last.role === "user" && last.content === normalizeText(message)) {
    turns.pop();
  }

  return turns
    .slice(-4)
    .map((entry) => `${entry.role}: ${entry.content.slice(0, 350)}`)
    .join("\n");
};

const sanitizeSearchQuery = (value) => {
  const firstLine = String(value ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";

  const cleaned = firstLine
    .replace(/^(?:search\s*query|query)\s*[:\-]\s*/i, "")
    .replace(/^["'`\u201C\u201D\u2018\u2019]+|["'`\u201C\u201D\u2018\u2019]+$/g, "")
    .replace(/[*_#>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const wordCount = cleaned.split(/\s+/).filter(Boolean).length;

  // Anything longer than a query is the model answering instead of rewriting.
  if (!cleaned || wordCount > 18 || cleaned.length > 160) {
    return "";
  }

  return cleaned;
};

const buildSearchQueryRequest = (message, context, model) => ({
  method: "post",
  url: GROQ_URL,
  headers: {
    Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    "Content-Type": "application/json",
  },
  data: applyReasoningControls(
    {
      model,
      messages: [
        { role: "system", content: SEARCH_QUERY_SYSTEM_PROMPT },
        { role: "user", content: `Recent conversation:\n${context || "(none)"}\nMessage: ${message}\nSearch query:` },
      ],
      temperature: 0,
      // Reasoning models spend hidden tokens before the visible answer.
      max_tokens: clampCompletionTokens(model, 512),
    },
    model
  ),
  timeout: SEARCH_QUERY_TIMEOUT_MS,
});

const rewriteSearchQuery = async (message, conversation = []) => {
  const normalizedMessage = normalizeText(message);

  if (!normalizedMessage || !process.env.GROQ_API_KEY) {
    return "";
  }

  const context = formatConversationForQuery(conversation, normalizedMessage);

  // Nothing earlier in the chat to resolve against.
  if (!context) {
    return "";
  }

  const candidateModels = [SEARCH_QUERY_MODEL, FAST_MODEL, FALLBACK_MODEL]
    .map((entry) => normalizeText(entry))
    .filter(Boolean)
    .filter((entry, index, list) => list.indexOf(entry) === index)
    .filter(isModelUsable)
    .slice(0, 2);

  for (const candidateModel of candidateModels) {
    try {
      const response = await axios(buildSearchQueryRequest(normalizedMessage, context, candidateModel));
      const query = sanitizeSearchQuery(response.data?.choices?.[0]?.message?.content);

      if (query) {
        logEvent("rewriteSearchQuery:success", { model: candidateModel, from: normalizedMessage.slice(0, 80), to: query });
        return query;
      }
    } catch (error) {
      const failure = logGroqFailure(`rewriteSearchQuery:${candidateModel}`, error);

      if (failure.deadModel) {
        markModelDead(candidateModel, failure.reason);
      }

      if (failure.reason === "auth") {
        break;
      }
    }
  }

  return "";
};

/* ------------------------------------------------------------------ *
 * 16. Boot self-test
 * ------------------------------------------------------------------ */

// Call this once from server startup. It turns "every answer is the fallback
// message" into a single explicit line in the boot log naming the cause.
const verifyGroqSetup = async () => {
  const report = {
    ok: false,
    hasApiKey: Boolean(process.env.GROQ_API_KEY),
    configured: {
      chat: CHAT_MODEL,
      reasoning: REASONING_MODEL,
      creative: CREATIVE_MODEL,
      fast: FAST_MODEL,
      fallback: FALLBACK_MODEL,
      reflection: REFLECTION_MODEL,
      title: TITLE_MODEL,
    },
    missing: [],
    availableCount: 0,
  };

  if (!report.hasApiKey) {
    logEvent("verifyGroqSetup:no-api-key", { hint: "GROQ_API_KEY is not set — every request will fail with an auth error." });
    return report;
  }

  const available = await fetchAvailableModels();

  if (!available) {
    logEvent("verifyGroqSetup:probe-failed", { hint: "Could not list models. Check the key, the network, and Groq status." });
    return report;
  }

  report.availableCount = available.size;
  report.missing = Object.entries(report.configured)
    .filter(([, model]) => model && !available.has(model))
    .map(([tier, model]) => `${tier}=${model}`);

  for (const entry of report.missing) {
    markModelDead(entry.split("=")[1], "missing at boot");
  }

  report.ok = report.missing.length === 0;

  logEvent("verifyGroqSetup:done", report);
  return report;
};

module.exports = {
  generateGroqResponse,
  streamGroqResponse,
  reflectAnswer,
  generateChatTitle,
  buildHeuristicTitle,
  rewriteSearchQuery,
  verifyGroqSetup,
  classifyQuery,
  extractOutputDirectives,
  auditDraft,
  acceptReflection,
  stitchContinuation,
  buildFallbackReply,
  describeGroqFailure,
};
