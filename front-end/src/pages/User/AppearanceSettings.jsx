// front-end/src/pages/User/AppearanceSettings.jsx
import { useEffect, useId, useRef, useState } from "react";
import {
	MODES,
	THEMES,
	exportTheme,
	getPalette,
	importTheme,
	normalizeHex,
	resetAppearance,
	resolveMode,
	setBackground,
	setMode,
	setTheme,
	useAppearance,
} from "../../theme/appearance";

/* ------------------------------- small icons ------------------------------- */

function ChevronIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function ImportIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="M12 4v10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
			<path d="m7.5 10.5 4.5 4.5 4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M5 19h14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
		</svg>
	);
}

function CopyIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<rect x="8.5" y="8.5" width="10.5" height="10.5" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
			<path d="M15 8.5V6.7A1.7 1.7 0 0 0 13.3 5H6.7A1.7 1.7 0 0 0 5 6.7v6.6A1.7 1.7 0 0 0 6.7 15h1.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
		</svg>
	);
}

function CheckIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function ResetIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="M5 12a7 7 0 1 0 2.2-5.1" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
			<path d="M5 4.5v4h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

/* --------------------------------- mode cards -------------------------------- */

// Tiny fixed-colour chat mock-ups. They intentionally do NOT follow the live
// theme: each one shows what that mode looks like.
function ModePreview({ variant }) {
	const light = (
		<div className="appearance-mode__scene appearance-mode__scene--light">
			<span className="appearance-mode__rail" />
			<span className="appearance-mode__lines"><i /><i /><i /><b /></span>
			<span className="appearance-mode__input" />
		</div>
	);
	const dark = (
		<div className="appearance-mode__scene appearance-mode__scene--dark">
			<span className="appearance-mode__rail" />
			<span className="appearance-mode__lines"><i /><i /><i /><b /></span>
			<span className="appearance-mode__input" />
		</div>
	);

	if (variant === "light") return light;
	if (variant === "dark") return dark;

	return (
		<div className="appearance-mode__split">
			<div className="appearance-mode__half appearance-mode__half--left">{light}</div>
			<div className="appearance-mode__half appearance-mode__half--right">{dark}</div>
		</div>
	);
}

/* --------------------------------- dropdown ---------------------------------- */

const LIST_MAX_HEIGHT = 288; // keep in sync with .appearance-dropdown__list max-height (18rem)
const LIST_GAP = 12;

// Visible vertical range for the list: the viewport, narrowed by any ancestor that
// scrolls or clips (the settings page lives inside one).
const getVisibleBounds = (element) => {
	let top = 0;
	let bottom = window.innerHeight || document.documentElement.clientHeight;
	let node = element.parentElement;

	while (node && node !== document.body && node !== document.documentElement) {
		if (/(auto|scroll|hidden|clip|overlay)/.test(window.getComputedStyle(node).overflowY)) {
			const rect = node.getBoundingClientRect();
			top = Math.max(top, rect.top);
			bottom = Math.min(bottom, rect.bottom);
		}
		node = node.parentElement;
	}

	return { top, bottom };
};

// Open downwards when there is room, otherwise flip upwards, and always cap the
// height to the space actually available so the options are never cut off.
const computePlacement = (button, optionCount) => {
	const rect = button.getBoundingClientRect();
	const bounds = getVisibleBounds(button);
	const wanted = Math.min(LIST_MAX_HEIGHT, optionCount * 40 + 12);
	const below = Math.max(0, bounds.bottom - rect.bottom - LIST_GAP);
	const above = Math.max(0, rect.top - bounds.top - LIST_GAP);
	const up = below < wanted && above > below;
	const room = up ? above : below;

	return { up, maxHeight: Math.max(120, Math.min(LIST_MAX_HEIGHT, room)) };
};

