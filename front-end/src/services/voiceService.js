//front-end/src/services/voiceService.js
const getReadableText = (content) => String(content ?? "").trim();
let activeSpeechRequestId = 0;

export const cancelSpeechSynthesis = () => {
	// Invalidate the current chunk chain before cancelling: browsers may fire onend/onerror
	// for a cancelled utterance, and those handlers must not enqueue the next chunk.
	activeSpeechRequestId += 1;
	if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
	try {
		window.speechSynthesis.cancel();
	} catch {
		// ignore
	}
};

// Detect the DOMINANT script instead of the first match
const SCRIPT_RANGES = [
	{ lang: "ar", re: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/g },
	{ lang: "ru", re: /[\u0400-\u04FF]/g },
	{ lang: "hi-IN", re: /[\u0900-\u097F]/g },
	{ lang: "bn-IN", re: /[\u0980-\u09FF]/g },
	{ lang: "pa-IN", re: /[\u0A00-\u0A7F]/g },
	{ lang: "gu-IN", re: /[\u0A80-\u0AFF]/g },
	{ lang: "or-IN", re: /[\u0B00-\u0B7F]/g },
	{ lang: "ta-IN", re: /[\u0B80-\u0BFF]/g },
	{ lang: "te-IN", re: /[\u0C00-\u0C7F]/g },
	{ lang: "kn-IN", re: /[\u0C80-\u0CFF]/g },
	{ lang: "ml-IN", re: /[\u0D00-\u0D7F]/g },
	{ lang: "th-TH", re: /[\u0E00-\u0E7F]/g },
	{ lang: "ko-KR", re: /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/g },
	{ lang: "ja-JP", re: /[\u3040-\u30FF]/g },
	{ lang: "zh-CN", re: /[\u4E00-\u9FFF]/g },
	{ lang: "he-IL", re: /[\u0590-\u05FF]/g },
];

const detectLanguageFromText = (text) => {
	const sample = String(text ?? "").trim();
	if (!sample) return null;

	let best = null;
	let bestCount = 0;
	for (const { lang, re } of SCRIPT_RANGES) {
		const count = (sample.match(re) || []).length;
		if (count > bestCount) {
			bestCount = count;
			best = lang;
		}
	}
	// require a minimum share of the text to avoid false positives on a stray character
	return bestCount >= 3 || bestCount / sample.length > 0.15 ? best : null;
};

// Curated list of natural-sounding voices, in priority order.
// Add the exact voice names available on your target OS/browser here.
const PREFERRED_VOICE_NAMES = [
	"Google UK English Female",
	"Google US English",
	"Microsoft Aria Online (Natural) - English (United States)",
	"Microsoft Ava Online (Natural) - English (United States)",
	"Samantha",
];

const voiceSelectionCache = new Map();

const pickVoiceForLang = (preferredLang) => {
	if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
	const voices = window.speechSynthesis.getVoices?.() || [];
	if (!voices.length) return null;

	const normalizedPreferred = String(preferredLang || "").toLowerCase();
	const base = normalizedPreferred.split("-")[0];
	const cacheKey = base;

	if (voiceSelectionCache.has(cacheKey)) {
		return voiceSelectionCache.get(cacheKey);
	}

	const exact = voices.filter((v) => String(v.lang || "").toLowerCase() === normalizedPreferred);
	const sameBase = voices.filter((v) => String(v.lang || "").toLowerCase().startsWith(`${base}-`) || String(v.lang || "").toLowerCase() === base);
	const pool = exact.length ? exact : sameBase.length ? sameBase : voices;

	let chosen = null;
	for (const name of PREFERRED_VOICE_NAMES) {
		chosen = pool.find((v) => v.name === name);
		if (chosen) break;
	}

	if (!chosen) {
		const scored = pool
			.map((voice) => {
				let score = 0;
				if (/(natural|premium|google|microsoft|enhanced|neural)/i.test(voice.name || "")) score += 3;
				if (voice.localService) score += 1;
				const lang = String(voice.lang || "").toLowerCase();
				if (lang === normalizedPreferred) score += 2;
				else if (base && lang.startsWith(`${base}-`)) score += 1;
				return { voice, score };
			})
			.sort((a, b) => b.score - a.score);
		chosen = scored[0]?.voice || null;
	}

	voiceSelectionCache.set(cacheKey, chosen);
	return chosen;
};

