//back-end/services/imageService.js
const axios = require("axios");
const logger = console;

// Current Pollinations endpoint (the old image.pollinations.ai/prompt is legacy).
const IMAGE_API_URL = process.env.IMAGE_API_URL || "https://gen.pollinations.ai/image";
// Secret key (sk_...) from https://enter.pollinations.ai - keep it on the backend only.
const IMAGE_API_KEY = process.env.IMAGE_API_KEY || process.env.IMAGE_API_TOKEN || "";
// Run GET https://gen.pollinations.ai/image/models to see valid model IDs (e.g. flux, zimage, gptimage).
const IMAGE_MODEL = process.env.IMAGE_MODEL || "flux";
const IMAGE_ENHANCE = String(process.env.IMAGE_ENHANCE || "true") === "true";
const IMAGE_NEGATIVE_PROMPT =
  process.env.IMAGE_NEGATIVE_PROMPT ||
  "blurry, low quality, low resolution, distorted, deformed, extra limbs, watermark, text, jpeg artifacts, cropped, cut off, out of frame";
const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS || 60000);
const MAX_IMAGE_GEN_ATTEMPTS = Number(process.env.MAX_IMAGE_GEN_ATTEMPTS || 3);
const MIN_REQUEST_GAP_MS = Number(process.env.IMAGE_MIN_REQUEST_GAP_MS || 1000);
const IMAGE_REQUEST_HEADERS = {
  Accept: "image/*,*/*;q=0.8",
  ...(IMAGE_API_KEY ? { Authorization: `Bearer ${IMAGE_API_KEY}` } : {}),
};

const normalizeText = (value) => String(value ?? "").trim();

const logEvent = (event, details = {}) => {
  logger.info(`[imageGenerationService] ${event}`, details);
};