function Dropdown({ value, options, onChange, ariaLabel, renderValue }) {
	const [open, setOpen] = useState(false);
	const [active, setActive] = useState(0);
	const [placement, setPlacement] = useState({ up: false, maxHeight: LIST_MAX_HEIGHT });
	const rootRef = useRef(null);
	const buttonRef = useRef(null);
	const listId = useId();
	const selectedIndex = Math.max(0, options.findIndex((option) => option.value === value));
	const selected = options[selectedIndex];

	useEffect(() => {
		if (!open) return undefined;

		const handlePointer = (event) => {
			if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
		};

		document.addEventListener("mousedown", handlePointer);
		document.addEventListener("touchstart", handlePointer);
		return () => {
			document.removeEventListener("mousedown", handlePointer);
			document.removeEventListener("touchstart", handlePointer);
		};
	}, [open]);

	const openList = () => {
		if (buttonRef.current) setPlacement(computePlacement(buttonRef.current, options.length));
		setActive(selectedIndex);
		setOpen(true);
	};

	// Keep the placement right if the window is resized or something scrolls while open.
	useEffect(() => {
		if (!open) return undefined;

		const update = () => {
			if (buttonRef.current) setPlacement(computePlacement(buttonRef.current, options.length));
		};

		window.addEventListener("resize", update);
		window.addEventListener("scroll", update, true);
		return () => {
			window.removeEventListener("resize", update);
			window.removeEventListener("scroll", update, true);
		};
	}, [open, options.length]);

	const choose = (index) => {
		const option = options[index];
		if (option && !option.disabled) onChange(option.value);
		setOpen(false);
	};

	const handleKeyDown = (event) => {
		if (!open) {
			if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
				event.preventDefault();
				openList();
			}
			return;
		}

		if (event.key === "Escape") {
			event.preventDefault();
			setOpen(false);
		} else if (event.key === "ArrowDown") {
			event.preventDefault();
			setActive((index) => Math.min(options.length - 1, index + 1));
		} else if (event.key === "ArrowUp") {
			event.preventDefault();
			setActive((index) => Math.max(0, index - 1));
		} else if (event.key === "Home") {
			event.preventDefault();
			setActive(0);
		} else if (event.key === "End") {
			event.preventDefault();
			setActive(options.length - 1);
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			choose(active);
		} else if (event.key === "Tab") {
			setOpen(false);
		}
	};

	return (
		<div className="appearance-dropdown" ref={rootRef}>
			<button
				ref={buttonRef}
				type="button"
				className="appearance-dropdown__button"
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-controls={open ? listId : undefined}
				aria-label={ariaLabel}
				onClick={() => (open ? setOpen(false) : openList())}
				onKeyDown={handleKeyDown}
			>
				{renderValue ? renderValue(selected) : <span>{selected?.label}</span>}
				<span className="appearance-dropdown__chevron"><ChevronIcon /></span>
			</button>

			{open ? (
				<ul
					id={listId}
					className={`appearance-dropdown__list${placement.up ? " appearance-dropdown__list--up" : ""}`}
					style={{ maxHeight: placement.maxHeight }}
					role="listbox"
					aria-label={ariaLabel}
					aria-activedescendant={`${listId}-${active}`}
				>
					{options.map((option, index) => (
						<li
							key={option.value}
							id={`${listId}-${index}`}
							role="option"
							aria-selected={option.value === value}
							className={`appearance-dropdown__option${index === active ? " is-active" : ""}${option.value === value ? " is-selected" : ""}`}
							onMouseEnter={() => setActive(index)}
							onMouseDown={(event) => event.preventDefault()}
							onClick={() => choose(index)}
						>
							{option.preview ? <span className="appearance-dropdown__preview">{option.preview}</span> : null}
							<span className="appearance-dropdown__label">{option.label}</span>
							{option.value === value ? <span className="appearance-dropdown__check"><CheckIcon /></span> : null}
						</li>
					))}
				</ul>
			) : null}
		</div>
	);
}

/* -------------------------------- colour field ------------------------------- */

