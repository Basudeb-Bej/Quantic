//back-end/brain/tools.js
const os = require("os");

const TOOL_RULES = [
	{ name: "date", patterns: [/^date[?!.]*$/i, /\bcurrent date\b/i, /\bwhat('?s| is)? the date\b/i, /\bdate now\b/i, /\btoday('?s)? date\b/i, /\btoday('?s)?\b/i] },
	{ name: "time", patterns: [/^time[?!.]*$/i, /\bcurrent time\b/i, /\bwhat('?s| is)? the time\b/i, /\btime now\b/i, /\bwhat time is it\b/i] },
	{ name: "systemInfo", patterns: [/\bsystem info\b/i, /\bserver info\b/i, /\bmachine info\b/i, /\bprocess info\b/i] },
	{ name: "calculator", patterns: [/\bcalculate\b/i, /\bsolve\b/i, /\bsum\b/i, /\bwhat is\b.*[0-9][0-9\s+\-*/().]+/i] },
];

const normalizeMessage = (message) => String(message ?? "").trim();

const includesAny = (message, patterns) => patterns.some((pattern) => pattern.test(message));

const createSuccess = (tool, data, meta = {}) => ({
	ok: true,
	source: "tool",
	tool,
	data,
	...meta,
});

const createFailure = (tool, errorCode, message, meta = {}) => ({
	ok: false,
	source: "tool",
	tool,
	error: {
		code: errorCode,
		message,
	},
	data: null,
	...meta,
});

const detectToolName = (message) => {
	const normalizedMessage = normalizeMessage(message);

	for (const rule of TOOL_RULES) {
		if (includesAny(normalizedMessage, rule.patterns)) {
			return rule.name;
		}
	}

	return null;
};

const safeDateSnapshot = (input) => {
	const date = input instanceof Date ? input : new Date(input ?? Date.now());

	if (Number.isNaN(date.getTime())) {
		return null;
	}

	return date;
};

const resolveTimeZone = (timeZone) => {
	const normalizedTimeZone = normalizeMessage(timeZone);

	if (!normalizedTimeZone) {
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	}

	try {
		new Intl.DateTimeFormat("en-US", { timeZone: normalizedTimeZone });
		return normalizedTimeZone;
	} catch {
		return Intl.DateTimeFormat().resolvedOptions().timeZone;
	}
};

const getCurrentDate = (input, timeZone) => {
	const date = safeDateSnapshot(input);

	if (!date) {
		return createFailure("date", "INVALID_DATE", "Invalid date input.");
	}

	const resolvedTimeZone = resolveTimeZone(timeZone);

	return createSuccess("date", {
		iso: date.toISOString(),
		localDate: new Intl.DateTimeFormat("en-US", {
			dateStyle: "full",
			timeZone: resolvedTimeZone,
		}).format(date),
		timeZone: resolvedTimeZone,
	});
};

const getCurrentTime = (input, timeZone) => {
	const date = safeDateSnapshot(input);

	if (!date) {
		return createFailure("time", "INVALID_TIME", "Invalid time input.");
	}

	const resolvedTimeZone = resolveTimeZone(timeZone);

	return createSuccess("time", {
		iso: date.toISOString(),
		localTime: new Intl.DateTimeFormat("en-US", {
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
			hour12: true,
			timeZone: resolvedTimeZone,
		}).format(date),
		timeZone: resolvedTimeZone,
	});
};

const extractArithmeticExpression = (expression) => {
	const normalizedExpression = normalizeMessage(expression);

	if (!normalizedExpression) {
		return "";
	}

	const expressionMatch = normalizedExpression.match(/(-?\d+(?:\.\d+)?(?:\s*[+\-*/()]\s*-?\d+(?:\.\d+)?)+)/);

	if (expressionMatch?.[1]) {
		return expressionMatch[1];
	}

	return normalizedExpression
		.replace(/^.*?(?:calculate|solve|what is|compute)\s+/i, "")
		.replace(/[?=]+$/g, "")
		.trim();
};

const evaluateExpression = (expression) => {
	const normalizedExpression = String(expression ?? "").trim();

	if (!normalizedExpression || !/^[0-9+\-*/().\s]+$/.test(normalizedExpression)) {
		return null;
	}

	try {
		const result = Function(`"use strict"; return (${normalizedExpression});`)();
		return typeof result === "number" && Number.isFinite(result) ? result : null;
	} catch {
		return null;
	}
};

const normalizeEquationExpression = (expression, variableName = "x") => {
	const normalizedExpression = normalizeMessage(expression);
	const escapedVariableName = String(variableName || "x").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const variableRegex = new RegExp(`\\b${escapedVariableName}\\b`, "gi");

	return normalizedExpression
		.replace(new RegExp(`(\\d|\\))\\s*${escapedVariableName}\\b`, "gi"), `$1*${variableName}`)
		.replace(new RegExp(`\\b${escapedVariableName}\\s*(?=\\d|\\()`, "gi"), `${variableName}*`)
		.replace(variableRegex, `(${variableName})`);
};

const evaluateExpressionWithVariable = (expression, variableValue, variableName = "x") => {
	const normalizedExpression = normalizeEquationExpression(expression, variableName);
	const substitutedExpression = normalizedExpression.replace(
		new RegExp(`\\b${String(variableName || "x").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"),
		`(${Number(variableValue)})`
	);

	return evaluateExpression(substitutedExpression);
};

const formatNumber = (value) => {
	if (!Number.isFinite(value)) {
		return null;
	}

	const roundedValue = Math.abs(value) < 1e-10 ? 0 : Number(value.toFixed(10));
	return Number.isInteger(roundedValue) ? String(roundedValue) : String(roundedValue).replace(/\.0+$/, "");
};

const solveLinearEquation = (expression, variableName = "x") => {
	const normalizedExpression = normalizeMessage(expression)
		.split(/[\r\n?!;]/)[0]
		.replace(/^(?:if|please|solve|find|calculate)\s+/i, "")
		.replace(/^(?:what(?:'s| is)?(?:\s+the\s+value\s+of)?\s+)?/i, "")
		.trim();

	if (!normalizedExpression.includes("=") || !new RegExp(`\\b${String(variableName || "x")}\\b`, "i").test(normalizedExpression)) {
		return null;
	}

	const [leftSide, ...rightParts] = normalizedExpression.split("=");
	const rightSide = rightParts.join("=").trim();
	const leftExpression = String(leftSide ?? "").trim();
	const rightExpression = String(rightSide ?? "").trim();

	if (!leftExpression || !rightExpression) {
		return null;
	}

	const leftAtZero = evaluateExpressionWithVariable(leftExpression, 0, variableName);
	const leftAtOne = evaluateExpressionWithVariable(leftExpression, 1, variableName);
	const rightAtZero = evaluateExpressionWithVariable(rightExpression, 0, variableName);
	const rightAtOne = evaluateExpressionWithVariable(rightExpression, 1, variableName);

	if ([leftAtZero, leftAtOne, rightAtZero, rightAtOne].some((value) => value === null)) {
		return null;
	}

	const leftSlope = leftAtOne - leftAtZero;
	const rightSlope = rightAtOne - rightAtZero;
	const denominator = leftSlope - rightSlope;

	if (Math.abs(denominator) < 1e-10) {
		return null;
	}

	const solution = (rightAtZero - leftAtZero) / denominator;

	if (!Number.isFinite(solution)) {
		return null;
	}

	const leftSolved = evaluateExpressionWithVariable(leftExpression, solution, variableName);
	const rightSolved = evaluateExpressionWithVariable(rightExpression, solution, variableName);

	if (leftSolved === null || rightSolved === null || Math.abs(leftSolved - rightSolved) > 1e-8) {
		return null;
	}

	return {
		variable: variableName,
		value: formatNumber(solution),
		equation: `${leftExpression} = ${rightExpression}`,
	};
};

const basicCalculator = (expression) => {
	const normalizedExpression = normalizeMessage(expression);
	const solvedEquation = solveLinearEquation(normalizedExpression, "x");

	if (solvedEquation) {
		return createSuccess("calculator", solvedEquation);
	}
	const parsedExpression = extractArithmeticExpression(normalizedExpression);

	if (!parsedExpression) {
		return createFailure("calculator", "EMPTY_EXPRESSION", "Calculator expression is required.");
	}

	const result = evaluateExpression(parsedExpression);

	if (result === null) {
		return createFailure("calculator", "INVALID_EXPRESSION", "Expression could not be evaluated.", {
			expression: parsedExpression,
		});
	}

	return createSuccess("calculator", {
		expression: parsedExpression,
		value: result,
	});
};

const systemInfo = () => {
	try {
		return createSuccess("systemInfo", {
			hostname: os.hostname(),
			platform: os.platform(),
			release: os.release(),
			architecture: os.arch(),
			nodeVersion: process.version,
			uptimeSeconds: Math.round(os.uptime()),
			memory: {
				total: os.totalmem(),
				free: os.freemem(),
			},
		});
	} catch (error) {
		return createFailure("systemInfo", "SYSTEM_INFO_UNAVAILABLE", error?.message || "System information is unavailable.");
	}
};

const executeTool = (message, toolName, options = {}) => {
	const normalizedMessage = normalizeMessage(message);
	const resolvedToolName = toolName || detectToolName(normalizedMessage);
	const userSnapshot = options.userTime ? safeDateSnapshot(options.userTime) : null;

	if (!resolvedToolName) {
		return createFailure(null, "NO_TOOL_MATCH", "No matching tool was detected.");
	}

	if (resolvedToolName === "date") {
		return getCurrentDate(userSnapshot || undefined, options.timeZone);
	}

	if (resolvedToolName === "time") {
		return getCurrentTime(userSnapshot || undefined, options.timeZone);
	}

	if (resolvedToolName === "systemInfo") {
		return systemInfo();
	}

	if (resolvedToolName === "calculator") {
		return basicCalculator(normalizedMessage);
	}

	return createFailure(resolvedToolName, "UNSUPPORTED_TOOL", `Unsupported tool: ${resolvedToolName}`);
};

module.exports = {
	TOOL_RULES,
	detectToolName,
	getCurrentDate,
	getCurrentTime,
	basicCalculator,
	systemInfo,
	executeTool,
	resolveTimeZone,
	evaluateExpression,
	extractArithmeticExpression,
};