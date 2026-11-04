//back-end/rag/ragPipeline.js
const { createEmbedding } = require("./embedder.js");
const { loadDB } = require("./vectorStore.js");

const normalizeText = (value) => String(value ?? "").trim();

const normalizeMetadata = (metadata = {}) => ({
  source: normalizeText(metadata?.source),
  date: normalizeText(metadata?.date),
  type: normalizeText(metadata?.type),
  title: normalizeText(metadata?.title),
  chunkIndex: Number.isFinite(Number(metadata?.chunkIndex)) ? Number(metadata.chunkIndex) : null,
  totalChunks: Number.isFinite(Number(metadata?.totalChunks)) ? Number(metadata.totalChunks) : null,
});

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

const retrieveTopK = (embedding, topK = 3) => {
  if (!Array.isArray(embedding) || !embedding.length) {
    return [];
  }

  return loadDB()
    .map((entry) => ({
      text: normalizeText(entry?.text || entry?.content || ""),
      score: cosineSimilarity(embedding, entry?.embedding),
      metadata: normalizeMetadata(entry?.metadata || entry),
    }))
    .filter((entry) => entry.text)
    .sort((left, right) => right.score - left.score)
    .slice(0, Math.max(0, Number(topK) || 0))
    .map((entry) => ({
      text: entry.text,
      score: Number(entry.score.toFixed(4)),
      metadata: entry.metadata,
    }));
};

const normalizePromptText = (value) => String(value ?? "").trim();

const formatConversationContext = (conversation = []) => {
  if (!Array.isArray(conversation) || !conversation.length) {
    return "";
  }

  return conversation
    .map((entry) => {
      const role = String(entry?.role || "").toLowerCase();
      const content = String(entry?.content || "").trim();

      if (!content) {
        return null;
      }

      const label = role === "assistant" ? "Assistant" : "User";
      return `${label}: ${content}`;
    })
    .filter(Boolean)
    .join("\n");
};

const joinSectionContent = (...parts) =>
  parts
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join("\n\n");

