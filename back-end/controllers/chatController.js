//back-end/controllers/chatController.js
const mongoose = require("mongoose");
const sharp = require("sharp");
const User = require("../models/LoginModel.js");
const Settings = require("../models/SettingsModel.js");
const Chat = require("../models/ChatModel.js");
const Message = require("../models/MessageModel.js");
const { buildPrompt } = require("../rag/ragPipeline.js");
const { generateGroqResponse, streamGroqResponse, generateChatTitle, buildHeuristicTitle, rewriteSearchQuery } = require("../services/llmService.js");
const { recognize } = require("tesseract.js");
const { PDFParse } = require("pdf-parse");
const officeParser = require("officeparser");
const {
	extractMemory,
	saveMemory,
	buildMemoryLayerContext,
	deleteLocationMemories,
} = require("../services/memoryService.js");
const { responsePlanner } = require("../brain/responsePlanner.js");
const { executeTool } = require("../brain/tools.js");
const { searchWebDetailed, formatWebSearchContext } = require("../services/webSearch.js");
const imageService = require("../services/imageService.js");
const { getSystemSettings } = require("../models/SystemSettingsModel.js");

const logger = console;

// const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || process.env.GROQ_MODEL-2 || process.env.GROQ_MODEL-3 || process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || "openai/gpt-oss-120b";

const REASONING_MODEL = process.env.GROQ_REASONING_MODEL || "qwen/qwen3.6-27b";

const selectModel = (message, intent, complexity) => {
	const normalizedComplexity = String(complexity || "").toLowerCase();

	if (normalizedComplexity === "complex" || normalizedComplexity === "coding") {
		return REASONING_MODEL;
	}

	return CHAT_MODEL;
};

const normalizeText = (value) => String(value ?? "").trim();

const countWebContextSources = (webContext) => {
	if (!webContext || webContext === "WEB_SEARCH_FAILED") {
		return 0;
	}

	const matches = String(webContext).match(/^Source \d+\s*\|/gm) || [];
	return matches.length;
};

// ---------------------------------------------------------------------------
// Trusted citation sources.
// The model is never allowed to supply citation URLs: it truncates, mangles and
// invents them (-> 404s). The real URLs come from the search results we handed
// it, are sent to the client in a marker at the start of the reply, and each
// "[Source N]" badge looks its link up by number.
// ---------------------------------------------------------------------------
const SOURCES_MARKER_PREFIX = "<!--SRC:";
const SOURCES_MARKER_PATTERN = /^<!--SRC:[\s\S]*?-->\r?\n?/;

const extractWebSources = (webContext) => {
	if (!webContext || webContext === "WEB_SEARCH_FAILED") {
		return [];
	}

	const sources = [];

	for (const line of String(webContext).split(/\r?\n/)) {
		const head = line.match(/^Source (\d+)\s*\|/);
		const urlMatch = line.match(/\|\s*URL:\s*(https?:\/\/\S+)\s*$/);

		if (!head || !urlMatch) continue;

		const titleMatch = line.match(/\|\s*Title:\s*(.*?)\s*(?:\||$)/);
		sources.push({
			n: Number(head[1]),
			url: urlMatch[1],
			title: titleMatch ? titleMatch[1].slice(0, 160) : "",
		});
	}

	return sources;
};

const buildSourcesMarker = (sources) => {
	if (!Array.isArray(sources) || !sources.length) {
		return "";
	}

	// "<" / ">" are escaped so the JSON can never contain the closing "-->".
	const json = JSON.stringify(sources).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
	return `${SOURCES_MARKER_PREFIX}${json}-->\n`;
};

const stripSourcesMarker = (text) => String(text ?? "").replace(SOURCES_MARKER_PATTERN, "");

const sanitizeCitationFormatting = (text, sourceCount = 0) => {
	let cleaned = normalizeText(text);

	cleaned = cleaned.replace(/[【\[［「]\s*source\s*(\d+)\s*[】\]］」]/gi, "[Source $1]");
	cleaned = cleaned.replace(/\[\s*source\s*(\d+)\s*\]/gi, "[Source $1]");
	cleaned = cleaned.replace(/(\[Source\s*\d+\]\s*\(https?:\/\/[^\s)]+\))\s*[】\]］」]/gi, "$1");

	// Handle multi-digit citations like [Source 12] - split them into individual citations
	cleaned = cleaned.replace(/\[Source\s*(\d{2,})\]/gi, (match, digits) => {
		const asSingleNumber = Number(digits);
		if (sourceCount && asSingleNumber <= sourceCount) {
			return `[Source ${asSingleNumber}]`;
		}

		const parts = digits.split("");
		const allValid = parts.every((digit) => {
			const num = Number(digit);
			return num >= 1 && (!sourceCount || num <= sourceCount);
		});

		// Return properly formatted citations with correct numbering
		if (allValid) {
			return parts.map((digit) => `[Source ${digit}]`).join(" ");
		}
		return match;
	});

	// Citations are bare "[Source N]" tags. Any URL the model attached is dropped
	// (even a half-open "(https://..." one) - see the trusted sources note above.
	cleaned = cleaned.replace(/\\\[\s*(source\s*\d+)\s*\\\]/gi, "[$1]");
	cleaned = cleaned.replace(/\[Source\s*(\d+)\]\s*\(\s*https?:\/\/[^\s)]*\)?/gi, "[Source $1]");
	cleaned = cleaned.replace(/(\[Source \d+\])\s*\1/gi, "$1");
	cleaned = cleaned.replace(/\](\s*)\[/g, "] [$1");
	cleaned = cleaned.replace(/\[Source\s*(\d+)\s*\]/gi, "[Source $1]");

	return cleaned.trim();
};

const MAX_PDF_OCR_PAGES = 4;
const MAX_PDF_OCR_TEXT_LENGTH = 6000;
const TEXT_ANALYSIS_LIMIT = 20000;
const CODE_TEXT_ANALYSIS_LIMIT = 120000;

const CASUAL_GREETING_PATTERN = /\b(hello|hi|hey|good morning|good afternoon|good evening)\b/i;
const HOW_ARE_YOU_PATTERN = /\bhow\s*(?:are|r)\s*(?:you|u)\b/i;

const buildConversationalPrefix = (message) => {
	const normalized = normalizeText(message);
	const hasGreeting = CASUAL_GREETING_PATTERN.test(normalized);
	const hasHowAreYou = HOW_ARE_YOU_PATTERN.test(normalized);

	if (hasGreeting && hasHowAreYou) {
		return `${getTimeOfDayGreeting()}! I'm doing great, thanks for asking.`;
	}
	if (hasHowAreYou) {
		return "I'm doing great, thanks for asking!";
	}
	if (hasGreeting) {
		return `${getTimeOfDayGreeting()}!`;
	}
	return "";
};

const OFFICE_DOCUMENT_MIME_TYPES = new Set([
	"application/msword",
	"application/x-msword",
	"application/vnd.ms-word",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.ms-excel",
	"application/x-msexcel",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.ms-powerpoint",
	"application/x-mspowerpoint",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"application/vnd.oasis.opendocument.text",
	"application/vnd.oasis.opendocument.spreadsheet",
	"application/vnd.oasis.opendocument.presentation",
	"application/rtf",
	"text/rtf",
]);

const OFFICE_DOCUMENT_EXTENSIONS = new Set([
	"doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "ods", "odp", "rtf",
]);

const CODE_FILE_EXTENSIONS = new Set([
	"js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "java", "c", "h", "cpp", "cc", "hpp",
	"cs", "go", "rs", "rb", "php", "swift", "kt", "kts", "scala", "sql", "sh", "bash",
	"yml", "yaml", "toml", "ini", "env", "md", "css", "scss", "less", "vue",
	"svelte", "json5", "graphql", "proto", "gradle", "r", "pl", "lua",
	"txt", "text", "log", "csv", "tsv", "json", "xml", "html", "htm", "xhtml",
	"properties", "conf", "cfg", "config", "makefile", "dockerfile", "bat", "cmd", "ps1",
	"ipynb", "tex", "bib", "diff", "patch", "gitignore", "editorconfig",
]);

const isCodeFileAttachment = (attachment) => CODE_FILE_EXTENSIONS.has(getAttachmentExtension(attachment));

const normalizeMessageAttachments = (attachments) => {
	if (!Array.isArray(attachments)) {
		return [];
	}

	return attachments
		.map((attachment) => {
			const key = normalizeText(attachment?.key);
			const name = normalizeText(attachment?.name);
			const dataUrl = String(attachment?.dataUrl || "").trim(); // Preserve dataUrl carefully

			if (!key || !name || !dataUrl) {
				return null;
			}

			return {
				key,
				name,
				size: Number.isFinite(Number(attachment?.size)) ? Number(attachment.size) : 0,
				type: normalizeText(attachment?.type),
				dataUrl,
			};
		})
		.filter(Boolean);
};

const extractLegacyImageAttachment = (content) => {
	const normalizedContent = normalizeText(content);

	if (!normalizedContent) {
		return null;
	}

	// Test for raw base64 data URL (most common format)
	if (/^data:image\/[a-z0-9.+\-]+;base64,/i.test(normalizedContent) && normalizedContent.includes("data:image/")) {
		return {
			key: `legacy-image-${normalizedContent.length}`,
			name: "Generated image",
			size: normalizedContent.length,
			type: "image/png",
			dataUrl: normalizedContent,
		};
	}

	// Test for markdown image syntax with data URL
	const markdownMatch = normalizedContent.match(/^!\[[^\]]*\]\((data:image\/[a-z0-9.+\-]+;base64,[^)]+)\)$/i);
	if (markdownMatch?.[1]) {
		return {
			key: `legacy-image-${markdownMatch[1].length}`,
			name: "Generated image",
			size: markdownMatch[1].length,
			type: "image/png",
			dataUrl: markdownMatch[1],
		};
	}

	// Test for wrapped data URL (might have extra whitespace or newlines)
	const wrappedMatch = normalizedContent.match(/(data:image\/[a-z0-9.+\-]+;base64,[A-Za-z0-9+\/=]+)/i);
	if (wrappedMatch?.[1] && wrappedMatch[1].length > 100) {
		// Only treat as legacy if it looks like a real base64 data URL
		return {
			key: `legacy-image-${wrappedMatch[1].length}`,
			name: "Generated image",
			size: wrappedMatch[1].length,
			type: "image/png",
			dataUrl: wrappedMatch[1],
		};
	}

	return null;
};

const normalizeLegacyImageMessage = (message) => {
	const legacyImageAttachment = extractLegacyImageAttachment(message?.content);

	if (!legacyImageAttachment) {
		return null;
	}

	return {
		content: "",
		attachments: [legacyImageAttachment],
	};
};

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "avif"]);
const isImageAttachment = (attachment) =>
	(String(attachment?.type || "").toLowerCase().startsWith("image/") || IMAGE_EXTENSIONS.has(getAttachmentExtension(attachment))) &&
	normalizeText(attachment?.dataUrl).startsWith("data:");
const isPdfAttachment = (attachment) =>
	(String(attachment?.type || "").toLowerCase() === "application/pdf" || getAttachmentExtension(attachment) === "pdf") &&
	normalizeText(attachment?.dataUrl).startsWith("data:");
const getAttachmentExtension = (attachment) => {
	const fileName = normalizeText(attachment?.name).toLowerCase();
	const match = fileName.match(/\.([a-z0-9]+)$/);

	return match?.[1] || "";
};

const isOfficeDocumentAttachment = (attachment) => {
	const mimeType = String(attachment?.type || "").toLowerCase();
	const extension = getAttachmentExtension(attachment);

	return (OFFICE_DOCUMENT_MIME_TYPES.has(mimeType) || OFFICE_DOCUMENT_EXTENSIONS.has(extension)) && normalizeText(attachment?.dataUrl).startsWith("data:");
};

// const isTextAttachment = (attachment) => {
// 	const mimeType = String(attachment?.type || "").toLowerCase();

// 	return (
// 		mimeType.startsWith("text/") ||
// 		mimeType === "application/json" ||
// 		mimeType === "application/xml" ||
// 		mimeType === "application/xhtml+xml" ||
// 		mimeType === "application/csv" ||
// 		mimeType === "text/csv"
// 	) && normalizeText(attachment?.dataUrl).startsWith("data:");
// };