const waitForVoices = (preferredLang) =>
	new Promise((resolve) => {
		if (typeof window === "undefined" || !("speechSynthesis" in window)) {
			resolve(null);
			return;
		}

		const synth = window.speechSynthesis;
		try {
			synth.getVoices?.();
		} catch {
			// ignore
		}

		const existing = pickVoiceForLang(preferredLang);
		if (existing) {
			resolve(existing);
			return;
		}

		let done = false;
		const finish = (voice) => {
			if (done) return;
			done = true;
			resolve(voice || pickVoiceForLang(preferredLang));
		};

		synth.addEventListener?.("voiceschanged", () => finish(pickVoiceForLang(preferredLang)), { once: true });

		window.setTimeout(() => finish(pickVoiceForLang(preferredLang)), 1200);
	});

// Split into speakable chunks so long replies don't get cut off (Chrome truncation bug)
const chunkText = (text, maxLen = 180) => {
	const sentences = text.match(/[^.!?։。？！]+[.!?։。？！]*\s*/g) || [text];
	const chunks = [];
	let current = "";
	for (const sentence of sentences) {
		if ((current + sentence).length > maxLen && current) {
			chunks.push(current.trim());
			current = sentence;
		} else {
			current += sentence;
		}
	}
	if (current.trim()) chunks.push(current.trim());
	return chunks;
};

// Mobile browsers only allow speech after a tap-initiated utterance.
export const primeSpeechSynthesis = () => {
	try {
		if (typeof window === "undefined" || !("speechSynthesis" in window)) {
			return;
		}

		const silent = new SpeechSynthesisUtterance(" ");
		silent.volume = 0;
		window.speechSynthesis.speak(silent);
	} catch {
		// ignore
	}
};

export const speakWithAI = async (content, onStart, onEnd, options = {}) => {
	const readableText = getReadableText(content);
	if (!readableText || typeof window === "undefined" || !("speechSynthesis" in window)) {
		return null;
	}

	// A new playback supersedes any older utterance chain.
	const requestId = ++activeSpeechRequestId;
	const detectedLang = detectLanguageFromText(readableText);
	const preferredLang = options.lang || detectedLang || navigator?.language || "en-US";
	const voice = await waitForVoices(preferredLang);
	if (requestId !== activeSpeechRequestId) return null;
	const resolvedLang = voice?.lang || preferredLang;

	const synth = window.speechSynthesis;
	try {
		synth.cancel();
	} catch {
		// ignore
	}

	// Android Chrome can drop speech queued immediately after cancel(), especially
	// after microphone recognition has just stopped. Give its speech engine a brief
	// moment to settle; keep the existing desktop path unchanged.
	const isAndroidChrome =
		/Android/i.test(navigator?.userAgent || "") &&
		/Chrome/i.test(navigator?.userAgent || "");
	if (isAndroidChrome) {
		await new Promise((resolve) => window.setTimeout(resolve, 120));
		if (requestId !== activeSpeechRequestId) return null;
	}

	const chunks = chunkText(readableText);
	const START_TIMEOUT_MS = 3000;
	let index = 0;
	let started = false;

	return new Promise((resolve) => {
		let settled = false;

		const settle = (value) => {
			if (!settled) {
				settled = true;
				resolve(value);
			}
		};

		// If the first chunk never starts (browser dropped it), report failure so the caller can fall back.
		const startGuard = window.setTimeout(() => {
			if (started) {
				return;
			}

			if (requestId !== activeSpeechRequestId) {
				settle(null); // stopped or superseded: caller must NOT fall back
				return;
			}

			activeSpeechRequestId += 1;

			try {
				window.speechSynthesis.cancel();
			} catch {
				// ignore
			}

			settle(false);
		}, START_TIMEOUT_MS);

		const speakNext = () => {
			if (requestId !== activeSpeechRequestId) {
				return;
			}

			if (index >= chunks.length) {
				if (typeof onEnd === "function") {
					onEnd();
				}

				return;
			}

			const utterance = new SpeechSynthesisUtterance(chunks[index]);
			utterance.lang = resolvedLang;
			utterance.voice = voice || null;
			utterance.rate = 0.86;
			utterance.pitch = 1.05;
			utterance.volume = 1;

			utterance.onstart = () => {
				if (started) {
					return;
				}

				started = true;
				window.clearTimeout(startGuard);

				if (typeof onStart === "function") {
					onStart();
				}

				settle(true);
			};

			if (typeof options.onBoundary === "function") {
				utterance.onboundary = (event) => options.onBoundary(event);
			}

			utterance.onend = () => {
				if (requestId !== activeSpeechRequestId) {
					return;
				}

				index += 1;
				speakNext();
			};

			utterance.onerror = () => {
				if (requestId !== activeSpeechRequestId) {
					return;
				}

				if (!started) {
					window.clearTimeout(startGuard);
					settle(false);
					return;
				}

				index += 1;
				speakNext();
			};

			window.speechSynthesis.speak(utterance);
		};

		speakNext();
		window.speechSynthesis.resume?.();
	});
};