const formatContextValue = (value) => {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value.map((item) => formatContextValue(item)).filter(Boolean).join("\n");
  }

  if (typeof value === "object") {
    if (Array.isArray(value.sources) || Array.isArray(value.rankedSources)) {
      const summary = formatContextValue(value.summary || value.message || "");
      const sources = value.rankedSources || value.sources || [];
      const sourceText = sources
        .map((source, index) => {
          const parts = [`Source ${index + 1}`];
          if (source?.title) parts.push(`Title: ${source.title}`);
          if (source?.domain) parts.push(`Domain: ${source.domain}`);
          if (source?.snippet) parts.push(`Snippet: ${source.snippet}`);
          if (source?.previewText) parts.push(`Preview: ${source.previewText.slice(0, 520)}`);
          if (source?.url) parts.push(`URL: ${source.url}`);
          return parts.join(" | ");
        })
        .filter(Boolean)
        .join("\n");

      return joinSectionContent(summary ? `Summary:\n${summary}` : "", sourceText ? `Sources:\n${sourceText}` : "");
    }

    if (Object.prototype.hasOwnProperty.call(value, "shortTerm") || Object.prototype.hasOwnProperty.call(value, "longTerm") || Object.prototype.hasOwnProperty.call(value, "semantic")) {
      return joinSectionContent(
        value.shortTerm ? `Short-term memory:\n${formatContextValue(value.shortTerm)}` : "",
        value.longTerm ? `Long-term memory:\n${formatContextValue(value.longTerm)}` : "",
        value.semantic ? `Semantic memory:\n${formatContextValue(value.semantic)}` : ""
      );
    }

    return Object.entries(value)
      .map(([key, item]) => {
        const formattedItem = formatContextValue(item);
        return formattedItem ? `${key}: ${formattedItem}` : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  return String(value).trim();
};

const formatRetrievedDoc = (doc, index = 0) => {
  const text = normalizeText(doc?.text);
  if (!text) {
    return "";
  }

  const metadata = normalizeMetadata(doc?.metadata);
  const sourceBits = [];

  if (metadata.title) sourceBits.push(metadata.title);
  if (metadata.source) sourceBits.push(metadata.source);
  if (metadata.type) sourceBits.push(metadata.type);
  if (metadata.date) sourceBits.push(metadata.date);

  const scoreText = Number.isFinite(Number(doc?.score)) ? `score=${Number(doc.score).toFixed(3)}` : "";
  const headerParts = [`Doc ${index + 1}`];

  if (sourceBits.length) {
    headerParts.push(sourceBits.join(" | "));
  }

  if (scoreText) {
    headerParts.push(scoreText);
  }

  return [headerParts.join(" | "), text].join("\n");
};

const formatRetrievedDocs = (docs = []) => {
  if (!Array.isArray(docs) || !docs.length) {
    return "";
  }

  return docs.map(formatRetrievedDoc).filter(Boolean).join("\n\n");
};

const normalizeResponseStyle = (value) => {
  const normalizedStyle = normalizePromptText(value).toLowerCase();

  if (["concise", "structured", "detailed", "friendly"].includes(normalizedStyle)) {
    return normalizedStyle;
  }

  return "balanced";
};

const buildStyleInstruction = (responseStyle) => {
  const normalizedStyle = normalizeResponseStyle(responseStyle);

  if (normalizedStyle === "concise") {
    return "Response style: concise. Keep answers short, direct, and to the point. Avoid unnecessary detail. When a response has multiple parts, use a small numbered list.";
  }

  if (normalizedStyle === "structured") {
    return "Response style: structured. Organize multi-part answers as numbered points, keep each point clear and parallel, and include quantitative details when they are relevant.";
  }

  if (normalizedStyle === "detailed") {
    return "Response style: detailed. Explain deeply, include useful context, and break complex ideas into clear steps when helpful. Prefer numbered points for multi-part answers and include quantitative details when available.";
  }

  if (normalizedStyle === "friendly") {
    return "Response style: friendly. Use a warm, conversational tone while staying clear and helpful. Keep the response structured with short numbered or bulleted points when the answer has more than one idea.";
  }

  return "Response style: balanced. Be clear, moderately concise, and adapt depth to the user's question.";
};

const formatAttachmentContext = (attachments = []) => {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return "";
  }

  const lines = attachments
    .map((attachment, index) => {
      const parts = [`Attachment ${index + 1}`];

      if (attachment?.name) parts.push(`Name: ${attachment.name}`);
      if (attachment?.type) parts.push(`Type: ${attachment.type}`);
      if (Number.isFinite(Number(attachment?.size))) parts.push(`Size: ${Number(attachment.size)} bytes`);

      return parts.join(" | ");
    })
    .filter(Boolean)
    .join("\n");

  return lines ? `User attachments:\n${lines}` : "";
};

const formatAttachmentAnalysis = (analysis = "") => normalizePromptText(analysis);

const isStructuredFormatRequest = (query) => /\b(quantitative points|maintaining structure|structured answer|structured format|numbered points|like the image|make it without effect others|organized answer)\b/i.test(normalizePromptText(query));

const isStepByStepRequest = (query) => /\b(step by step|show (?:the )?work|show (?:all )?steps|solve|calculate|equation|pH|mole|moles|stoichiometry|titration|molarity|concentration|physics|chemistry|formula)\b/i.test(normalizePromptText(query));

const isCreativeGenerationRequest = (query) => /\b(song|lyrics|poem|poetry|story|storytelling|rap|rap song|joke|essay|letter|script|dialogue|caption)\b/i.test(normalizePromptText(query));

const isCodeOrTutorialRequest = (query) => /\b(code|snippet|example|tutorial|walkthrough|setup|install|guide|step by step|step-by-step|sinatra|erb|ruby|bash|shell|html|css|javascript|typescript|python|react|node|sql)\b/i.test(normalizePromptText(query));

// "difference between A and B", "A vs B", "compare A with B", "distinguish ..."
// A bare "compare" is not enough ("compare two strings in JS" is a coding question), so the
// verb has to be followed by a second subject.
const isComparisonRequest = (query) => {
  const text = normalizePromptText(query);

  if (!text) {
    return false;
  }

  return /\b(?:differences?|differentiate|distinguish|distinction)\b/i.test(text)
    || /\bcompar(?:e|ison|ing)\b[^.?!\n]{0,80}?\b(?:with|to|and|vs\.?|versus|between)\b/i.test(text)
    || /\b[\w-]+\s+(?:vs\.?|versus)\s+[\w-]+/i.test(text);
};

const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

// "5 difference between ...", "give five key differences", "3 points of difference"
const parseRequestedPointCount = (query) => {
  const text = normalizePromptText(query).toLowerCase();
  const match = text.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:(?:key|main|major|important|basic|primary)\s+)?(?:differences?|distinctions?|points?|ways|reasons)\b/);

  if (!match) {
    return 0;
  }

  const raw = match[1];
  const value = Number(raw) || NUMBER_WORDS[raw] || 0;
  return value >= 1 && value <= 20 ? value : 0;
};

