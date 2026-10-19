// front-end/src/theme/appearance.js
//
// Appearance engine: mode (system / light / dark), theme preset, and a per-mode
// background colour. Accent comes from the theme; the text colour is chosen
// automatically so it always stays readable on whatever background is picked.
// It turns those colours into the CSS variables App.css is written against
// (--app-*), applies them to
// <html>, and persists everything in localStorage (device-level, instant).
//
// With the default theme in dark mode and no overrides NO variables are set, so
// the stylesheet renders exactly as it always did.
//
// This module applies the saved appearance as soon as it is imported (before
// React renders), so there is no flash of the wrong theme.

export const STORAGE_KEY = "quantic.appearance.v1";

export const MODES = [
	{ id: "system", label: "System" },
	{ id: "light", label: "Light" },
	{ id: "dark", label: "Dark" },
];

// Each theme provides a palette per resolved mode. `accent2` is optional.
export const THEMES = [
	{
		id: "quantic",
		label: "Quantic",
		dark: { accent: "#6fc0ff", accent2: "#4de2b1", background: "#08111f", foreground: "#eff5ff" },
		light: { accent: "#1d6fd6", background: "#f3f6fb", foreground: "#0f1b2d" },
	},
	{
		id: "chatgpt",
		label: "ChatGPT",
		dark: { accent: "#3a83f7", background: "#000000", foreground: "#ededed" },
		light: { accent: "#3a83f7", background: "#ffffff", foreground: "#0d0d0d" },
	},
	{
		id: "midnight",
		label: "Midnight",
		dark: { accent: "#8b7cff", background: "#0b0b1a", foreground: "#e8e8ff" },
		light: { accent: "#5b4bd6", background: "#f6f5ff", foreground: "#1a1633" },
	},
	{
		id: "ocean",
		label: "Ocean",
		dark: { accent: "#22d3ee", background: "#04141c", foreground: "#e6faff" },
		light: { accent: "#0a7f9a", background: "#f0fbff", foreground: "#0b2530" },
	},
	{
		id: "forest",
		label: "Forest",
		dark: { accent: "#34d399", background: "#07140e", foreground: "#e8f7ef" },
		light: { accent: "#047857", background: "#f2fbf6", foreground: "#0f2a1d" },
	},
	{
		id: "rose",
		label: "Rose",
		dark: { accent: "#fb7185", background: "#14080b", foreground: "#fdebee" },
		light: { accent: "#d11a45", background: "#fff5f6", foreground: "#2b0d14" },
	},
	{
		id: "sunset",
		label: "Sunset",
		dark: { accent: "#fb923c", background: "#140c05", foreground: "#fdf0e3" },
		light: { accent: "#c2410c", background: "#fff8f1", foreground: "#2b1608" },
	},
	{
		id: "graphite",
		label: "Graphite",
		dark: { accent: "#a1a1aa", background: "#111113", foreground: "#f4f4f5" },
		light: { accent: "#52525b", background: "#fafafa", foreground: "#18181b" },
	},
];

const DEFAULT_STATE = Object.freeze({
	mode: "dark",
	themeId: "quantic",
	overrides: { dark: {}, light: {} },
});

/* ------------------------------ colour maths ------------------------------ */

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

export const normalizeHex = (value) => {
	const match = HEX_RE.exec(String(value ?? "").trim());
	if (!match) return null;
	let hex = match[1].toLowerCase();
	if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
	return `#${hex}`;
};

const toRgb = (hex) => {
	const h = normalizeHex(hex).slice(1);
	return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
};

