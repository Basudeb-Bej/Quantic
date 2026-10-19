// front-end/src/pages/Admin/AdminSettingsTab.jsx
import { useEffect, useState } from "react";
import { fetchSettings, updateSettings, forceLogoutAllSessions } from "../../services/adminApi";

const CHAT_MODEL_OPTIONS = [
	{ value: "openai/gpt-oss-120b", label: "GPT-OSS 120B (recommended, best quality)" },
	{ value: "openai/gpt-oss-20b", label: "GPT-OSS 20B (fast, lightweight)" },
	{ value: "openai/gpt-oss-safeguard-20b", label: "GPT-OSS Safeguard 20B (extra content safety)" },
	{ value: "qwen/qwen3.6-27b", label: "Qwen 3.6 27B (strongest reasoning)" },
];

const SECTION_LABELS = {
	features: "Feature toggles",
	model: "Model configuration",
	maintenance: "Maintenance mode",
	announcement: "Announcement banner",
	moderation: "Content moderation",
};

const FEATURE_TOGGLE_META = {
	webSearch: {
		label: "Web search",
		description: "Let Quantic look up current information from the web while answering chats.",
	},
	imageGeneration: {
		label: "Image generation",
		description: "Allow users to generate AI images directly inside a conversation.",
	},
	memory: {
		label: "Memory",
		description: "Remember key details across chats so future replies stay personalized.",
	},
	registrationOpen: {
		label: "Open registration",
		description: "Allow new visitors to create accounts and sign up for Quantic.",
	},
};

const humanizeFeatureKey = (key) =>
	String(key || "")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/^./, (char) => char.toUpperCase());

function deepClone(value) {
	return JSON.parse(JSON.stringify(value));
}

// Announcements are stored as { text, url }. Older records may still be plain
// strings, so everything read from the API is normalized to the object shape.
function normalizeAnnouncementMessages(messages) {
	if (!Array.isArray(messages)) return [];
	return messages
		.map((entry) => {
			if (typeof entry === "string") {
				return { text: entry.trim(), url: "" };
			}
			if (entry && typeof entry === "object") {
				return { text: String(entry.text || "").trim(), url: String(entry.url || "").trim() };
			}
			return { text: "", url: "" };
		})
		.filter((entry) => entry.text.length > 0);
}

function normalizeSettings(raw) {
	if (!raw) return raw;
	const announcement = raw.announcement || {};
	return {
		...raw,
		announcement: {
			...announcement,
			messages: normalizeAnnouncementMessages(announcement.messages),
		},
	};
}

// Accepts "example.com/blog", "https://example.com/blog" or an in-app path
// like "/pricing". Returns { url, error } — url is "" when the input is blank.
function normalizeUrlInput(rawValue) {
	const value = String(rawValue || "").trim();
	if (!value) return { url: "", error: "" };

	// "//evil.com" (and the backslash variant browsers treat the same way) looks
	// like an in-app path but navigates off-site. charCodeAt keeps the check free
	// of escape sequences: 47 is "/", 92 is a backslash.
	const protocolRelative =
		value.startsWith("//") || (value.charCodeAt(0) === 47 && value.charCodeAt(1) === 92);
	if (protocolRelative) {
		return { url: "", error: "A link cannot start with // — write https:// for an external site." };
	}

	if (value.startsWith("/")) {
		return { url: value, error: "" };
	}

	const candidate = value.includes("://") ? value : `https://${value}`;

	let parsed;
	try {
		parsed = new URL(candidate);
	} catch (parseError) {
		return { url: "", error: "That does not look like a valid link." };
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		return { url: "", error: "Only http:// and https:// links are allowed." };
	}

	// In "https://accounts.example.com@evil.com/" everything before the @ is
	// just a username — the real host is the part nobody reads.
	if (parsed.username || parsed.password) {
		return { url: "", error: "A link cannot carry a username or password before the @." };
	}

	return { url: parsed.toString(), error: "" };
}

function sectionPayload(settings, sectionKey) {
	if (!settings) return null;
	switch (sectionKey) {
		case "features":
			return { features: settings.features };
		case "model":
			return { model: settings.model };
		case "maintenance":
			return { maintenance: settings.maintenance };
		case "announcement":
			return { announcement: settings.announcement };
		case "moderation":
			return { moderation: settings.moderation };
		default:
			return null;
	}
}

function isSectionDirty(settings, savedSettings, sectionKey) {
	if (!settings || !savedSettings) return false;
	const current = sectionPayload(settings, sectionKey);
	const saved = sectionPayload(savedSettings, sectionKey);
	return JSON.stringify(current) !== JSON.stringify(saved);
}