const logError = (event, error) => {
  logger.error(`[imageGenerationService] ${event}`, {
    message: error?.message || "Unknown error",
    code: error?.code || null,
    status: error?.response?.status || null,
    retryAfter: error?.response?.headers?.["retry-after"] || null,
  });
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SERVICE_VERSION = "landscape-framing-v3";
logEvent("loaded", {
  version: SERVICE_VERSION,
  model: IMAGE_MODEL,
  defaultSize: `${process.env.IMAGE_DEFAULT_WIDTH || 1216}x${process.env.IMAGE_DEFAULT_HEIGHT || 832}`,
  hasApiKey: Boolean(IMAGE_API_KEY),
});


let queueTail = Promise.resolve();
let lastRequestAt = 0;

const runQueued = (task) => {
  const run = async () => {
    const waitFor = Math.max(0, lastRequestAt + MIN_REQUEST_GAP_MS - Date.now());
    if (waitFor > 0) {
      await delay(waitFor);
    }
    lastRequestAt = Date.now();
    return task();
  };

  const result = queueTail.then(run, run);
  queueTail = result.catch(() => {});
  return result;
};

// Finished image prompts ("A stunning BMW ..., photorealistic, 85mm lens, HDR, 8K") often have no
// "create/draw" verb. Recognise them by their photography / art vocabulary instead.
const IMAGE_STYLE_TERMS = [
  /photo-?realistic/, /hyper-?realistic/, /ultra[- ]?detailed/, /highly detailed/, /cinematic/,
  /depth of field/, /bokeh/, /\b\d{2,3}\s?mm\b/, /\bhdr\b/, /\b[248]k\b/, /octane render/,
  /unreal engine/, /ray[- ]?trac/, /studio lighting/, /golden hour/, /wide[- ]angle/, /low[- ]angle/,
  /close[- ]up/, /concept art/, /digital painting/, /oil painting/, /watercolou?r/, /anime style/,
  /volumetric/, /dramatic (lighting|contrast)/, /soft lighting/, /(crisp|sharp) focus/,
  /professional [a-z ]{0,20}photography/, /award[- ]winning/, /artstation/, /no watermark/,
];

const looksLikeImagePrompt = (text) => {
  const t = normalizeText(text).toLowerCase();
  if (t.length < 40 || t.includes("```")) return false;
  if (/^(explain|what|why|how|when|who|which|compare|difference|tell me|summari[sz]e|translate|review)\b/.test(t)) {
    return false;
  }
  const score = IMAGE_STYLE_TERMS.filter((re) => re.test(t)).length;
  const commas = (t.match(/,/g) || []).length;
  return score >= 3 || (score >= 2 && commas >= 3);
};

const isImageGenerationQuery = (query) => {
  const normalized = normalizeText(query).toLowerCase();

  if (looksLikeImagePrompt(normalized)) {
    return true;
  }

  // "image of a sunset over the sea" / "picture of ..." without a command verb
  if (/^\s*(an?\s+)?(image|picture|photo|illustration|render)\s+of\b/i.test(normalized) && !normalized.includes("?")) {
    return true;
  }

  // If the user is asking for code (e.g., "using Java code"), do NOT treat it as an image request
  // unless they explicitly mention an image/picture/photo/art/etc.
  const isCodeOrDevQuery = (text) => {
    if (!text) return false;

    const patterns = [
      /```/,
      /\b(source\s*code|code|program|script|snippet|implementation|function|method|class|compile|run|debug)\b/i,
      /\b(java|javascript|typescript|python|c\+\+|c#|c\s*sharp|go|golang|php|ruby|rust|swift|kotlin|dart)\b/i,
      /\b(node|express|react|vite|spring|django|flask)\b/i,
      /\b(using|in)\s+(java|javascript|typescript|python|c\+\+|c#|go|php|ruby|rust|swift|kotlin|dart)\b/i,
    ];

    return patterns.some((p) => p.test(text));
  };

  const explicitCodeSignal = /```|\b(source\s*code|code|program|script|snippet|implementation)\b/i.test(normalized);
  if (explicitCodeSignal) {
    return false;
  }

  const hasExplicitImageNoun = /\b(image|picture|photo|illustration|art|drawing|sketch|render|cgi|logo|wallpaper|icon)\b/i.test(normalized);
  const codeLike = isCodeOrDevQuery(normalized);
  if (codeLike && !hasExplicitImageNoun) {
    return false;
  }
  
  // Explicit image generation patterns
  const generatePatterns = [
    /\b(generate|create|make|draw|render|produce)\s+(an?|the)?\s*(image|picture|photo|illustration|art|drawing|sketch|render|visual|cgi)\b/i,
    /\b(generate|create|make|draw)\s+(an?|the)?\s*(image of|picture of|photo of)\b/i,
    /\b(ai\s+art|image\s+generation|text\s+to\s+image)\b/i,
    /^\s*(generate|create|make)\s+(me\s+)?(an?|the)?\s*(?!(code|explanation|summary|list|step))\w*\s*(image|picture|photo|art)/i,
  ];
  
  // Object drawing patterns (draw a car, create a cat image, etc.)
  const objectPattern = /\b(draw|create|make|generate|render)\s+(a|an|the)?\s*([a-z]+)\s*(image|picture|photo|illustration)?\s*$/i;
  
  // Short patterns like "draw a dog", "make me a sunset"
  const shortPattern = /^\s*(draw|create|make|generate)\s+(a|an|the)?\s*.+\s*$/i;
  
  for (const pattern of generatePatterns) {
    if (pattern.test(normalized)) {
      return true;
    }
  }
  
  if (objectPattern.test(normalized) && !normalized.includes("code") && !normalized.includes("explain")) {
    return true;
  }
  
  if (shortPattern.test(normalized) && normalized.length < 60 && !normalized.includes("?") && !codeLike) {
    return true;
  }
  
  return false;
};

// Default to landscape (3:2) like ChatGPT so wide subjects (cars, scenes) are not squeezed into a square.
const DEFAULT_WIDTH = Number(process.env.IMAGE_DEFAULT_WIDTH || 1216);
const DEFAULT_HEIGHT = Number(process.env.IMAGE_DEFAULT_HEIGHT || 832);
const RATIO_SIZES = {
  "16:9": [1344, 768],
  "9:16": [768, 1344],
  "1:1": [1024, 1024],
  "4:3": [1152, 896],
  "3:4": [896, 1152],
  "3:2": [1216, 832],
  "2:3": [832, 1216],
};

const chooseImageSize = (text) => {
  const t = normalizeText(text).toLowerCase();

  const ratio = t.match(/\b(16|9|4|3|2|1)\s*:\s*(9|16|3|4|2|1)\b/);
  if (ratio) {
    const key = `${ratio[1]}:${ratio[2]}`;
    if (RATIO_SIZES[key]) return RATIO_SIZES[key];
  }
  if (/\b(square|logo|icon|avatar|profile (picture|photo)|sticker|emoji)\b/.test(t)) return RATIO_SIZES["1:1"];
  if (/\b(phone wallpaper|mobile wallpaper|vertical|portrait (orientation|mode|format)|portrait of|poster|full[- ]body|headshot|selfie)\b/.test(t)) {
    return RATIO_SIZES["2:3"];
  }
  if (/\b(banner|panorama|panoramic|ultra[- ]?wide|widescreen|desktop wallpaper)\b/.test(t)) return RATIO_SIZES["16:9"];
  return [DEFAULT_WIDTH, DEFAULT_HEIGHT];
};

const MAX_PROMPT_CHARS = 1500;
const LONG_PROMPT_CHARS = 250; // already detailed - don't let enhance rewrite it

// "no people, no text, or watermark" belongs in negative_prompt; leaving it in the
// positive prompt tends to *add* text/watermarks with diffusion models.
const NEG_TERM = "(?:people|persons?|humans?|text|words|letters|watermarks?|logos?|signatures?|captions?|blur|blurry|distortion|artifacts?)";
const NEGATION_RE = new RegExp(
  `[,;.]?\\s*\\b(?:no|without)\\s+${NEG_TERM}(?:\\s*(?:,|,?\\s+(?:or|and))\\s*${NEG_TERM})*`,
  "gi"
);

const prepareImagePrompt = (query) => {
  let text = normalizeText(query)
    .replace(/^\s*(?:prompt(?:\s+for\s+image\s+generation)?|image\s+prompt)\s*:\s*/i, "")
    // Strip the command words ("create me an image of ...") but keep the subject.
    .replace(/^(please\s+)?(can|could|would)\s+you\s+/i, "")
    .replace(/^(please\s+)?(generate|create|make|draw|render|produce|paint)\s+(me\s+)?(an?|the)?\s*/i, "")
    .replace(/^(image|picture|photo|illustration|drawing|sketch|render|art)\s+(of|showing)\s+/i, "")
    .replace(/^of\s+/i, "")
    .replace(/\s+(image|picture|photo|illustration|drawing|sketch|render|cgi)\s*$/i, "");

  const negatives = [];
  text = text.replace(NEGATION_RE, (match) => {
    match
      .replace(/^[,;.\s]*(?:no|without)\s+/i, "")
      .split(/\s*(?:,|\bor\b|\band\b)\s*/i)
      .map((term) => term.trim().toLowerCase())
      .filter(Boolean)
      .forEach((term) => negatives.push(term));
    return "";
  });

  text = text
    .replace(/\s+([,.;])/g, "$1")
    .replace(/[,;]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length > MAX_PROMPT_CHARS) {
    const cut = text.slice(0, MAX_PROMPT_CHARS);
    const boundary = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf(". "));
    text = (boundary > MAX_PROMPT_CHARS * 0.6 ? cut.slice(0, boundary) : cut).trim();
  }

  const negativePrompt = [
    ...new Set(
      [...IMAGE_NEGATIVE_PROMPT.split(","), ...negatives].map((term) => term.trim().toLowerCase()).filter(Boolean)
    ),
  ].join(", ");

  if (!text) {
    return { prompt: "an abstract piece of art, high quality, detailed", negativePrompt };
  }

  // With enhance=true, or a prompt that is already detailed, don't pad it.
  const alreadyDetailed =
    IMAGE_ENHANCE || text.length > LONG_PROMPT_CHARS || /\b(high quality|detailed|4k|hd|realistic|beautiful|stunning)\b/i.test(text);

  const wantsCloseUp = /\b(close-?up|macro|headshot|portrait|detail shot|texture|cropped|extreme)\b/i.test(text);
  const isVehicle = /\b(car|sedan|coupe|suv|truck|motorcycle|motorbike|supercar|vehicle|bmw|audi|mercedes|ferrari|lamborghini|porsche|tesla)\b/i.test(text);

  let lead = "";
  if (!wantsCloseUp) {
    lead = isVehicle
      ? "Wide shot, the entire vehicle fully visible in frame from bumper to bumper with space around it, three-quarter front view. "
      : "Wide shot, the entire subject fully visible in frame with space around it. ";
    // "low-angle" close to a subject is the usual cause of cropped cars/people
    text = text.replace(/\blow[- ]angle\b/gi, "slightly low angle");
  }

  const body = (alreadyDetailed ? text : `${text}, high quality, highly detailed, sharp focus`).replace(/[.,;\s]+$/, "");

  return {
    prompt: `${lead}${body}`,
    negativePrompt,
  };
};

const extractImagePrompt = (query) => prepareImagePrompt(query).prompt;

// Read real pixel size from PNG/JPEG bytes so we can log what Pollinations actually returned.
const getImageDimensions = (buf) => {
  try {
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i += 1; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch (_) { /* ignore */ }
  return null;
};

const isImageResponse = (response) => {
  const contentType = String(response?.headers?.["content-type"] || "").toLowerCase();

  if (contentType.startsWith("image/")) {
    return true;
  }

  const buffer = response?.data;
  if (!buffer || buffer.length < 4) {
    return false;
  }

  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47;
  const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
  const isGif = buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46;
  const isWebp = buffer.length >= 12 && buffer.toString("ascii", 8, 12) === "WEBP";

  return isPng || isJpeg || isGif || isWebp;
};

const parseRetryAfterMs = (error) => {
  const headerValue = error?.response?.headers?.["retry-after"];
  if (!headerValue) {
    return null;
  }

  const asSeconds = Number(headerValue);
  if (Number.isFinite(asSeconds)) {
    return Math.max(0, asSeconds * 1000);
  }

  const asDate = Date.parse(headerValue);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return null;
};

const buildFriendlyError = (error) => {
  const status = error?.response?.status;

  if (status === 401 || status === 403) {
    return "Image generation isn't authorised. The server's Pollinations API key is missing or invalid.";
  }

  if (status === 402) {
    return "The image service is out of Pollen credits. Please try again later.";
  }

  if (status === 429) {
    return "The image generator is busy right now. I’m retrying a couple more times, so please hold on or try again in about 30 seconds.";
  }

  if (status >= 500) {
    return "The image generator is temporarily unavailable. Please try again shortly.";
  }

  if (error?.code === "ECONNABORTED") {
    return "Image generation timed out. Please try again.";
  }

  return error?.message || "Failed to generate image.";
};

const withJitter = (ms) => ms + Math.floor(Math.random() * 400);

const generateImageInternal = async (prompt, options = {}) => {
  const { prompt: normalizedPrompt, negativePrompt: derivedNegativePrompt } = prepareImagePrompt(prompt);
  const [autoWidth, autoHeight] = chooseImageSize(prompt);
  // A hard-coded 1024x1024 from a caller is the old default, not a deliberate choice - ignore it.
  const isLegacySquare = options.width === 1024 && options.height === 1024;
  const width = (!isLegacySquare && options.width) || autoWidth;
  const height = (!isLegacySquare && options.height) || autoHeight;

  logEvent("generateImage:start", { prompt: normalizedPrompt.slice(0, 100), model: options.model || IMAGE_MODEL, width, height });

  let lastError = null;

  for (let attempt = 1; attempt <= MAX_IMAGE_GEN_ATTEMPTS; attempt++) {
    const seed = Math.floor(Math.random() * 2147483647);
    const encodedPrompt = encodeURIComponent(normalizedPrompt);
    const params = new URLSearchParams({
      model: options.model || IMAGE_MODEL,
      width: String(width),
      height: String(height),
      seed: String(seed),
      enhance: String(options.enhance ?? (IMAGE_ENHANCE && normalizedPrompt.length <= LONG_PROMPT_CHARS)),
      negative_prompt: options.negativePrompt || derivedNegativePrompt,
    });

    const imageUrl = `${IMAGE_API_URL}/${encodedPrompt}?${params.toString()}`;

    try {
      const response = await axios.get(imageUrl, {
        responseType: "arraybuffer",
        timeout: IMAGE_TIMEOUT_MS,
        headers: IMAGE_REQUEST_HEADERS,
        maxRedirects: 5,
        validateStatus: (status) => status >= 200 && status < 300,
      });

      if (!isImageResponse(response)) {
        throw new Error(`Non-image response received (content-type: ${response.headers?.["content-type"] || "unknown"})`);
      }

      const base64Image = Buffer.from(response.data, "binary").toString("base64");
      const mimeType = String(response.headers?.["content-type"] || "image/png").split(";")[0] || "image/png";
      const dataUrl = `data:${mimeType};base64,${base64Image}`;

      const actual = getImageDimensions(Buffer.from(response.data));
      logEvent("generateImage:success", {
        version: SERVICE_VERSION,
        requested: `${width}x${height}`,
        received: actual ? `${actual.width}x${actual.height}` : "unknown",
        prompt: normalizedPrompt.slice(0, 100),
        attempt,
        size: base64Image.length,
      });

      return {
        success: true,
        dataUrl,
        prompt: normalizedPrompt,
        width,
        height,
      };
    } catch (error) {
      lastError = error;
      logError(`generateImage:attempt-${attempt}`, error);

      const status = error?.response?.status;
      if (status && status >= 400 && status < 500 && status !== 429) {
        // 4xx (bad key, no credits, bad params) will not fix itself on retry
        break;
      }

      if (attempt < MAX_IMAGE_GEN_ATTEMPTS) {
        const retryAfterMs = parseRetryAfterMs(error);
        const backoffMs = retryAfterMs ?? withJitter(Math.min(30000, 2500 * 2 ** (attempt - 1)));
        await delay(backoffMs);
      }
    }
  }

  return {
    success: false,
    error: buildFriendlyError(lastError),
    prompt: normalizedPrompt,
  };
};

const generateImage = (prompt, options = {}) => runQueued(() => generateImageInternal(prompt, options));

module.exports = {
  chooseImageSize,
  isImageGenerationQuery,
  extractImagePrompt,
  generateImage,
};