/* ------------------------------------------------------------------------- *
 * Speech-recognition language
 * ------------------------------------------------------------------------- */

const VOICE_LANG_STORAGE_KEY = "quantic_voice_lang";

// Recognition only works in ONE language per session, and the wrong one is the most common reason
// speech comes out garbled (Bengali or Indian-accented English read as US English).
export const VOICE_LANGUAGE_OPTIONS = [
	{ code: "en-IN", short: "EN\u00B7IN", label: "English (India)" },
	// { code: "bn-IN", short: "\u09AC\u09BE\u0982\u09B2\u09BE", label: "\u09AC\u09BE\u0982\u09B2\u09BE (Bengali)" },
	// { code: "hi-IN", short: "\u0939\u093F\u0928\u094D\u0926\u0940", label: "\u0939\u093F\u0928\u094D\u0926\u0940 (Hindi)" },
	{ code: "en-US", short: "EN\u00B7US", label: "English (US)" },
];

// The saved choice, plus the browser's own language if it is not one of the presets.
export const getVoiceLanguageOptions = (activeCode) => {
	const code = String(activeCode || "");
	if (!code || VOICE_LANGUAGE_OPTIONS.some((option) => option.code === code)) {
		return VOICE_LANGUAGE_OPTIONS;
	}
	return [{ code, short: code.toUpperCase(), label: code }, ...VOICE_LANGUAGE_OPTIONS];
};

const guessDefaultVoiceLanguage = () => {
	const browserLang = String((typeof navigator !== "undefined" && navigator.language) || "en-US");
	const lower = browserLang.toLowerCase();

	if (lower.startsWith("bn")) return "bn-IN";
	if (lower.startsWith("hi")) return "hi-IN";

	let timeZone = "";
	try {
		timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
	} catch {
		// ignore
	}

	// A US-English browser in India is very common; en-IN understands Indian accents far better.
	const inIndia = /^asia\/(kolkata|calcutta)$/i.test(timeZone) || lower.endsWith("-in");
	if (lower.startsWith("en") && inIndia) return "en-IN";

	return browserLang;
};

export const getInitialVoiceLanguage = () => {
	try {
		const saved = String(window.localStorage.getItem(VOICE_LANG_STORAGE_KEY) || "");
		if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,4})?$/.test(saved)) {
			return saved;
		}
	} catch {
		// ignore
	}
	return guessDefaultVoiceLanguage();
};