function ColorField({ id, label, value, onCommit, canReset, onReset }) {
	const [draft, setDraft] = useState(value);
	const [invalid, setInvalid] = useState(false);

	// Follow external changes (theme switch, mode switch, import, reset).
	useEffect(() => {
		setDraft(value);
		setInvalid(false);
	}, [value]);

	const commitDraft = (text) => {
		const hex = normalizeHex(text);
		if (hex) {
			setInvalid(false);
			if (hex !== value) onCommit(hex);
			return true;
		}
		setInvalid(true);
		return false;
	};

	return (
		<div className="appearance-color-wrap">
			{canReset ? (
				<button type="button" className="appearance-icon-button appearance-icon-button--ghost" onClick={onReset} aria-label={`Reset ${label.toLowerCase()} to theme default`} title="Reset to theme default">
					<ResetIcon />
				</button>
			) : null}
			<div className={`appearance-color${invalid ? " is-invalid" : ""}`}>
				<label className="appearance-color__swatch" style={{ background: value }} htmlFor={`${id}-picker`}>
					<span className="appearance-sr-only">Pick {label.toLowerCase()} colour</span>
					<input
						id={`${id}-picker`}
						type="color"
						value={value}
						onChange={(event) => onCommit(event.target.value)}
					/>
				</label>
				<input
					id={id}
					className="appearance-color__hex"
					type="text"
					value={draft}
					spellCheck={false}
					autoComplete="off"
					maxLength={7}
					aria-label={`${label} hex colour`}
					aria-invalid={invalid}
					onChange={(event) => {
						const text = event.target.value;
						setDraft(text);
						// Apply live as soon as the text is a complete, valid colour.
						if (/^#?[0-9a-f]{6}$/i.test(text.trim())) commitDraft(text);
						else setInvalid(false);
					}}
					onBlur={() => {
						if (!commitDraft(draft)) {
							setDraft(value);
							setInvalid(false);
						}
					}}
					onKeyDown={(event) => {
						if (event.key === "Enter") event.currentTarget.blur();
						if (event.key === "Escape") {
							setDraft(value);
							setInvalid(false);
							event.currentTarget.blur();
						}
					}}
				/>
			</div>
		</div>
	);
}

/* ---------------------------------- main card -------------------------------- */

const MODE_LABEL = { system: "System", light: "Light", dark: "Dark" };

function AppearanceSettings({ showToast }) {
	const state = useAppearance();
	const baseId = useId();
	const [copied, setCopied] = useState(false);
	const [notice, setNotice] = useState("");
	const copiedTimer = useRef(null);

	useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

	const resolved = resolveMode(state.mode);
	const palette = getPalette(state, resolved);
	const overrides = state.overrides[resolved] || {};
	const hasAnyChange = state.themeId !== "quantic" || state.mode !== "dark" || Boolean(state.overrides.dark.background) || Boolean(state.overrides.light.background);

	const announce = (message, type = "info") => {
		setNotice(message);
		if (typeof showToast === "function") showToast(message, { type, scope: "settings" });
	};

	const handleCopy = async () => {
		const text = exportTheme(state);
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Fallback for non-secure contexts / denied permission.
			const area = document.createElement("textarea");
			area.value = text;
			area.setAttribute("readonly", "");
			area.style.position = "fixed";
			area.style.opacity = "0";
			document.body.appendChild(area);
			area.select();
			try {
				document.execCommand("copy");
			} catch {
				announce("Couldn't copy the theme.", "error");
				area.remove();
				return;
			}
			area.remove();
		}
		setCopied(true);
		announce("Theme copied to clipboard.", "success");
		window.clearTimeout(copiedTimer.current);
		copiedTimer.current = window.setTimeout(() => setCopied(false), 1800);
	};

	const handleImport = async () => {
		let text = "";
		try {
			text = await navigator.clipboard.readText();
		} catch {
			text = window.prompt("Paste a Quantic theme to import:") || "";
		}

		if (!text.trim()) {
			announce("Nothing to import. Copy a theme first, then try again.", "error");
			return;
		}

		const result = importTheme(text);
		announce(result.ok ? "Theme imported." : result.error, result.ok ? "success" : "error");
	};

	const themeOptions = THEMES.map((item) => {
		const colors = item[resolved];
		return {
			value: item.id,
			label: item.label,
			preview: (
				<span className="appearance-theme-chip" style={{ background: colors.background, color: colors.accent, borderColor: colors.foreground }}>
					Aa
				</span>
			),
		};
	});

	return (
		<section className="settings-card settings-card--appearance" aria-labelledby={`${baseId}-title`}>
			<div className="settings-card__header">
				<div>
					<p className="settings-card__label">Appearance</p>
					<h2 id={`${baseId}-title`}>Visual style</h2>
					{/* <p className="settings-card__subtext">
						Changes apply instantly and are saved on this device. Text colour adjusts automatically to stay readable.
						{state.mode === "system" ? ` Following your system (${MODE_LABEL[resolved].toLowerCase()}).` : ""}
					</p> */}
				</div>
				<button type="button" className="workspace__link-button appearance-reset" onClick={() => { resetAppearance(); announce("Appearance reset to defaults.", "success"); }} disabled={!hasAnyChange}>
					Reset
				</button>
			</div>

			{/* ------------------------------ Mode ------------------------------ */}
			<div className="appearance-panel">
				<div className="appearance-row appearance-row--mode">
					<div className="appearance-row__label" id={`${baseId}-mode`}>Mode</div>
					<div className="appearance-modes" role="radiogroup" aria-labelledby={`${baseId}-mode`}>
						{MODES.map((mode) => (
							<button
								key={mode.id}
								type="button"
								role="radio"
								aria-checked={state.mode === mode.id}
								className={`appearance-mode${state.mode === mode.id ? " is-selected" : ""}`}
								onClick={() => setMode(mode.id)}
								title={mode.id === "system" ? "Match your device setting" : `${mode.label} mode`}
							>
								<ModePreview variant={mode.id} />
								<span className="appearance-mode__caption">{mode.label}</span>
							</button>
						))}
					</div>
				</div>
			</div>

			{/* ------------------------------ Theme ----------------------------- */}
			<div className="appearance-panel">
				<div className="appearance-row">
					<div className="appearance-row__label">Theme</div>
					<div className="appearance-row__controls">
						<button type="button" className="appearance-icon-button" onClick={handleImport} aria-label="Import theme from clipboard" title="Import theme from clipboard">
							<ImportIcon />
						</button>
						<button type="button" className="appearance-icon-button" onClick={handleCopy} aria-label="Copy theme to clipboard" title={copied ? "Copied!" : "Copy theme to clipboard"}>
							{copied ? <CheckIcon /> : <CopyIcon />}
						</button>
						<Dropdown
							value={state.themeId}
							options={themeOptions}
							onChange={setTheme}
							ariaLabel="Theme"
							renderValue={(option) => (
								<>
									{option?.preview}
									<span>{option?.label}</span>
								</>
							)}
						/>
					</div>
				</div>

				<div className="appearance-row">
					<label className="appearance-row__label" htmlFor={`${baseId}-background`}>Background</label>
					<div className="appearance-row__controls">
						<ColorField
							id={`${baseId}-background`}
							label="Background"
							value={palette.background}
							onCommit={(hex) => setBackground(hex)}
							canReset={Boolean(overrides.background)}
							onReset={() => setBackground(null)}
						/>
					</div>
				</div>

			</div>

			<p className="appearance-sr-only" role="status" aria-live="polite">{notice}</p>
		</section>
	);
}

export default AppearanceSettings;