const toHex = ([r, g, b]) =>
	`#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

const mix = (a, b, amount) => {
	const [r1, g1, b1] = toRgb(a);
	const [r2, g2, b2] = toRgb(b);
	return toHex([r1 + (r2 - r1) * amount, g1 + (g2 - g1) * amount, b1 + (b2 - b1) * amount]);
};

const rgbToHsl = ([r, g, b]) => {
	r /= 255; g /= 255; b /= 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
		else if (max === g) h = (b - r) / d + 2;
		else h = (r - g) / d + 4;
		h *= 60;
	}
	return [h, s, l];
};

const hslToRgb = ([h, s, l]) => {
	h = ((h % 360) + 360) % 360;
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0, g = 0, b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
};

const luminance = (hex) => {
	const [r, g, b] = toRgb(hex).map((v) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export const contrastRatio = (a, b) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
};

// Nudge `color` lighter/darker (away from the background) until it reads on it.
const ensureContrast = (color, background, target = 4.5) => {
	if (contrastRatio(color, background) >= target) return color;
	const [h, s, l] = rgbToHsl(toRgb(color));
	const direction = luminance(background) > 0.4 ? -1 : 1;
	for (let step = 1; step <= 50; step += 1) {
		const candidate = toHex(hslToRgb([h, s, Math.max(0, Math.min(1, l + direction * step * 0.02))]));
		if (contrastRatio(candidate, background) >= target) return candidate;
	}
	return direction > 0 ? "#ffffff" : "#000000";
};

// Keep the theme's own text colour when it reads on the background; otherwise
// fall back to near-black / near-white, whichever contrasts more.
const readableForeground = (preferred, background) => {
	if (contrastRatio(preferred, background) >= 4.5) return preferred;
	const dark = "#111418";
	const light = "#f4f6f8";
	return contrastRatio(dark, background) >= contrastRatio(light, background) ? dark : light;
};

// Solid outline colour for controls: starts as a soft blend of text and
// background and is strengthened until it reaches `target`:1 against the
// background, so inputs/buttons stay visible on any background (even mid-tones
// where a translucent border would vanish).
const controlEdge = (background, foreground, start, target = 3) => {
	for (let amount = start; amount <= 1; amount += 0.05) {
		const candidate = mix(background, foreground, amount);
		if (contrastRatio(candidate, background) >= target) return candidate;
	}
	return foreground;
};

const shiftHue = (hex, degrees, lightnessDelta = 0) => {
	const [h, s, l] = rgbToHsl(toRgb(hex));
	return toHex(hslToRgb([h + degrees, s, Math.max(0.15, Math.min(0.85, l + lightnessDelta))]));
};

const channels = (hex) => toRgb(hex).join(" ");

/* ------------------------------ palette logic ------------------------------ */

export const getTheme = (id) => THEMES.find((theme) => theme.id === id) || THEMES[0];

export const resolveMode = (mode) => {
	if (mode === "light" || mode === "dark") return mode;
	try {
		return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
	} catch {
		return "dark";
	}
};

// The three colours the user actually sees/edits for the current mode.
export const getPalette = (state, resolvedMode = resolveMode(state.mode)) => {
	const base = getTheme(state.themeId)[resolvedMode];
	const over = state.overrides?.[resolvedMode] || {};
	const background = over.background || base.background;
	return {
		accent: base.accent,
		accent2: base.accent2 || null,
		background,
		foreground: over.background ? readableForeground(base.foreground, background) : base.foreground,
	};
};

export const isLightBackground = (hex) => luminance(hex) > 0.4;

// A "light scheme" = dark text on a lighter background. Decided from the actual
// text/background pair (not just the background) so mid-tone backgrounds that
// get dark text are treated as light too.
export const isLightScheme = ({ background, foreground }) => luminance(foreground) < luminance(background);

const isUntouchedDefault = (state, resolvedMode) =>
	state.themeId === "quantic" &&
	resolvedMode === "dark" &&
	!state.overrides?.dark?.background;

const VAR_NAMES = [
	"--app-fg", "--app-fg-rgb", "--app-fg-fill",
	"--app-accent", "--app-accent-rgb", "--app-accent-text",
	"--app-accent-2", "--app-accent-2-rgb", "--app-accent-2-text",
	"--app-on-accent", "--app-edge",
	"--app-bg", "--app-bg-rgb", "--app-surface", "--app-surface-rgb",
	"--app-panel", "--app-panel-rgb", "--app-line",
	"--app-boost-lo", "--app-boost-mid", "--app-boost-hi",
	"--app-accent-boost-lo", "--app-accent-boost-mid", "--app-accent-boost-hi",
	"--app-shadow-k", "--app-tint-l",
	"--app-body-bg",
];

export const buildVariables = (state, resolvedMode = resolveMode(state.mode)) => {
	if (isUntouchedDefault(state, resolvedMode)) return {};

	const { accent, background, foreground, accent2: themeAccent2 } = getPalette(state, resolvedMode);
	const dark = resolvedMode === "dark";
	const light0 = isLightScheme({ background, foreground });
	let accent2 = themeAccent2 || shiftHue(accent, -38, dark ? 0.02 : -0.02);
	// On light schemes the accent fills carry white text, so keep both readable with it.
	if (light0) accent2 = ensureContrast(accent2, "#ffffff", 4.5);
	const surface = mix(background, foreground, dark ? 0.07 : 0.045);
	// Text on accent / accent-2 fills: whichever of near-black / white reads best on BOTH.
	const worst = (ink) => Math.min(contrastRatio(accent, ink), contrastRatio(accent2, ink));
	const onAccent = worst("#06111f") >= worst("#ffffff") ? "#06111f" : "#ffffff";

	// Quantic keeps its signature glow; other themes get a clean flat background.
	const [ar, ag, ab] = toRgb(accent);
	const glow = state.themeId === "quantic"
		? `radial-gradient(circle at top left, rgba(${ar}, ${ag}, ${ab}, ${dark ? 0.2 : 0.12}), transparent 32%), ${background}`
		: background;

	const light = isLightScheme({ background, foreground });
	const panel = mix(background, foreground, light ? 0.06 : 0.035);

	// Light schemes: the stylesheet was drawn for dark backgrounds, where faint
	// white overlays are enough. On light backgrounds those same overlays vanish,
	// so their strength is multiplied, shadows are softened and pale tinted text
	// (pink / mint / lavender) is darkened.
	const lightOnly = light
		? {
			"--app-boost-lo": "2.6",
			"--app-boost-mid": "1.9",
			"--app-boost-hi": "1.3",
			"--app-accent-boost-lo": "1.8",
			"--app-accent-boost-mid": "1.3",
			"--app-accent-boost-hi": "1.3",
			"--app-shadow-k": "0.35",
			"--app-tint-l": "0.42",
		}
		: {};

	return {
		...lightOnly,
		"--app-panel": panel,
		"--app-panel-rgb": channels(panel),
		"--app-line": mix(background, foreground, light ? 0.2 : 0.16),
		"--app-fg": foreground,
		"--app-fg-rgb": channels(foreground),
		"--app-fg-fill": foreground,
		"--app-accent": accent,
		"--app-accent-rgb": channels(accent),
		"--app-accent-text": ensureContrast(accent, background),
		"--app-accent-2": accent2,
		"--app-accent-2-rgb": channels(accent2),
		"--app-accent-2-text": ensureContrast(accent2, background),
		"--app-on-accent": onAccent,
		"--app-edge": controlEdge(background, foreground, dark ? 0.3 : 0.5),
		"--app-bg": background,
		"--app-bg-rgb": channels(background),
		"--app-surface": surface,
		"--app-surface-rgb": channels(surface),
		"--app-body-bg": glow,
	};
};

/* --------------------------------- storage --------------------------------- */

const cloneDefault = () => ({
	mode: DEFAULT_STATE.mode,
	themeId: DEFAULT_STATE.themeId,
	overrides: { dark: {}, light: {} },
});

const sanitizeOverrides = (input) => {
	// Older versions also stored accent/foreground overrides; they are ignored now.
	const hex = normalizeHex(input?.background);
	return hex ? { background: hex } : {};
};

const sanitizeState = (input) => {
	const state = cloneDefault();
	if (!input || typeof input !== "object") return state;
	if (MODES.some((m) => m.id === input.mode)) state.mode = input.mode;
	if (THEMES.some((t) => t.id === input.themeId)) state.themeId = input.themeId;
	state.overrides.dark = sanitizeOverrides(input.overrides?.dark);
	state.overrides.light = sanitizeOverrides(input.overrides?.light);
	return state;
};

const readStored = () => {
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		return raw ? sanitizeState(JSON.parse(raw)) : cloneDefault();
	} catch {
		return cloneDefault();
	}
};

const writeStored = (state) => {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch {
		// storage unavailable (private mode / quota): the theme still applies for this session
	}
};

/* ---------------------------------- store ---------------------------------- */

let currentState = typeof window === "undefined" ? cloneDefault() : readStored();
const listeners = new Set();

export const applyAppearance = (state = currentState) => {
	if (typeof document === "undefined") return;

	const root = document.documentElement;
	const resolved = resolveMode(state.mode);
	const variables = buildVariables(state, resolved);

	for (const name of VAR_NAMES) {
		if (variables[name] === undefined) root.style.removeProperty(name);
		else root.style.setProperty(name, variables[name]);
	}

	root.dataset.appMode = resolved;
	root.dataset.appBg = isLightScheme(getPalette(state, resolved)) ? "light" : "dark";
	root.dataset.appTheme = state.themeId;
	root.style.colorScheme = resolved;

	const meta = document.querySelector('meta[name="theme-color"]');
	if (meta) meta.setAttribute("content", variables["--app-bg"] || "#08111f");
};

const commit = (next, { persist = true } = {}) => {
	currentState = next;
	if (persist) writeStored(next);
	applyAppearance(next);
	listeners.forEach((listener) => listener());
};

export const getAppearance = () => currentState;

export const subscribeAppearance = (listener) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export const setMode = (mode) => {
	if (!MODES.some((m) => m.id === mode)) return;
	commit({ ...currentState, mode });
};

export const setTheme = (themeId) => {
	if (!THEMES.some((t) => t.id === themeId)) return;
	// Picking a theme starts from that theme's own colours.
	commit({ ...currentState, themeId, overrides: { dark: {}, light: {} } });
};

// value: hex, or null to go back to the theme's own background.
export const setBackground = (value) => {
	const resolved = resolveMode(currentState.mode);
	const overrides = { ...currentState.overrides, [resolved]: { ...currentState.overrides[resolved] } };

	if (value === null) {
		delete overrides[resolved].background;
	} else {
		const hex = normalizeHex(value);
		if (!hex) return false;
		overrides[resolved].background = hex;
	}

	commit({ ...currentState, overrides });
	return true;
};

export const resetAppearance = () => commit(cloneDefault());

/* ------------------------------ import / export ----------------------------- */

export const exportTheme = (state = currentState) => {
	const resolved = resolveMode(state.mode);
	const palette = getPalette(state, resolved);
	return JSON.stringify({
		quanticTheme: 1,
		theme: state.themeId,
		mode: resolved,
		background: palette.background,
	});
};

export const importTheme = (text) => {
	let data;
	try {
		data = JSON.parse(String(text ?? "").trim());
	} catch {
		return { ok: false, error: "That doesn't look like a Quantic theme." };
	}

	if (!data || data.quanticTheme !== 1) {
		return { ok: false, error: "That doesn't look like a Quantic theme." };
	}

	const background = normalizeHex(data.background);

	if (!background) {
		return { ok: false, error: "The theme is missing a valid background colour." };
	}

	const themeId = THEMES.some((t) => t.id === data.theme) ? data.theme : currentState.themeId;
	const target = data.mode === "light" ? "light" : "dark";
	const overrides = { ...currentState.overrides, [target]: { background } };

	// Apply in the mode the theme was made for, so it looks as the author intended.
	commit({ ...currentState, themeId, mode: target, overrides });
	return { ok: true };
};

/* ------------------------------- react binding ------------------------------ */

import { useEffect, useState } from "react";

export function useAppearance() {
	const [state, setState] = useState(getAppearance);

	useEffect(() => {
		const sync = () => setState(getAppearance());
		sync();
		return subscribeAppearance(sync);
	}, []);

	return state;
}

/* ------------------------------ boot-time wiring ---------------------------- */

if (typeof window !== "undefined") {
	applyAppearance(currentState);

	// "System" mode follows the OS live.
	try {
		const query = window.matchMedia("(prefers-color-scheme: light)");
		const onSystemChange = () => {
			if (currentState.mode === "system") commit(currentState, { persist: false });
		};
		if (query.addEventListener) query.addEventListener("change", onSystemChange);
		else if (query.addListener) query.addListener(onSystemChange);
	} catch {
		// matchMedia unavailable
	}

	// Keep multiple open tabs in sync.
	window.addEventListener("storage", (event) => {
		if (event.key === STORAGE_KEY) commit(readStored(), { persist: false });
	});
}