export const rememberVoiceLanguage = (code) => {
	try {
		window.localStorage.setItem(VOICE_LANG_STORAGE_KEY, String(code || ""));
	} catch {
		// ignore
	}
};

// Join recognition segments into one string without losing or duplicating any spaces.
export const joinVoiceTranscript = (parts, lang = "") => {
	const noSpaceLanguage = /^(ja|zh|th|lo|km|my)\b/i.test(String(lang));
	return (Array.isArray(parts) ? parts : [])
		.map((part) => String(part ?? "").trim())
		.filter(Boolean)
		.join(noSpaceLanguage ? "" : " ");
};


/* ------------------------------------------------------------------------- *
 * Microphone level meter (drives the orb while the user is talking)
 * ------------------------------------------------------------------------- */

// Reads the live loudness of the microphone. On phones the meter is skipped, because a second
// microphone stream can steal the mic from speech recognition there; the orb then reacts to the
// recogniser's own speech events instead.
export const createMicLevelMeter = () => {
	let stream = null;
	let audioContext = null;
	let analyser = null;
	let samples = null;
	let wanted = false;

	const isPhone = typeof navigator !== "undefined" && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent || "");

	const release = () => {
		try {
			stream?.getTracks?.().forEach((track) => track.stop());
		} catch {
			// ignore
		}
		try {
			audioContext?.close?.();
		} catch {
			// ignore
		}
		stream = null;
		audioContext = null;
		analyser = null;
		samples = null;
	};

	const start = async () => {
		if (wanted || isPhone || typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
			return false;
		}

		wanted = true;

		try {
			const nextStream = await navigator.mediaDevices.getUserMedia({
				audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
			});

			if (!wanted) {
				nextStream.getTracks().forEach((track) => track.stop());
				return false;
			}

			const AudioContextClass = window.AudioContext || window.webkitAudioContext;
			if (!AudioContextClass) {
				nextStream.getTracks().forEach((track) => track.stop());
				wanted = false;
				return false;
			}

			stream = nextStream;
			audioContext = new AudioContextClass();
			audioContext.resume?.();

			analyser = audioContext.createAnalyser();
			analyser.fftSize = 512;
			analyser.smoothingTimeConstant = 0.55;
			audioContext.createMediaStreamSource(stream).connect(analyser);
			samples = new Uint8Array(analyser.fftSize);
			return true;
		} catch {
			wanted = false;
			release();
			return false;
		}
	};

	const stop = () => {
		wanted = false;
		release();
	};

	// 0 = silence, 1 = loud speech. The small offset is a noise gate for room hiss.
	const getLevel = () => {
		if (!analyser || !samples) {
			return 0;
		}

		analyser.getByteTimeDomainData(samples);

		let sum = 0;
		for (let index = 0; index < samples.length; index += 1) {
			const centred = (samples[index] - 128) / 128;
			sum += centred * centred;
		}

		const rms = Math.sqrt(sum / samples.length);
		return Math.max(0, Math.min(1, (rms - 0.014) / 0.15));
	};

	return { start, stop, getLevel, isActive: () => Boolean(analyser) };
};


/* ------------------------------------------------------------------------- *
 * Voice orb: an electric plasma ring that lights up when the user or Quantic speaks
 * ------------------------------------------------------------------------- */

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const lerp = (from, to, amount) => from + (to - from) * amount;
const randomBetween = (min, max) => min + Math.random() * (max - min);

const RING_HARMONICS = [2, 3, 5, 8, 11, 16, 23, 31, 44];
const RING_POINTS = 220;
const MAX_BOLTS = 46;

// Deep electric blue for the user, a touch more cyan for Quantic.
const ORB_HUES = { idle: 222, listening: 221, user: 216, thinking: 232, speaking: 207 };

/**
 * canvas   - the <canvas> to draw on (square).
 * options  - { getUserLevel: () => 0..1, hasMeter: () => boolean, reduceMotion: boolean }
 * returns  - { setMode("idle"|"listening"|"thinking"|"speaking"), setUserSpeaking(bool), pulse(0..1), destroy() }
 */