// AFTER
const isTextAttachment = (attachment) => {
	const mimeType = String(attachment?.type || "").toLowerCase();
	const hasDataUrl = normalizeText(attachment?.dataUrl).startsWith("data:");

	if (!hasDataUrl) {
		return false;
	}

	if (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/xml" ||
		mimeType === "application/xhtml+xml" ||
		mimeType === "application/csv" ||
		mimeType === "text/csv" ||
		mimeType === "application/ld+json" ||
		mimeType === "application/yaml" ||
		mimeType === "application/x-yaml" ||
		mimeType === "application/x-ndjson" ||
		mimeType === "application/javascript" ||
		mimeType === "application/x-javascript"
	) {
		return true;
	}

	// Some browsers / cloud drives label plain text and code as octet-stream.
	// Extension fallback lets us parse known textual formats without trusting MIME alone.
	return isCodeFileAttachment(attachment);
};

const parseDataUrl = (value) => {
	const normalizedValue = normalizeText(value);
	const match = normalizedValue.match(/^data:([^;]+);base64,(.+)$/i);

	if (!match?.[2]) {
		return null;
	}

	return {
		mimeType: match[1],
		buffer: Buffer.from(match[2], "base64"),
	};
};

const buildImageAttachmentAnalysis = async (attachments = []) => {
	const imageAttachments = Array.isArray(attachments) ? attachments.filter(isImageAttachment).slice(0, 3) : [];

	if (imageAttachments.length === 0) {
		return "";
	}

	const analysis = await Promise.all(
		imageAttachments.map(async (attachment, index) => {
			const parsed = parseDataUrl(attachment.dataUrl);

			if (!parsed?.buffer) {
				return `Image ${index + 1}${attachment.name ? ` (${attachment.name})` : ""}: unreadable attachment.`;
			}

			let imageBuffer = parsed.buffer;

			try {
				imageBuffer = await sharp(imageBuffer).rotate().resize({ width: 1600, withoutEnlargement: true }).grayscale().normalize().toBuffer();
			} catch {
				imageBuffer = parsed.buffer;
			}

			try {
				const result = await recognize(imageBuffer, "eng");
				const extractedText = normalizeText(result?.data?.text || "").replace(/\s+/g, " ").trim();

				if (!extractedText) {
					return `Image ${index + 1}${attachment.name ? ` (${attachment.name})` : ""}: no readable text was extracted.`;
				}

				return [
					`Image ${index + 1}${attachment.name ? ` (${attachment.name})` : ""}`,
					`OCR text: ${extractedText.slice(0, 2000)}`,
				].join("\n");
			} catch (error) {
				logger.warn("[chatController] image OCR failed", { message: error?.message || String(error) });
				return `Image ${index + 1}${attachment.name ? ` (${attachment.name})` : ""}: OCR failed.`;
			}
		})
	);

	return analysis.filter(Boolean).join("\n\n");
};

const buildDocumentAttachmentAnalysis = async (attachment, index) => {
	const parsed = parseDataUrl(attachment.dataUrl);

	if (!parsed?.buffer) {
		return `${attachment.name || `Attachment ${index + 1}`}: unreadable attachment.`;
	}

	if (isPdfAttachment(attachment)) {
		let pdfParser = null;

		try {
			pdfParser = new PDFParse({ data: parsed.buffer });
			const pdf = await pdfParser.getText();
			const extractedText = normalizeText(pdf?.text || "").replace(/\s+/g, " ").trim();

			// if (extractedText.length >= 40) {
			// 	return [
			// 		`PDF ${index + 1}${attachment.name ? ` (${attachment.name})` : ""}`,
			// 		`Extracted text: ${extractedText.slice(0, 6000)}`,
			// 	].join("\n");
			// }

			if (extractedText.length >= 40) {
				return [
					`PDF ${index + 1}${attachment.name ? ` (${attachment.name})` : ""}`,
					`Extracted text: ${extractedText.slice(0, 20000)}`,
				].join("\n");
			}

			const screenshots = await pdfParser.getScreenshot({
				first: 1,
				last: MAX_PDF_OCR_PAGES,
				imageBuffer: true,
				imageDataUrl: false,
				scale: 1.5,
			}).catch(() => null);

			const ocrPages = Array.isArray(screenshots?.pages) ? screenshots.pages : [];
			const ocrResults = [];

			for (const [pageIndex, page] of ocrPages.entries()) {
				const pageBuffer = page?.data ? Buffer.from(page.data) : null;

				if (!pageBuffer) {
					continue;
				}

				let imageBuffer = pageBuffer;
				try {
					imageBuffer = await sharp(pageBuffer).rotate().resize({ width: 1800, withoutEnlargement: true }).grayscale().normalize().toBuffer();
				} catch {
					imageBuffer = pageBuffer;
				}

				try {
					const result = await recognize(imageBuffer, "eng");
					const extractedPageText = normalizeText(result?.data?.text || "").replace(/\s+/g, " ").trim();

					if (extractedPageText) {
						ocrResults.push(`Page ${pageIndex + 1}: ${extractedPageText.slice(0, MAX_PDF_OCR_TEXT_LENGTH)}`);
					}
				} catch (error) {
					logger.warn("[chatController] pdf OCR failed", { message: error?.message || String(error) });
				}
			}

			if (ocrResults.length > 0) {
				return [
					`PDF ${index + 1}${attachment.name ? ` (${attachment.name})` : ""}`,
					`OCR text: ${ocrResults.join("\n")}`,
				].join("\n");
			}

			return `PDF ${index + 1}${attachment.name ? ` (${attachment.name})` : ""}: no readable text was extracted.`;
		} catch (error) {
			logger.warn("[chatController] pdf extraction failed", { message: error?.message || String(error) });
			return `PDF ${index + 1}${attachment.name ? ` (${attachment.name})` : ""}: extraction failed.`;
		} finally {
			await pdfParser?.destroy?.().catch(() => { });
		}
	}

	if (isOfficeDocumentAttachment(attachment)) {
		try {
			const ast = await officeParser.parseOffice(parsed.buffer, {
				toText: true,
				ignoreNotes: false,
				putNotesAtLast: true,
				extractAttachments: false,
				ocr: false,
			});
			const extractedText = normalizeText(ast?.toText?.() || ast?.text || "").replace(/\s+/g, " ").trim();

			if (!extractedText) {
				return `${attachment.name || `Attachment ${index + 1}`}: no readable text was extracted.`;
			}

			// return [
			// 	`${attachment.name || `Attachment ${index + 1}`}`,
			// 	`Extracted text: ${extractedText.slice(0, 4000)}`,
			// ].join("\n");

			return [
				`${attachment.name || `Attachment ${index + 1}`}`,
				`Extracted text: ${extractedText.slice(0, 16000)}`,
			].join("\n");
		} catch (error) {
			logger.warn("[chatController] office document extraction failed", { message: error?.message || String(error) });
			return `${attachment.name || `Attachment ${index + 1}`}: extraction failed.`;
		}
	}

	// AFTER
	if (isTextAttachment(attachment)) {
		const isCode = isCodeFileAttachment(attachment);
		const rawText = parsed.buffer.toString("utf8");
		const extractedText = isCode
			? rawText.replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim()
			: normalizeText(rawText).replace(/\s+/g, " ").trim();

		if (!extractedText) {
			return `${attachment.name || `Attachment ${index + 1}`}: no readable text was extracted.`;
		}

		const analysisLimit = isCode ? CODE_TEXT_ANALYSIS_LIMIT : TEXT_ANALYSIS_LIMIT;
		const lineCount = isCode ? extractedText.split("\n").length : null;

		return [
			`${isCode ? "Code file" : "Text attachment"} ${index + 1}${attachment.name ? ` (${attachment.name})` : ""}${lineCount ? ` — ${lineCount} lines` : ""}`,
			`Extracted text:\n${extractedText.slice(0, analysisLimit)}`,
		].join("\n");
	}

	return `${attachment.name || `Attachment ${index + 1}`}: this file format cannot be text-extracted by the current Quantic parser (${attachment.type || "unknown"}). The file was attached, but its contents were not analyzed. If it is an audio/video/archive/binary format, convert it to a supported text or document format first.`;
};

const MAX_ANALYZED_ATTACHMENTS = 10;
const buildAttachmentAnalysis = async (attachments = []) => {
	const allAttachments = Array.isArray(attachments) ? attachments : [];
	const normalizedAttachments = allAttachments.slice(0, MAX_ANALYZED_ATTACHMENTS);
	if (allAttachments.length > MAX_ANALYZED_ATTACHMENTS) {
		logger.warn("[chatController] attachment count truncated", {
			provided: allAttachments.length,
			analyzed: MAX_ANALYZED_ATTACHMENTS,
		});
	}

	if (normalizedAttachments.length === 0) {
		return "";
	}

	const analysis = [];

	const imageAnalysis = await buildImageAttachmentAnalysis(normalizedAttachments);
	if (imageAnalysis) {
		analysis.push(imageAnalysis);
	}

	for (const [index, attachment] of normalizedAttachments.entries()) {
		if (isImageAttachment(attachment)) {
			continue;
		}

		const documentAnalysis = await buildDocumentAttachmentAnalysis(attachment, index);
		if (documentAnalysis) {
			analysis.push(documentAnalysis);
		}
	}

	return analysis.filter(Boolean).join("\n\n");
};

//const isGreetingMessage = (message) => /\b(hello|hi|hey|good morning|good afternoon|good evening|how are you)\b/i.test(normalizeText(message));

const GREETING_ONLY_PHRASES = new Set([
	"hi", "hii", "hiya", "hey", "hello", "yo",
	"good morning", "good afternoon", "good evening",
	"how are you", "how are you doing", "how're you", "hows it going",
	"what's up", "whats up", "sup",
]);