// "(a) ... (b) ..." or "6(a). ... 6(b). ..." - an exam-style question made of lettered parts.
const countLetteredParts = (query) => {
  const text = normalizePromptText(query);
  return (text.match(/(?:^|\n)\s*(?:\d+\s*)?\(([a-h])\)[.:)]?\s+\S/gi) || []).length;
};

const buildCompletionInstruction = (query) => {
  const isCreative = isCreativeGenerationRequest(query);
  const isCodeOrTutorial = isCodeOrTutorialRequest(query);
  const isStepByStep = isStepByStepRequest(query);
  // An explicit "briefly" or "in 2 sentences" from the user outranks the detailed comparison layout.
  const wantsShortAnswer = /\b(?:briefly|be brief|in brief|concise|concisely|short answer|keep it short|one line|one-liner|in a nutshell|tl;?dr|just the answer|quick(?:ly)? answer)\b/i.test(normalizePromptText(query))
    || /\bin\s+(?:about\s+|around\s+|under\s+|no more than\s+|at most\s+)?\d{1,4}\s*(?:words?|sentences?|lines?)\b/i.test(normalizePromptText(query));
  const isComparison = isComparisonRequest(query) && !wantsShortAnswer;
  const requestedPoints = parseRequestedPointCount(query);
  const letteredParts = countLetteredParts(query);
  const parts = [];

  if (isStepByStep) {
    parts.push([
      "Step-by-step solution requested.",
      "Use explicit labels like Step 1, Step 2, Step 3, and a final answer section.",
      "For calculation, chemistry, physics, and equation problems, include the given values, the formula or setup, the substitution, the arithmetic, and the final answer.",
      "Prefer plain text math such as n(HCl) = M x V when that reads naturally, and avoid raw LaTeX escape clutter unless it makes the answer clearer.",
      "Never use LaTeX environment syntax such as \\begin{cases}, \\end{cases}, \\\\, \\Rightarrow, \\;, or \\quad. Write systems of equations as separate plain-text lines instead, for example: x + y = 45 and x - y = 7, each on its own line.",
      "Keep the explanation natural and concise, but do not skip the intermediate steps.",
    ].join(" "));
  }

  if (isCodeOrTutorial) {
    parts.push([
      "Code or tutorial request detected.",
      "Fully complete the requested code, setup steps, or example instead of stopping mid-snippet.",
      "Include the remaining lines, missing closing tags, and any needed follow-up steps so the answer is usable as-is.",
      "Do not summarize away the code when the user asked for a concrete example.",
      "When the task is to implement, build, or demonstrate something in code, first list the steps as ONE sequentially numbered list (1., 2., 3., ... each number used exactly once, in order), with a single plain sentence per step and no code between the steps.",
      "Then give ONE complete, runnable program in a single fenced code block that contains every step in the same order, with a short comment marking each step. Do NOT split the program into a separate code block per step, and never leave a step's code in a disconnected fragment.",
      "If the user asks for output, show it in its own fenced block labelled Output directly after the full program, with values that are consistent with the code.",
      "Shell or setup commands may stay in one block per phase, but keep related commands together.",
    ].join(" "));
  } else if (isCreative) {
    parts.push([
      "Creative request detected.",
      "Fully complete the requested artifact instead of summarizing it.",
      "If the user asks for a song, poem, story, or similar composition, provide the full output in the requested language and format.",
      "Do not stop after a partial draft unless the user explicitly asks for a short version.",
    ].join(" "));
  }

  if (isComparison) {
    parts.push([
      "Comparison request detected. Never answer a comparison with a handful of one-line bullets.",
      `Structure the answer in three parts. (1) A Markdown comparison table with the columns Basis | <first topic> | <second topic> and ${requestedPoints ? `exactly ${requestedPoints} rows` : "5 to 7 rows"}, one row per point of difference.`,
      `(2) Directly under the table, a short heading Explanation followed by a numbered list (1., 2., 3., ...) with ${requestedPoints ? `exactly ${requestedPoints} items` : "one item per table row"}, in the same order as the table. Each item must explain the difference in 2 to 3 sentences and include a concrete example, cause, or consequence.`,
      "(3) A closing line that states when each topic applies, or the key takeaway.",
      "Use the same terms in the table and in the explanation, and make every point a genuine difference rather than a restatement of another point.",
    ].join(" "));
  }

  if (letteredParts >= 2) {
    parts.push([
      `The question has ${letteredParts} lettered parts such as (a) and (b).`,
      "Answer every part, each under its own heading that repeats the question's label exactly (for example 6(a) and 6(b)).",
      "Give every part its full depth: a later part must not be shorter or thinner than an earlier one.",
    ].join(" "));
  }

  return parts.join(" ");
};

