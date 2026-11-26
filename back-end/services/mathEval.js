// back-end/services/mathEval.js
// Safe math evaluator (recursive descent). No eval / Function, so model-supplied text cannot run code.
"use strict";

const CONSTANTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };
const FUNCTIONS = {
	sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
	sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
	ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2, exp: Math.exp,
	min: Math.min, max: Math.max, pow: Math.pow,
};
const MAX_LENGTH = 300;
const MAX_ABS = 1e300;

const tokenize = (input) => {
	const tokens = [];
	const pattern = /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?|\.\d+)|([a-z_][a-z0-9_]*)|(\*\*|[-+*/^%(),]))/giy;
	let index = 0;

	while (index < input.length) {
		pattern.lastIndex = index;
		const match = pattern.exec(input);

		if (!match) {
			if (/^\s*$/.test(input.slice(index))) break;
			throw new Error(`Unexpected character "${input[index]}"`);
		}

		if (match[1] !== undefined) tokens.push({ t: "num", v: Number(match[1]) });
		else if (match[2] !== undefined) tokens.push({ t: "id", v: match[2].toLowerCase() });
		else tokens.push({ t: "op", v: match[3] === "**" ? "^" : match[3] });

		index = pattern.lastIndex;
	}

	return tokens;
};

const evaluate = (expression) => {
	const text = String(expression ?? "").trim().replace(/×/g, "*").replace(/÷/g, "/").replace(/,(?=\d{3}\b)/g, "");

	if (!text) throw new Error("Empty expression");
	if (text.length > MAX_LENGTH) throw new Error("Expression too long");

	const tokens = tokenize(text);
	let position = 0;

	const peek = () => tokens[position];
	const take = () => tokens[position++];
	const isOp = (value) => peek()?.t === "op" && peek().v === value;

	const check = (value) => {
		if (!Number.isFinite(value) || Math.abs(value) > MAX_ABS) throw new Error("Result is not a finite number");
		return value;
	};

	// expression := term (('+'|'-') term)*
	const parseExpression = () => {
		let value = parseTerm();
		while (isOp("+") || isOp("-")) {
			const op = take().v;
			const right = parseTerm();
			value = op === "+" ? value + right : value - right;
		}
		return check(value);
	};

	// term := unary (('*'|'/'|'%') unary)*   (implicit multiplication: 2(3+4), 2pi)
	const parseTerm = () => {
		let value = parseUnary();
		for (;;) {
			if (isOp("*") || isOp("/") || isOp("%")) {
				const op = take().v;
				const right = parseUnary();
				if (op === "/" && right === 0) throw new Error("Division by zero");
				value = op === "*" ? value * right : op === "/" ? value / right : value % right;
			} else if (peek() && (peek().t === "num" || peek().t === "id" || isOp("("))) {
				value *= parseUnary();
			} else {
				return check(value);
			}
		}
	};

	const parseUnary = () => {
		if (isOp("-")) { take(); return -parseUnary(); }
		if (isOp("+")) { take(); return parseUnary(); }
		return parsePower();
	};

	// power := primary ('^' unary)?   (right associative)
	const parsePower = () => {
		const base = parsePrimary();
		if (isOp("^")) {
			take();
			return check(Math.pow(base, parseUnary()));
		}
		// postfix percent: 50% -> 0.5
		return base;
	};

	const parsePrimary = () => {
		const token = take();

		if (!token) throw new Error("Unexpected end of expression");
		if (token.t === "num") {
			if (isOp("%") && !(tokens[position + 1] && (tokens[position + 1].t === "num" || tokens[position + 1].t === "id" || (tokens[position + 1].t === "op" && tokens[position + 1].v === "(")))) {
				take();
				return token.v / 100;
			}
			return token.v;
		}

		if (token.t === "id") {
			if (isOp("(")) {
				if (!Object.prototype.hasOwnProperty.call(FUNCTIONS, token.v)) throw new Error(`Unknown function "${token.v}"`);
				take();
				const args = [];
				if (!isOp(")")) {
					do { args.push(parseExpression()); } while (isOp(",") && take());
				}
				if (!isOp(")")) throw new Error("Missing closing parenthesis");
				take();
				return check(FUNCTIONS[token.v](...args));
			}
			if (Object.prototype.hasOwnProperty.call(CONSTANTS, token.v)) return CONSTANTS[token.v];
			throw new Error(`Unknown name "${token.v}"`);
		}

		if (token.v === "(") {
			const value = parseExpression();
			if (!isOp(")")) throw new Error("Missing closing parenthesis");
			take();
			return value;
		}

		throw new Error(`Unexpected "${token.v}"`);
	};

	const result = parseExpression();
	if (position < tokens.length) throw new Error(`Unexpected "${tokens[position].v}"`);
	return result;
};

const formatNumber = (value) => {
	if (Number.isInteger(value)) return String(value);
	return String(Number(value.toPrecision(12)));
};

module.exports = { evaluate, formatNumber };