export const createLightningOrb = (canvas, options = {}) => {
	const ctx = canvas?.getContext?.("2d");
	const inert = { setMode() {}, setUserSpeaking() {}, pulse() {}, step() {}, destroy() {} };

	if (!ctx) {
		return inert;
	}

	const getUserLevel = typeof options.getUserLevel === "function" ? options.getUserLevel : () => 0;
	const hasMeter = typeof options.hasMeter === "function" ? options.hasMeter : () => false;
	const osReducesMotion = typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
	const reduceMotion = Boolean(options.reduceMotion || osReducesMotion);
	const crackleInterval = reduceMotion ? 0.16 : 0.045;

	let size = Number(options.size) || 320;
	let dpr = 1;
	let time = 0;
	let mode = "idle";
	let userSpeaking = false;
	let energy = 0.09;
	let level = 0;
	let flash = 0;
	let hue = ORB_HUES.idle;
	let rotation = 0;
	let crackleClock = 0;
	let boltBudget = 0;
	let bolts = [];
	let sparks = [];
	let running = true;
	let frameHandle = 0;
	let lastStamp = 0;

	// Interwoven loops, like the filaments of a plasma ball. The last two only appear when it is bright.
	const loops = [0, 1, 2, 3, 4].map((index) => ({
		radiusOffset: (index - 2) * 0.02,
		phase: RING_HARMONICS.map(() => Math.random() * Math.PI * 2),
		drift: RING_HARMONICS.map(() => randomBetween(-1.4, 1.4)),
		amp: RING_HARMONICS.map((harmonic) => randomBetween(0.55, 1) / Math.pow(harmonic, 0.62)),
		width: [1.5, 1.15, 0.95, 0.8, 0.7][index],
	}));

	const applySize = (cssSize) => {
		size = Math.max(60, Math.round(cssSize));
		dpr = typeof window !== "undefined" ? Math.min(2, window.devicePixelRatio || 1) : 1;
		canvas.width = Math.round(size * dpr);
		canvas.height = Math.round(size * dpr);
	};

	const measure = () => {
		const rect = canvas.getBoundingClientRect?.();
		const cssSize = rect?.width || canvas.clientWidth || 0;
		if (cssSize >= 60) {
			applySize(cssSize);
		}
	};

	const ringRadius = () => size * 0.285 * (1 + 0.045 * energy + 0.03 * flash);

	const refreshSparks = () => {
		const count = Math.round(1 + energy * 5);
		sparks = Array.from({ length: count }, () => ({
			angle: Math.random() * Math.PI * 2,
			radius: randomBetween(0.985, 1.02),
			size: randomBetween(0.012, 0.03),
			power: randomBetween(0.5, 1),
		}));
	};

	const spawnBolt = () => {
		if (bolts.length >= MAX_BOLTS) {
			return;
		}

		const radius = ringRadius();
		const angle = Math.random() * Math.PI * 2;
		const inward = Math.random() < 0.25;
		const direction = inward ? -1 : 1;
		// Long, thin wisps reaching far out, like the fine tendrils around a plasma ball.
		const wispy = !inward && energy > 0.35 && Math.random() < 0.3;
		const baseReach = wispy
			? size * randomBetween(0.10, 0.18)
			: size * randomBetween(0.05, 0.1 + 0.2 * energy) * (1 + flash * 0.6) * (inward ? 0.5 : 1);
		const reach = Math.min(baseReach, size * 0.18);
		const steps = wispy ? Math.round(randomBetween(10, 16)) : Math.round(randomBetween(6, 12));
		const sway = size * (wispy ? 0.02 : 0.03) * (0.45 + energy);
		const points = [];

		for (let step = 0; step <= steps; step += 1) {
			const t = step / steps;
			const r = radius + direction * reach * t;
			const lateral = step === 0 ? 0 : randomBetween(-1, 1) * sway * (1 - 0.35 * t);
			const a = angle + lateral / Math.max(r, 1);
			points.push([Math.cos(a) * r, Math.sin(a) * r]);
		}

		let fork = null;
		if (!inward && !wispy && steps >= 8 && Math.random() < 0.55) {
			const [startX, startY] = points[Math.floor(steps * randomBetween(0.4, 0.7))];
			const heading = Math.atan2(startY, startX) + randomBetween(0.25, 0.6) * (Math.random() < 0.5 ? -1 : 1);
			const forkLength = reach * randomBetween(0.3, 0.5);
			fork = [[startX, startY]];
			for (let step = 1; step <= 4; step += 1) {
				const distance = (forkLength * step) / 4;
				fork.push([
					startX + Math.cos(heading) * distance + randomBetween(-1, 1) * sway * 0.5,
					startY + Math.sin(heading) * distance + randomBetween(-1, 1) * sway * 0.5,
				]);
			}
		}

		bolts.push({
			points,
			fork,
			wispy,
			born: time,
			life: wispy ? randomBetween(0.16, 0.36) : randomBetween(0.11, 0.27),
			width: wispy ? randomBetween(0.5, 0.85) : randomBetween(0.8, 1.6),
		});
	};

	const targetEnergy = () => {
		if (mode === "speaking") {
			// Speech synthesis gives us no audio to measure, so shape a natural syllable-like envelope.
			const envelope = clamp01(0.55 + 0.25 * Math.sin(time * 7.3) + 0.15 * Math.sin(time * 12.9 + 1.7) + 0.08 * Math.sin(time * 21.1));
			return 0.42 + 0.5 * envelope;
		}

		if (mode === "thinking") {
			return 0.36 + 0.1 * Math.sin(time * 3.4);
		}

		if (mode === "listening") {
			const metering = hasMeter();

			// The user's real voice level lights the orb directly.
			if (metering && level > 0.04) {
				return 0.22 + 0.78 * level;
			}

			if (userSpeaking) {
				const envelope = clamp01(0.55 + 0.25 * Math.sin(time * 9.1) + 0.15 * Math.sin(time * 15.3 + 0.6));
				return metering ? 0.3 + 0.2 * envelope : 0.4 + 0.5 * envelope;
			}

			return 0.17 + 0.03 * Math.sin(time * 1.6);
		}

		return 0.09 + 0.02 * Math.sin(time * 1.1);
	};

	const targetHue = () => {
		if (mode === "speaking") return ORB_HUES.speaking;
		if (mode === "thinking") return ORB_HUES.thinking;
		if (mode === "listening") return level > 0.08 || userSpeaking ? ORB_HUES.user : ORB_HUES.listening;
		return ORB_HUES.idle;
	};

	const update = (dt) => {
		time += dt;

		const rawLevel = mode === "listening" ? clamp01(Number(getUserLevel()) || 0) : 0;
		level = lerp(level, rawLevel, rawLevel > level ? 0.55 : 0.14);

		const target = targetEnergy();
		energy += (target - energy) * (1 - Math.exp(-dt * (target > energy ? 16 : 4.2)));
		flash *= Math.exp(-dt * 5.5);
		hue += (targetHue() - hue) * (1 - Math.exp(-dt * 6));
		rotation += dt * (reduceMotion ? 0.03 : 0.1 + energy * 0.5);

		loops.forEach((loop) => {
			for (let index = 0; index < RING_HARMONICS.length; index += 1) {
				loop.phase[index] += loop.drift[index] * dt * (0.5 + energy * 2.4);
			}
		});

		// Lightning flickers in sudden jumps rather than smooth motion.
		crackleClock += dt;
		if (crackleClock >= crackleInterval) {
			crackleClock = 0;
			const jump = 0.35 + energy * 1.6;
			loops.forEach((loop) => {
				RING_HARMONICS.forEach((harmonic, index) => {
					if (harmonic >= 8) {
						loop.phase[index] += randomBetween(-jump, jump);
					}
				});
			});
			refreshSparks();
		}

		boltBudget += dt * (1.3 + 22 * energy * energy + 24 * flash) * (reduceMotion ? 0.25 : 1);
		while (boltBudget >= 1) {
			boltBudget -= 1;
			spawnBolt();
		}
		bolts = bolts.filter((bolt) => time - bolt.born < bolt.life);
	};

	const strokePoints = (points, cx, cy) => {
		ctx.beginPath();
		points.forEach(([x, y], index) => {
			if (index === 0) ctx.moveTo(cx + x, cy + y);
			else ctx.lineTo(cx + x, cy + y);
		});
		ctx.stroke();
	};

	const draw = () => {
		const cx = size / 2;
		const cy = size / 2;
		const radius = ringRadius();
		const scale = size / 340;
		const gain = Math.min(1.25, 0.55 + 0.5 * energy + 0.3 * flash);

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.clearRect(0, 0, size, size);
		ctx.globalCompositeOperation = "lighter";
		ctx.lineCap = "round";
		ctx.lineJoin = "round";

		// Soft plasma haze around the ring; the centre stays dark.
		const haze = ctx.createRadialGradient(cx, cy, radius * 0.55, cx, cy, radius * 1.75);
		haze.addColorStop(0, `hsla(${hue}, 100%, 55%, 0)`);
		haze.addColorStop(0.38, `hsla(${hue}, 100%, 58%, ${0.1 + 0.3 * energy + 0.15 * flash})`);
		haze.addColorStop(1, `hsla(${hue}, 100%, 50%, 0)`);
		ctx.fillStyle = haze;
		ctx.fillRect(0, 0, size, size);

		// The ring itself.
		const wobble = size * (0.008 + 0.028 * energy) * (1 + flash * 0.5);
		const highGain = 0.4 + 0.6 * energy;

		loops.forEach((loop, loopIndex) => {
			ctx.beginPath();

			for (let point = 0; point <= RING_POINTS; point += 1) {
				const angle = (point / RING_POINTS) * Math.PI * 2 + rotation * (loopIndex % 2 ? -1 : 1);
				let noise = 0;

				for (let index = 0; index < RING_HARMONICS.length; index += 1) {
					const harmonic = RING_HARMONICS[index];
					noise += loop.amp[index] * (harmonic >= 8 ? highGain : 1) * Math.sin(harmonic * angle + loop.phase[index]);
				}

				const r = radius * (1 + loop.radiusOffset) + noise * wobble;
				const x = cx + Math.cos(angle) * r;
				const y = cy + Math.sin(angle) * r;

				if (point === 0) ctx.moveTo(x, y);
				else ctx.lineTo(x, y);
			}

			ctx.closePath();

			const extraLoopFade = loopIndex >= 3 ? clamp01((energy - 0.22) * 2.2) : 1;
			const loopGain = gain * [1, 0.8, 0.62, 0.5, 0.42][loopIndex] * extraLoopFade;

			if (loopGain < 0.02) {
				return;
			}

			ctx.shadowBlur = 26 * scale;
			ctx.shadowColor = `hsla(${hue}, 100%, 60%, ${Math.min(1, 0.9 * loopGain)})`;
			ctx.strokeStyle = `hsla(${hue}, 100%, 58%, ${0.2 * loopGain})`;
			ctx.lineWidth = 9 * scale;
			ctx.stroke();

			ctx.shadowBlur = 12 * scale;
			ctx.strokeStyle = `hsla(${hue}, 100%, 68%, ${Math.min(1, 0.6 * loopGain)})`;
			ctx.lineWidth = 2.4 * scale * (loop.width / 1.5);
			ctx.stroke();

			ctx.shadowBlur = 4 * scale;
			ctx.strokeStyle = `rgba(232, 246, 255, ${Math.min(1, 0.9 * loopGain)})`;
			ctx.lineWidth = 1 * scale;
			ctx.stroke();
		});

		// Lightning bolts leaping off the ring.
		bolts.forEach((bolt) => {
			const fade = Math.pow(1 - clamp01((time - bolt.born) / bolt.life), 1.4);
			const alpha = fade * (0.45 + 0.55 * energy) * (bolt.wispy ? 0.75 : 1);

			ctx.shadowBlur = (bolt.wispy ? 6 : 12) * scale;
			ctx.shadowColor = `hsla(${hue}, 100%, 62%, ${alpha})`;
			ctx.strokeStyle = `hsla(${hue}, 100%, 66%, ${0.55 * alpha})`;
			ctx.lineWidth = bolt.width * 2.6 * scale;
			strokePoints(bolt.points, cx, cy);
			if (bolt.fork) strokePoints(bolt.fork, cx, cy);

			ctx.shadowBlur = 5 * scale;
			ctx.strokeStyle = `rgba(236, 248, 255, ${0.95 * alpha})`;
			ctx.lineWidth = bolt.width * 0.9 * scale;
			strokePoints(bolt.points, cx, cy);
			if (bolt.fork) strokePoints(bolt.fork, cx, cy);
		});

		// Bright hot spots that twinkle along the ring.
		ctx.shadowBlur = 0;
		sparks.forEach((spark) => {
			const x = cx + Math.cos(spark.angle) * radius * spark.radius;
			const y = cy + Math.sin(spark.angle) * radius * spark.radius;
			const sparkSize = size * spark.size * (0.7 + 0.8 * energy);
			const alpha = Math.min(1, spark.power * (0.3 + 0.7 * energy) + flash * 0.3);
			const glow = ctx.createRadialGradient(x, y, 0, x, y, sparkSize);
			glow.addColorStop(0, `rgba(255, 255, 255, ${alpha})`);
			glow.addColorStop(0.35, `hsla(${hue}, 100%, 72%, ${alpha * 0.7})`);
			glow.addColorStop(1, `hsla(${hue}, 100%, 55%, 0)`);
			ctx.fillStyle = glow;
			ctx.fillRect(x - sparkSize, y - sparkSize, sparkSize * 2, sparkSize * 2);
		});

		ctx.shadowBlur = 0;
		ctx.globalCompositeOperation = "source-over";
	};

	const tick = (stamp) => {
		if (!running) {
			return;
		}

		frameHandle = window.requestAnimationFrame(tick);
		const dt = Math.min(0.05, Math.max(0.001, (stamp - (lastStamp || stamp)) / 1000));
		lastStamp = stamp;
		update(dt);
		draw();
	};

	let observer = null;
	if (typeof window !== "undefined") {
		measure();
		if (typeof ResizeObserver !== "undefined") {
			observer = new ResizeObserver(measure);
			observer.observe(canvas);
		}
	} else {
		applySize(size);
	}

	refreshSparks();

	if (options.autoStart !== false && typeof window !== "undefined" && window.requestAnimationFrame) {
		frameHandle = window.requestAnimationFrame(tick);
	}

	return {
		setMode(nextMode) {
			if (nextMode === mode) return;
			if (nextMode === "speaking") flash = Math.max(flash, 0.5);
			mode = nextMode;
			if (mode !== "listening") userSpeaking = false;
		},
		setUserSpeaking(value) {
			userSpeaking = Boolean(value) && mode === "listening";
			if (userSpeaking) flash = Math.max(flash, 0.15);
		},
		pulse(amount = 0.5) {
			flash = Math.min(1.2, flash + amount * 0.5);
			const bursts = reduceMotion ? 0 : Math.ceil(amount * 2);
			for (let index = 0; index < bursts; index += 1) spawnBolt();
		},
		// One manual frame (used for testing and screenshots).
		step(dt = 1 / 60) {
			update(dt);
			draw();
		},
		destroy() {
			running = false;
			if (frameHandle && typeof window !== "undefined") window.cancelAnimationFrame?.(frameHandle);
			observer?.disconnect?.();
		},
	};
};