const isGreetingMessage = (message) => {
	const strippedMessage = normalizeText(message)
		.toLowerCase()
		.replace(/\bquantic(?:\s*ai)?\b/gi, "")
		.replace(/[!?.,]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	return GREETING_ONLY_PHRASES.has(strippedMessage);
};

const isCreatorQuestion = (message) => {
	const normalizedMessage = normalizeText(message);

	const patterns = [
		/\bwho\s+(?:built|build|builds|building|made|make|makes|created|creates|creating|develop(?:ed|s|ing)?|design(?:ed|s|ing)?|coded|wrote|programmed)\s+(?:you|this|quantic(?:\s+ai)?)\b/i,
		/\bwho(?:'s|\s+is)\s+(?:your|this)\s+(?:creator|developer|maker|founder|builder|author)\b/i,
		/\bwho(?:'s|\s+is)\s+behind\s+(?:you|this|quantic(?:\s+ai)?)\b/i,
		/\b(creator|developer|maker|founder|builder|author)\s+of\s+(?:you|quantic(?:\s+ai)?)\b/i,
		/\bwhich\s+(?:company|team|person)\s+(?:built|made|created|developed)\s+(?:you|quantic(?:\s+ai)?)\b/i,
		/\bwho\s+owns\s+quantic(?:\s+ai)?\b/i,
		/\bwho\s+founded\s+quantic(?:\s+ai)?\b/i,
	];

	return patterns.some((pattern) => pattern.test(normalizedMessage));
};

const isCompoundInfoRequest = (message) => {
	const normalized = normalizeText(message).toLowerCase();
	const asksWeather = /\bweather\b/.test(normalized);
	const asksOther = /\b(news|headline|headlines|update|updates|stock|price|score)\b/.test(normalized);

	return asksWeather && asksOther;
};

const CLAUSE_SPLIT_PATTERN = /[?!.]+|\band\b|,(?=\s*(?:say|tell|give|show|what|who|how|why|when|where|is|are|do|does|can|could|please)\b)/i;

const splitMessageIntoClauses = (message) =>
	normalizeText(message)
		.split(CLAUSE_SPLIT_PATTERN)
		.map((clause) => normalizeText(clause))
		.filter(Boolean);

const isCompoundMessage = (message) => splitMessageIntoClauses(message).length > 1;

const asksForAdditionalWebInfo = (message) =>
	/\b(news|headline|headlines|update|updates|stock|price|score)\b/i.test(normalizeText(message));

const isLocationCorrectionMessage = (message) => {
	const normalized = normalizeText(message).toLowerCase();
	return /\b(not my (correct )?location|wrong location|that's not (my|where i)|thats not (my|where i)|i('m| am) not (in|from|located in))\b/.test(normalized);
};

const getTimeOfDayGreeting = (date = new Date()) => {
	const hour = Number(date?.getHours?.()) || 0;

	if (hour < 12) {
		return "Good morning";
	}

	if (hour < 18) {
		return "Good afternoon";
	}

	return "Good evening";
};

const buildGreetingReply = () => `${getTimeOfDayGreeting()}. How can I assist you today?`;

const buildCreatorReply = () => "I was created by Basudeb Bej, the developer behind Quantic AI. I help with writing, coding, learning, and problem-solving.";

const normalizeConversation = (conversation) => {
	if (!Array.isArray(conversation)) {
		return [];
	}

	return conversation
		.slice(-10)
		.map((entry) => ({
			role: normalizeText(entry?.role),
			content: normalizeText(stripSourcesMarker(entry?.content)),
		}))
		.filter((entry) => entry.role && entry.content);
};

const isValidUserId = (value) => mongoose.Types.ObjectId.isValid(String(value ?? ""));

const normalizeThreadId = (value) => normalizeText(value);

const toObjectIdOrNull = (value) => {
	const normalizedValue = normalizeText(value);
	if (!normalizedValue || !isValidUserId(normalizedValue)) {
		return null;
	}

	return new mongoose.Types.ObjectId(normalizedValue);
};

const buildThreadLookup = (userObjectId, threadId) => {
	const normalizedThreadId = normalizeThreadId(threadId);

	if (!normalizedThreadId || !isValidUserId(normalizedThreadId)) {
		return null;
	}

	if (String(userObjectId) === normalizedThreadId) {
		return { _id: userObjectId };
	}

	return {
		_id: new mongoose.Types.ObjectId(normalizedThreadId),
		userId: userObjectId,
	};
};

const stripMarkdownForTitle = (value) => normalizeText(value)
	.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
	.replace(/^#{1,6}\s+/, "")
	.replace(/^[-*+]\s+/, "")
	.replace(/^\d+\.\s+/, "")
	.replace(/\*\*(.*?)\*\*/g, "$1")
	.replace(/\*(.*?)\*/g, "$1")
	.replace(/`([^`]+)`/g, "$1")
	.replace(/_([^_]+)_/g, "$1")
	.trim();

const buildThreadTitle = (message) => {
	const heuristicTitle = buildHeuristicTitle(message);
	if (heuristicTitle) {
		return heuristicTitle;
	}

	const cleanedMessage = stripMarkdownForTitle(message);
	const words = cleanedMessage.split(/\s+/).filter(Boolean).slice(0, 6);
	return words.join(" ").trim() || "New chat";
};

const buildThreadPreview = (message) => normalizeText(message).slice(0, 140);

const formatThreadSummary = (thread, messageCount = 0) => ({
	id: String(thread?._id || ""),
	title: normalizeText(thread?.title) || "New chat",
	preview: normalizeText(thread?.lastMessage || thread?.preview),
	pinned: Boolean(thread?.pinned),
	lastMessageAt: thread?.lastMessageAt || thread?.updatedAt || thread?.createdAt || null,
	createdAt: thread?.createdAt || null,
	updatedAt: thread?.updatedAt || null,
	messageCount: Number(messageCount || 0),
});

const formatThreadMessage = (message) => ({
	role: normalizeText(message?.role),
	content: (() => {
		const normalizedContent = normalizeText(message?.content);
		return extractLegacyImageAttachment(normalizedContent) ? "" : normalizedContent;
	})(),
	attachments: (() => {
		const normalizedAttachments = normalizeMessageAttachments(message?.attachments);
		if (normalizedAttachments.length > 0) {
			return normalizedAttachments;
		}

		const legacyImageAttachment = extractLegacyImageAttachment(message?.content);
		return legacyImageAttachment ? [legacyImageAttachment] : [];
	})(),
	createdAt: message?.createdAt || null,
});

const normalizeStoredThreadMessages = (messages) => {
	if (!Array.isArray(messages)) {
		return [];
	}

	return messages
		.map(formatThreadMessage)
		.filter((message) =>
			message.role && (message.content || (Array.isArray(message.attachments) && message.attachments.length))
		);
};

const migrateLegacyThreadMessages = async (thread) => {
	if (!thread?._id || !Array.isArray(thread?.messages) || thread.messages.length === 0) {
		return;
	}

	const existingCount = await Message.countDocuments({ chatId: thread._id }).catch(() => 0);
	if (existingCount > 0) {
		return;
	}

	const legacyMessages = normalizeStoredThreadMessages(thread.messages).map((message) => ({
		chatId: thread._id,
		role: message.role,
		content: message.content,
		attachments: message.attachments,
		createdAt: message.createdAt || thread.createdAt || new Date(),
	}));

	if (!legacyMessages.length) {
		return;
	}

	await Message.insertMany(legacyMessages, { ordered: false }).catch(() => null);
};

const fetchThreadMessages = async (thread) => {
	if (!thread?._id) {
		return [];
	}

	let messages = await Message.find({ chatId: thread._id }).sort({ createdAt: 1 }).lean();

	// Detect and upgrade any legacy image-only messages
	const legacyMessageUpdates = messages
		.map((message) => {
			const normalizedLegacyMessage = normalizeLegacyImageMessage(message);

			if (!normalizedLegacyMessage) {
				return null;
			}

			return {
				updateOne: {
					filter: { _id: message._id },
					update: {
						$set: normalizedLegacyMessage,
					},
				},
			};
		})
		.filter(Boolean);

	if (legacyMessageUpdates.length > 0) {
		try {
			const bulkResult = await Message.bulkWrite(legacyMessageUpdates, { ordered: false });
			if (bulkResult?.ok) {
				// Re-fetch after upgrade to get the updated messages
				messages = await Message.find({ chatId: thread._id }).sort({ createdAt: 1 }).lean();
			}
		} catch (error) {
			logger.warn("[fetchThreadMessages] legacy image upgrade failed", { error: error?.message || String(error) });
			// Continue with original messages even if upgrade fails
		}
	}

	if (messages.length === 0 && Array.isArray(thread?.messages) && thread.messages.length > 0) {
		await migrateLegacyThreadMessages(thread);
		messages = await Message.find({ chatId: thread._id }).sort({ createdAt: 1 }).lean();
	}

	return normalizeStoredThreadMessages(messages);
};

const countThreadMessages = async (threads) => {
	const threadIds = Array.isArray(threads)
		? threads.map((thread) => thread?._id).filter((id) => Boolean(id))
		: [];

	if (threadIds.length === 0) {
		return new Map();
	}

	const counts = await Message.aggregate([
		{ $match: { chatId: { $in: threadIds } } },
		{ $group: { _id: "$chatId", count: { $sum: 1 } } },
	]).catch(() => []);

	return new Map(counts.map((entry) => [String(entry._id), Number(entry.count || 0)]));
};

const shouldSaveConversationHistory = async (userId) => {
	const settings = await Settings.findById(userId).select("saveConversationHistory").lean().catch(() => null);

	return settings?.saveConversationHistory !== false;
};

const startConversationHistory = async ({ userId, message, attachments = [], threadId, editMessageIndex = null }) => {
	const normalizedUserId = normalizeText(userId);
	const normalizedMessage = normalizeText(message);
	const normalizedEditMessageIndex = Number.isInteger(editMessageIndex) && editMessageIndex >= 0 ? editMessageIndex : null;
	const userObjectId = toObjectIdOrNull(normalizedUserId);

	if (!userObjectId || !normalizedMessage) {
		return null;
	}

	const threadLookup = buildThreadLookup(userObjectId, threadId);
	let thread = threadLookup ? await Chat.findOne(threadLookup) : null;
	const isNewThread = !thread;

	if (thread) {
		await migrateLegacyThreadMessages(thread.toObject?.() || thread);
	}

	if (!thread) {
		thread = new Chat({
			userId: userObjectId,
			title: buildThreadTitle(normalizedMessage),
			preview: buildThreadPreview(normalizedMessage),
			lastMessage: normalizedMessage,
			lastMessageAt: new Date(),
			titleAutoGenerated: true,
		});
	} else if (!thread.userId) {
		thread.userId = userObjectId;
	}

	const now = new Date();
	if (normalizedEditMessageIndex !== null) {
		const threadMessages = await Message.find({ chatId: thread._id }).sort({ createdAt: 1 }).lean();
		const shouldRewriteTurn = Array.isArray(threadMessages) && threadMessages[normalizedEditMessageIndex]?.role === "user";

		if (shouldRewriteTurn) {
			const removedMessages = threadMessages.slice(normalizedEditMessageIndex);
			if (removedMessages.length > 0) {
				await Message.deleteMany({ _id: { $in: removedMessages.map((entry) => entry._id) } });
			}
		}
	}

	thread.title = normalizeText(thread.title) || buildThreadTitle(normalizedMessage);
	thread.lastMessage = normalizedMessage;
	thread.preview = buildThreadPreview(normalizedMessage);
	thread.lastMessageAt = now;

	await thread.save();
	await Message.create({
		chatId: thread._id,
		role: "user",
		content: normalizedMessage,
		attachments: normalizeMessageAttachments(attachments),
		createdAt: now,
	});
	thread.isNewThread = isNewThread;
	return thread;
};

const completeConversationHistory = async ({ userId, message, reply, threadId, regenerate = false, attachments = [], assistantMessageIndex = null, generateTitle = false, model = "" }) => {
	const normalizedUserId = normalizeText(userId);
	const normalizedMessage = normalizeText(message);
	const normalizedReply = normalizeText(reply);
	const userObjectId = toObjectIdOrNull(normalizedUserId);
	const normalizedAttachments = normalizeMessageAttachments(attachments);
	const normalizedAssistantMessageIndex = Number.isInteger(assistantMessageIndex) && assistantMessageIndex >= 0 ? assistantMessageIndex : null;

	if (!userObjectId || (!normalizedReply && normalizedAttachments.length === 0)) {
		return null;
	}

	const threadLookup = buildThreadLookup(userObjectId, threadId);
	const thread = threadLookup ? await Chat.findOne(threadLookup) : null;

	if (!thread) {
		return null;
	}

	await migrateLegacyThreadMessages(thread.toObject?.() || thread);

	const now = new Date();
	if (regenerate) {
		const threadMessages = await Message.find({ chatId: thread._id }).sort({ createdAt: 1 }).catch(() => []);
		const previousAssistantMessage = normalizedAssistantMessageIndex !== null
			? threadMessages[normalizedAssistantMessageIndex]
			: await Message.findOne({ chatId: thread._id, role: "assistant" })
				.sort({ createdAt: -1 })
				.catch(() => null);

		if (previousAssistantMessage?.role === "assistant") {
			previousAssistantMessage.content = normalizedReply;
			previousAssistantMessage.attachments = normalizedAttachments;
			await previousAssistantMessage.save();
		} else {
			await Message.create({
				chatId: thread._id,
				role: "assistant",
				content: normalizedReply,
				attachments: normalizedAttachments,
				createdAt: now,
			});
		}
	} else {
		await Message.create({
			chatId: thread._id,
			role: "assistant",
			content: normalizedReply,
			attachments: normalizedAttachments,
			createdAt: now,
		});
	}
	thread.lastMessage = normalizedReply;
	thread.preview = buildThreadPreview(normalizedReply);
	thread.lastMessageAt = now;

	if (!normalizeText(thread.title)) {
		thread.title = buildThreadTitle(normalizedReply);
	}

	// if (generateTitle) {
	// 	const generatedTitle = await generateChatTitle(normalizedMessage || normalizedReply, model);
	// 	if (generatedTitle) {
	// 		thread.title = generatedTitle;
	// 	}
	// }

	await thread.save();
	return thread;
};

const saveConversationHistory = async ({ message, reply, userId, threadId, regenerate = false, attachments = [], assistantMessageIndex = null, generateTitle = false, model = "" }) => completeConversationHistory({ message, reply, userId, threadId, regenerate, attachments, assistantMessageIndex, generateTitle, model });

const getConversationHistory = async (userId, includeArchived = false) => {
	const normalizedUserId = normalizeText(userId);
	const userObjectId = toObjectIdOrNull(normalizedUserId);

	if (!userObjectId) {
		return [];
	}

	const filter = {
		$or: [{ userId: userObjectId }, { _id: userObjectId }]
	};

	if (!includeArchived) {
		filter.archived = { $ne: true };
	}

	const threads = await Chat.find(filter)
		.sort({ lastMessageAt: -1, updatedAt: -1 })
		.lean();

	const messageCounts = await countThreadMessages(threads);

	return Array.isArray(threads)
		? threads.map((thread) => {
			const fallbackCount = Array.isArray(thread?.messages) ? thread.messages.length : 0;
			return formatThreadSummary(thread, messageCounts.get(String(thread?._id)) || fallbackCount);
		})
		: [];
};

const getConversationThread = async (userId, threadId) => {
	const normalizedUserId = normalizeText(userId);
	const userObjectId = toObjectIdOrNull(normalizedUserId);
	const normalizedThreadId = normalizeThreadId(threadId);

	if (!userObjectId) {
		return null;
	}

	const threadLookup = buildThreadLookup(userObjectId, normalizedThreadId);
	if (!threadLookup) {
		return null;
	}

	const thread = await Chat.findOne(threadLookup).lean();

	if (!thread) {
		return null;
	}

	const messages = await fetchThreadMessages(thread);

	return {
		...formatThreadSummary(thread, messages.length),
		messages,
	};
};

const updateConversationThread = async ({ userId, threadId, title, pinned, archived }) => {
	const normalizedUserId = normalizeText(userId);
	const userObjectId = toObjectIdOrNull(normalizedUserId);
	const normalizedThreadId = normalizeThreadId(threadId);

	if (!userObjectId) {
		return null;
	}

	const threadLookup = buildThreadLookup(userObjectId, normalizedThreadId);
	if (!threadLookup) {
		return null;
	}

	const thread = await Chat.findOne(threadLookup);

	if (!thread) {
		return null;
	}

	if (typeof title === "string") {
		const nextTitle = normalizeText(title);
		if (nextTitle) {
			thread.title = nextTitle;
			thread.titleAutoGenerated = false;
		}
	}

	if (typeof pinned === "boolean") {
		thread.pinned = pinned;
	}

	if (typeof archived === "boolean") {
		thread.archived = archived;
	}

	await thread.save();
	return thread;
};

const deleteConversationThread = async ({ userId, threadId }) => {
	const normalizedUserId = normalizeText(userId);
	const userObjectId = toObjectIdOrNull(normalizedUserId);
	const normalizedThreadId = normalizeThreadId(threadId);

	if (!userObjectId) {
		return false;
	}

	const threadLookup = buildThreadLookup(userObjectId, normalizedThreadId);
	if (!threadLookup) {
		return false;
	}

	await Message.deleteMany({ chatId: threadLookup._id });
	const result = await Chat.deleteOne(threadLookup);
	return Boolean(result?.deletedCount);
};

const getDatabaseProfile = async (userId) => {
	const normalizedUserId = normalizeText(userId);

	if (!normalizedUserId || !isValidUserId(normalizedUserId)) {
		return null;
	}

	const [user, settings] = await Promise.all([
		User.findById(normalizedUserId).select("name email role createdAt updatedAt").lean(),
		Settings.findById(normalizedUserId).select("displayName username description responseStyle").lean(),
	]);

	if (!user && !settings) {
		return null;
	}

	return {
		name: normalizeText(settings?.displayName || user?.name),
		email: normalizeText(user?.email || settings?.email),
		username: normalizeText(settings?.username),
		description: normalizeText(settings?.description),
		responseStyle: normalizeText(settings?.responseStyle || "balanced"),
		role: normalizeText(user?.role || "user"),
		createdAt: user?.createdAt || null,
		updatedAt: user?.updatedAt || null,
	};
};

const formatProfileContext = (profile) => {
	if (!profile) {
		return "";
	}

	const lines = [];

	if (profile.name) lines.push(`Name: ${profile.name}`);
	if (profile.username) lines.push(`Username: ${profile.username}`);
	if (profile.email) lines.push(`Email: ${profile.email}`);
	if (profile.description) lines.push(`Description: ${profile.description}`);
	if (profile.responseStyle) lines.push(`Response style: ${profile.responseStyle}`);

	return lines.join("\n");
};

const isWeatherQuery = (message) => {
	const normalizedMessage = normalizeText(message);

	const hasWeatherTerm = /\b(weather|forecast|temperature|rain|sunny|hot|cold)\b/i.test(normalizedMessage);

	const isGeneralQuestion = /^(what|how|when|where|why|who)\b/i.test(normalizedMessage) &&
		!/\b(weather|forecast|temperature|rain)\b/i.test(normalizedMessage);

	if (isGeneralQuestion && hasWeatherTerm) {
		return /\b(weather|forecast|temperature|rain)\b/i.test(normalizedMessage) &&
			/\b(in|for|at)\b/i.test(normalizedMessage);
	}

	const isBareWeatherPhrase = /\b(today'?s?\s+weather|weather\s+today|tonight'?s?\s+weather|weather\s+tonight|current\s+weather|weather\s+now|weather\s+update|weather\s+report|weather\s+forecast|check(?:ing)?\s+(?:the\s+)?weather|weather\s+please)\b/i.test(normalizedMessage);

	return hasWeatherTerm && (
		isBareWeatherPhrase ||
		/\b(in|for|at)\b/i.test(normalizedMessage) ||
		/\bweather\s+(?:of|in|for|at)/i.test(normalizedMessage) ||
		/\bwhat('?s| is)? the weather/i.test(normalizedMessage) ||
		/\bhow('?s| is)? the weather/i.test(normalizedMessage)
	);
};

const isWeatherContinuation = (message) => /^(today|tomorrow|same place|same location|there|here|that place|same)$/i.test(normalizeText(message));

// const WEATHER_LOCATION_PROMPT_SIGNAL = /tell me a city or location/i;
const WEATHER_LOCATION_PROMPT_SIGNAL = /(tell me a city or location|which city or location|city or location would you like)/i;
const WEATHER_LOCATION_STOPWORDS = new Set([
	"you", "can", "say", "me", "please", "tell", "give", "know", "want", "need",
	"accurate", "correct", "real", "live", "current", "actual", "exact",
	"from", "using", "via", "source", "accuweather", "imd",
	"meteorological", "department", "service", "app", "website", "google",
	"check", "find", "get", "provide", "share", "show", "and", "or",
]);

const isFollowingWeatherLocationPrompt = (conversation = []) => {
	const lastAssistantMessage = Array.isArray(conversation)
		? [...conversation].reverse().find((entry) => entry?.role === "assistant")
		: null;

	return Boolean(lastAssistantMessage && WEATHER_LOCATION_PROMPT_SIGNAL.test(normalizeText(lastAssistantMessage.content)));
};

const isPlausibleLocationCandidate = (value) => {
	const normalizedValue = normalizeText(value);
	if (!normalizedValue) {
		return false;
	}

	const words = normalizedValue.split(/\s+/).filter(Boolean);
	if (words.length < 1 || words.length > 6) { // Increased from 4 to 6
		return false;
	}

	return words.every((word) => !WEATHER_LOCATION_STOPWORDS.has(word.toLowerCase()));
};

const isCalculatorQuery = (message) => {
	const normalizedMessage = normalizeText(message).toLowerCase();
	const hasArithmeticCharacters = /[0-9]/.test(normalizedMessage) && /[+\-*/]/.test(normalizedMessage);
	const hasCalculatorVerb = /\b(calculate|solve|compute|what(?:'s| is))\b/i.test(normalizedMessage);
	const isPureExpression = /^[0-9\s+\-*/().]+$/.test(normalizedMessage);
	const hasEquationSignal = /=/.test(normalizedMessage) && /\bx\b/i.test(normalizedMessage) && /[+\-*/]/.test(normalizedMessage);

	return isPureExpression || hasEquationSignal || (hasArithmeticCharacters && hasCalculatorVerb);
};

const getWeatherTimeIntent = (message) => {
	const normalizedMessage = normalizeText(message).toLowerCase();

	if (/\btomorrow\b/i.test(normalizedMessage)) {
		return "tomorrow";
	}

	if (/\btoday\b/i.test(normalizedMessage)) {
		return "today";
	}

	return "current";
};

const isWeatherLocationCandidate = (value) => {
	const normalizedValue = normalizeText(value).toLowerCase();

	if (!normalizedValue) {
		return false;
	}

	const blockedWords = new Set(["today", "tonight", "tomorrow", "current", "now", "weather", "forecast"]);

	return !blockedWords.has(normalizedValue);
};

const normalizeWeatherLocationCandidate = (value) => normalizeText(value)
	.replace(/^(?:of|in|for|at)\s+/i, "")
	.replace(/'s$/i, "")
	.replace(/^[\s:;,.\-–—]+|[\s:;,.\-–—]+$/g, "")
	.trim();

const splitWeatherLocationCandidates = (value) => {
	const normalizedValue = normalizeText(value);

	if (!normalizedValue) {
		return [];
	}

	return normalizedValue
		.split(/\s*(?:,|\band\b|\+|&)\s*/i)
		.map(normalizeWeatherLocationCandidate)
		.filter(Boolean)
		.filter((entry, index, list) => list.indexOf(entry) === index);
};

const normalizeWeatherQueryText = (value) => normalizeText(value)
	.replace(/\r\n/g, "\n")
	.split(/\s*\/\//)[0]
	.split(/\s*#/)[0]
	.split(/\s*\|\|/)[0]
	.replace(/\n+/g, " ")
	.replace(/[?!.]+$/g, "")
	.trim();

const extractBareWeatherLocation = (message) => {
	const normalizedMessage = normalizeWeatherQueryText(message);

	if (!normalizedMessage) {
		return "";
	}

	const cleanedMessage = normalizedMessage
		.replace(/\b(weather|forecast|temperature|rain|sunny|hot|cold)\b/ig, "")
		.replace(/^(?:what\s+is\s+the\s+)?weather\s+(?:of|in|for|at)\s+/i, "")
		.replace(/[?!.]+$/g, "")
		.trim();

	if (!cleanedMessage) {
		return "";
	}

	const words = cleanedMessage.split(/\s+/).filter(Boolean);

	if (words.length < 1 || words.length > 4) {
		return "";
	}

	if (/^(today|tonight|tomorrow|now|current)$/i.test(cleanedMessage)) {
		return "";
	}

	return normalizeWeatherLocationCandidate(cleanedMessage);
};

const extractWeatherLocation = (message, conversation = []) => {
	const messageText = normalizeWeatherQueryText(message);

	// More comprehensive location extraction patterns
	const patterns = [
		/\b(?:in|for|at)\s+([a-zA-Z][a-zA-Z\s'.-]{1,80})/i,
		/^([a-zA-Z][a-zA-Z\s'.-]{1,80}?)\s+weather\b/i,
		/\b([a-zA-Z][a-zA-Z\s'.-]{1,80}?)'s\s+weather\b/i,
		/\bweather\s+(?:of|in|for|at)\s+([a-zA-Z][a-zA-Z\s'.-]{1,80})/i,
		/\b(?:what('?s| is)? the weather in|how's the weather in)\s+([a-zA-Z][a-zA-Z\s'.-]{1,80})/i,
	];

	let extractedLocation = null;

	for (const pattern of patterns) {
		const match = messageText.match(pattern);
		if (match?.[1] && isWeatherLocationCandidate(match[1]) && isPlausibleLocationCandidate(match[1])) {
			extractedLocation = normalizeWeatherLocationCandidate(match[1]);
			break;
		}
	}

	if (extractedLocation) return extractedLocation;

	const bareLocation = extractBareWeatherLocation(messageText);
	if (bareLocation && isWeatherLocationCandidate(bareLocation) && isPlausibleLocationCandidate(bareLocation)) {
		return bareLocation;
	}

	for (const entry of Array.isArray(conversation) ? conversation.slice().reverse() : []) {
		if (normalizeText(entry?.role).toLowerCase() !== "user") {
			continue;
		}

		const content = normalizeWeatherQueryText(entry?.content);

		for (const pattern of patterns) {
			const match = content.match(pattern);
			if (match?.[1] && isWeatherLocationCandidate(match[1]) && isPlausibleLocationCandidate(match[1])) {
				return normalizeWeatherLocationCandidate(match[1]);
			}
		}
	}

	return "";
};

const extractWeatherLocations = (message, conversation = []) => {
	const uniqueLocations = [];
	const addLocations = (value) => {
		if (!value) return;

		// Split by common separators
		const candidates = value
			.split(/\s*(?:,|\band\b|\+|&|or)\s*/i)
			.map(normalizeWeatherLocationCandidate)
			.filter(Boolean);

		for (const location of candidates) {
			if (!uniqueLocations.includes(location) &&
				isWeatherLocationCandidate(location) &&
				isPlausibleLocationCandidate(location)) {
				uniqueLocations.push(location);
			}
		}
	};

	const messageText = normalizeWeatherQueryText(message);

	// Try multiple patterns
	const locationPatterns = [
		/\b(?:in|for|at)\s+([a-zA-Z][a-zA-Z\s'.-]{1,120})/i,
		/^([a-zA-Z][a-zA-Z\s'.-]{1,120}?)\s+weather\b/i,
		/\b([a-zA-Z][a-zA-Z\s'.-]{1,120}?)'s\s+weather\b/i,
		/\bweather\s+(?:of|in|for|at)\s+([a-zA-Z][a-zA-Z\s'.-]{1,120})/i,
	];

	for (const pattern of locationPatterns) {
		const match = messageText.match(pattern);
		if (match?.[1]) {
			addLocations(match[1]);
		}
	}

	addLocations(extractBareWeatherLocation(messageText));

	// Check conversation for locations if none found
	if (uniqueLocations.length === 0) {
		for (const entry of Array.isArray(conversation) ? conversation.slice().reverse() : []) {
			if (normalizeText(entry?.role).toLowerCase() !== "user") {
				continue;
			}

			const content = normalizeWeatherQueryText(entry?.content);

			for (const pattern of locationPatterns) {
				const match = content.match(pattern);
				if (match?.[1]) {
					addLocations(match[1]);
				}
			}

			if (uniqueLocations.length > 0) {
				break;
			}
		}
	}

	return uniqueLocations;
};

const extractLocationFromMemoryText = (text) => {
	const normalizedText = normalizeText(text);

	if (!normalizedText) {
		return "";
	}

	// Prefer an explicit "from/in/at/living in X" phrase — this is the only
	// reliable way to isolate a place name out of a full sentence.
	const explicitMatch = normalizedText.match(/\b(?:from|in|at|living in|based in|located in)\s+([a-zA-Z][a-zA-Z\s',.\-]{1,80})/i);
	if (explicitMatch?.[1]) {
		return normalizeWeatherLocationCandidate(explicitMatch[1]);
	}

	// Only trust the raw content directly if it already looks like a clean
	// place name — short, no sentence verbs/subjects mixed in.
	const wordCount = normalizedText.split(/\s+/).filter(Boolean).length;
	const looksLikeSentence = /\b(is|am|are|was|were|says|said|user|told|mentioned|wants?|needs?)\b/i.test(normalizedText);

	if (wordCount <= 8 && !looksLikeSentence) {
		return normalizeWeatherLocationCandidate(normalizedText);
	}

	return "";
};

const getRecentWeatherLocation = (conversation = []) => {
	// Look through conversation for any location mention
	for (const entry of Array.isArray(conversation) ? conversation.slice().reverse() : []) {
		if (normalizeText(entry?.role).toLowerCase() !== "user") {
			continue;
		}

		const content = normalizeText(entry?.content);

		// Try to extract location from the content
		const location = extractWeatherLocation(content, []);

		if (location) {
			return location;
		}

		const locationPatterns = [
			/\b(?:from|in|at)\s+([a-zA-Z][a-zA-Z\s',.\-]{1,80})/i,
			/\bmy location\s+is\s+([a-zA-Z][a-zA-Z\s',.\-]{1,80})/i,
			/\bI(?:'m| am)\s+from\s+([a-zA-Z][a-zA-Z\s',.\-]{1,80})/i,
			/\bliving\s+in\s+([a-zA-Z][a-zA-Z\s',.\-]{1,80})/i,
		];

		for (const pattern of locationPatterns) {
			const match = content.match(pattern);
			if (match && match[1]) {
				const candidate = normalizeWeatherLocationCandidate(match[1]);
				if (isWeatherLocationCandidate(candidate) && isPlausibleLocationCandidate(candidate)) {
					return candidate;
				}
			}
		}
	}

	return "";
};

const weatherCodeToSummary = (code, isDay = true) => {
	const codeNumber = Number(code);

	if ([0].includes(codeNumber)) return isDay ? "clear sky" : "clear night";
	if ([1, 2].includes(codeNumber)) return isDay ? "partly cloudy" : "partly cloudy night";
	if ([3].includes(codeNumber)) return "overcast";
	if ([45, 48].includes(codeNumber)) return "foggy";
	if ([51, 53, 55, 56, 57].includes(codeNumber)) return "light drizzle";
	if ([61, 63, 65, 66, 67].includes(codeNumber)) return "rainy";
	if ([71, 73, 75, 77].includes(codeNumber)) return "snowy";
	if ([80, 81, 82].includes(codeNumber)) return "showers";
	if ([95, 96, 99].includes(codeNumber)) return "thunderstorms";
	return "unavailable";
};

const formatWeatherReport = ({ locationLabel, summary, temperature, feelsLike, humidity, precipitation, windSpeed, observationTime }) => {
	const lines = [
		`1. Location: ${locationLabel}`,
		`2. Condition: ${summary}`,
		`3. Temperature: ${temperature}°C${feelsLike !== undefined && feelsLike !== null ? ` (feels like ${feelsLike}°C)` : ""}`,
		`4. Humidity: ${humidity !== undefined && humidity !== null ? `${humidity}%` : "unavailable"}`,
		`5. Precipitation: ${precipitation !== undefined && precipitation !== null ? `${precipitation} mm` : "unavailable"}`,
		`6. Wind: ${windSpeed !== undefined && windSpeed !== null ? `${windSpeed} km/h` : "unavailable"}`,
	];

	if (observationTime) {
		lines.push(`7. Updated: ${observationTime}`);
	}

	return lines.join("\n");
};

const getWeatherReport = async (location, timeIntent = "current") => {
	const normalizedLocation = normalizeText(location);

	if (!normalizedLocation) {
		return null;
	}

	const geocodeUrl = new URL("https://geocoding-api.open-meteo.com/v1/search");
	geocodeUrl.searchParams.set("name", normalizedLocation);
	geocodeUrl.searchParams.set("count", "10");
	geocodeUrl.searchParams.set("language", "en");
	geocodeUrl.searchParams.set("format", "json");

	const geocodeResponse = await fetch(geocodeUrl);

	if (!geocodeResponse.ok) {
		return null;
	}

	const geocodeData = await geocodeResponse.json();
	const geocodeResults = Array.isArray(geocodeData?.results) ? geocodeData.results : [];

	if (!geocodeResults.length) {
		return null;
	}

	const locationSegments = normalizedLocation.split(",").map((part) => part.trim()).filter(Boolean);
	const expectedCountry = locationSegments.length > 1 ? locationSegments[locationSegments.length - 1].toLowerCase() : "";
	const expectedRegion = locationSegments.length > 2 ? locationSegments[locationSegments.length - 2].toLowerCase() : "";

	let place = geocodeResults[0];

	if (expectedCountry) {
		const countryMatches = geocodeResults.filter((result) => {
			const resultCountry = String(result?.country || "").toLowerCase();
			return resultCountry && (resultCountry.includes(expectedCountry) || expectedCountry.includes(resultCountry));
		});

		if (countryMatches.length) {
			place = countryMatches[0];

			if (expectedRegion) {
				const regionMatch = countryMatches.find((result) => String(result?.admin1 || "").toLowerCase().includes(expectedRegion));
				if (regionMatch) {
					place = regionMatch;
				}
			}
		}
	}

	if (!place?.latitude || !place?.longitude) {
		return null;
	}

	const placeParts = [place.name, place.admin1, place.country].filter(Boolean);
	const locationLabel = placeParts.join(", ") || normalizedLocation;

	if (timeIntent === "tomorrow") {
		const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
		forecastUrl.searchParams.set("latitude", String(place.latitude));
		forecastUrl.searchParams.set("longitude", String(place.longitude));
		forecastUrl.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");
		forecastUrl.searchParams.set("forecast_days", "2");
		forecastUrl.searchParams.set("timezone", "auto");

		const forecastResponse = await fetch(forecastUrl);

		if (!forecastResponse.ok) {
			return null;
		}

		const forecastData = await forecastResponse.json();
		const daily = forecastData?.daily || {};
		const tomorrowIndex = 1;
		const weatherCode = daily.weather_code?.[tomorrowIndex];
		const tempMax = daily.temperature_2m_max?.[tomorrowIndex];
		const tempMin = daily.temperature_2m_min?.[tomorrowIndex];
		const dayLabel = daily.time?.[tomorrowIndex] || "tomorrow";

		if (weatherCode === undefined || weatherCode === null) {
			return null;
		}

		return [
			`1. Location: ${locationLabel}`,
			`2. Forecast: tomorrow (${dayLabel}) ${weatherCodeToSummary(weatherCode, true)}`,
			`3. High: ${tempMax ?? "n/a"}°C`,
			`4. Low: ${tempMin ?? "n/a"}°C`,
		].join("\n");
	}

	const forecastUrl = new URL("https://api.open-meteo.com/v1/forecast");
	forecastUrl.searchParams.set("latitude", String(place.latitude));
	forecastUrl.searchParams.set("longitude", String(place.longitude));
	forecastUrl.searchParams.set(
		"current",
		"temperature_2m,apparent_temperature,weather_code,wind_speed_10m,relative_humidity_2m,precipitation,is_day"
	);
	forecastUrl.searchParams.set("timezone", "auto");

	const forecastResponse = await fetch(forecastUrl);

	if (!forecastResponse.ok) {
		return null;
	}

	const forecastData = await forecastResponse.json();
	const current = forecastData?.current || {};
	const summary = weatherCodeToSummary(current.weather_code, Number(current.is_day) === 1);
	const temperature = current.temperature_2m;
	const feelsLike = current.apparent_temperature;
	const humidity = current.relative_humidity_2m;
	const precipitation = current.precipitation;
	const windSpeed = current.wind_speed_10m;

	if (temperature === undefined || temperature === null) {
		return null;
	}

	return formatWeatherReport({
		locationLabel,
		summary,
		temperature,
		feelsLike,
		humidity,
		precipitation,
		windSpeed,
		observationTime: current.time ? current.time.replace("T", " ") : "",
	});
};

const buildTimeAndDateReport = ({ timeZone, userTime }) => {
	let normalizedTimeZone = normalizeText(timeZone) || "UTC";
	const referenceDate = (() => {
		const parsed = new Date(userTime);
		return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
	})();

	const formatOptions = {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: true,
	};

	let zonedParts;
	try {
		zonedParts = new Intl.DateTimeFormat("en-US", { ...formatOptions, timeZone: normalizedTimeZone }).formatToParts(referenceDate);
	} catch {
		normalizedTimeZone = "UTC";
		zonedParts = new Intl.DateTimeFormat("en-US", { ...formatOptions, timeZone: "UTC" }).formatToParts(referenceDate);
	}

	const partValue = (type) => zonedParts.find((part) => part.type === type)?.value || "";
	const dateLabel = `${partValue("weekday")}, ${partValue("month")} ${partValue("day")}, ${partValue("year")}`;
	const timeLabel = `${partValue("hour")}:${partValue("minute")}:${partValue("second")} ${partValue("dayPeriod")}`;

	const utcLabel = new Intl.DateTimeFormat("en-GB", {
		timeZone: "UTC",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
	}).format(referenceDate);

	const getWeekNumber = (date) => {
		const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
		const dayNumber = (target.getUTCDay() + 6) % 7;
		target.setUTCDate(target.getUTCDate() - dayNumber + 3);
		const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
		return 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
	};

	const startOfYear = new Date(Date.UTC(referenceDate.getUTCFullYear(), 0, 1));
	const dayOfYear = Math.floor((referenceDate.getTime() - startOfYear.getTime()) / 86400000) + 1;
	const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
	const totalDaysInYear = isLeapYear(referenceDate.getUTCFullYear()) ? 366 : 365;

	return [
		`1. Date: ${dateLabel}`,
		`2. Time: ${timeLabel}`,
		`3. Timezone: ${normalizedTimeZone}`,
		`4. UTC Time: ${utcLabel}`,
		`5. Week Number: Week ${getWeekNumber(referenceDate)}`,
		`6. Day of Year: Day ${dayOfYear} of ${totalDaysInYear}`,
	].join("\n");
};

const getWeatherReports = async (locations, timeIntent = "current") => {
	const normalizedLocations = Array.isArray(locations)
		? locations.map(normalizeText).filter(Boolean)
		: [];

	if (normalizedLocations.length === 0) {
		return [];
	}

	const reports = await Promise.all(
		normalizedLocations.map(async (location) => ({
			location,
			report: await getWeatherReport(location, timeIntent),
		}))
	);

	return reports;
};

const resolveToolContext = async ({ message, conversation, tool, toolName, timeZone, userTime, userId, memoryContext }) => {
	const resolvedTool = tool || toolName || "none";
	const normalizedMessage = normalizeText(message).toLowerCase();

	if (resolvedTool === "none") {
		return null;
	}

	if (resolvedTool === "weather") {
		// Safety guard: only run the weather tool if the user actually asked about weather
		const awaitingLocation = isFollowingWeatherLocationPrompt(conversation);
		if (!isWeatherQuery(message) && !isWeatherContinuation(message) && !awaitingLocation) {
			return null;
		}

		// Try to get location from message
		let weatherLocations = extractWeatherLocations(message, []);

		// If no location in message, try to get from conversation history
		if (weatherLocations.length === 0) {
			const continuationLocation = isWeatherContinuation(message) ? getRecentWeatherLocation(conversation) : "";
			if (continuationLocation) {
				weatherLocations = [continuationLocation];
			}
		}

		// If still no location, try to get from memory
		if (weatherLocations.length === 0 && memoryContext && memoryContext.memories) {
			// Look for location-related memories
			const locationMemories = memoryContext.memories.filter(m =>
				m.key && (m.key.includes('location') || m.key.includes('place') || m.key.includes('city') || m.key.includes('from'))
			);
			if (locationMemories.length > 0) {
				// Extract location from the most recent location memory
				const latestLocation = locationMemories.sort((a, b) =>
					new Date(b.lastUsedAt || b.updatedAt || 0) - new Date(a.lastUsedAt || a.updatedAt || 0)
				)[0];
				const locationText = latestLocation.content || latestLocation.value || '';
				const extractedLocation = extractLocationFromMemoryText(locationText);

				if (extractedLocation && isWeatherLocationCandidate(extractedLocation) && isPlausibleLocationCandidate(extractedLocation)) {
					weatherLocations = [extractedLocation];
				}
			}
		}

		const resolvedWeatherLocations = weatherLocations.length > 0 ? weatherLocations : [];

		if (resolvedWeatherLocations.length === 0) {
			// No location found anywhere - ask for location
			return JSON.stringify({
				type: "followup",
				message: "I can check the weather for you! Which city or location would you like the forecast for?",
				expected: "location"
			});
		}

		const weatherTimeIntent = getWeatherTimeIntent(message);
		const reports = await getWeatherReports(resolvedWeatherLocations, weatherTimeIntent);
		const successfulReports = reports.filter((entry) => entry.report);

		if (successfulReports.length === 1 && resolvedWeatherLocations.length === 1) {
			return successfulReports[0].report;
		}

		if (successfulReports.length > 1) {
			return successfulReports
				.map((entry, index) => `${index + 1}. ${entry.location}\n${entry.report}`)
				.join("\n\n");
		}

		if (successfulReports.length === 1 && resolvedWeatherLocations.length > 1) {
			return successfulReports
				.map((entry, index) => `${index + 1}. ${entry.location}\n${entry.report}`)
				.join("\n\n");
		}

		if (resolvedWeatherLocations.length > 0) {
			return `I couldn't fetch live weather for ${resolvedWeatherLocations.join(", ")} right now.`;
		}

		return JSON.stringify({
			type: "followup",
			message: "I can check the weather for you! Which city or location would you like the forecast for?",
			expected: "location"
		});
	}

	// ... rest of the function remains the same
};

