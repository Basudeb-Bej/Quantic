//back-end/brain/intentClassifier.js
const INTENT_RULES = {
  coding: [
    { pattern: /\b(code|coding|bug|error|fix|debug|function|api|endpoint|query|stack trace|exception|typescript|javascript|node(?:\.js)?|react|mongo(?:db)?|express)\b/i, weight: 2 },
    { pattern: /\b(?:how do i|why does|what is wrong with|help me (?:build|write|fix|debug))\b/i, weight: 1 },
  ],
  realtime: [
    { pattern: /\b(weather|forecast|temperature|humidity|rain|sunny|hot|cold|date|time|today|tomorrow|now)\b/i, weight: 2 },
    { pattern: /\b(current\s+(?:date|time)|what(?:'s| is)? the (?:date|time)|what(?:'s| is)? the weather)\b/i, weight: 2 },
  ],
  personal: [
    { pattern: /\b(my name|who am i|what do you call me|what should you call me|about me|my preferences|what do you know about me)\b/i, weight: 3 },
    { pattern: /\b(?:remember my|save my|change my|update my)\s+(?:name|preferences|profile)\b/i, weight: 2 },
  ],
  tool: [
    { pattern: /\b(calculate|solve|sum|add|subtract|multiply|divide|convert|currency|system info|server info|machine info|process info)\b/i, weight: 3 },
    { pattern: /\b(?:use|run|call|invoke)\s+(?:a\s+)?(?:tool|agent|function)\b/i, weight: 2 },
  ],
  complex: [
    { pattern: /\b(explain in detail|deep dive|comprehensive|thorough|step by step|architecture|refactor|production ready|design a system)\b/i, weight: 3 },
  ],
};

const COMPLEX_LENGTH_THRESHOLD = 320;
const GENERAL_CONFIDENCE = 0.42;

const normalizeMessage = (message) => String(message ?? "").trim();

const scoreMatches = (message, rules) => {
  let score = 0;

  for (const rule of rules) {
    if (rule.pattern.test(message)) {
      score += rule.weight;
    }
  }

  return score;
};

const inferComplexityBonus = (message) => {
  if (message.length >= COMPLEX_LENGTH_THRESHOLD) {
    return 2;
  }

  if (/\b(and|also|plus|then|after that|in addition)\b/i.test(message)) {
    return 0.5;
  }

  return 0;
};

const finalizeConfidence = (score, baseline = 1) => {
  if (score <= 0) {
    return 0;
  }

  return Math.max(0.2, Math.min(0.98, score / (score + baseline)));
};

const classifyIntent = (message) => {
  const normalizedMessage = normalizeMessage(message);

  if (!normalizedMessage) {
    return { intent: "general", confidence: 0.1 };
  }

  const scores = {
    tool: scoreMatches(normalizedMessage, INTENT_RULES.tool),
    personal: scoreMatches(normalizedMessage, INTENT_RULES.personal),
    realtime: scoreMatches(normalizedMessage, INTENT_RULES.realtime),
    coding: scoreMatches(normalizedMessage, INTENT_RULES.coding),
    complex: scoreMatches(normalizedMessage, INTENT_RULES.complex) + inferComplexityBonus(normalizedMessage),
  };

  if (/\b(hello|hi|hey|thanks|thank you|good morning|good evening|how are you)\b/i.test(normalizedMessage)) {
    return { intent: "general", confidence: GENERAL_CONFIDENCE };
  }

  const rankedIntents = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((left, right) => right[1] - left[1]);

  if (!rankedIntents.length) {
    return { intent: "general", confidence: GENERAL_CONFIDENCE };
  }

  const [bestIntent, bestScore] = rankedIntents[0];
  const secondBestScore = rankedIntents[1]?.[1] || 0;
  const confidence = finalizeConfidence(bestScore - secondBestScore + (bestScore * 0.35));

  return {
    intent: bestIntent,
    confidence,
  };
};

module.exports = { classifyIntent, INTENT_RULES };