const buildSection = (title, content) => {
  const normalizedContent = normalizePromptText(content);

  if (!normalizedContent) {
    return "";
  }

  return [title, normalizedContent].join("\n");
};

const formatPrompt = ({
  now,
  profileContext,
  memoryContext,
  conversationContext,
  docs,
  toolContext,
  webContext,
  attachmentContext,
  attachmentAnalysis,
  responseStyle,
  query,
}) => {
  const sections = [];
  const structuredFormatRequested = isStructuredFormatRequest(query);
  const stepByStepRequested = isStepByStepRequest(query);

  sections.push(buildSection("System Identity", [
    "You are Quantic AI.",
    `Current Date: ${now}`,
    "Be concise, direct, and grounded in available context.",
    "Prefer the smallest sufficient context set instead of repeating everything.",
    "Do not use emojis, decorative symbols, or emoji-style bullets unless the user explicitly asks for them.",
    buildStyleInstruction(responseStyle),
    "When answering a definition, identification, or 'which of the following' question, wrap the key term or phrase that directly answers the question in **double asterisks** (markdown bold) — for example: **The Heisenberg Uncertainty Principle** states that... Bold only the defining term/phrase itself, not the whole sentence.",
    "Number every ordered list in sequence (1., 2., 3., ...) and never repeat the same number, even when a code block or paragraph sits between two items. Never put bold markers inside a heading or inside another bold span; write a heading as plain text.",
    structuredFormatRequested
      ? "Format this answer as a structured response with numbered points, and include quantitative details when they are helpful."
      : "",
    stepByStepRequested
      ? "..."
      : "",
    buildCompletionInstruction(query),
  ].join("\n")));

  if (profileContext) {
    sections.push(buildSection("User Profile", formatContextValue(profileContext)));
  }

  if (memoryContext) {
    sections.push(buildSection("User Memory", formatContextValue(memoryContext)));
  }

  const ragPieces = [];

  if (Array.isArray(docs) && docs.length) {
    ragPieces.push(formatRetrievedDocs(docs));
  }

  if (toolContext) {
    ragPieces.push(`Tool Context:\n${formatContextValue(toolContext)}`);
  }

  if (webContext) {
    ragPieces.push(`Web Context:\n${formatContextValue(webContext)}`);
  }

  if (ragPieces.length) {
    sections.push(buildSection("RAG Context", ragPieces.join("\n\n")));
  }

  if (webContext) {
    sections.push(buildSection("Citation Format — MANDATORY", [
      "Every citation MUST use exactly this syntax: [Source N](URL) — square brackets, then parentheses, no space between them.",
      "N must be a single plain number matching the source's position in Web Context (Source 1, Source 2, etc.). Never write '12' to mean two sources — write [Source 1](url1) [Source 2](url2) as two separate, space-separated citations.",
      "NEVER use full-width brackets 【 】. NEVER use curly braces. NEVER write the word Source without an immediately following (URL).",
      "Place each citation directly after the sentence or clause it supports, not bundled at the end.",
      "Use the exact URL given in Web Context for that source number — do not invent or reuse a URL for the wrong source number.",
      "Example of CORRECT format: Suvendu Adhikari is the Leader of the Opposition [Source 1](https://example.com/a) while Mamata Banerjee is Chief Minister [Source 2](https://example.com/b).",
      "Example of WRONG format (never do this): 【Source1】(url) 【Source12](url2) — mismatched brackets and glued numbers are forbidden.",
      "Never merge two citation numbers into one, e.g. writing [Source 12] to mean sources 1 and 2 — that renders as a broken link to a non-existent source 12.",
    ].join(" ")));
  }

  if (conversationContext) {
    sections.push(buildSection("Conversation History", conversationContext));
  }

  if (attachmentContext) {
    sections.push(buildSection("Attachments", attachmentContext));
  }

  if (attachmentAnalysis) {
    sections.push(buildSection("Attachment Analysis", attachmentAnalysis));

    const isCodeAttachment = /^Code file \d+/m.test(attachmentAnalysis);

    sections.push(buildSection("Attachment Response Guidance", [
      "An attachment was uploaded and extracted text or OCR context is available.",
      "Use the attachment analysis context to describe or summarize the uploaded file.",
      "For document or presentation summaries, finish the thought completely and do not stop mid-bullet, mid-heading, or mid-outline.",
      "Prefer a complete short summary or a complete numbered list over a partial outline.",
      "Do not say that you cannot view the attachment when attachment analysis is present.",
      isCodeAttachment
        ? "This attachment is source code. Read it sequentially from top to bottom — do not skim or jump straight to a summary. Walk through it in order (imports, then each function(b) ..." or "6(a). ... 6(b). ..." - an exam-style question made of lettered parts.
const countLetteredParts = (query) => {
  const text = normalizePromptText(query);
  return (text.match(/(?:^|\n)\s*(?:\d+\s*)?\(([a-h])\)[.:)]?\s+\S/gi) || []).length;
};

const buildCompletionInstruction = (query) => {
  const isCreative = isCreativeGenerationRequest(query);
  const isCodeOrTutorial = isCodeOrTutorialRequest(query);
  const isStepByStep = isStepByStepRequest(query);
  // An explicit "briefly" or "in 2 sentences" from the user outranks the detailed comparison layout.
  const wantsShortAnswer = /\b(?:briefly|be brief|in brief|concise|concisely|short answer|keep it short|one line|one-liner|in a nutshell|tl;?dr|just the answer|quick(?:ly)? answer)\b/i.test(normalizePromptText(query))
    || /\bin\s+(?:about\s+|around\s+|under\s+|no more than\s+|at most\s+)?\d{1,4}\s*(?:words?|sentences?|lines?)\b/i.test(normalizePromptText(query));
  const isComparison = isComparisonRequest(query) && !wantsShortAnswer;
  const requestedPoints = parseRequestedPointCount(query);
  const letteredParts = countLetteredParts(query);
  const parts = [];

  if (isStepByStep) {
    parts.push([
      "Step-by-step solution requested.",
      "Use explicit labels like Step 1, Step 2, Step 3, and a final answer section.",
      "For calculation, chemistry, physics, and equation problems, include the given values, the formula or setup, the substitution, the arithmetic, and the final answer.",
      "Prefer plain text math such as n(HCl) = M x V when that reads naturally, and avoid raw LaTeX escape clutter unless it makes the answer clearer.",
      "Never use LaTeX environment syntax such as \\begin{cases}, \\end{cases}, \\\\, \\Rightarrow, \\;, or \\quad. Write systems of equations as separate plain-text lines instead, for example: x + y = 45 and x - y = 7, each on its own line.",
      "Keep the explanation natural and concise, but do not skip the intermediate steps.",
    ].join(" "));
  }

  if (isCodeOrTutorial) {
    parts.push([
      "Code or tutorial request detected.",
      "Fully complete the requested code, setup steps, or example instead of stopping mid-snippet.",
      "Include the remaining lines, missing closing tags, and any needed follow-up steps so the answer is usable as-is.",
      "Do not summarize away the code when the user asked for a concrete example.",
      "When the task is to implement, build, or demonstrate something in code, first list the steps as ONE sequentially numbered list (1., 2., 3., ... each number used exactly once, in order), with a single plain sentence per step and no code between the steps.",
      "Then give ONE complete, runnable program in a single fenced code block that contains every step in the same order, with a short comment marking each step. Do NOT split the program into a separate code block per step, and never leave a step's code in a disconnected fragment.",
      "If the user asks for output, show it in its own fenced block labelled Output directly after the full program, with values that are consistent with the code.",
      "Shell or setup commands may stay in one block per phase, but keep related commands together.",
    ].join(" "));
  } else if (isCreative) {
    parts.push([
      "Creative request detected.",
      "Fully complete the requested artifact instead of summarizing it.",
      "If the user asks for a song, poem, story, or similar composition, provide the full output in the requested language and format.",
      "Do not stop after a partial draft unless the user explicitly asks for a short version.",
    ].join(" "));
  }

  if (isComparison) {
    parts.push([
      "Comparison request detected. Never answer a comparison with a handful of one-line bullets.",
      `Structure the answer in three parts. (1) A Markdown comparison table with the columns Basis | <first topic> | <second topic> and ${requestedPoints ? `exactly ${requestedPoints} rows` : "5 to 7 rows"}, one row per point of difference.`,
      `(2) Directly under the table, a short heading Explanation followed by a numbered list (1., 2., 3., ...) with ${requestedPoints ? `exactly ${requestedPoints} items` : "one item per table row"}, in the same order as the table. Each item must explain the difference in 2 to 3 sentences and include a concrete example, cause, or consequence.`,
      "(3) A closing line that states when each topic applies, or the key takeaway.",
      "Use the same terms in the table and in the explanation, and make every point a genuine difference rather than a restatement of another point.",
    ].join(" "));
  }

  if (letteredParts >= 2) {
    parts.push([
      `The question has ${letteredParts} lettered parts such as (a) and (b).`,
      "Answer every part, each under its own heading that repeats the question's label exactly (for example 6(a) and 6(b)).",
      "Give every part its full depth: a later part must not be shorter or thinner than an earlier one.",
    ].join(" "));
  }

  return parts.join(" ");
};

const buildSection = (title, content) => {
  const normalizedContent = normalizePromptText(content);

  if (!normalizedContent) {
    return "";
  }

  return [title, normalizedContent].join("\n");
};

const formatPrompt = ({
  now,
  profileContext,
  memoryContext,
  conversationContext,
  docs,
  toolContext,
  webContext,
  attachmentContext,
  attachmentAnalysis,
  responseStyle,
  query,
}) => {
  const sections = [];
  const structuredFormatRequested = isStructuredFormatRequest(query);
  const stepByStepRequested = isStepByStepRequest(query);

  sections.push(buildSection("System Identity", [
    "You are Quantic AI.",
    `Current Date: ${now}`,
    "Be concise, direct, and grounded in available context.",
    "Prefer the smallest sufficient context set instead of repeating everything.",
    "Do not use emojis, decorative symbols, or emoji-style bullets unless the user explicitly asks for them.",
    buildStyleInstruction(responseStyle),
    "When answering a definition, identification, or 'which of the following' question, wrap the key term or phrase that directly answers the question in **double asterisks** (markdown bold) — for example: **The Heisenberg Uncertainty Principle** states that... Bold only the defining term/phrase itself, not the whole sentence.",
    "Number every ordered list in sequence (1., 2., 3., ...) and never repeat the same number, even when a code block or paragraph sits between two items. Never put bold markers inside a heading or inside another bold span; write a heading as plain text.",
    structuredFormatRequested
      ? "Format this answer as a structured response with numbered points, and include quantitative details when they are helpful."
      : "",
    stepByStepRequested
      ? "..."
      : "",
    buildCompletionInstruction(query),
  ].join("\n")));

  if (profileContext) {
    sections.push(buildSection("User Profile", formatContextValue(profileContext)));
  }

  if (memoryContext) {
    sections.push(buildSection("User Memory", formatContextValue(memoryContext)));
  }

  const ragPieces = [];

  if (Array.isArray(docs) && docs.length) {
    ragPieces.push(formatRetrievedDocs(docs));
  }

  if (toolContext) {
    ragPieces.push(`Tool Context:\n${formatContextValue(toolContext)}`);
  }

  if (webContext) {
    ragPieces.push(`Web Context:\n${formatContextValue(webContext)}`);
  }

  if (ragPieces.length) {
    sections.push(buildSection("RAG Context", ragPieces.join("\n\n")));
  }

  if (webContext) {
    sections.push(buildSection("Citation Format — MANDATORY", [
      "Every citation MUST use exactly this syntax: [Source N](URL) — square brackets, then parentheses, no space between them.",
      "N must be a single plain number matching the source's position in Web Context (Source 1, Source 2, etc.). Never write '12' to mean two sources — write [Source 1](url1) [Source 2](url2) as two separate, space-separated citations.",
      "NEVER use full-width brackets 【 】. NEVER use curly braces. NEVER write the word Source without an immediately following (URL).",
      "Place each citation directly after the sentence or clause it supports, not bundled at the end.",
      "Use the exact URL given in Web Context for that source number — do not invent or reuse a URL for the wrong source number.",
      "Example of CORRECT format: Suvendu Adhikari is the Leader of the Opposition [Source 1](https://example.com/a) while Mamata Banerjee is Chief Minister [Source 2](https://example.com/b).",
      "Example of WRONG format (never do this): 【Source1】(url) 【Source12](url2) — mismatched brackets and glued numbers are forbidden.",
      "Never merge two citation numbers into one, e.g. writing [Source 12] to mean sources 1 and 2 — that renders as a broken link to a non-existent source 12.",
    ].join(" ")));
  }

  if (conversationContext) {
    sections.push(buildSection("Conversation History", conversationContext));
  }

  if (attachmentContext) {
    sections.push(buildSection("Attachments", attachmentContext));
  }

  if (attachmentAnalysis) {
    sections.push(buildSection("Attachment Analysis", attachmentAnalysis));

    const isCodeAttachment = /^Code file \d+/m.test(attachmentAnalysis);

    sections.push(buildSection("Attachment Response Guidance", [
      "An attachment was uploaded and extracted text or OCR context is available.",
      "Use the attachment analysis context to describe or summarize the uploaded file.",
      "For document or presentation summaries, finish the thought completely and do not stop mid-bullet, mid-heading, or mid-outline.",
      "Prefer a complete short summary or a complete numbered list over a partial outline.",
      "Do not say that you cannot view the attachment when attachment analysis is present.",
      isCodeAttachment
        ? "This attachment is source code. Read it sequentially from top to bottom — do not skim or jump straight to a summary. Walk through it in order (imports, then each function instead of stopping mid-snippet.",
      "Include the remaining lines, missing closing tags, and any needed follow-up steps so the answer is usable as-is.",
      "Do not summarize away the code when the user asked for a concrete example.",
    ].join(" ");
  }

  return [
    "Creative request detected.",
    "Fully complete the requested artifact instead of summarizing it.",
    "If the user asks for a song, poem, story, or similar composition, provide the full output in the requested language and format.",
    "Do not stop after a partial draft unless the user explicitly asks for a short version.",
  ].join(" ");
};

const buildSection = (title, content) => {
  const normalizedContent = normalizePromptText(content);

  if (!normalizedContent) {
    return "";
  }

  return [title, normalizedContent].join("\n");
};

const formatPrompt = ({
  now,
  profileContext,
  memoryContext,
  conversationContext,
  docs,
  toolContext,
  webContext,
  attachmentContext,
  attachmentAnalysis,
  responseStyle,
  query,
}) => {
  const sections = [];
  const structuredFormatRequested = isStructuredFormatRequest(query);
  const stepByStepRequested = isStepByStepRequest(query);

  sections.push(buildSection("System Identity", [
    "You are Quantic AI.",
    `Current Date: ${now}`,
    "Be concise, direct, and grounded in available context.",
    "Prefer the smallest sufficient context set instead of repeating everything.",
    "Do not use emojis, decorative symbols, or emoji-style bullets unless the user explicitly asks for them.",
    buildStyleInstruction(responseStyle),
    "When answering a definition, identification, or 'which of the following' question, wrap the key term or phrase that directly answers the question in **double asterisks** (markdown bold) — for example: **The Heisenberg Uncertainty Principle** states that... Bold only the defining term/phrase itself, not the whole sentence.",
    structuredFormatRequested
      ? "Format this answer as a structured response with numbered points, and include quantitative details when they are helpful."
      : "",
    stepByStepRequested
      ? "..."
      : "",
    buildCompletionInstruction(query),
  ].join("\n")));

  if (profileContext) {
    sections.push(buildSection("User Profile", formatContextValue(profileContext)));
  }

  if (memoryContext) {
    sections.push(buildSection("User Memory", formatContextValue(memoryContext)));
  }

  const ragPieces = [];

  if (Array.isArray(docs) && docs.length) {
    ragPieces.push(formatRetrievedDocs(docs));
  }

  if (toolContext) {
    ragPieces.push(`Tool Context:\n${formatContextValue(toolContext)}`);
  }

  if (webContext) {
    ragPieces.push(`Web Context:\n${formatContextValue(webContext)}`);
  }

  if (ragPieces.length) {
    sections.push(buildSection("RAG Context", ragPieces.join("\n\n")));
  }

  if (webContext) {
    sections.push(buildSection("Citation Format — MANDATORY", [
      "Every citation MUST use exactly this syntax: [Source N](URL) — square brackets, then parentheses, no space between them.",
      "N must be a single plain number matching the source's position in Web Context (Source 1, Source 2, etc.). Never write '12' to mean two sources — write [Source 1](url1) [Source 2](url2) as two separate, space-separated citations.",
      "NEVER use full-width brackets 【 】. NEVER use curly braces. NEVER write the word Source without an immediately following (URL).",
      "Place each citation directly after the sentence or clause it supports, not bundled at the end.",
      "Use the exact URL given in Web Context for that source number — do not invent or reuse a URL for the wrong source number.",
      "Example of CORRECT format: Suvendu Adhikari is the Leader of the Opposition [Source 1](https://example.com/a) while Mamata Banerjee is Chief Minister [Source 2](https://example.com/b).",
      "Example of WRONG format (never do this): 【Source1】(url) 【Source12](url2) — mismatched brackets and glued numbers are forbidden.",
      "Never merge two citation numbers into one, e.g. writing [Source 12] to mean sources 1 and 2 — that renders as a broken link to a non-existent source 12.",
    ].join(" ")));
  }

  if (conversationContext) {
    sections.push(buildSection("Conversation History", conversationContext));
  }

  if (attachmentContext) {
    sections.push(buildSection("Attachments", attachmentContext));
  }

  if (attachmentAnalysis) {
    sections.push(buildSection("Attachment Analysis", attachmentAnalysis));

    const isCodeAttachment = /^Code file \d+/m.test(attachmentAnalysis);

    sections.push(buildSection("Attachment Response Guidance", [
      "An attachment was uploaded and extracted text or OCR context is available.",
      "Use the attachment analysis context to describe or summarize the uploaded file.",
      "For document or presentation summaries, finish the thought completely and do not stop mid-bullet, mid-heading, or mid-outline.",
      "Prefer a complete short summary or a complete numbered list over a partial outline.",
      "Do not say that you cannot view the attachment when attachment analysis is present.",
      isCodeAttachment
        ? "This attachment is source code. Read it sequentially from top to bottom — do not skim or jump straight to a summary. Walk through it in order (imports, then each function/class/component), and when reviewing or explaining it, follow that same top-to-bottom order, referencing specific line ranges, function names, or short excerpts under 15 words. If a '[... characters omitted ...]' marker appears in the extracted text, explicitly tell the user the file was too large to read in full and name which part was cut."
        : "",
    ].filter(Boolean).join("\n")));
  }

  sections.push(buildSection("User", normalizePromptText(query)));
  sections.push(buildSection("Answer", ""));

  return sections.filter(Boolean).join("\n\n");
};

const buildFallbackPrompt = (query, options = {}) =>
  formatPrompt({
    now: new Date().toISOString(),
    profileContext: options.profileContext || "",
    memoryContext: options.memoryContext || "",
    conversationContext: formatConversationContext(options.conversation || []),
    docs: [],
    toolContext: options.toolContext || "",
    webContext: options.webContext || "",
    responseStyle: options.responseStyle || "balanced",
    attachmentContext: formatAttachmentContext(options.attachments || []),
    attachmentAnalysis: formatAttachmentAnalysis(options.attachmentAnalysis || ""),
    query,
  });

const buildPrompt = async (query, options = {}) => {
  const normalizedQuery = normalizePromptText(query);

  try {
    const now = new Date().toISOString();
    const shouldUseEmbedding = options.useRAG !== false;
    const embedding = shouldUseEmbedding ? await createEmbedding(normalizedQuery) : null;
    const docs = options.useRAG === false || !embedding ? [] : retrieveTopK(embedding, options.topKDocs || 3);
    const profileContext = options.profileContext || "";
    const memoryContext = options.memoryContext || "";
    const conversationContext = formatConversationContext(options.conversation || []);
    const toolContext = options.toolContext || "";
    const webContext = options.webContext || "";
    const responseStyle = normalizeResponseStyle(options.responseStyle || "balanced");
    const attachmentContext = formatAttachmentContext(options.attachments || []);
    const attachmentAnalysis = formatAttachmentAnalysis(options.attachmentAnalysis || "");

    return formatPrompt({
      now,
      profileContext,
      memoryContext,
      conversationContext,
      docs,
      toolContext,
      webContext,
      attachmentContext,
      attachmentAnalysis,
      responseStyle,
      query: normalizedQuery,
    });
  } catch {
    return buildFallbackPrompt(normalizedQuery, options);
  }
};

module.exports = {
  buildPrompt,
  formatConversationContext,
  formatPrompt,
  formatRetrievedDocs,
};