// ---------------------------------------------------------------------------
// Live-information detection. Things that change (richest person, net worth, news, scores, CEOs,
// latest versions) need the live web even when the planner did not flag them.
// Set WEB_LIVE_DETECT=0 in .env to switch this extra detection off.
// ---------------------------------------------------------------------------
const liveDetectEnabled = () => String(process.env.WEB_LIVE_DETECT ?? "1") !== "0";
const liveNormalize = (value) => String(value ?? "").replace(/\s+/g, " ").trim();

// Commands that produce something rather than ask for a fact, and chit-chat: never worth a web search.
const LIVE_GENERATIVE_START = /^(write|compose|draft|create|generate|make|build|design|translate|summari[sz]e|rewrite|paraphrase|fix|debug|refactor|convert|implement|code)\b/i;
const LIVE_SMALL_TALK_START = /^(hi+|hello|hey+|good\s+(?:morning|afternoon|evening|night)|thanks?|thank you|ok(?:ay)?|bye|how are you|how(?:'s| is) it going|what'?s up|sup)\b/i;
const LIVE_QUESTION_START = /^(who|whom|whose|what|which|when|where|why|how|is|are|was|were|does|do|did|can|could|will|would|has|have|tell|show|give|find|list|name|any|latest|current|today|check|news)\b/i;
const LIVE_REQUEST_PHRASE = /\b(tell me|show me|give me|let me know|i want to know|i wanna know|do you know|can you (?:tell|find|check|show))\b/i;

const LIVE_RECENCY_PATTERNS = [
	/\b(today|tonight|yesterday|right now|as of (?:now|today)|this (?:week|month|year|season|weekend|morning|evening)|latest|recent(?:ly)?|newest|breaking|just (?:announced|released|happened|launched))\b/i,
	// "current" also means electric current, so leave the obvious physics phrases alone.
	/\bcurrent(?:ly)?\b(?!\s+(?:in\s+a\b|flow|density|source|through|electricity|transformer|meter|carrying))/i,
	/\b(?:live|ongoing)\s+(?:score|scores|updates?|news|price|rate|stream|match|coverage|results?)\b/i,
	/\b20(?:2[5-9]|3\d)\b/,
];
const LIVE_NEWS_PATTERN = /\b(news|headlines?|top stories|breaking)\b/i;
const LIVE_RANKING_PATTERN = /\b(richest|wealthiest|net\s?worth|billionaires?|highest[- ]paid|most valuable (?:company|brand|player)|market\s?cap(?:italization)?|leaderboard|largest economy|most followed|most subscribed|(?:world|global|fifa|icc|atp|wta|qs|nirf|university|college)\s+rankings?)\b/i;
const LIVE_ROLE_HOLDER_PATTERN = /\bwho\s+(?:is|'s)\s+(?:the\s+)?(?:current\s+|present\s+|new\s+)?(?:ceo|cto|cfo|coo|chairman|head coach|coach|captain|skipper)\b/i;
const LIVE_SPORTS_PATTERN = /\b(?:(?:cricket|football|ipl|nba|nfl|epl|tennis|match|game)\s+(?:live\s+)?scores?|scorecard|fixtures?|standings|points table|who (?:won|is winning|will win)|match (?:today|result|tonight)|box office|release date)\b/i;

const isLiveInfoQuestion = (text) => {
	if (!liveDetectEnabled()) return false;

	const value = liveNormalize(text);

	if (!value || value.length > 400 || value.includes("```")) return false;
	if (LIVE_GENERATIVE_START.test(value) || LIVE_SMALL_TALK_START.test(value)) return false;

	// Short bare lookups ("ipl points table", "bitcoin price today") are questions too.
	const isShortLookup = value.split(/\s+/).length <= 8;
	const asksSomething = LIVE_QUESTION_START.test(value) || /\?\s*$/.test(value) || LIVE_REQUEST_PHRASE.test(value) || isShortLookup;
	if (!asksSomething) return false;

	return LIVE_RECENCY_PATTERNS.some((pattern) => pattern.test(value))
		|| LIVE_NEWS_PATTERN.test(value)
		|| LIVE_RANKING_PATTERN.test(value)
		|| LIVE_ROLE_HOLDER_PATTERN.test(value)
		|| LIVE_SPORTS_PATTERN.test(value);
};

const LIVE_ANAPHORA = /\b(he|him|his|she|her|hers|it|its|they|them|their|theirs|that|this|those|these|there|then|same|former|latter|ones?)\b/i;
const LIVE_CONTINUATION_START = /^(and|also|what about|how about|then|so|but|now)\b/i;

// A follow-up like "his current networth?" is meaningless to a search engine until the
// pronoun is replaced with the name from the previous turn.
const needsQueryRewrite = (message, conversation) => {
	if (!liveDetectEnabled()) return false;
	if (!Array.isArray(conversation) || !conversation.length) return false;

	const value = liveNormalize(message);
	if (!value) return false;

	return LIVE_ANAPHORA.test(value) || LIVE_CONTINUATION_START.test(value) || value.split(/\s+/).length <= 4;
};

const resolveWebContext = async ({ message, useWeb, conversation = [] }) => {
	if (!useWeb) {
		return null;
	}

	const normalizedMessage = normalizeText(message);

	// A follow-up such as "his current networth?" means nothing to a search engine on its own.
	// Rewrite it into a standalone query from the recent conversation; if that fails for any
	// reason, search with the original message exactly as before.
	let searchBase = normalizedMessage;

	if (needsQueryRewrite(normalizedMessage, conversation)) {
		try {
			const rewritten = normalizeText(await rewriteSearchQuery(normalizedMessage, conversation));

			if (rewritten) {
				searchBase = rewritten;
			}
		} catch {
			// keep the original message
		}
	}

	const stateLevelPmMessage = /\bpm\b/i.test(searchBase)
		&& !/^\s*\d+\s*pm\b/i.test(searchBase)
		&& !/\b(?:at|by|from|until|before|after)\s+\d+\s*pm\b/i.test(searchBase)
		&& /\b(west bengal|bihar|kerala|gujarat|maharashtra|tamil nadu|punjab|rajasthan|assam|odisha|telangana|karnataka)\b/i.test(searchBase)
		? searchBase.replace(/\bpm\b/gi, "chief minister")
		: searchBase;

	logger.info("[chatController] web search", { message: normalizedMessage.slice(0, 120), query: stateLevelPmMessage.slice(0, 120) });

	try {
		const bundle = await searchWebDetailed(stateLevelPmMessage);
		const hasSources = Boolean((bundle?.rankedSources && bundle.rankedSources.length) || (bundle?.sources && bundle?.sources.length));
		if (!bundle || !hasSources || bundle.status !== "ok") {
			logger.warn("[chatController] web search returned no usable sources", { query: stateLevelPmMessage.slice(0, 120), status: bundle?.status || "none" });
			return "WEB_SEARCH_FAILED";
		}

		return formatWebSearchContext(bundle);
	} catch {
		return "WEB_SEARCH_FAILED";
	}
};

const buildPromptOptions = async ({ message, conversation, attachments, attachmentAnalysis, userId, plan, toolContext, webContext, memoryContext }) => {
	const profile = await getDatabaseProfile(userId);

	return {
		profileContext: formatProfileContext(profile),
		memoryContext: memoryContext || "",
		attachments: Array.isArray(attachments) ? attachments : [],
		attachmentAnalysis: normalizeText(attachmentAnalysis),
		responseStyle: profile?.responseStyle || "balanced",
		useRAG: plan.useRAG,
		useWeb: plan.useWeb,
		userId,
		conversation,
		toolContext,
		webContext,
	};
};

const resolveModelComplexity = (plan) => {
	if (Array.isArray(plan?.layerPlan) && plan.layerPlan.includes("reasoning")) {
		return "complex";
	}

	if (plan?.confidence >= 0.75 && plan?.useRAG && plan?.useWeb) {
		return "complex";
	}

	if (plan.intent === "coding") {
		return "coding";
	}

	if (plan.intent === "realtime") {
		return "fast";
	}

	if (plan.useRAG) {
		return "complex";
	}

	return plan.tool !== "none" ? "fast" : "simple";
};

const persistAfterReply = async ({ message, reply, userId, threadId, regenerate = false, attachments = [], assistantMessageIndex = null, generateTitle = false, model = "" }) => {
	await saveConversationHistory({ message, reply, userId, threadId, regenerate, attachments, assistantMessageIndex, generateTitle, model }).catch((error) => {
		logger.warn("[chatController] history save failed", { message: error?.message || String(error) });
	});
};

async function handleChat(req, res) {
	// Chat responses must never be reused by a browser, CDN, or intermediary cache.
	// This also makes stale-response reports diagnosable in production logs.
	const requestId = normalizeText(req.headers["x-quantic-request-id"]) || require("crypto").randomUUID();
	res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
	res.setHeader("Pragma", "no-cache");
	res.setHeader("Expires", "0");
	res.setHeader("X-Quantic-Request-Id", requestId);

	const { message, conversation, attachments, timeZone, userTime, regenerate = false, assistantMessageIndex = null } = req.body || {};
	const editMessageIndex = Number.isInteger(req.body?.editMessageIndex) ? req.body.editMessageIndex : null;
	const streamMode = String(req.query.stream || req.headers["x-stream-mode"] || "true").toLowerCase() !== "false";
	const normalizedMessage = normalizeText(message);
	const authenticatedUserId = normalizeText(req.auth?.userId);
	const clientTimeZone = normalizeText(timeZone || req.headers["x-time-zone"]);
	const hasTimeSignal =
		/\b(?:current\s+time|time\s+now|what(?:'s| is)?\s+the\s+time|what\s+time\s+is\s+it)\b/i.test(normalizedMessage)
		|| /^\s*time\s*[?!.]*\s*$/i.test(normalizedMessage);
	const hasDateSignal =
		/\b(?:current\s+date|today(?:'s)?\s+date|date\s+now|what(?:'s| is)?\s+the\s+date)\b/i.test(normalizedMessage)
		|| /^\s*date\s*[?!.]*\s*$/i.test(normalizedMessage);
	const messageIsCompound = isCompoundMessage(normalizedMessage);
	const pendingToolContexts = [];
	const isAuthenticated = Boolean(authenticatedUserId);
	const userId = isAuthenticated ? authenticatedUserId : null;
	const normalizedConversation = normalizeConversation(conversation);
	const shouldPersistHistory = isAuthenticated ? await shouldSaveConversationHistory(userId) : false;
	const incomingThreadId = normalizeThreadId(req.headers["x-chat-thread-id"]);
	let conversationThread = null;

	logger.info("[chatController] request received", {
		requestId,
		messageLength: normalizedMessage.length,
		attachmentCount: Array.isArray(attachments) ? attachments.length : 0,
		attachmentNames: Array.isArray(attachments) ? attachments.slice(0, 10).map((item) => normalizeText(item?.name).slice(0, 120)) : [],
		threadId: normalizeThreadId(req.headers["x-chat-thread-id"]),
		regenerate: Boolean(regenerate),
	});
	logger.info("[chatController] auth debug", {
		authHeaderUserId: normalizeText(req.headers["x-user-id"]),
		hasAuth: Boolean(req.auth?.userId),
		hasUser: Boolean(req.user?.id || req.user?._id),
		isAuthenticated,
	});

	res.setHeader("Access-Control-Expose-Headers", "x-chat-thread-id, x-chat-thread-title");

	if (!normalizedMessage) {
		return res.status(400).json({ error: "Message required" });
	}

	if (req.authBanned) {
		return res.status(403).end("Your account has been suspended. Please contact support if you believe this is a mistake.");
	}

	const systemSettings = await getSystemSettings().catch(() => null);

	if (systemSettings?.maintenance?.enabled && req.auth?.role !== "admin") {
		return res.status(503).end(
			systemSettings.maintenance.message || "Quantic is currently undergoing maintenance. Please check back shortly."
		);
	}

	if (systemSettings?.moderation?.enabled && Array.isArray(systemSettings.moderation.bannedWords) && systemSettings.moderation.bannedWords.length) {
		const lowerCaseMessage = normalizedMessage.toLowerCase();
		const matchedBannedWord = systemSettings.moderation.bannedWords.find((word) => word && lowerCaseMessage.includes(word));

		if (matchedBannedWord) {
			return res.status(400).end("Your message contains content that isn't allowed here. Please rephrase and try again.");
		}
	}

	if (shouldPersistHistory) {
		if (regenerate && incomingThreadId) {
			const threadLookup = buildThreadLookup(toObjectIdOrNull(userId), incomingThreadId);
			conversationThread = threadLookup ? await Chat.findOne(threadLookup).catch(() => null) : null;
		} else {
			conversationThread = await startConversationHistory({
				userId,
				message: normalizedMessage,
				attachments: Array.isArray(attachments) ? attachments : [],
				threadId: incomingThreadId,
				editMessageIndex,
			}).catch((error) => {
				logger.warn("[chatController] history start failed", { message: error?.message || String(error) });
				return null;
			});
		}

		if (conversationThread?._id) {
			res.setHeader("x-chat-thread-id", String(conversationThread._id));
		}
	}

	const isTitleLocked = conversationThread?.titleAutoGenerated === false;
	let priorUserMessageCount = 0;

	if (conversationThread?._id && !conversationThread.isNewThread) {
		priorUserMessageCount = await Message.countDocuments({ chatId: conversationThread._id, role: "user" }).catch(() => 0);
	}

	// startConversationHistory already inserted the current turn, so 1 means "first ever".
	const isFirstUserTurn = Boolean(conversationThread?.isNewThread) || priorUserMessageCount <= 1;
	let shouldGenerateTitle = Boolean(conversationThread?._id) && !regenerate && !isTitleLocked && isFirstUserTurn;

	if (shouldGenerateTitle) {
		const generatedTitle = await generateChatTitle(normalizedMessage).catch((error) => {
			logger.warn("[chatController] title generation failed", { message: error?.message || String(error) });
			return "";
		});

		if (generatedTitle) {
			conversationThread.title = generatedTitle;
			conversationThread.titleAutoGenerated = true;
			await conversationThread.save().catch((error) => {
				logger.warn("[chatController] title save failed", { message: error?.message || String(error) });
			});
		}
	}

	shouldGenerateTitle = false;

	if (conversationThread?._id) {
		res.setHeader("x-chat-thread-title", encodeURIComponent(normalizeText(conversationThread.title) || "New chat"));
	}

	const isLocationCorrectionMessage = (message) => {
		const normalized = normalizeText(message).toLowerCase();
		return /\b(not my (correct )?location|wrong location|that's not (my|where i)|thats not (my|where i)|i('m| am) not (in|from|located in)|wrong,?\s*my location|my (?:correct |actual |real )?location is|correct location is|actual location is)\b/.test(normalized);
	};

	const extractExplicitLocationStatement = (message) => {
		const normalized = normalizeText(message);

		if (!normalized) {
			return "";
		}

		const patterns = [
			/\bmy (?:correct |actual |real )?location\s+is\s+([a-zA-Z][a-zA-Z\s',.\-]{1,100})/i,
			/\bcorrect location\s+is\s+([a-zA-Z][a-zA-Z\s',.\-]{1,100})/i,
			/\bactual location\s+is\s+([a-zA-Z][a-zA-Z\s',.\-]{1,100})/i,
			/\bi\s*(?:'m| am)\s+(?:actually\s+)?(?:from|in|at|located in)\s+([a-zA-Z][a-zA-Z\s',.\-]{1,100})/i,
		];

		for (const pattern of patterns) {
			const match = normalized.match(pattern);
			if (match?.[1]) {
				return match[1].replace(/[?!.]+$/g, "").trim();
			}
		}

		return "";
	};

	const memoryFeatureEnabled = systemSettings?.features?.memory !== false;
	//const shouldGenerateTitle = Boolean(conversationThread?.isNewThread) && !regenerate;
	if (isAuthenticated && memoryFeatureEnabled) {
		if (isLocationCorrectionMessage(normalizedMessage)) {
			await deleteLocationMemories(userId).catch((error) => {
				logger.warn("[chatController] location memory delete failed", { message: error?.message || String(error) });
			});

			const correctedLocation = extractExplicitLocationStatement(normalizedMessage);

			if (correctedLocation) {
				await saveMemory(
					userId,
					[{ type: "fact", key: "location", content: correctedLocation, confidence: 0.95, importance: 3 }],
					normalizedMessage
				).catch((error) => {
					logger.warn("[chatController] corrected location save failed", { message: error?.message || String(error) });
				});
			}
		} else {
			const extractedMemories = await extractMemory(normalizedMessage);
			await saveMemory(userId, extractedMemories, normalizedMessage).catch((error) => {
				logger.warn("[chatController] memory save failed", { message: error?.message || String(error) });
			});
		}
	}

	let activeConversation = normalizedConversation;
	if (conversationThread?._id && !regenerate && editMessageIndex === null) {
		activeConversation = await fetchThreadMessages(conversationThread)
			.then((messages) => {
				const history = messages.slice(-10);
				// startConversationHistory stores the current user turn before generation.
				// The current request is already supplied separately as the query, so remove
				// that final duplicate turn from history to avoid stale/duplicated context.
				const last = history[history.length - 1];
				if (last?.role === "user" && normalizeText(last.content) === normalizedMessage) {
					history.pop();
				}
				return history;
			})
			.catch(() => normalizedConversation);
	}

	let memoryContext = { shortTerm: "", longTerm: "", semantic: "", memories: [] };
	if (isAuthenticated && memoryFeatureEnabled) {
		memoryContext = await buildMemoryLayerContext({
			userId,
			query: normalizedMessage,
			conversation: activeConversation,
		}).catch(() => ({ shortTerm: "", longTerm: "", semantic: "", memories: [] }));
	}

	const attachmentAnalysis = await buildAttachmentAnalysis(Array.isArray(attachments) ? attachments : []);

	// Image generation request: detect and short-circuit to the image service
	try {
		if (imageService && imageService.isImageGenerationQuery && imageService.isImageGenerationQuery(normalizedMessage)) {
			if (systemSettings?.features?.imageGeneration === false) {
				const disabledReply = "Image generation is currently disabled by the administrator.";
				res.status(200).end(disabledReply);

				if (shouldPersistHistory && conversationThread?._id) {
					await persistAfterReply({ message: normalizedMessage, reply: disabledReply, userId, threadId: conversationThread._id, regenerate, assistantMessageIndex, generateTitle: shouldGenerateTitle });
				}

				return;
			}

			const result = await imageService.generateImage(normalizedMessage);

			if (result && result.success && result.dataUrl) {
				const imageAttachment = {
					key: `generated-image-${Date.now()}`,
					name: "Generated image",
					size: result.dataUrl.length,
					type: "image/png",
					dataUrl: result.dataUrl,
				};

				res.status(200).json({
					replyType: "image",
					content: "",
					attachments: [imageAttachment],
					prompt: result.prompt,
				});

				if (shouldPersistHistory && conversationThread?._id) {
					await persistAfterReply({
						message: normalizedMessage,
						reply: "",
						attachments: [imageAttachment],
						userId,
						threadId: conversationThread._id,
						regenerate,
						assistantMessageIndex,
						generateTitle: shouldGenerateTitle,
					});
				}

				return;
			}

			// If generation failed, return a helpful error to the client but do not break other logic
			const errorMessage = (result && result.error) ? String(result.error) : "Unable to generate image.";
			res.status(500).end(errorMessage);
			return;
		}
	} catch (err) {
		logger.warn("[chatController] image generation failed", { message: err?.message || String(err) });
		// fall through to normal planner flow on error
	}

	if (isGreetingMessage(normalizedMessage)) {
		const reply = buildGreetingReply();

		res.status(200).end(reply);

		if (shouldPersistHistory && conversationThread?._id) {
			await persistAfterReply({ message: normalizedMessage, reply, userId, threadId: conversationThread._id, regenerate, assistantMessageIndex, generateTitle: shouldGenerateTitle });
		}

		return;
	}

	if (isCreatorQuestion(normalizedMessage)) {
		if (!messageIsCompound) {
			const reply = buildCreatorReply();

			res.status(200).end(reply);

			if (shouldPersistHistory && conversationThread?._id) {
				await persistAfterReply({ message: normalizedMessage, reply, userId, threadId: conversationThread._id, regenerate, assistantMessageIndex, generateTitle: shouldGenerateTitle });
			}

			return;
		}

		pendingToolContexts.push(`Creator info: ${buildCreatorReply()}`);
	}

	if (hasTimeSignal || hasDateSignal) {
		const timeDateReport = buildTimeAndDateReport({ timeZone: clientTimeZone, userTime });

		if (!messageIsCompound) {
			res.status(200).end(timeDateReport);

			if (shouldPersistHistory && conversationThread?._id) {
				await persistAfterReply({ message: normalizedMessage, reply: timeDateReport, userId, threadId: conversationThread._id, regenerate, assistantMessageIndex, generateTitle: shouldGenerateTitle });
			}

			return;
		}

		pendingToolContexts.push(`Current date and time (already known, state it directly and accurately):\n${timeDateReport}`);
	}

	if (isCalculatorQuery(normalizedMessage)) {
		const calculatorResult = executeTool(normalizedMessage, "calculator");

		if (calculatorResult?.ok) {
			const calculatorReply = typeof calculatorResult.data?.variable === "string" && calculatorResult.data.variable && calculatorResult.data?.value !== undefined && calculatorResult.data?.value !== null
				? `${calculatorResult.data.variable} = ${calculatorResult.data.value}.`
				: `The result is ${calculatorResult.data?.value ?? "unavailable"}.`;

			if (!messageIsCompound) {
				res.status(200).end(calculatorReply);

				if (shouldPersistHistory && conversationThread?._id) {
					await persistAfterReply({ message: normalizedMessage, reply: calculatorReply, userId, threadId: conversationThread._id, regenerate, assistantMessageIndex, generateTitle: shouldGenerateTitle });
				}

				return;
			}

			pendingToolContexts.push(`Calculation result (already known, state it directly):\n${calculatorReply}`);
		}
	}

	const plan = await responsePlanner(normalizedMessage, activeConversation);
	const awaitingWeatherLocation = isFollowingWeatherLocationPrompt(activeConversation);
	if (awaitingWeatherLocation) {
		plan.intent = "realtime";
		plan.tool = "weather";
		plan.useWeb = false;
		plan.useRAG = false;
	}
	// Force web-grounding for time-sensitive current office-holder questions.
	const hasCurrentSignal = /\b(current|present|latest|as of|right now|now|20\d{2})\b/i.test(normalizedMessage);
	const hasFinanceSignal = /\b(gold|silver|crude\s+oil|oil\s+price|share\s+price|stock\s+price|stock\s+market|market\s+price|crypto|bitcoin|ethereum|nifty|sensex|exchange\s+rate|forex|currency\s+rate|usd\s+to\s+inr|inr\s+to\s+usd|gold\s+price|gold\s+rate|commodity\s+price)\b/i.test(normalizedMessage);
	const hasOfficeQuestionSignal = /\b(who is|who's|who\s+is|what is|name of|posted as|serving as|represents|holds)\b/i.test(normalizedMessage);
	const hasPublicOfficeEntitySignal = /\b(mla|mp|member\s+of\s+legislative\s+assembly|member\s+of\s+parliament|assembly\s+constituency|legislative\s+assembly|legislative\s+council|cm|chief\s+minister|prime\s+minister|pm|president|governor|minister|ias|ips|district\s+magistrate|district\s+collector|collector|dm|superintendent\s+of\s+police|sp|s\.p\.|police\s+superintendent)\b/i.test(normalizedMessage);
	const hasPublicPmAliasSignal = /\bpm\b/i.test(normalizedMessage)
		&& !/^\s*\d+\s*pm\b/i.test(normalizedMessage)
		&& !/\b(?:at|by|from|until|before|after)\s+\d+\s*pm\b/i.test(normalizedMessage);
	const hasElectionResultSignal = /\b(election|elections|result|results|winner|won|counting|vote\s+share|votes?)\b/i.test(normalizedMessage)
		&& /\b(assembly\s+constituency|constituency|mla|mp|member\s+of\s+legislative\s+assembly|member\s+of\s+parliament|minister|mayor|ward|district|west\s+bengal|india)\b/i.test(normalizedMessage);
	const isPublicOfficeQuestion = (hasPublicOfficeEntitySignal || hasPublicPmAliasSignal) && (hasOfficeQuestionSignal || hasCurrentSignal);
	const isPublicOfficeJoiningDateQuestion =
		/\b(cm|chief\s+minister|prime\s+minister|president|governor|minister)\b/i.test(normalizedMessage)
		&& /\b(joining\s+date|took\s+oath|oath\s+date|sworn\s+in|assumed\s+office|term\s+started|took\s+office)\b/i.test(normalizedMessage);
	const isElectionResultQuestion = hasElectionResultSignal;
	const isFinanceQuestion = hasFinanceSignal;
	if (isPublicOfficeQuestion) {
		plan.intent = "realtime";
		plan.useWeb = true;
		plan.tool = "none";
		plan.useRAG = false;
	}
	if (isPublicOfficeJoiningDateQuestion) {
		plan.intent = "realtime";
		plan.useWeb = true;
		plan.tool = "none";
		plan.useRAG = false;
	}
	if (isElectionResultQuestion) {
		plan.intent = "realtime";
		plan.useWeb = true;
		plan.tool = "none";
		plan.useRAG = false;
	}
	if (isFinanceQuestion) {
		plan.intent = "realtime";
		plan.useWeb = true;
		plan.tool = "none";
		plan.useRAG = false;
	}
	// Things that change (richest person, net worth, news, scores, CEOs, latest versions) need live data even
	// when the planner did not flag them. Only ever turns web ON, never touches tools, coding or RAG.
	if (!plan.useWeb && (!plan.tool || plan.tool === "none") && plan.intent !== "coding" && isLiveInfoQuestion(normalizedMessage)) {
		plan.intent = "realtime";
		plan.useWeb = true;
	}
	const configuredChatModel = normalizeText(systemSettings?.model?.chatModel);
	const model = configuredChatModel || selectModel(normalizedMessage, plan.intent, resolveModelComplexity(plan));

	const compoundRequest = isCompoundInfoRequest(normalizedMessage);
	if ((compoundRequest && plan.tool === "weather") || (messageIsCompound && asksForAdditionalWebInfo(normalizedMessage))) {
		plan.useWeb = true;
	}

	const toolContext = await resolveToolContext({ message: normalizedMessage, conversation: activeConversation, tool: plan.tool, timeZone: clientTimeZone, userTime, userId, memoryContext });
	if (!messageIsCompound && ["system", "weather", "calculator"].includes(plan.tool) && toolContext) {
		let outgoingReply = toolContext;

		try {
			const parsedToolContext = JSON.parse(toolContext);
			if (parsedToolContext && parsedToolContext.type === "followup" && parsedToolContext.message) {
				outgoingReply = parsedToolContext.message;
			}
		} catch {
			// toolContext is plain text (a real weather report / calculator / date result) — use as-is
		}

		res.status(200).end(outgoingReply);

		if (shouldPersistHistory && conversationThread?._id) {
			await persistAfterReply({ message: normalizedMessage, reply: outgoingReply, userId, threadId: conversationThread._id, regenerate, generateTitle: shouldGenerateTitle, model });
		}

		return;
	}
	const webSearchFeatureEnabled = systemSettings?.features?.webSearch !== false;
	const webContext = await resolveWebContext({ message: normalizedMessage, useWeb: plan.useWeb && webSearchFeatureEnabled, conversation: activeConversation });
	const combinedToolContext = [...pendingToolContexts, toolContext].filter(Boolean).join("\n\n");

	const promptOptions = await buildPromptOptions({
		message: normalizedMessage,
		conversation: activeConversation,
		attachments: Array.isArray(attachments) ? attachments : [],
		attachmentAnalysis,
		userId,
		plan,
		toolContext: combinedToolContext,
		webContext,
		memoryContext,
	});

	logger.info("[chatController] plan", { userId, plan, model, streamMode });

	const proofreadingRequested =
		/\b(?:spell(?:ing)?[ -]?(?:check|mistakes?|errors?)|typos?|proofread(?:ing)?|grammar(?:[ -]?(?:check|mistakes?|errors?))?|punctuation(?:[ -]?(?:check|mistakes?|errors?))?|correct (?:the )?(?:spelling|grammar|english|punctuation)|check (?:my |this |the |these )?(?:spelling|grammar|writing|text|document|file)|review (?:my |this |the |these )?(?:writing|text|document|file)|find (?:and )?fix (?:the )?(?:mistakes?|errors?)|language errors?)\b/i.test(normalizedMessage);

	let prompt = await buildPrompt(normalizedMessage, promptOptions);
	prompt += `

LATEST-TURN PRIORITY:
- Answer the latest user request in this request, not a previous turn.
- Treat the current user message and any successfully extracted attachment contents as the primary task.
- Use earlier conversation only when it helps interpret the latest request; never repeat a prior answer merely because it appears in history.
- If an attachment was provided, explicitly use its extracted contents. If extraction failed or produced no text, state that instead of guessing.
- Be tolerant of obvious spelling mistakes, typos, and phonetic misspellings in the user's question. Infer the intended word or entity from context when unambiguous (for example, "Rassia" means "Russia"); answer the intended question instead of treating the typo as an unknown entity.
- If a typo makes the request genuinely ambiguous, ask one brief clarification question rather than claiming that no reliable information exists.
- Do not silently change names, numbers, locations, or technical identifiers when the intended correction is uncertain.
- When the user explicitly asks to detect/check spelling or grammar, perform an actual proofreading pass and list the original text, correction, and reason. Do not merely answer the underlying topic.
- For attachments, distinguish between file receipt, successful content extraction, and actual semantic analysis. Never imply that OCR alone can count objects or understand a scene in an image.
`;
	if (proofreadingRequested) {
		prompt += `

PROOFREADING TASK (only because the user explicitly requested it):
- Inspect the user's text and all extracted attachment text for spelling, grammar, punctuation, and obvious word-choice errors.
- Report each finding with the original phrase, a corrected version, and a brief explanation.
- For files, include page/slide/sheet/line references when extraction provides them; never invent locations.
- Separate definite errors from optional style improvements.
- If no errors are found in the available text, say so clearly.
- Do not claim to have checked unreadable or unsupported file contents. If extraction is partial, state that limitation.
- Preserve the user's intended meaning and do not silently rewrite unrelated content.
`;
	}
	let reply = "";
	const plannerComplexity = resolveModelComplexity(plan);
	const shouldStreamResponse = streamMode && plannerComplexity !== "complex";

	if (!shouldStreamResponse) {
		reply = await generateGroqResponse(prompt, normalizedMessage, model, {
			intent: plan.intent,
			complexity: plannerComplexity,
			hasAttachmentAnalysis: Boolean(attachmentAnalysis),
		});
		reply = buildSourcesMarker(extractWebSources(webContext)) + sanitizeCitationFormatting(reply, countWebContextSources(webContext));
		res.status(200).end(reply);
		if (shouldPersistHistory && conversationThread?._id) {
			await persistAfterReply({ message: normalizedMessage, reply, userId, threadId: conversationThread._id, regenerate, assistantMessageIndex, generateTitle: shouldGenerateTitle, model });
		}
		return;
	}

	res.setHeader("Content-Type", "text/plain; charset=utf-8");
	res.setHeader("Cache-Control", "no-cache");
	res.setHeader("Transfer-Encoding", "chunked");
	res.setHeader("Connection", "keep-alive");

	// Send the trusted source list first so every badge can resolve its link.
	const sourcesMarker = buildSourcesMarker(extractWebSources(webContext));
	if (sourcesMarker) {
		res.write(sourcesMarker);
	}

	reply = await streamGroqResponse(prompt, res, normalizedMessage, model, {
		intent: plan.intent,
		complexity: plannerComplexity,
		hasAttachmentAnalysis: Boolean(attachmentAnalysis),
	});
	reply = sourcesMarker + sanitizeCitationFormatting(reply, countWebContextSources(webContext));
	if (shouldPersistHistory && conversationThread?._id) {
		await persistAfterReply({ message: normalizedMessage, reply, userId, threadId: conversationThread._id, regenerate, assistantMessageIndex, generateTitle: shouldGenerateTitle, model });
	}
}

const getChatHistory = async (req, res) => {
	const userId = normalizeText(req.auth?.userId);

	if (!userId) {
		return res.status(401).json({ message: "Not authenticated." });
	}

	const threads = await getConversationHistory(userId);
	return res.json({ threads });
};

const getChatHistoryThread = async (req, res) => {
	const userId = normalizeText(req.auth?.userId);
	const threadId = normalizeText(req.params?.threadId);

	if (!userId) {
		return res.status(401).json({ message: "Not authenticated." });
	}

	const thread = await getConversationThread(userId, threadId);

	if (!thread) {
		return res.status(404).json({ message: "Chat history not found." });
	}

	return res.json({ thread });
};

const updateChatHistoryThread = async (req, res) => {
	const userId = normalizeText(req.auth?.userId);
	const threadId = normalizeText(req.params?.threadId);
	const title = normalizeText(req.body?.title);
	const pinned = typeof req.body?.pinned === "boolean" ? req.body.pinned : undefined;
	const archived = typeof req.body?.archived === "boolean" ? req.body.archived : undefined;

	if (!userId) {
		return res.status(401).json({ message: "Not authenticated." });
	}

	const thread = await updateConversationThread({ userId, threadId, title, pinned, archived });

	if (!thread) {
		return res.status(404).json({ message: "Chat history not found." });
	}

	return res.json({ thread: formatThreadSummary(thread) });
};

const deleteChatHistoryThread = async (req, res) => {
	const userId = normalizeText(req.auth?.userId);
	const threadId = normalizeText(req.params?.threadId);

	if (!userId) {
		return res.status(401).json({ message: "Not authenticated." });
	}

	const deleted = await deleteConversationThread({ userId, threadId });

	if (!deleted) {
		return res.status(404).json({ message: "Chat history not found." });
	}

	return res.status(204).send();
};

const chat = async (req, res) => handleChat(req, res);

module.exports = {
	chat,
	handleChat,
	getChatHistory,
	getChatHistoryThread,
	updateChatHistoryThread,
	deleteChatHistoryThread,
	normalizeConversation,
	resolveToolContext,
	resolveWebContext,
	buildPromptOptions,
	persistAfterReply,
};