function AdminSettingsTab() {
	const [settings, setSettings] = useState(null);
	const [savedSettings, setSavedSettings] = useState(null);
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const [toast, setToast] = useState(null);
	const [bannedWordDraft, setBannedWordDraft] = useState("");
	const [announcementDraft, setAnnouncementDraft] = useState("");
	const [announcementUrlDraft, setAnnouncementUrlDraft] = useState("");
	const [announcementError, setAnnouncementError] = useState("");
	const [forceLogoutOpen, setForceLogoutOpen] = useState(false);
	const [forceLogoutPending, setForceLogoutPending] = useState(false);
	const [forceLogoutMessage, setForceLogoutMessage] = useState("");

	// Per-section save modal: { sectionKey: string } | null
	const [saveModal, setSaveModal] = useState(null);

	useEffect(() => {
		fetchSettings()
			.then((result) => {
				const next = normalizeSettings(result.settings);
				setSettings(next);
				setSavedSettings(deepClone(next));
			})
			.catch((err) => setError(err?.message || "Failed to load settings."))
			.finally(() => setLoading(false));
	}, []);

	useEffect(() => {
		if (!toast) return undefined;
		const timer = window.setTimeout(() => setToast(null), 3200);
		return () => window.clearTimeout(timer);
	}, [toast]);

	const showToast = (message, type = "success") => {
		setToast({ message, type });
	};

	const openSaveModal = (sectionKey, { force = false } = {}) => {
		if (!force && !isSectionDirty(settings, savedSettings, sectionKey)) {
			return;
		}
		setError("");
		setSaveModal({ sectionKey });
	};

	const closeSaveModal = () => {
		if (saving) return;
		setSaveModal(null);
	};

	const revertSection = (sectionKey) => {
		if (!savedSettings) return;
		setSettings((current) => {
			if (!current) return current;
			const restored = deepClone(savedSettings);
			switch (sectionKey) {
				case "features":
					return { ...current, features: restored.features };
				case "model":
					return { ...current, model: restored.model };
				case "maintenance":
					return { ...current, maintenance: restored.maintenance };
				case "announcement":
					return { ...current, announcement: restored.announcement };
				case "moderation":
					return { ...current, moderation: restored.moderation };
				default:
					return current;
			}
		});
	};

	const handleCancelSaveSection = () => {
		if (saving || !saveModal?.sectionKey) return;
		revertSection(saveModal.sectionKey);
		if (saveModal.sectionKey === "announcement") {
			setAnnouncementError("");
		}
		setSaveModal(null);
	};

	const handleConfirmSaveSection = async () => {
		if (!saveModal?.sectionKey || !settings) return;

		const sectionKey = saveModal.sectionKey;
		const payload = sectionPayload(settings, sectionKey);
		if (!payload) return;

		setSaving(true);
		setError("");

		try {
			const result = await updateSettings(payload);
			const next = normalizeSettings(result.settings);
			setSettings(next);
			setSavedSettings(deepClone(next));
			setSaveModal(null);
			showToast(`${SECTION_LABELS[sectionKey]} saved.`);
		} catch (err) {
			setError(err?.message || "Failed to save settings.");
		} finally {
			setSaving(false);
		}
	};

	// --- Feature toggles: toggle opens modal ---
	const handleFeatureToggle = (key) => {
		setSettings((current) => ({
			...current,
			features: { ...current.features, [key]: !current.features[key] },
		}));
		openSaveModal("features", { force: true });
	};

	// --- Model: local edits only; save via header button ---
	const handleModelChange = (key, value) => {
		setSettings((current) => ({
			...current,
			model: { ...current.model, [key]: value },
		}));
	};

	// --- Maintenance ---
	const handleMaintenanceToggle = () => {
		setSettings((current) => ({
			...current,
			maintenance: { ...current.maintenance, enabled: !current.maintenance.enabled },
		}));
		openSaveModal("maintenance", { force: true });
	};

	const handleMaintenanceMessageChange = (value) => {
		setSettings((current) => ({
			...current,
			maintenance: { ...current.maintenance, message: value },
		}));
	};

	const handleMaintenanceMessageBlur = () => {
		// Use functional check against latest state after onChange
		setSettings((current) => {
			if (isSectionDirty(current, savedSettings, "maintenance")) {
				setError("");
				setSaveModal({ sectionKey: "maintenance" });
			}
			return current;
		});
	};

	// --- Announcement ---
	const handleAnnouncementToggle = () => {
		setSettings((current) => ({
			...current,
			announcement: { ...current.announcement, enabled: !current.announcement.enabled },
		}));
		openSaveModal("announcement", { force: true });
	};

	const handleAddAnnouncement = () => {
		const text = announcementDraft.trim();
		if (!text) {
			setAnnouncementError("Add a message before saving the announcement.");
			return;
		}

		const { url, error: urlError } = normalizeUrlInput(announcementUrlDraft);
		if (urlError) {
			setAnnouncementError(urlError);
			return;
		}

		const existing = settings?.announcement?.messages || [];
		const duplicate = existing.some((entry) => entry.text === text && (entry.url || "") === url);
		if (duplicate) {
			setAnnouncementError("That announcement is already in the list.");
			return;
		}

		setSettings((current) => ({
			...current,
			announcement: {
				...current.announcement,
				messages: [...(current.announcement.messages || []), { text, url }],
			},
		}));
		setAnnouncementDraft("");
		setAnnouncementUrlDraft("");
		setAnnouncementError("");
		openSaveModal("announcement", { force: true });
	};

	const handleRemoveAnnouncement = (index) => {
		setSettings((current) => ({
			...current,
			announcement: {
				...current.announcement,
				messages: (current.announcement.messages || []).filter((_, itemIndex) => itemIndex !== index),
			},
		}));
		setAnnouncementError("");
		openSaveModal("announcement", { force: true });
	};

	const handleAnnouncementKeyDown = (event) => {
		if (event.key === "Enter") {
			event.preventDefault();
			handleAddAnnouncement();
		}
	};

	// --- Moderation ---
	const handleModerationToggle = () => {
		setSettings((current) => ({
			...current,
			moderation: { ...current.moderation, enabled: !current.moderation.enabled },
		}));
		openSaveModal("moderation", { force: true });
	};

	const handleAddBannedWord = () => {
		const word = bannedWordDraft.trim().toLowerCase();
		if (!word) return;

		setSettings((current) => {
			if (current.moderation.bannedWords.includes(word)) {
				return current;
			}
			return {
				...current,
				moderation: {
					...current.moderation,
					bannedWords: [...current.moderation.bannedWords, word],
				},
			};
		});
		setBannedWordDraft("");
		openSaveModal("moderation", { force: true });
	};

	const handleRemoveBannedWord = (word) => {
		setSettings((current) => ({
			...current,
			moderation: {
				...current.moderation,
				bannedWords: current.moderation.bannedWords.filter((entry) => entry !== word),
			},
		}));
		openSaveModal("moderation", { force: true });
	};

	const handleForceLogout = async () => {
		setForceLogoutPending(true);
		setForceLogoutMessage("");

		try {
			const result = await forceLogoutAllSessions();
			setForceLogoutMessage(result?.message || "All sessions revoked.");
			setForceLogoutOpen(false);
			showToast(result?.message || "All sessions revoked.");
		} catch (err) {
			setForceLogoutMessage(err?.message || "Failed to revoke sessions.");
		} finally {
			setForceLogoutPending(false);
		}
	};

	const renderModelSaveButton = () => {
		const dirty = isSectionDirty(settings, savedSettings, "model");
		return (
			<button
				type="button"
				className="admin-settings__section-save"
				onClick={() => openSaveModal("model")}
				disabled={!dirty || saving}
			>
				{dirty ? "Save changes" : "Saved"}
			</button>
		);
	};

	if (loading) return <p>Loading settings...</p>;
	if (error && !settings) return <p className="admin-error">{error}</p>;
	if (!settings) return null;

	const modalSectionLabel = saveModal ? SECTION_LABELS[saveModal.sectionKey] : "";
	const announcementMessages = settings.announcement.messages || [];

	return (
		<div className="admin-settings">
			{/* <h2>System settings</h2> */}

			<section className="admin-settings__section">
				<div className="admin-settings__section-header">
					<h3>Feature toggles</h3>
				</div>
				{Object.entries(settings.features).map(([key, value]) => {
					const meta = FEATURE_TOGGLE_META[key];
					return (
						<label key={key} className="admin-settings__toggle">
							<span className="admin-settings__toggle-copy">
								<strong className="admin-settings__toggle-title">{meta?.label || humanizeFeatureKey(key)}</strong>
								<small className="admin-settings__toggle-description">
									{meta?.description || "Toggle this feature on or off for all users."}
								</small>
							</span>
							<input type="checkbox" checked={Boolean(value)} onChange={() => handleFeatureToggle(key)} />
						</label>
					);
				})}
			</section>

			<section className="admin-settings__section">
				<div className="admin-settings__section-header">
					<h3>Announcement banner</h3>
				</div>
				<p className="admin-settings__hint">
					Add one or more short messages to broadcast to every user. Each appears as its own bullet in the banner. Give a
					message a link and the whole bullet becomes clickable.
				</p>
				<label className="admin-settings__toggle">
					<span>Show announcement banner</span>
					<input type="checkbox" checked={settings.announcement.enabled} onChange={handleAnnouncementToggle} />
				</label>
				<div className="admin-settings__announcement-form">
					<input
						type="text"
						className="admin-settings__announcement-input"
						value={announcementDraft}
						placeholder="Announcement message"
						maxLength={300}
						onChange={(event) => {
							setAnnouncementDraft(event.target.value);
							if (announcementError) setAnnouncementError("");
						}}
						onKeyDown={handleAnnouncementKeyDown}
					/>
					<div className="admin-settings__announcement-form-row">
						<input
							type="text"
							className="admin-settings__announcement-input admin-settings__announcement-input--url"
							value={announcementUrlDraft}
							placeholder="https://example.com/changelog"
							maxLength={500}
							onChange={(event) => {
								setAnnouncementUrlDraft(event.target.value);
								if (announcementError) setAnnouncementError("");
							}}
							onKeyDown={handleAnnouncementKeyDown}
						/>
						<button type="button" onClick={handleAddAnnouncement}>
							Add
						</button>
					</div>
					{/* {announcementError ? (
						<small className="admin-settings__field-error">{announcementError}</small>
					) : (
						<small className="admin-settings__hint admin-settings__hint--tight">
							Leave the link blank for a plain message. https:// is added for you, and /paths stay in-app.
						</small>
					)} */}
				</div>
				{announcementMessages.length ? (
					<ul className="admin-settings__banner-list">
						{announcementMessages.map((entry, index) => (
							<li key={`${entry.text}-${entry.url}-${index}`} className="admin-settings__banner-list-item">
								<span className="admin-settings__banner-bullet">•</span>
								<span className="admin-settings__banner-list-body">
									<span className="admin-settings__banner-list-text">{entry.text}</span>
									{entry.url ? (
										<a
											className="admin-settings__banner-list-link"
											href={entry.url}
											target="_blank"
											rel="noopener noreferrer"
											title={entry.url}
										>
											<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
												<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5" />
												<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5" />
											</svg>
											<span className="admin-settings__banner-list-link-text">{entry.url}</span>
										</a>
									) : null}
								</span>
								<button
									type="button"
									className="admin-settings__banner-list-remove"
									onClick={() => handleRemoveAnnouncement(index)}
									aria-label={`Remove announcement: ${entry.text}`}
								>
									×
								</button>
							</li>
						))}
					</ul>
				) : (
					<span className="admin-settings__hint">No announcements yet.</span>
				)}
			</section>

			<section className="admin-settings__section">
				<div className="admin-settings__section-header">
					<h3>Maintenance mode</h3>
				</div>
				<p className="admin-settings__hint">
					When enabled, only admins can chat. Everyone else sees the message below instead of a response.
				</p>
				<label className="admin-settings__toggle">
					<span>Enable maintenance mode</span>
					<input type="checkbox" checked={settings.maintenance.enabled} onChange={handleMaintenanceToggle} />
				</label>
				<label className="admin-settings__field">
					<span>Message shown to blocked users</span>
					<textarea
						className="admin-settings__textarea"
						value={settings.maintenance.message}
						maxLength={500}
						rows={3}
						onChange={(event) => handleMaintenanceMessageChange(event.target.value)}
						onBlur={handleMaintenanceMessageBlur}
					/>
				</label>
			</section>

			<section className="admin-settings__section">
				<div className="admin-settings__section-header">
					<h3>Model configuration</h3>
					{renderModelSaveButton()}
				</div>
				<label className="admin-settings__field">
					<span>Chat model</span>
					<select
						className="admin-settings__select"
						value={settings.model.chatModel || ""}
						onChange={(event) => handleModelChange("chatModel", event.target.value)}
					>
						{!CHAT_MODEL_OPTIONS.some((opt) => opt.value === settings.model.chatModel) && settings.model.chatModel ? (
							<option value={settings.model.chatModel}>{settings.model.chatModel} (current)</option>
						) : null}
						{CHAT_MODEL_OPTIONS.map((opt) => (
							<option key={opt.value} value={opt.value}>
								{opt.label}
							</option>
						))}
					</select>
				</label>
				<label className="admin-settings__field">
					<span>Max tokens</span>
					<input
						type="number"
						value={settings.model.maxTokens}
						onChange={(event) => handleModelChange("maxTokens", Number(event.target.value))}
					/>
				</label>
			</section>

			<section className="admin-settings__section">
				<div className="admin-settings__section-header">
					<h3>Content moderation</h3>
				</div>
				<p className="admin-settings__hint">
					Messages containing any word below are rejected before reaching the model.
				</p>
				<label className="admin-settings__toggle">
					<span>Enable banned word filter</span>
					<input type="checkbox" checked={settings.moderation.enabled} onChange={handleModerationToggle} />
				</label>
				<div className="admin-settings__chip-input">
					<input
						type="text"
						value={bannedWordDraft}
						placeholder="Add a word or phrase"
						onChange={(event) => setBannedWordDraft(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								handleAddBannedWord();
							}
						}}
					/>
					<button type="button" onClick={handleAddBannedWord}>
						Add
					</button>
				</div>
				<div className="admin-settings__chips">
					{settings.moderation.bannedWords.length === 0 ? (
						<span className="admin-settings__hint">No banned words yet.</span>
					) : (
						settings.moderation.bannedWords.map((word) => (
							<span key={word} className="admin-settings__chip">
								{word}
								<button type="button" onClick={() => handleRemoveBannedWord(word)} aria-label={`Remove ${word}`}>
									×
								</button>
							</span>
						))
					)}
				</div>
			</section>

			{error ? <p className="admin-error">{error}</p> : null}

			<section className="admin-settings__section admin-settings__section--danger">
				<h3>Security</h3>
				<p className="admin-settings__hint">
					Immediately signs out every user, including admin's, from every device. Use this if you suspect a compromised
					session.
				</p>
				<button type="button" className="admin-settings__danger-button" onClick={() => setForceLogoutOpen(true)}>
					Force logout all sessions
				</button>
				{forceLogoutMessage ? <p className="admin-settings__hint">{forceLogoutMessage}</p> : null}
			</section>

			{saveModal ? (
				<div className="admin-dialog-backdrop" role="presentation" onClick={handleCancelSaveSection}>
					<div
						className="admin-dialog"
						role="dialog"
						aria-modal="true"
						aria-labelledby="admin-settings-save-title"
						onClick={(event) => event.stopPropagation()}
					>
						<h3 id="admin-settings-save-title" className="admin-dialog__title">
							Save {modalSectionLabel}?
						</h3>
						<p className="admin-dialog__description">
							This will apply your changes to <strong>{modalSectionLabel}</strong> for all users. Other sections are not
							affected.
						</p>
						<div className="admin-dialog__actions">
							<button type="button" className="admin-dialog__cancel" onClick={handleCancelSaveSection} disabled={saving}>
								Cancel
							</button>
							<button
								type="button"
								className="admin-dialog__confirm"
								onClick={handleConfirmSaveSection}
								disabled={saving}
							>
								{saving ? "Saving..." : "Save"}
							</button>
						</div>
					</div>
				</div>
			) : null}

			{forceLogoutOpen ? (
				<div className="admin-dialog-backdrop" role="presentation" onClick={() => setForceLogoutOpen(false)}>
					<div className="admin-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
						<h3 className="admin-dialog__title">Force logout everyone?</h3>
						<p className="admin-dialog__description">
							This revokes every active login token right now, including your own. Everyone will need to sign in again.
						</p>
						<div className="admin-dialog__actions">
							<button
								type="button"
								className="admin-dialog__cancel"
								onClick={() => setForceLogoutOpen(false)}
								disabled={forceLogoutPending}
							>
								Cancel
							</button>
							<button
								type="button"
								className="admin-dialog__confirm admin-dialog__confirm--danger"
								onClick={handleForceLogout}
								disabled={forceLogoutPending}
							>
								{forceLogoutPending ? "Working..." : "Force logout"}
							</button>
						</div>
					</div>
				</div>
			) : null}

			{/* Bottom-right toast for save success */}
			{toast ? (
				<div className={`admin-toast ${toast.type === "danger" ? "admin-toast--danger" : ""}`} role="status">
					{toast.message}
				</div>
			) : null}
		</div>
	);
}

export default AdminSettingsTab;