//front-end/src/pages/User/ChatPage.jsx
import { Fragment, useEffect, useRef, useState } from "react";
import {
    AttachFileIcon,
    CachedIcon,
    ContentCopyIcon,
    EditIcon,
    SendIcon,
    VolumeUpIcon,
} from "../../components/GoogleIcons";
import LoginModals from "../../components/LoginModals";
import Navbar from "../../components/Navbar";
import SideBar from "../../components/SideBar";
import SettingsPage from "./Settings";
import {
    createLightningOrb,
    createMicLevelMeter,
    getInitialVoiceLanguage,
    getVoiceLanguageOptions,
    joinVoiceTranscript,
    rememberVoiceLanguage,
    speakWithAI,
    cancelSpeechSynthesis,
} from "../../services/voiceService";
import { useToasts } from "../../hooks/useToasts";

const apiBaseUrl = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/+$/, "");
const activeViewStorageKey = "quantic_active_view";
const sidebarOpenStorageKey = "quantic_sidebar_open";
const authKnownStorageKey = "quantic_auth_known";
const authProfileStorageKey = "quantic_auth_profile";
const chatHistoryStoragePrefix = "quantic_chat_history";

// Voice conversation: how long to wait in silence before the spoken message is sent.
// A short pause between two sentences must NOT send (or cut) the message, so the wait restarts
// every time a new word is heard.
const VOICE_SEND_AFTER_FINAL_MS = 1400;
const VOICE_SEND_AFTER_INTERIM_MS = 2200;

const getChatHistoryStorageKey = (userId) => `${chatHistoryStoragePrefix}_${String(userId ?? "guest").trim() || "guest"}`;

const guestChatHistoryStorageKey = getChatHistoryStorageKey("guest");

// Anonymous browser id, sent with chat requests so the backend can apply the guest image limit.
const guestDeviceIdStorageKey = "quantic_guest_device_id";
const getGuestDeviceId = () => {
    try {
        let id = localStorage.getItem(guestDeviceIdStorageKey);
        if (!id) {
            id = window.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
            localStorage.setItem(guestDeviceIdStorageKey, id);
        }
        return id;
    } catch {
        return "";
    }
};

const normalizeThreadSummary = (thread) => ({
    id: String(thread?.id || thread?._id || "").trim(),
    title: String(thread?.title || "New chat").trim() || "New chat",
    preview: String(thread?.preview || "").trim(),
    pinned: Boolean(thread?.pinned || thread?.isPinned),
    lastMessageAt: thread?.lastMessageAt || thread?.updatedAt || thread?.createdAt || null,
    createdAt: thread?.createdAt || null,
    updatedAt: thread?.updatedAt || null,
    messageCount: Number(thread?.messageCount || 0),
});

const normalizeMessageAttachment = (attachment) => {
    const key = String(attachment?.key || "").trim();
    const name = String(attachment?.name || "").trim();
    const dataUrl = String(attachment?.dataUrl || "").trim();

    // Only return valid attachments with all required fields
    if (!key || !name || !dataUrl) {
        return null;
    }

    return {
        key,
        name,
        size: Number.isFinite(Number(attachment?.size)) ? Number(attachment?.size) : 0,
        type: String(attachment?.type || "").trim(),
        dataUrl,
    };
};

const extractLegacyImageAttachment = (content) => {
    const normalizedContent = String(content || "").trim();

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

const normalizeMessageAttachments = (attachments) => {
    if (!Array.isArray(attachments)) {
        return [];
    }

    return attachments
        .map(normalizeMessageAttachment)
        .filter((attachment) => attachment !== null && attachment !== undefined);
};

const normalizeMessageRecord = (entry) => ({
    role: String(entry?.role || "").trim(),
    content: (() => {
        const normalizedContent = String(entry?.content || "").trim();
        return extractLegacyImageAttachment(normalizedContent) ? "" : normalizedContent;
    })(),
    status: String(entry?.status || "").trim() || undefined,
    attachments: (() => {
        const normalizedAttachments = normalizeMessageAttachments(entry?.attachments);
        if (normalizedAttachments.length > 0) {
            return normalizedAttachments;
        }

        const legacyImageAttachment = extractLegacyImageAttachment(entry?.content);
        return legacyImageAttachment ? [legacyImageAttachment] : [];
    })(),
});

const normalizeThreadMessages = (messages) => {
    if (!Array.isArray(messages)) {
        return [];
    }

    return messages
        .map(normalizeMessageRecord)
        .filter((entry) => entry.role && (entry.content || entry.attachments.length));
};

const parseTimelineDate = (value) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const startOfDay = (date) => {
    const copy = new Date(date);
    copy.setHours(0, 0, 0, 0);
    return copy;
};

const groupChatThreads = (threads) => {
    const now = new Date();
    const today = startOfDay(now);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const sortedThreads = [...threads]
        .map(normalizeThreadSummary)
        .filter((thread) => thread.id)
        .sort((left, right) => {
            if (left.pinned !== right.pinned) {
                return Number(right.pinned) - Number(left.pinned);
            }

            return new Date(right.lastMessageAt || 0) - new Date(left.lastMessageAt || 0);
        });

    const groups = [
        { label: "Today", items: [] },
        { label: "Yesterday", items: [] },
        { label: "Earlier", items: [] },
    ];

    for (const thread of sortedThreads) {
        const date = parseTimelineDate(thread.lastMessageAt || thread.updatedAt || thread.createdAt);

        if (!date) {
            groups[2].items.push(thread);
            continue;
        }

        const day = startOfDay(date).getTime();

        if (day === today.getTime()) {
            groups[0].items.push(thread);
            continue;
        }

        if (day === yesterday.getTime()) {
            groups[1].items.push(thread);
            continue;
        }

        groups[2].items.push(thread);
    }

    return groups.filter((group) => group.items.length > 0);
};

const readStoredBoolean = (key, fallback) => {
    if (typeof window === "undefined") {
        return fallback;
    }

    const storedValue = sessionStorage.getItem(key);
    if (storedValue === null) {
        return fallback;
    }

    return storedValue === "true";
};

const isMobileViewport = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 900px)").matches;

const getDefaultSidebarOpenState = () => !isMobileViewport();

const readStoredJson = (key, fallback) => {
    if (typeof window === "undefined") {
        return fallback;
    }

    const storedValue = sessionStorage.getItem(key);
    if (!storedValue) {
        return fallback;
    }

    try {
        return JSON.parse(storedValue);
    } catch {
        return fallback;
    }
};

const readStoredMessages = (key) => {
    if (typeof window === "undefined") {
        return [];
    }

    const storedValue = localStorage.getItem(key);
    if (!storedValue) {
        return [];
    }

    try {
        const parsed = JSON.parse(storedValue);
        return Array.isArray(parsed)
            ? parsed
                .map(normalizeMessageRecord)
                .filter((entry) => entry.role && (entry.content || entry.attachments.length))
            : [];
    } catch {
        return [];
    }
};

const writeStoredMessages = (key, value) => {
    if (typeof window === "undefined") {
        return;
    }

    if (!Array.isArray(value) || value.length === 0) {
        localStorage.removeItem(key);
        return;
    }

    localStorage.setItem(key, JSON.stringify(value));
};

const readStoredAttachments = (key) => {
    if (typeof window === "undefined") {
        return [];
    }

    const storedValue = localStorage.getItem(key);
    if (!storedValue) {
        return [];
    }

    try {
        const parsed = JSON.parse(storedValue);
        return Array.isArray(parsed) ? normalizeMessageAttachments(parsed) : [];
    } catch {
        return [];
    }
};

const writeStoredAttachments = (key, value) => {
    if (typeof window === "undefined") {
        return;
    }

    const attachments = normalizeMessageAttachments(value);

    if (attachments.length === 0) {
        localStorage.removeItem(key);
        return;
    }

    try {
        localStorage.setItem(key, JSON.stringify(attachments));
    } catch (error) {
        // Draft attachment persistence is best-effort: large base64 files can exceed
        // the browser's small localStorage quota. Never let this break the chat UI.
        if (error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED") {
            try {
                if (typeof window !== "undefined") {
                    window.dispatchEvent(new CustomEvent("quantic:storage-quota-exceeded", {
                        detail: { key, kind: "draft-attachments" },
                    }));
                }
            } catch {
                // Notification failure must not affect chat functionality.
            }
            return false;
        }
        console.error("[ChatPage] Could not persist draft attachments.", error);
        return false;
    }
    return true;
};

const readStoredString = (key, fallback = "") => {
    if (typeof window === "undefined") {
        return fallback;
    }

    const storedValue = localStorage.getItem(key);
    return storedValue && storedValue.trim() ? storedValue : fallback;
};

const writeStoredString = (key, value) => {
    if (typeof window === "undefined") {
        return;
    }

    const normalizedValue = String(value ?? "").trim();
    if (!normalizedValue) {
        localStorage.removeItem(key);
        return;
    }

    localStorage.setItem(key, normalizedValue);
};

const getDraftAttachmentsStorageKey = (userId, threadId) => {
    const normalizedUserId = String(userId ?? "guest").trim() || "guest";
    const normalizedThreadId = String(threadId ?? "new").trim() || "new";
    return `${chatHistoryStoragePrefix}_draft_attachments_${normalizedUserId}_${normalizedThreadId}`;
};

const TEXTAREA_MAX_HEIGHT_PX = 200;

const autoResizeTextarea = (node) => {
    if (!node) {
        return;
    }

    node.style.height = "auto";
    node.style.height = `${Math.min(node.scrollHeight, TEXTAREA_MAX_HEIGHT_PX)}px`;
};

const PASTE_TEXT_BLOCK_MIN_LENGTH = 400;
const PASTE_TEXT_BLOCK_MIN_LINES = 8;

const buildPastedTextPreview = (text) => {
    const normalized = String(text || "");
    const firstLine = normalized.split(/\r?\n/, 1)[0] || "";
    return firstLine.slice(0, 60) || "Pasted Text";
};

const encodeTextAsDataUrl = (text) => {
    try {
        return `data:text/plain;base64,${btoa(unescape(encodeURIComponent(String(text || ""))))}`;
    } catch {
        return "";
    }
};

const decodeTextDataUrl = (dataUrl) => {
    const match = String(dataUrl || "").match(/^data:text\/plain;base64,(.+)$/i);
    if (!match?.[1]) {
        return "";
    }
    try {
        return decodeURIComponent(escape(atob(match[1])));
    } catch {
        return "";
    }
};

const isPastedTextAttachment = (attachment) =>
    String(attachment?.type || "").toLowerCase() === "text/plain" &&
    String(attachment?.dataUrl || "").startsWith("data:text/plain;base64,");

const readFileAsDataUrl = (file) =>
    new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(reader.error || new Error("Unable to read attachment."));
        reader.readAsDataURL(file);
    });

const readJsonResponse = async (response) => {
    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
        return null;
    }

    try {
        return await response.json();
    } catch {
        return null;
    }
};

const getLegalCopySegments = (isLoggedIn) =>
    isLoggedIn
        ? [
            "Quantic can make mistakes. Check important info. See ",
            { text: "Cookie Preferences", id: "cookie-preferences" },
            ".",
        ]
        : [
            "By messaging Quantic, an AI chatbot, you agree to our ",
            { text: "Terms", id: "terms" },
            " and have read our ",
            { text: "Privacy Policy", id: "privacy-policy" },
            ". See ",
            { text: "Cookie Preferences", id: "cookie-preferences" },
            ".",
        ];

const legalPages = {
    terms: {
        title: "Terms",
        intro: [
            "These terms explain how you can use Quantic and what we expect from people using the app.",
        ],
        sections: [
            {
                heading: "Acceptable use",
                points: [
                    "Use the app for lawful purposes only.",
                    "Do not send harmful, abusive, deceptive, or illegal content.",
                    "Do not attempt to disrupt the service, bypass access controls, or abuse rate limits.",
                ],
            },
            {
                heading: "Account responsibility",
                points: [
                    "Keep your login details secure.",
                    "You are responsible for activity performed under your account.",
                    "Tell us if you suspect unauthorized access.",
                ],
            },
            {
                heading: "Service changes",
                points: [
                    "We may change, suspend, or improve features over time.",
                    "We may update these terms when the product or legal requirements change.",
                ],
            },
        ],
    },
    "privacy-policy": {
        title: "Privacy Policy",
        intro: [
            "This summary explains what data Quantic stores and why it is used.",
        ],
        sections: [
            {
                heading: "Information we store",
                points: [
                    "Account details you provide during registration or profile updates.",
                    "Session and UI preferences such as the active view and sidebar state.",
                    "Chat settings that help keep your experience consistent across visits.",
                ],
            },
            {
                heading: "How we use it",
                points: [
                    "To authenticate you and keep you signed in securely.",
                    "To restore your saved preferences and profile settings.",
                    "To operate the chat experience and improve the product.",
                ],
            },
            {
                heading: "Your control",
                points: [
                    "You can clear browser storage to remove local preferences.",
                    "You can log out to end the current authenticated session.",
                ],
            },
        ],
    },
    "cookie-preferences": {
        title: "Cookie Preferences",
        intro: [
            "Quantic uses browser storage for essential functionality and convenience preferences.",
        ],
        sections: [
            {
                heading: "Essential storage",
                points: [
                    "Keeps the current session state and login flow working.",
                    "Remembers the sidebar and active view settings.",
                ],
            },
            {
                heading: "Preference storage",
                points: [
                    "Stores selected profile preferences such as avatar and motion settings.",
                    "Helps the app restore your layout the next time you visit.",
                ],
            },
            {
                heading: "Manage locally",
                points: [
                    "Use your browser settings to clear site data if you want a fresh start.",
                    "Logging out removes the current session state from this device.",
                ],
            },
        ],
    },
};

const starterPrompts = [
    "Explain this codebase like I’m joining the project today.",
    "Draft a short project update for my team.",
    "Give me three ways to improve this chat UI.",
    "Summarize the benefits of a custom RAG pipeline.",
];

function CloseIcon() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M6 6l12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
    );
}

function CheckIcon() {
    return (
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M5 13l4 4L19 7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function SendingIcon() {
    return (
        <svg className="chat-composer__sending-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth="2" strokeOpacity="0.28" />
            <path d="M12 4a8 8 0 0 1 8 8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
    );
}

function AttachmentPreview({ attachment, variant = "composer", onRemove, onImageClick, onPastedTextClick }) {
    const isImage = String(attachment?.type || "").toLowerCase().startsWith("image/") && String(attachment?.dataUrl || "").startsWith("data:");
    const name = String(attachment?.name || "Attachment").trim() || "Attachment";

    if (variant === "message") {
        if (isPastedTextAttachment(attachment)) {
            const decoded = decodeTextDataUrl(attachment.dataUrl);
            const previewLines = decoded.split(/\r?\n/).slice(0, 4);

            return (
                <button
                    type="button"
                    className="chat-transcript__attachment-tile chat-transcript__attachment-tile--pasted"
                    onClick={() => onPastedTextClick?.({ name: attachment.name || "Pasted Text", content: decoded })}
                    aria-label="View full pasted text"
                    title="Click to view full pasted text"
                >
                    <div className="chat-transcript__attachment-tile-preview chat-transcript__attachment-tile-preview--text">
                        {previewLines.map((line, index) => (
                            <div key={`${attachment.key}-line-${index}`} className="chat-transcript__pasted-chip-line">
                                {line || "\u00A0"}
                            </div>
                        ))}
                    </div>
                    <div className="chat-transcript__attachment-tile-footer">
                        <span className="chat-transcript__pasted-chip-badge">PASTED</span>
                    </div>
                </button>
            );
        }

        if (isImage) {
            const isGenerated = name === "Generated image" || String(attachment?.key || "").startsWith("legacy-image-");
            return (
                <button
                    type="button"
                    className={`chat-transcript__attachment-tile chat-transcript__attachment-tile--image${isGenerated ? " chat-transcript__attachment-tile--generated" : ""}`}
                    onClick={() => onImageClick?.(attachment)}
                    aria-label={`View ${name}`}
                    title="Click to view full size"
                >
                    <img className="chat-transcript__attachment-thumb" src={attachment.dataUrl} alt={name} loading="lazy" />
                </button>
            );
        }

        return (
            <div className="chat-transcript__attachment-tile">
                <div className="chat-transcript__attachment-tile-preview">
                    <span className="chat-transcript__attachment-icon" aria-hidden="true">
                        {name.slice(0, 1).toUpperCase()}
                    </span>
                </div>
                <div className="chat-transcript__attachment-tile-footer">
                    <span className="chat-transcript__pasted-chip-badge">{name}</span>
                </div>
            </div>
        );
    }

    return (
        <div className="chat-composer__attachment-chip">
            {onRemove ? (
                <button
                    type="button"
                    className="chat-composer__attachment-remove"
                    aria-label={`Remove ${name}`}
                    onClick={() => onRemove(attachment.key)}
                >
                    ×
                </button>
            ) : null}
            <div className="chat-composer__attachment-preview">
                {isImage ? (
                    <img className="chat-composer__attachment-thumb" src={attachment.dataUrl} alt="" aria-hidden="true" loading="lazy" />
                ) : (
                    <span className="chat-composer__attachment-icon" aria-hidden="true">
                        {name.slice(0, 1).toUpperCase()}
                    </span>
                )}
            </div>
            <div className="chat-composer__attachment-footer">
                <span className="chat-composer__attachment-name">{name}</span>
            </div>
        </div>
    );
}

function PastedTextChip({ block, onRemove, onPreview }) {
    const lines = String(block?.content || "").split(/\r?\n/);
    const previewLines = lines.slice(0, 4);

    return (
        <div className="chat-composer__attachment-chip">
            {onRemove ? (
                <button
                    type="button"
                    className="chat-composer__attachment-remove"
                    aria-label="Remove pasted content"
                    onClick={() => onRemove(block.key)}
                >
                    ×
                </button>
            ) : null}
            <button
                type="button"
                className="chat-composer__attachment-preview chat-composer__attachment-preview--text chat-composer__attachment-preview--clickable"
                onClick={() => onPreview?.({ name: "Pasted Text", content: block?.content || "" })}
                aria-label="View full pasted text"
                title="Click to view full pasted text"
            >
                {previewLines.map((line, index) => (
                    <div key={`${block.key}-line-${index}`} className="chat-composer__pasted-chip-line">
                        {line || "\u00A0"}
                    </div>
                ))}
            </button>
            <div className="chat-composer__attachment-footer">
                <span className="chat-composer__attachment-name">Pasted Text</span>
            </div>
        </div>
    );
}

const normalizeStrayLatexArtifacts = (content) =>
    String(content ?? "")
        .replace(/\\begin\{cases\}([\s\S]*?)\\end\{cases\}/g, (match, inner) =>
            inner
                .split("\\\\")
                .map((row) => row.trim())
                .filter(Boolean)
                .join("\n")
        )
        .replace(/\\Leftrightarrow/g, "⇔")
        .replace(/\\Rightarrow/g, "⇒")
        .replace(/\\Leftarrow/g, "⇐")
        .replace(/\\leftrightarrow/g, "↔")
        .replace(/\\rightarrow/g, "→")
        .replace(/\\leftarrow/g, "←")
        .replace(/\\qquad/g, "    ")
        .replace(/\\quad/g, "  ")
        .replace(/\\[,;]/g, " ")
        .replace(/\\times/g, "×")
        .replace(/\\cdot/g, "·")
        .replace(/\\div/g, "÷")
        .replace(/\\pm/g, "±")
        .replace(/\\leq/g, "≤")
        .replace(/\\geq/g, "≥")
        .replace(/\\text\{([^{}]+)\}/g, "$1")
        .replace(/\\left/g, "")
        .replace(/\\right/g, "");

const normalizeMarkdownContent = (content) =>
    normalizeStrayLatexArtifacts(String(content ?? "").replace(/\r\n/g, "\n"))

        .replace(/\\\[\s*(source\s*\d+)\s*\\\]/gi, "[$1]")

        .replace(/[【\[［「]\s*source\s*(\d+)\s*[】\]］」]/gi, "[Source $1]")

        .replace(/(\[Source\s*\d+\]\s*\(https?:\/\/[^\s)]+\))\s*[】\]］」]/gi, "$1");

// ---------------------------------------------------------------------------
// Trusted citation sources. The server prefixes each web-grounded reply with
// "<!--SRC:[{n,url,title}]-->". Badge links come ONLY from here - never from
// URLs the model typed (those get truncated/invented and 404).
// ---------------------------------------------------------------------------
const SOURCES_MARKER_PATTERN = /^<!--SRC:([\s\S]*?)-->\r?\n?/;
let activeCitationSources = {};

const parseSourcesMarker = (content) => {
    const raw = String(content ?? "");

    // Hide the marker even while its first few characters are still streaming in.
    if (raw && "<!--SRC:".startsWith(raw)) {
        return { text: "", sources: {} };
    }

    if (!raw.startsWith("<!--SRC:")) {
        return { text: raw, sources: {} };
    }

    const match = raw.match(SOURCES_MARKER_PATTERN);

    // Marker still streaming in: show nothing yet instead of flashing JSON.
    if (!match) {
        return { text: "", sources: {} };
    }

    const sources = {};
    try {
        const list = JSON.parse(match[1]);
        for (const entry of Array.isArray(list) ? list : []) {
            if (entry?.n && typeof entry.url === "string") {
                sources[String(entry.n)] = { url: entry.url, title: String(entry.title || "") };
            }
        }
    } catch {
        // malformed marker: render the text without links
    }

    return { text: raw.slice(match[0].length), sources };
};

const stripSourcesMarker = (content) => parseSourcesMarker(content).text;

const renderMarkdownContent = (content) => {
    const { text, sources } = parseSourcesMarker(content);
    const previousSources = activeCitationSources;
    activeCitationSources = sources;

    try {
        return renderMarkdownContentInner(text);
    } finally {
        activeCitationSources = previousSources;
    }
};

const renderMathExpression = (expression, keyPrefix, { display = false } = {}) => {
    const normalizedExpression = String(expression ?? "").trim();
    const boxedMatch = normalizedExpression.match(/^\\boxed\{([\s\S]+)\}$/);

    if (boxedMatch?.[1]) {
        return display ? (
            <div key={`${keyPrefix}-math-box`} className="chat-transcript__math-display chat-transcript__math-display--boxed">
                <span className="chat-transcript__math-box">{normalizeStrayLatexArtifacts(boxedMatch[1])}</span>
            </div>
        ) : (
            <span key={`${keyPrefix}-math-box`} className="chat-transcript__math-box">
                {normalizeStrayLatexArtifacts(boxedMatch[1])}
            </span>
        );
    }

    const mathText = normalizeStrayLatexArtifacts(normalizedExpression);

    return display ? (
        <div key={`${keyPrefix}-math-display`} className="chat-transcript__math-display">
            <span className="chat-transcript__math">{mathText}</span>
        </div>
    ) : (
        <span key={`${keyPrefix}-math-inline`} className="chat-transcript__math">
            {mathText}
        </span>
    );
};

const splitMarkdownTableRow = (line) =>
    String(line ?? "")
        .trim()
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((cell) => cell.trim());

const isMarkdownTableDivider = (line) => {
    const cells = splitMarkdownTableRow(line);
    return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
};

const isHttpUrl = (value) => {
    try {
        const url = new URL(String(value ?? ""));
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
};

// A raw URL must never be printed in full inside a message: Google News RSS
// links alone can be 300+ characters. Show host + a short path, keep the full
// URL in href/title.
const formatDisplayUrl = (value, maxLength = 42) => {
    const raw = String(value ?? "");
    try {
        const url = new URL(raw);
        const host = url.hostname.replace(/^www\./i, "");
        const rest = `${url.pathname}${url.search}`.replace(/^\/$/, "");
        const shown = `${host}${rest}`;
        return shown.length > maxLength ? `${shown.slice(0, maxLength - 1)}…` : shown;
    } catch {
        return raw.length > maxLength ? `${raw.slice(0, maxLength - 1)}…` : raw;
    }
};

const trimTrailingUrlPunctuation = (value) => String(value ?? "").replace(/[),.;:!?]+$/g, "");

// Add a global error handler for links
// const handleLinkClick = (event) => {
//     const target = event.target.closest('a');
//     if (!target) return;

//     if (target.href) {
//         event.preventDefault();
//         try {
//             window.open(target.href, '_blank', 'noopener,noreferrer');
//         } catch (error) {
//             console.error('Failed to open link:', error);
//             // Fallback: try direct navigation
//             try {
//                 window.location.href = target.href;
//             } catch (fallbackError) {
//                 console.error('Failed to navigate:', fallbackError);
//             }
//         }
//     }
// };

const renderInlineMarkdown = (text, keyPrefix) => {
    const normalizedText = String(text ?? "");
    const nodes = [];
    let cursor = 0;
    let segmentStart = 0;
    let matchIndex = 0;

    const flushText = (end) => {
        if (end > segmentStart) {
            nodes.push(normalizedText.slice(segmentStart, end));
        }
    };

    while (cursor < normalizedText.length) {
        // Handle HTML line breaks
        const brMatch = normalizedText.slice(cursor).match(/^<br\s*\/?>/i);
        if (brMatch) {
            flushText(cursor);
            nodes.push(<br key={`${keyPrefix}-br-${matchIndex}`} />);
            matchIndex += 1;
            cursor += brMatch[0].length;
            segmentStart = cursor;
            continue;
        }

        // Handle display math \[ ... \]
        if (normalizedText.startsWith("\\[", cursor)) {
            const end = normalizedText.indexOf("\\]", cursor + 2);
            if (end !== -1) {
                flushText(cursor);
                nodes.push(renderMathExpression(normalizedText.slice(cursor + 2, end), `${keyPrefix}-math-${matchIndex}`, { display: true }));
                matchIndex += 1;
                cursor = end + 2;
                segmentStart = cursor;
                continue;
            }
        }

        // Handle inline math \( ... \)
        if (normalizedText.startsWith("\\(", cursor)) {
            const end = normalizedText.indexOf("\\)", cursor + 2);
            if (end !== -1) {
                flushText(cursor);
                nodes.push(renderMathExpression(normalizedText.slice(cursor + 2, end), `${keyPrefix}-math-${matchIndex}`));
                matchIndex += 1;
                cursor = end + 2;
                segmentStart = cursor;
                continue;
            }
        }

        // Handle display math $$ ... $$
        if (normalizedText.startsWith("$$", cursor)) {
            const end = normalizedText.indexOf("$$", cursor + 2);
            if (end !== -1) {
                flushText(cursor);
                nodes.push(renderMathExpression(normalizedText.slice(cursor + 2, end), `${keyPrefix}-math-${matchIndex}`));
                matchIndex += 1;
                cursor = end + 2;
                segmentStart = cursor;
                continue;
            }
        }

        // Handle inline code
        if (normalizedText[cursor] === "`") {
            const end = normalizedText.indexOf("`", cursor + 1);
            if (end !== -1) {
                flushText(cursor);
                nodes.push(
                    <code key={`${keyPrefix}-code-${matchIndex}`}>{normalizedText.slice(cursor + 1, end)}</code>,
                );
                matchIndex += 1;
                cursor = end + 1;
                segmentStart = cursor;
                continue;
            }
        }

        // Handle bold text
        if (normalizedText.startsWith("**", cursor)) {
            const end = normalizedText.indexOf("**", cursor + 2);
            if (end !== -1) {
                flushText(cursor);
                nodes.push(
                    <strong key={`${keyPrefix}-strong-${matchIndex}`}>{normalizedText.slice(cursor + 2, end)}</strong>,
                );
                matchIndex += 1;
                cursor = end + 2;
                segmentStart = cursor;
                continue;
            }
        }

        // Handle italic text with *
        if (normalizedText[cursor] === "*" && normalizedText[cursor + 1] !== "*") {
            const end = normalizedText.indexOf("*", cursor + 1);
            if (end !== -1 && end > cursor + 1) {
                flushText(cursor);
                nodes.push(
                    <em key={`${keyPrefix}-em-${matchIndex}`}>{normalizedText.slice(cursor + 1, end)}</em>,
                );
                matchIndex += 1;
                cursor = end + 1;
                segmentStart = cursor;
                continue;
            }
        }

        // Handle italic text with _
        if (normalizedText[cursor] === "_" && normalizedText[cursor + 1] !== "_") {
            const end = normalizedText.indexOf("_", cursor + 1);
            if (end !== -1 && end > cursor + 1) {
                flushText(cursor);
                nodes.push(
                    <em key={`${keyPrefix}-em-${matchIndex}`}>{normalizedText.slice(cursor + 1, end)}</em>,
                );
                matchIndex += 1;
                cursor = end + 1;
                segmentStart = cursor;
                continue;
            }
        }

        if (normalizedText[cursor] === "[") {
            // Citations: "[Source N]" optionally followed by "(url)". The URL is
            // ALWAYS consumed into the badge (even if the closing paren is missing
            // or there is whitespace before it) so it can never leak into the text.
            const citeMatch = normalizedText
                .slice(cursor)
                .match(/^\[\s*source\s*(\d+)\s*\](?:\s*\(\s*(https?:\/\/[^\s)]*)\)?)?/i);
            if (citeMatch) {
                flushText(cursor);
                // Ignore any URL the model typed after the tag; use the server's list.
                const citeSource = activeCitationSources[citeMatch[1]];
                const citeUrl = citeSource?.url && isHttpUrl(citeSource.url) ? citeSource.url : "";
                nodes.push(
                    citeUrl && isHttpUrl(citeUrl) ? (
                        <a
                            key={`${keyPrefix}-cite-${matchIndex}`}
                            href={citeUrl}
                            target="_blank"
                            rel="noreferrer noopener"
                            title={citeSource?.title || formatDisplayUrl(citeUrl)}
                            className="chat-transcript__citation-badge"
                        >
                            Source {citeMatch[1]}
                        </a>
                    ) : (
                        <span key={`${keyPrefix}-cite-${matchIndex}`} className="chat-transcript__citation-badge">
                            Source {citeMatch[1]}
                        </span>
                    ),
                );
                matchIndex += 1;
                cursor += citeMatch[0].length;
                segmentStart = cursor;
                continue;
            }

            // const strictMatch = normalizedText.slice(cursor).match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/i);
            // const looseCitationMatch = !strictMatch && normalizedText.slice(cursor).match(/^\[\s*(source\s*\d+)\s*\]\s+\((https?:\/\/[^\s)]+)\)/i);
            // const linkMatch = strictMatch || looseCitationMatch;
            const linkMatch = normalizedText.slice(cursor).match(/^\[\s*([^\]]+?)\s*\]\s*\((https?:\/\/[^\s)]+)\)(?:\s*[】\]］」])?/i);

            if (linkMatch?.[0] && isHttpUrl(linkMatch[2])) {
                flushText(cursor);
                const isCitation = /^source\s*\d+$/i.test(linkMatch[1].trim());
                const linkText = linkMatch[1].trim();
                const url = linkMatch[2];

                // Ensure the URL is properly formatted
                const sanitizedUrl = trimTrailingUrlPunctuation(url);

                nodes.push(
                    <a
                        key={`${keyPrefix}-link-${matchIndex}`}
                        href={sanitizedUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={sanitizedUrl}
                        className={isCitation ? "chat-transcript__citation-badge" : "chat-transcript__markdown-link"}
                    >
                        {/^https?:\/\//i.test(linkText) ? formatDisplayUrl(linkText) : linkText}
                    </a>
                );
                matchIndex += 1;
                cursor += linkMatch[0].length;
                segmentStart = cursor;
                continue;
            }

            // Handle citation without URL - render as badge
            const citationMatch = normalizedText.slice(cursor).match(/^\[Source\s+(\d+)\]/i);
            if (citationMatch) {
                flushText(cursor);
                const sourceNumber = citationMatch[1];
                nodes.push(
                    <span key={`${keyPrefix}-citation-${matchIndex}`} className="chat-transcript__citation-badge">
                        Source {sourceNumber}
                    </span>
                );
                matchIndex += 1;
                cursor += citationMatch[0].length;
                segmentStart = cursor;
                continue;
            }

            // Handle regular markdown links [text](url)
            const regularLinkMatch = normalizedText.slice(cursor).match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/);
            if (regularLinkMatch && isHttpUrl(regularLinkMatch[2])) {
                flushText(cursor);
                const url = trimTrailingUrlPunctuation(regularLinkMatch[2]);
                nodes.push(
                    <a
                        key={`${keyPrefix}-link-${matchIndex}`}
                        href={url}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={url}
                        className="chat-transcript__markdown-link"
                    >
                        {/^https?:\/\//i.test(regularLinkMatch[1].trim()) ? formatDisplayUrl(regularLinkMatch[1].trim()) : regularLinkMatch[1]}
                    </a>
                );
                matchIndex += 1;
                cursor += regularLinkMatch[0].length;
                segmentStart = cursor;
                continue;
            }
        }

        // Handle standalone URLs
        const urlMatch = normalizedText.slice(cursor).match(/^(https?:\/\/[^\s<>"]+)/i);
        if (urlMatch?.[0]) {
            const sanitizedUrl = trimTrailingUrlPunctuation(urlMatch[0]);
            if (sanitizedUrl && isHttpUrl(sanitizedUrl)) {
                flushText(cursor);
                nodes.push(
                    <a
                        key={`${keyPrefix}-url-${matchIndex}`}
                        href={sanitizedUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        title={sanitizedUrl}
                        className="chat-transcript__markdown-link chat-transcript__markdown-link--url"
                    >
                        {formatDisplayUrl(sanitizedUrl)}
                    </a>,
                );
                matchIndex += 1;
                cursor += sanitizedUrl.length;
                segmentStart = cursor;
                continue;
            }
        }

        cursor += 1;
    }

    flushText(normalizedText.length);
    return nodes;
};

const renderInlineMarkdownWithLineBreaks = (content, keyPrefix) => {
    const lines = normalizeMarkdownContent(content).split("\n");
    const nodes = [];

    lines.forEach((line, index) => {
        if (index > 0) {
            nodes.push(<br key={`${keyPrefix}-br-${index}`} />);
        }
        nodes.push(...renderInlineMarkdown(line, `${keyPrefix}-line-${index}`));
    });

    return nodes;
};

const renderMarkdownContentInner = (content) => {
    const lines = normalizeMarkdownContent(content).split("\n");
    const blocks = [];
    let index = 0;
    let blockKey = 0;
    let orderedListRunningCount = 0;

    while (index < lines.length) {
        const line = lines[index];
        const trimmedLine = line.trim();

        if (!trimmedLine) {
            index += 1;
            continue;
        }

        if (trimmedLine.startsWith("\\[") || trimmedLine.startsWith("$$")) {
            const isDoubleDollarBlock = trimmedLine.startsWith("$$");
            const closingToken = isDoubleDollarBlock ? "$$" : "\\]";
            const blockLines = [];
            let blockLine = trimmedLine;

            if (blockLine === closingToken) {
                index += 1;
                continue;
            }

            if (blockLine.startsWith(closingToken)) {
                index += 1;
                continue;
            }

            if ((isDoubleDollarBlock && blockLine.endsWith("$$") && blockLine.length > 4) || (!isDoubleDollarBlock && blockLine.startsWith("\\[") && blockLine.endsWith("\\]") && blockLine.length > 4)) {
                const inner = blockLine.replace(/^\$\$|^\\\[/, "").replace(/\$\$$|\\\]$/, "").trim();
                blocks.push(renderMathExpression(inner, `math-block-${blockKey++}`, { display: true }));
                index += 1;
                continue;
            }

            if (blockLine.startsWith("\\[")) {
                blockLine = blockLine.slice(2).trim();
            }
            if (blockLine.startsWith("$$")) {
                blockLine = blockLine.slice(2).trim();
            }

            if (blockLine) {
                blockLines.push(blockLine);
            }

            index += 1;

            while (index < lines.length) {
                const currentLine = lines[index].trim();

                if (!currentLine) {
                    index += 1;
                    continue;
                }

                if (currentLine.endsWith(closingToken)) {
                    blockLines.push(currentLine.replace(new RegExp(`${closingToken.replace(/([.*+?^${}()|[\]\\])/g, "\\$1")}$`), "").trim());
                    index += 1;
                    break;
                }

                blockLines.push(currentLine);
                index += 1;
            }

            blocks.push(renderMathExpression(blockLines.join(" "), `math-block-${blockKey++}`, { display: true }));
            continue;
        }

        if (trimmedLine.startsWith("```")) {
            const language = trimmedLine.slice(3).trim();
            const codeLines = [];
            index += 1;

            while (index < lines.length && !lines[index].trim().startsWith("```")) {
                codeLines.push(lines[index]);
                index += 1;
            }

            if (index < lines.length && lines[index].trim().startsWith("```")) {
                index += 1;
            }

            // blocks.push(
            //     <pre key={`markdown-block-${blockKey++}`} className="chat-transcript__markdown-code">
            //         <code data-language={language || undefined}>{codeLines.join("\n")}</code>
            //     </pre>,
            // );
            blocks.push(
                <CodeBlock key={`markdown-block-${blockKey++}`} code={codeLines.join("\n")} language={language} />,
            );
            orderedListRunningCount = 0;
            continue;
        }

        const headingMatch = trimmedLine.match(/^(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            const headingLevel = Math.min(6, headingMatch[1].length);
            const HeadingTag = `h${Math.min(3, headingLevel)}`;
            blocks.push(
                <HeadingTag key={`markdown-block-${blockKey++}`} className={`chat-transcript__markdown-heading chat-transcript__markdown-heading--${headingLevel}`}>
                    {renderInlineMarkdown(headingMatch[2], `heading-${blockKey}`)}
                </HeadingTag>,
            );
            orderedListRunningCount = 0;
            index += 1;
            continue;
        }

        const unorderedListMatch = trimmedLine.match(/^[-*+]\s+(.*)$/);
        if (unorderedListMatch) {
            const items = [];

            while (index < lines.length) {
                const currentLine = lines[index].trim();
                const currentMatch = currentLine.match(/^[-*+]\s+(.*)$/);

                if (!currentMatch) {
                    break;
                }

                items.push(currentMatch[1]);
                index += 1;
            }

            blocks.push(
                <ul key={`markdown-block-${blockKey++}`} className="chat-transcript__markdown-list">
                    {items.map((item, itemIndex) => (
                        <li key={`markdown-list-item-${blockKey}-${itemIndex}`}>{renderInlineMarkdown(item, `list-${blockKey}-${itemIndex}`)}</li>
                    ))}
                </ul>,
            );
            continue;
        }

        const orderedListMatch = trimmedLine.match(/^\d+\.\s+(.*)$/);
        if (orderedListMatch) {
            const items = [];

            while (index < lines.length) {
                const currentLine = lines[index].trim();
                const currentMatch = currentLine.match(/^\d+\.\s+(.*)$/);

                if (!currentMatch) {
                    break;
                }

                items.push(currentMatch[1]);
                index += 1;
            }

            const listStartNumber = orderedListRunningCount + 1;
            orderedListRunningCount += items.length;

            blocks.push(
                <ol key={`markdown-block-${blockKey++}`} className="chat-transcript__markdown-list" start={listStartNumber}>
                    {items.map((item, itemIndex) => (
                        <li key={`markdown-ordered-item-${blockKey}-${itemIndex}`}>{renderInlineMarkdown(item, `ordered-${blockKey}-${itemIndex}`)}</li>
                    ))}
                </ol>,
            );
            continue;
        }

        const nextLine = lines[index + 1]?.trim() || "";
        if (trimmedLine.includes("|") && nextLine && isMarkdownTableDivider(nextLine)) {
            const headerCells = splitMarkdownTableRow(trimmedLine);
            const rows = [];
            index += 2;

            while (index < lines.length) {
                const currentLine = lines[index].trim();
                if (!currentLine || !currentLine.includes("|")) {
                    break;
                }

                const rowCells = splitMarkdownTableRow(currentLine);
                if (rowCells.length === 0) {
                    break;
                }

                rows.push(rowCells);
                index += 1;
            }

            blocks.push(
                <div key={`markdown-block-${blockKey++}`} className="chat-transcript__markdown-table-wrap">
                    <table className="chat-transcript__markdown-table">
                        <thead>
                            <tr>
                                {headerCells.map((cell, cellIndex) => (
                                    <th key={`markdown-table-head-${blockKey}-${cellIndex}`} scope="col">
                                        {renderInlineMarkdown(cell, `table-head-${blockKey}-${cellIndex}`)}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row, rowIndex) => (
                                <tr key={`markdown-table-row-${blockKey}-${rowIndex}`}>
                                    {headerCells.map((_, cellIndex) => (
                                        <td key={`markdown-table-cell-${blockKey}-${rowIndex}-${cellIndex}`}>
                                            {renderInlineMarkdown(row[cellIndex] || "", `table-cell-${blockKey}-${rowIndex}-${cellIndex}`)}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>,
            );
            orderedListRunningCount = 0;
            continue;
        }

        const paragraphLines = [line];
        index += 1;

        while (index < lines.length) {
            const nextLine = lines[index];
            const nextTrimmed = nextLine.trim();

            if (!nextTrimmed) {
                break;
            }

            if (
                nextTrimmed.startsWith("```") ||
                /^#{1,6}\s+/.test(nextTrimmed) ||
                /^[-*+]\s+/.test(nextTrimmed) ||
                /^\d+\.\s+/.test(nextTrimmed) ||
                (nextTrimmed.includes("|") && isMarkdownTableDivider(lines[index + 1]?.trim() || ""))
            ) {
                break;
            }

            paragraphLines.push(nextLine);
            index += 1;
        }

        blocks.push(
            <p key={`markdown-block-${blockKey++}`} className="chat-transcript__markdown-paragraph">
                {renderInlineMarkdownWithLineBreaks(paragraphLines.join("\n").trimEnd(), `paragraph-${blockKey}`)}
            </p>,
        );
    }

    return blocks;
};

const WEATHER_REPORT_PATTERN = /1\.\s*Location:\s*([^\n]+)\n2\.\s*Condition:\s*([^\n]+)\n3\.\s*Temperature:\s*([^\n]+)\n4\.\s*Humidity:\s*([^\n]+)\n5\.\s*Precipitation:\s*([^\n]+)\n6\.\s*Wind:\s*([^\n]+)(?:\n7\.\s*Updated:\s*([^\n]+))?/;

const parseWeatherReport = (content) => {
    const normalized = String(content ?? "").trim();
    const match = normalized.match(WEATHER_REPORT_PATTERN);

    if (!match) {
        return null;
    }

    return {
        location: (match[1] || "").trim(),
        condition: (match[2] || "").trim(),
        temperature: (match[3] || "").trim(),
        humidity: (match[4] || "").trim(),
        precipitation: (match[5] || "").trim(),
        wind: (match[6] || "").trim(),
        updated: (match[7] || "").trim(),
    };
};

const TIME_REPORT_PATTERN = /1\.\s*Date:\s*([^\n]+)\n2\.\s*Time:\s*([^\n]+)\n3\.\s*Timezone:\s*([^\n]+)\n4\.\s*UTC Time:\s*([^\n]+)\n5\.\s*Week Number:\s*([^\n]+)\n6\.\s*Day of Year:\s*([^\n]+)/;

const parseTimeReport = (content) => {
    const normalized = String(content ?? "").trim();
    const match = normalized.match(TIME_REPORT_PATTERN);

    if (!match) {
        return null;
    }

    return {
        leadingText: normalized.slice(0, match.index).trim(),
        date: (match[1] || "").trim(),
        time: (match[2] || "").trim(),
        timezone: (match[3] || "").trim(),
        utcTime: (match[4] || "").trim(),
        weekNumber: (match[5] || "").trim(),
        dayOfYear: (match[6] || "").trim(),
    };
};

function TimeCard({ data }) {
    const [now, setNow] = useState(() => new Date());
    const [use24Hour, setUse24Hour] = useState(false);

    useEffect(() => {
        const timer = window.setInterval(() => setNow(new Date()), 1000);
        return () => window.clearInterval(timer);
    }, []);

    if (!data) {
        return null;
    }

    const timeZone = data.timezone || "UTC";

    const getZonedParts = (date, zone, hour12) => {
        const options = {
            timeZone: zone,
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12,
        };

        if (!hour12) {
            options.hourCycle = "h23";
        }

        try {
            return new Intl.DateTimeFormat("en-US", options).formatToParts(date);
        } catch {
            return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).formatToParts(date);
        }
    };

    const partValue = (parts, type) => parts.find((part) => part.type === type)?.value || "";

    const displayParts = getZonedParts(now, timeZone, !use24Hour);
    const hour24Parts = getZonedParts(now, timeZone, false);

    const dateLabel = `${partValue(displayParts, "weekday")}, ${partValue(displayParts, "month")} ${partValue(displayParts, "day")}, ${partValue(displayParts, "year")}`;
    const hourStr = partValue(displayParts, "hour");
    const minuteStr = partValue(displayParts, "minute");
    const secondStr = partValue(displayParts, "second");
    const period = partValue(displayParts, "dayPeriod").toUpperCase();

    const hour24 = Number(partValue(hour24Parts, "hour")) % 24;
    const minuteNum = Number(minuteStr) || 0;
    const secondNum = Number(secondStr) || 0;

    const utcLabel = new Intl.DateTimeFormat("en-GB", {
        timeZone: "UTC",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(now);

    const getWeekNumber = (date) => {
        const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
        const dayNumber = (target.getUTCDay() + 6) % 7;
        target.setUTCDate(target.getUTCDate() - dayNumber + 3);
        const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
        return 1 + Math.round(((target - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    };

    const isLeapYear = (year) => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const startOfYear = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    const dayOfYear = Math.floor((now.getTime() - startOfYear.getTime()) / 86400000) + 1;
    const totalDaysInYear = isLeapYear(now.getUTCFullYear()) ? 366 : 365;

    const handleCopyTime = async () => {
        const textToCopy = `${hourStr}:${minuteStr}:${secondStr}${!use24Hour && period ? ` ${period}` : ""}`;
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(textToCopy);
            }
        } catch {
            // ignore
        }
    };

    const handPoint = (angleDegrees, length) => {
        const angleRadians = (angleDegrees - 90) * (Math.PI / 180);
        return {
            x: 100 + length * Math.cos(angleRadians),
            y: 100 + length * Math.sin(angleRadians),
        };
    };

    const hourAngle = ((hour24 % 12) + minuteNum / 60) * 30;
    const minuteAngle = (minuteNum + secondNum / 60) * 6;
    const secondAngle = secondNum * 6;
    const hourHand = handPoint(hourAngle, 45);
    const minuteHand = handPoint(minuteAngle, 65);
    const secondHand = handPoint(secondAngle, 72);

    return (
        <div className="time-card">
            <div className="time-card__main">
                <div className="time-card__digital">
                    <p className="time-card__date">{dateLabel}</p>
                    <div className="time-card__clock-row">
                        <span className="time-card__digits">{hourStr}:{minuteStr}:{secondStr}</span>
                        {!use24Hour && period ? <span className="time-card__period">{period}</span> : null}
                    </div>
                    <div className="time-card__actions">
                        <button type="button" className="time-card__button" onClick={() => setUse24Hour((current) => !current)}>
                            {use24Hour ? "Switch to 12h" : "Switch to 24h"}
                        </button>
                        <button type="button" className="time-card__button" onClick={handleCopyTime}>
                            Copy time
                        </button>
                    </div>
                </div>

                <svg className="time-card__analog" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
                    <circle cx="100" cy="100" r="92" className="time-card__face" />
                    {Array.from({ length: 12 }).map((_, index) => {
                        const angle = index * 30;
                        const isCardinal = index % 3 === 0;
                        const outer = handPoint(angle, 84);
                        const inner = handPoint(angle, isCardinal ? 72 : 76);
                        return (
                            <line
                                key={`tick-${index}`}
                                x1={outer.x}
                                y1={outer.y}
                                x2={inner.x}
                                y2={inner.y}
                                className={isCardinal ? "time-card__tick time-card__tick--major" : "time-card__tick"}
                            />
                        );
                    })}
                    {[12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((label, index) => {
                        const angle = index * 30;
                        const point = handPoint(angle, 60);
                        return (
                            <text key={`label-${label}`} x={point.x} y={point.y + 5} textAnchor="middle" className="time-card__number">
                                {label}
                            </text>
                        );
                    })}
                    <line x1="100" y1="100" x2={hourHand.x} y2={hourHand.y} className="time-card__hand time-card__hand--hour" />
                    <line x1="100" y1="100" x2={minuteHand.x} y2={minuteHand.y} className="time-card__hand time-card__hand--minute" />
                    <line x1="100" y1="100" x2={secondHand.x} y2={secondHand.y} className="time-card__hand time-card__hand--second" />
                    <circle cx="100" cy="100" r="4" className="time-card__pivot" />
                </svg>
            </div>

            <div className="time-card__grid">
                <div className="time-card__stat">
                    <span className="time-card__stat-label">Timezone</span>
                    <span className="time-card__stat-value">{timeZone || "—"}</span>
                </div>
                <div className="time-card__stat">
                    <span className="time-card__stat-label">UTC Time</span>
                    <span className="time-card__stat-value">{utcLabel || "—"}</span>
                </div>
                <div className="time-card__stat">
                    <span className="time-card__stat-label">Week Number</span>
                    <span className="time-card__stat-value">Week {getWeekNumber(now)}</span>
                </div>
                <div className="time-card__stat">
                    <span className="time-card__stat-label">Day of Year</span>
                    <span className="time-card__stat-value">Day {dayOfYear} of {totalDaysInYear}</span>
                </div>
            </div>
        </div>
    );
}

function WeatherConditionIcon({ condition }) {
    const normalized = String(condition || "").toLowerCase();
    let icon = "clear_day";

    if (normalized.includes("thunderstorm")) icon = "thunderstorm";
    else if (normalized.includes("snow")) icon = "weather_snowy";
    else if (normalized.includes("shower") || normalized.includes("rain") || normalized.includes("drizzle")) icon = "rainy";
    else if (normalized.includes("fog")) icon = "foggy";
    else if (normalized.includes("overcast")) icon = "cloud";
    else if (normalized.includes("partly")) icon = "partly_cloudy_day";
    else if (normalized.includes("night")) icon = "bedtime";

    return (
        <span className="weather-card__icon material-symbols-rounded" aria-hidden="true">
            {icon}
        </span>
    );
}

function WeatherCard({ data }) {
    if (!data) {
        return null;
    }

    return (
        <div className="weather-card">
            <div className="weather-card__top">
                <div className="weather-card__location">
                    <span className="material-symbols-rounded" aria-hidden="true">location_on</span>
                    <span>{data.location || "Unknown location"}</span>
                </div>
                <WeatherConditionIcon condition={data.condition} />
            </div>

            <div className="weather-card__main">
                <span className="weather-card__temperature">{data.temperature}</span>
                <span className="weather-card__condition">{data.condition}</span>
            </div>

            <div className="weather-card__grid">
                <div className="weather-card__stat">
                    <span className="weather-card__stat-label">Humidity</span>
                    <span className="weather-card__stat-value">{data.humidity || "—"}</span>
                </div>
                <div className="weather-card__stat">
                    <span className="weather-card__stat-label">Precipitation</span>
                    <span className="weather-card__stat-value">{data.precipitation || "—"}</span>
                </div>
                <div className="weather-card__stat">
                    <span className="weather-card__stat-label">Wind</span>
                    <span className="weather-card__stat-value">{data.wind || "—"}</span>
                </div>
            </div>

            {data.updated ? (
                <div className="weather-card__footer">
                    <span className="material-symbols-rounded" aria-hidden="true">schedule</span>
                    <span>Updated {data.updated}</span>
                </div>
            ) : null}
        </div>
    );
}

function MarkdownMessage({ content }) {
    const weatherReport = parseWeatherReport(content);
    if (weatherReport) {
        return (
            <>
                {weatherReport.leadingText ? (
                    <div className="chat-transcript__markdown">{renderMarkdownContent(weatherReport.leadingText)}</div>
                ) : null}
                <WeatherCard data={weatherReport} />
            </>
        );
    }

    const timeReport = parseTimeReport(content);
    if (timeReport) {
        return (
            <>
                {timeReport.leadingText ? (
                    <div className="chat-transcript__markdown">{renderMarkdownContent(timeReport.leadingText)}</div>
                ) : null}
                <TimeCard data={timeReport} />
            </>
        );
    }

    const renderedContent = renderMarkdownContent(content);

    if (!renderedContent.length) {
        return null;
    }

    return <div className="chat-transcript__markdown">{renderedContent}</div>;
}

function CodeBlock({ code, language }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch {
            // ignore
        }
    };

    return (
        <div className="chat-transcript__code-block">
            {/* <button
                type="button"
                className={`chat-transcript__code-copy ${copied ? "is-copied" : ""}`}
                onClick={handleCopy}
                aria-label="Copy code"
                title="Copy code"
            >
                <ContentCopyIcon />
                 <span>{copied ? "Copied" : "Copy"}</span>  
            </button> */}

            <button
                type="button"
                className={`chat-transcript__code-copy ${copied ? "is-copied" : ""}`}
                onClick={handleCopy}
                aria-label="Copy code"
                title="Copy code"
            >
                {copied ? <CheckIcon /> : <ContentCopyIcon />}
            </button>

            <pre className="chat-transcript__markdown-code">
                <code data-language={language || undefined}>{code}</code>
            </pre>
        </div>
    );
}

function ChatPage() {
    const { toasts, showToast, dismissToast } = useToasts();

    useEffect(() => {
        const handleStorageQuotaExceeded = () => {
            showToast(
                "This attachment is too large to save as a draft in this browser. It is still available in the current chat; send it or remove it before leaving.",
                { type: "warning" }
            );
        };
        window.addEventListener("quantic:storage-quota-exceeded", handleStorageQuotaExceeded);
        return () => window.removeEventListener("quantic:storage-quota-exceeded", handleStorageQuotaExceeded);
    }, [showToast]);
    const [auth, setAuth] = useState(() => readStoredJson(authProfileStorageKey, null));
    const [messages, setMessages] = useState([]);
    const [chatThreads, setChatThreads] = useState([]);
    const [currentThreadId, setCurrentThreadId] = useState("");
    const [chatHistoryLoading, setChatHistoryLoading] = useState(false);
    const [chatHistoryError, setChatHistoryError] = useState("");
    const [activeView, setActiveView] = useState(() => {
        if (typeof window === "undefined") {
            return "discover";
        }

        return sessionStorage.getItem(activeViewStorageKey) || "discover";
    });
    const [sidebarOpen, setSidebarOpen] = useState(() => readStoredBoolean(sidebarOpenStorageKey, getDefaultSidebarOpenState()));
    const [loginOpen, setLoginOpen] = useState(false);
    const [authMode, setAuthMode] = useState("login");
    const [authLoading, setAuthLoading] = useState(false);
    const [authError, setAuthError] = useState("");
    const [messageDraft, setMessageDraft] = useState("");
    const [editingMessageIndex, setEditingMessageIndex] = useState(null);
    const [editingMessageDraft, setEditingMessageDraft] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [isListening, setIsListening] = useState(false);
    const [isSpeaking, setIsSpeaking] = useState(false);
    const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
    const [voiceConversationOpen, setVoiceConversationOpen] = useState(false);
    const [voiceLang, setVoiceLang] = useState(getInitialVoiceLanguage);
    const [chatMenuOpen, setChatMenuOpen] = useState(false);
    const [chatMenuThreadId, setChatMenuThreadId] = useState("");
    const [chatRenamingThreadId, setChatRenamingThreadId] = useState("");
    const [chatRenameDraft, setChatRenameDraft] = useState("");
    const [chatRenameSavingThreadId, setChatRenameSavingThreadId] = useState("");
    const [chatDeleteConfirmThreadId, setChatDeleteConfirmThreadId] = useState("");
    const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
    const [adminPrefillEmail, setAdminPrefillEmail] = useState("");
    const [adminTwoFactorPending, setAdminTwoFactorPending] = useState(false);
    const [archivedThreadIds, setArchivedThreadIds] = useState(() => new Set());
    const [activeLegalPage, setActiveLegalPage] = useState(null);
    const [selectedAttachments, setSelectedAttachments] = useState([]);
    const [manualPlaybackActive, setManualPlaybackActive] = useState(false);
    const [expandedMessageIndexes, setExpandedMessageIndexes] = useState(() => new Set());
    const [copiedMessageIndex, setCopiedMessageIndex] = useState(null);
    const copiedMessageTimeoutRef = useRef(null);
    const [followUpExpected, setFollowUpExpected] = useState(null);

    const [lightboxAttachment, setLightboxAttachment] = useState(null);
    const [lightboxZoom, setLightboxZoom] = useState(1);

    const [pastedTextViewer, setPastedTextViewer] = useState(null);

    const openPastedTextViewer = (payload) => {
        const content = String(payload?.content ?? "");
        if (!content.trim()) {
            return;
        }
        setPastedTextViewer({ name: payload?.name || "Pasted Text", content });
    };

    const closePastedTextViewer = () => {
        setPastedTextViewer(null);
    };

    const handleCopyPastedTextViewer = async () => {
        if (!pastedTextViewer?.content) {
            return;
        }
        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(pastedTextViewer.content);
            }
        } catch {
            // ignore
        }
    };

    const [pastedTextBlocks, setPastedTextBlocks] = useState([]);

    const handleRemovePastedTextBlock = (key) => {
        setPastedTextBlocks((current) => current.filter((block) => block.key !== key));
    };

    const openLightbox = (attachment) => {
        if (!attachment?.dataUrl) {
            return;
        }
        setLightboxAttachment(attachment);
        setLightboxZoom(1);
    };

    const closeLightbox = () => {
        setLightboxAttachment(null);
        setLightboxZoom(1);
    };

    const handleLightboxZoomIn = () => {
        setLightboxZoom((current) => Math.min(3, +(current + 0.25).toFixed(2)));
    };

    const handleLightboxZoomOut = () => {
        setLightboxZoom((current) => Math.max(0.5, +(current - 0.25).toFixed(2)));
    };

    const handleLightboxResetZoom = () => {
        setLightboxZoom(1);
    };

    const handleLightboxDownload = () => {
        if (!lightboxAttachment?.dataUrl) {
            return;
        }

        const link = document.createElement("a");
        link.href = lightboxAttachment.dataUrl;
        link.download = lightboxAttachment.name || "image.png";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    };

    const attachmentInputRef = useRef(null);
    const messageInputRef = useRef(null);
    const recognitionRef = useRef(null);
    const voiceAudioRef = useRef(null);
    const voicePlaybackRequestRef = useRef(0);
    const orbInnerRef = useRef(null);
    const voiceAutoSendTimerRef = useRef(null);
    const voiceRestartTimerRef = useRef(null);
    const orbCanvasRef = useRef(null);
    const orbEngineRef = useRef(null);
    const voiceCaptionRef = useRef(null);
    const voiceLangRef = useRef(voiceLang);
    const voiceBaseTextRef = useRef("");
    const voiceSessionTextRef = useRef("");
    const voiceConsumedRef = useRef(0);
    const voiceLastDraftRef = useRef("");
    const noSpeechStreakRef = useRef(0);
    const showToastRef = useRef(showToast);
    const submitChatMessageRef = useRef(null);
    const isSendingRef = useRef(false);
    const isListeningRef = useRef(false);
    const isSpeakingRef = useRef(false);
    const voiceModeEnabledRef = useRef(false);
    const voiceConversationOpenRef = useRef(false);
    const speechReadAloudRef = useRef({ status: "idle", requestId: 0, utterance: null });
    const reduceMotion = Boolean(auth?.settings?.reduceMotion);
    const isLoggedIn = Boolean(auth);
    const showEmptyStatePrompt = messages.length === 0;
    const groupedChatThreads = groupChatThreads(chatThreads);
    const activeChatThread = chatThreads.find((thread) => thread.id === currentThreadId) || null;

    // Chat options menu only applies to an ongoing conversation
    useEffect(() => {
        if (chatMenuOpen && (!currentThreadId || messages.length === 0)) {
            setChatMenuOpen(false);
        }
    }, [chatMenuOpen, currentThreadId, messages.length]);
    const chatPinned = Boolean(activeChatThread?.pinned);
    const chatArchived = Boolean(currentThreadId && archivedThreadIds.has(currentThreadId));
    const draftAttachmentsStorageKey = getDraftAttachmentsStorageKey(auth?.id, currentThreadId);

    const closeChatMenu = () => setChatMenuOpen(false);
    const closeThreadMenu = () => setChatMenuThreadId("");
    const closeThreadRename = () => {
        setChatRenamingThreadId("");
        setChatRenameDraft("");
    };
    const closeDeleteChatThread = () => {
        setChatDeleteConfirmThreadId("");
    };
    const handleAttachmentButtonClick = () => {
        attachmentInputRef.current?.click();
    };
    const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
    const MAX_ATTACHMENTS_PER_MESSAGE = 6;

    const handleAttachmentInputChange = (event) => {
        const files = Array.from(event.target.files || []);
        event.target.value = "";
        if (!files.length) return;

        const accepted = files.filter((file) => {
            if (file.size > MAX_ATTACHMENT_BYTES) {
                showToast(`“${file.name}” is larger than 8 MB. Please choose a smaller file.`, { type: "error" });
                return false;
            }
            return true;
        });

        if (!accepted.length) return;

        void Promise.all(
            accepted.map(async (file) => {
                const key = `${file.name}-${file.size}-${file.lastModified}`;
                const dataUrl = await readFileAsDataUrl(file);
                return {
                    key,
                    name: file.name,
                    size: file.size,
                    type: file.type || "application/octet-stream",
                    dataUrl,
                };
            })
        ).then((attachments) => {
            const uniqueIncoming = attachments.filter((attachment) =>
                !selectedAttachments.some((existing) => existing.key === attachment.key)
            );
            const remainingSlots = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - selectedAttachments.length);
            if (uniqueIncoming.length > remainingSlots) {
                showToast(`You can attach up to ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`, { type: "warning" });
            }
            setSelectedAttachments((current) => {
                const nextAttachments = [...current];
                for (const attachment of uniqueIncoming.slice(0, remainingSlots)) {
                    if (!nextAttachments.some((existing) => existing.key === attachment.key)) {
                        nextAttachments.push(attachment);
                    }
                }
                return nextAttachments.slice(0, MAX_ATTACHMENTS_PER_MESSAGE);
            });
        }).catch((error) => {
            console.error("[ChatPage] attachment read failed", error);
            showToast("Quantic could not read one of those files. Try another file or a smaller copy.", { type: "error" });
        });
    };

    const handleComposerPaste = (event) => {
        const clipboardItems = Array.from(event.clipboardData?.items || []);
        const pastedImages = clipboardItems
            .filter((item) => item.kind === "file" && String(item.type || "").startsWith("image/"))
            .map((item, index) => item.getAsFile())
            .filter(Boolean);

        if (pastedImages.length) {
            event.preventDefault();

            void Promise.all(
                pastedImages.map(async (file, index) => {
                    const safeName = String(file.name || `pasted-image-${index + 1}.png`).trim();
                    const key = `${safeName}-${file.size}-${file.lastModified || Date.now()}-${index}`;
                    const dataUrl = await readFileAsDataUrl(file);
                    return {
                        key,
                        name: safeName,
                        size: file.size,
                        type: file.type,
                        dataUrl,
                    };
                })
            ).then((attachments) => {
                setSelectedAttachments((current) => {
                    const nextAttachments = [...current];

                    for (const attachment of attachments) {
                        if (!nextAttachments.some((currentAttachment) => currentAttachment.key === attachment.key)) {
                            nextAttachments.push(attachment);
                        }
                    }

                    return nextAttachments;
                });
            });

            return;
        }

        const pastedText = event.clipboardData?.getData("text/plain") || "";
        const pastedLineCount = pastedText.split(/\r?\n/).length;

        if (pastedText && (pastedText.length > PASTE_TEXT_BLOCK_MIN_LENGTH || pastedLineCount > PASTE_TEXT_BLOCK_MIN_LINES)) {
            event.preventDefault();

            const key = `pasted-text-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const preview = buildPastedTextPreview(pastedText);

            setPastedTextBlocks((current) => [
                ...current,
                {
                    key,
                    preview,
                    content: pastedText,
                    lineCount: pastedLineCount,
                    charCount: pastedText.length,
                },
            ]);
        }
    };

    const handleRemoveAttachment = (key) => {
        setSelectedAttachments((current) => current.filter((attachment) => attachment.key !== key));
    };

    const [selectionToolbar, setSelectionToolbar] = useState(null);
    const [selectionTypeMenuOpen, setSelectionTypeMenuOpen] = useState(false);

    const getCaretCoordinates = (textarea, position) => {
        const mirror = document.createElement("div");
        const computed = window.getComputedStyle(textarea);
        const properties = [
            "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
            "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
            "fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing", "textTransform", "wordSpacing",
        ];
        properties.forEach((property) => { mirror.style[property] = computed[property]; });
        mirror.style.position = "absolute";
        mirror.style.visibility = "hidden";
        mirror.style.whiteSpace = "pre-wrap";
        mirror.style.overflowWrap = "break-word";
        mirror.style.top = "0";
        mirror.style.left = "-9999px";
        mirror.textContent = textarea.value.slice(0, position);
        const marker = document.createElement("span");
        marker.textContent = "\u200b";
        mirror.appendChild(marker);
        document.body.appendChild(mirror);
        const markerRect = marker.getBoundingClientRect();
        const mirrorRect = mirror.getBoundingClientRect();
        document.body.removeChild(mirror);
        return { top: markerRect.top - mirrorRect.top, left: markerRect.left - mirrorRect.left };
    };

    const handleComposerSelect = (event) => {
        const node = event.target;
        const start = node.selectionStart ?? 0;
        const end = node.selectionEnd ?? 0;

        if (start === end) {
            setSelectionToolbar(null);
            setSelectionTypeMenuOpen(false);
            return;
        }

        const caret = getCaretCoordinates(node, start);
        const textareaRect = node.getBoundingClientRect();

        setSelectionToolbar({
            top: textareaRect.top - 46 + caret.top - node.scrollTop,
            left: Math.min(textareaRect.left + caret.left, textareaRect.right - 170),
        });
    };

    const applyComposerFormatting = (type) => {
        const node = messageInputRef.current;
        if (!node) {
            return;
        }

        const start = node.selectionStart ?? messageDraft.length;
        const end = node.selectionEnd ?? messageDraft.length;
        const selectedText = messageDraft.slice(start, end);

        // const wrapSelection = (marker) => {
        //     const before = messageDraft.slice(0, start);
        //     const after = messageDraft.slice(end);
        //     const contentToWrap = selectedText || "text";
        //     const nextValue = `${before}${marker}${contentToWrap}${marker}${after}`;

        //     setMessageDraft(nextValue);
        //     window.requestAnimationFrame(() => {
        //         node.focus();
        //         const cursorStart = start + marker.length;
        //         const cursorEnd = cursorStart + contentToWrap.length;
        //         node.setSelectionRange(cursorStart, cursorEnd);
        //         autoResizeTextarea(node);
        //     });
        // };

        const wrapSelection = (marker) => {
            const before = messageDraft.slice(0, start);
            const after = messageDraft.slice(end);

            const selectionHasMarkers =
                selectedText.length >= marker.length * 2 &&
                selectedText.startsWith(marker) &&
                selectedText.endsWith(marker);

            if (selectionHasMarkers) {
                const innerText = selectedText.slice(marker.length, selectedText.length - marker.length);
                const nextValue = `${before}${innerText}${after}`;

                setMessageDraft(nextValue);
                window.requestAnimationFrame(() => {
                    node.focus();
                    node.setSelectionRange(start, start + innerText.length);
                    autoResizeTextarea(node);
                });
                return;
            }

            const markersSurroundSelection = before.endsWith(marker) && after.startsWith(marker);

            if (markersSurroundSelection) {
                const newBefore = before.slice(0, before.length - marker.length);
                const newAfter = after.slice(marker.length);
                const nextValue = `${newBefore}${selectedText}${newAfter}`;
                const cursorStart = start - marker.length;

                setMessageDraft(nextValue);
                window.requestAnimationFrame(() => {
                    node.focus();
                    node.setSelectionRange(cursorStart, cursorStart + selectedText.length);
                    autoResizeTextarea(node);
                });
                return;
            }

            const contentToWrap = selectedText || "text";
            const nextValue = `${before}${marker}${contentToWrap}${marker}${after}`;

            setMessageDraft(nextValue);
            window.requestAnimationFrame(() => {
                node.focus();
                const cursorStart = start + marker.length;
                const cursorEnd = cursorStart + contentToWrap.length;
                node.setSelectionRange(cursorStart, cursorEnd);
                autoResizeTextarea(node);
            });
        };

        // const prefixLines = (prefixFn) => {
        //     const before = messageDraft.slice(0, start);
        //     const after = messageDraft.slice(end);
        //     const lineStart = before.lastIndexOf("\n") + 1;
        //     const affected = messageDraft.slice(lineStart, end) || "item";
        //     const lines = affected.split("\n");
        //     const prefixed = lines.map((line, index) => `${prefixFn(index)}${line}`).join("\n");
        //     const nextValue = `${messageDraft.slice(0, lineStart)}${prefixed}${after}`;

        //     setMessageDraft(nextValue);
        //     window.requestAnimationFrame(() => {
        //         node.focus();
        //         autoResizeTextarea(node);
        //     });
        // };

        const BLOCK_PREFIX_PATTERN = /^(#{1,3}\s+|[-*+]\s+|\d+\.\s+)/;

        const prefixLines = (prefixFn) => {
            const before = messageDraft.slice(0, start);
            const after = messageDraft.slice(end);
            const lineStart = before.lastIndexOf("\n") + 1;
            const affected = messageDraft.slice(lineStart, end) || "item";
            const lines = affected.split("\n");
            const nextPrefixes = lines.map((_, index) => prefixFn(index));
            const currentlyApplied = lines.every((line, index) => line.startsWith(nextPrefixes[index]));

            const prefixed = lines
                .map((line, index) => {
                    const cleanedLine = line.replace(BLOCK_PREFIX_PATTERN, "");
                    return currentlyApplied ? cleanedLine : `${nextPrefixes[index]}${cleanedLine}`;
                })
                .join("\n");

            const nextValue = `${messageDraft.slice(0, lineStart)}${prefixed}${after}`;

            setMessageDraft(nextValue);
            window.requestAnimationFrame(() => {
                node.focus();
                autoResizeTextarea(node);
            });
        };

        if (type === "link") {
            const url = window.prompt("Enter URL");
            if (!url) {
                return;
            }

            const before = messageDraft.slice(0, start);
            const after = messageDraft.slice(end);
            const linkText = selectedText || "link text";
            const nextValue = `${before}[${linkText}](${url})${after}`;

            setMessageDraft(nextValue);
            window.requestAnimationFrame(() => {
                node.focus();
                autoResizeTextarea(node);
            });
            return;
        }

        if (type === "bold") {
            wrapSelection("**");
            return;
        }

        if (type === "italic") {
            wrapSelection("_");
            return;
        }

        if (type === "code") {
            wrapSelection("`");
            return;
        }

        if (type === "bullet") {
            prefixLines(() => "- ");
            return;
        }

        if (type === "numbered") {
            prefixLines((index) => `${index + 1}. `);
            return;
        }

        if (type === "heading1" || type === "heading2" || type === "heading3") {
            const level = type === "heading1" ? 1 : type === "heading2" ? 2 : 3;
            prefixLines(() => `${"#".repeat(level)} `);
            return;
        }

        if (type === "clearBlock") {
            const before = messageDraft.slice(0, start);
            const after = messageDraft.slice(end);
            const lineStart = before.lastIndexOf("\n") + 1;
            const affected = messageDraft.slice(lineStart, end);
            const cleaned = affected
                .split("\n")
                .map((line) => line.replace(/^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+)/, ""))
                .join("\n");
            const nextValue = `${messageDraft.slice(0, lineStart)}${cleaned}${after}`;

            setMessageDraft(nextValue);
            window.requestAnimationFrame(() => {
                node.focus();
                autoResizeTextarea(node);
            });
        }
    };

    const composerFormatToolbar = (
        <div className="chat-composer__format-toolbar" role="toolbar" aria-label="Text formatting">
            <button type="button" className="chat-composer__format-button" onClick={() => applyComposerFormatting("bold")} aria-label="Bold" title="Bold">
                <strong>B</strong>
            </button>
            <button type="button" className="chat-composer__format-button" onClick={() => applyComposerFormatting("italic")} aria-label="Italic" title="Italic">
                <em>I</em>
            </button>
            <button type="button" className="chat-composer__format-button" onClick={() => applyComposerFormatting("bullet")} aria-label="Bullet list" title="Bullet list">
                <span className="material-symbols-rounded">format_list_bulleted</span>
            </button>
            <button type="button" className="chat-composer__format-button" onClick={() => applyComposerFormatting("numbered")} aria-label="Numbered list" title="Numbered list">
                <span className="material-symbols-rounded">format_list_numbered</span>
            </button>
            <button type="button" className="chat-composer__format-button" onClick={() => applyComposerFormatting("code")} aria-label="Inline code" title="Inline code">
                <span className="material-symbols-rounded">code</span>
            </button>
        </div>
    );

    const stopVoicePlayback = () => {
        // Invalidate any in-flight TTS request so it cannot start playing after Stop is clicked.
        voicePlaybackRequestRef.current += 1;
        const currentAudio = voiceAudioRef.current;
        const hasSpeechSynthesis = typeof window !== "undefined" && "speechSynthesis" in window;

        orbInnerRef.current?.classList.remove("is-pulsing");

        if (currentAudio) {
            try {
                currentAudio.pause();
                currentAudio.currentTime = 0;
                currentAudio.src = "";
            } catch {
                // ignore
            }
            voiceAudioRef.current = null;
        }

        if (hasSpeechSynthesis) {
            cancelSpeechSynthesis();
        }

        speechReadAloudRef.current.status = "idle";
        speechReadAloudRef.current.utterance = null;

        setIsSpeaking(false);
        setManualPlaybackActive(false);
    };

    const handleSpeechBoundaryPulse = () => {
        orbEngineRef.current?.pulse(0.5);
        const node = orbInnerRef.current;
        if (!node) return;
        node.classList.remove("is-pulsing");
        // force reflow so the animation restarts on the next word
        void node.offsetWidth;
        node.classList.add("is-pulsing");
    };

    const kickOrb = (amount) => {
        orbEngineRef.current?.pulse(amount);
    };

    // Forget everything captured so far (after a message is sent or a new voice session starts).
    const resetVoiceTranscript = () => {
        voiceBaseTextRef.current = "";
        voiceSessionTextRef.current = "";
        voiceConsumedRef.current = 0;
        voiceLastDraftRef.current = "";
    };

    const applyVoiceLanguage = (code) => {
        if (!code || code === voiceLangRef.current) {
            return;
        }

        voiceLangRef.current = code;
        setVoiceLang(code);
        rememberVoiceLanguage(code);

        // Restart the recogniser so the new language takes effect. onend keeps the words already
        // captured, and restarts listening because voice mode is still on.
        if (isListeningRef.current) {
            try {
                recognitionRef.current?.abort?.();
            } catch {
                // ignore
            }
        }
    };

    const handleCycleVoiceLanguage = () => {
        const options = getVoiceLanguageOptions(voiceLangRef.current);
        const currentIndex = options.findIndex((option) => option.code === voiceLangRef.current);
        applyVoiceLanguage(options[(currentIndex + 1) % options.length].code);
    };

    const stopVoiceListening = ({ keepVoiceMode = false } = {}) => {
        if (voiceAutoSendTimerRef.current) {
            window.clearTimeout(voiceAutoSendTimerRef.current);
            voiceAutoSendTimerRef.current = null;
        }

        if (voiceRestartTimerRef.current) {
            window.clearTimeout(voiceRestartTimerRef.current);
            voiceRestartTimerRef.current = null;
        }

        try {
            recognitionRef.current?.abort?.();
        } catch {
            // ignore
        }

        setIsListening(false);
        if (!keepVoiceMode) {
            setVoiceModeEnabled(false);
        }
    };

    const startVoiceListening = () => {
        if (typeof window === "undefined") {
            return;
        }

        const recognition = recognitionRef.current;
        if (!recognition || isListeningRef.current || isSpeakingRef.current) {
            return;
        }

        try {
            recognition.lang = voiceLangRef.current || recognition.lang;
            recognition.start();
        } catch {
            // ignore
        }
    };

    const restartVoiceListening = () => {
        if (typeof window === "undefined" || !voiceModeEnabledRef.current) {
            return;
        }

        if (voiceRestartTimerRef.current) {
            window.clearTimeout(voiceRestartTimerRef.current);
        }

        voiceRestartTimerRef.current = window.setTimeout(() => {
            if (!voiceModeEnabledRef.current || isSpeakingRef.current) {
                return;
            }

            startVoiceListening();
        }, 250);
    };

    const handleToggleVoiceMode = () => {
        if (voiceModeEnabledRef.current) {
            stopVoicePlayback();
            stopVoiceListening();
            return;
        }

        if (!recognitionRef.current) {
            return;
        }

        // Dictating into the text box: keep whatever is already typed and add the spoken words after it.
        const typedText = messageInputRef.current?.value ?? "";
        voiceBaseTextRef.current = typedText.trim();
        voiceSessionTextRef.current = "";
        voiceConsumedRef.current = 0;
        voiceLastDraftRef.current = typedText;
        noSpeechStreakRef.current = 0;

        setVoiceModeEnabled(true);
        startVoiceListening();
    };

    const handleStopVoiceMode = () => {
        stopVoicePlayback();
        stopVoiceListening();
        setVoiceConversationOpen(false);
    };

    const startVoiceConversation = () => {
        if (!recognitionRef.current) {
            console.error("[Voice] Recognition not initialized");
            return;
        }

        stopVoicePlayback();
        stopVoiceListening({ keepVoiceMode: false });
        setMessageDraft("");
        resetVoiceTranscript();
        noSpeechStreakRef.current = 0;
        setVoiceConversationOpen(true);
        setVoiceModeEnabled(true);

        window.setTimeout(() => {
            if (recognitionRef.current && !isListeningRef.current) {
                startVoiceListening();
            }
        }, 100);
    };

    const handleToggleVoiceConversationMic = () => {
        if (!voiceConversationOpenRef.current) {
            return;
        }

        if (isSpeakingRef.current) {
            stopVoicePlayback();
            window.setTimeout(() => {
                if (voiceConversationOpenRef.current && !isListeningRef.current) {
                    startVoiceListening();
                }
            }, 100);
            return;
        }

        if (isListeningRef.current) {
            stopVoiceListening({ keepVoiceMode: true });
            return;
        }

        startVoiceListening();
    };

    const playAssistantVoice = async (content, { resumeListening = false } = {}) => {
        const readableText = getReadableMessageText(content);

        if (!readableText) {
            return null;
        }

        const shouldResumeListening = Boolean(resumeListening || voiceModeEnabledRef.current);
        const isManualPlayback = !shouldResumeListening;

        if (shouldResumeListening) {
            stopVoiceListening({ keepVoiceMode: true });
        } else {
            setManualPlaybackActive(true);
        }

        stopVoicePlayback();
        const playbackRequestId = ++voicePlaybackRequestRef.current;

        try {
            const audio = await speakWithAI(
                readableText,
                () => setIsSpeaking(true),
                () => {
                    setIsSpeaking(false);
                    voiceAudioRef.current = null;
                    if (isManualPlayback) {
                        setManualPlaybackActive(false);
                    }
                    if (shouldResumeListening && voiceModeEnabledRef.current) {
                        restartVoiceListening();
                    }
                },
                { onBoundary: handleSpeechBoundaryPulse }
            );

            // Stop may have been clicked while the TTS request was still pending.
            if (playbackRequestId !== voicePlaybackRequestRef.current) {
                if (audio) {
                    try {
                        audio.pause();
                        audio.currentTime = 0;
                        audio.src = "";
                    } catch {
                        // ignore
                    }
                }
                return null;
            }

            if (audio) {
                voiceAudioRef.current = audio;
            }

            return audio;
        } catch {
            setIsSpeaking(false);
            voiceAudioRef.current = null;
            if (isManualPlayback) {
                setManualPlaybackActive(false);
            }
            if (shouldResumeListening && voiceModeEnabledRef.current) {
                restartVoiceListening();
            }
            return null;
        }
    };

    const handleReadMessageAloud = async (content, options = {}) => {
        if (isSpeakingRef.current || manualPlaybackActive || speechReadAloudRef.current.status !== "idle") {
            stopVoicePlayback();
            return;
        }

        const hasNativeAudio = typeof window !== "undefined" && typeof Audio !== "undefined";

        if (hasNativeAudio) {
            const playedAudio = await playAssistantVoice(content, options);

            if (playedAudio) {
                return;
            }
        }

        const readableText = getReadableMessageText(content);

        if (!readableText || typeof window === "undefined" || !("speechSynthesis" in window)) {
            return;
        }

        const synth = window.speechSynthesis;
        const speechState = speechReadAloudRef.current;
        const shouldResumeListening = Boolean(options?.resumeListening || voiceModeEnabledRef.current);

        if (shouldResumeListening) {
            stopVoiceListening({ keepVoiceMode: true });
        }

        // Toggle behavior: if currently speaking/pending, stop.
        if (speechState.status !== "idle") {
            speechState.status = "idle";
            speechState.requestId += 1;
            speechState.utterance = null;
            try {
                synth.cancel();
            } catch {
                // ignore
            }
            setManualPlaybackActive(false);
            return;
        }

        speechState.status = "pending";
        const requestId = speechState.requestId + 1;
        speechState.requestId = requestId;
        try {
            // Clear any stuck queue before speaking.
            synth.cancel();
            synth.resume?.();
        } catch {
            // ignore
        }

        const preferredLang = detectSpeechLang(content) || navigator?.language || "en-US";
        const preferredVoice = await waitForReadableSpeechVoice(preferredLang);

        if (speechReadAloudRef.current.requestId !== requestId || speechReadAloudRef.current.status !== "pending") {
            synth.cancel();
            speechReadAloudRef.current.status = "idle";
            setManualPlaybackActive(false);
            return;
        }

        const utterance = new SpeechSynthesisUtterance(readableText);
        speechReadAloudRef.current.utterance = utterance;

        utterance.voice = preferredVoice || null;
        utterance.lang = preferredVoice?.lang || preferredLang || navigator?.language || "en-US";
        utterance.rate = 0.86;
        utterance.pitch = 1.05;
        utterance.volume = 1;
        utterance.onstart = () => {
            if (speechReadAloudRef.current.requestId === requestId) {
                speechReadAloudRef.current.status = "speaking";
                setIsSpeaking(true);
            }
        };
        utterance.onend = () => {
            if (speechReadAloudRef.current.requestId === requestId) {
                speechReadAloudRef.current.status = "idle";
                speechReadAloudRef.current.utterance = null;
                setIsSpeaking(false);
                setManualPlaybackActive(false);
                if (shouldResumeListening && voiceModeEnabledRef.current) {
                    restartVoiceListening();
                }
            }
        };
        utterance.onerror = () => {
            if (speechReadAloudRef.current.requestId === requestId) {
                speechReadAloudRef.current.status = "idle";
                speechReadAloudRef.current.utterance = null;
                setIsSpeaking(false);
                setManualPlaybackActive(false);
                if (shouldResumeListening && voiceModeEnabledRef.current) {
                    restartVoiceListening();
                }
            }
        };

        try {
            synth.speak(utterance);
            synth.resume?.();
        } catch {
            if (speechReadAloudRef.current.requestId === requestId) {
                speechReadAloudRef.current.status = "idle";
                speechReadAloudRef.current.utterance = null;
                setIsSpeaking(false);
                setManualPlaybackActive(false);
                if (shouldResumeListening && voiceModeEnabledRef.current) {
                    restartVoiceListening();
                }
            }
        }
    };

    const closeInlineMessageEdit = () => {
        setEditingMessageIndex(null);
        setEditingMessageDraft("");
    };

    const toggleMessageExpanded = (index) => {
        setExpandedMessageIndexes((current) => {
            const next = new Set(current);
            if (next.has(index)) {
                next.delete(index);
            } else {
                next.add(index);
            }
            return next;
        });
    };

    // const handleCopyMessage = async (content) => {
    //     const normalizedContent = String(content ?? "").trim();

    //     if (!normalizedContent) {
    //         return;
    //     }

    //     try {
    //         if (navigator?.clipboard?.writeText) {
    //             await navigator.clipboard.writeText(normalizedContent);
    //         }
    //     } catch {
    //         return;
    //     }
    // };

    const handleCopyMessage = async (content, index) => {
        const normalizedContent = stripSourcesMarker(content).trim();

        if (!normalizedContent) {
            return;
        }

        try {
            if (navigator?.clipboard?.writeText) {
                await navigator.clipboard.writeText(normalizedContent);
            }
        } catch {
            return;
        }

        if (copiedMessageTimeoutRef.current) {
            window.clearTimeout(copiedMessageTimeoutRef.current);
        }

        setCopiedMessageIndex(index);
        copiedMessageTimeoutRef.current = window.setTimeout(() => {
            setCopiedMessageIndex(null);
            copiedMessageTimeoutRef.current = null;
        }, 1500);
    };

    const getReadableMessageText = (content) => {
        const normalizedContent = stripSourcesMarker(content).trim();

        if (!normalizedContent) {
            return "";
        }

        return normalizedContent
            .replace(/```[\s\S]*?```/g, " ")
            .split(/\r?\n/)
            .map((line) =>
                line
                    .replace(/^\s*#{1,6}\s+/, "")
                    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
                    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1")
                    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
                    .replace(/[\*_`>]/g, "")
            )
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
    };

    const detectSpeechLang = (text) => {
        const sample = String(text ?? "").trim();
        if (!sample) {
            return null;
        }

        // Very lightweight script-based detection to pick an appropriate TTS voice.
        // Falls back to the browser language if unknown.
        if (/[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/.test(sample)) return "ar";
        if (/[\u0400-\u04FF]/.test(sample)) return "ru";
        if (/[\u0900-\u097F]/.test(sample)) return "hi-IN";
        if (/[\u0980-\u09FF]/.test(sample)) return "bn-IN";
        if (/[\u0A00-\u0A7F]/.test(sample)) return "pa-IN";
        if (/[\u0A80-\u0AFF]/.test(sample)) return "gu-IN";
        if (/[\u0B00-\u0B7F]/.test(sample)) return "or-IN";
        if (/[\u0B80-\u0BFF]/.test(sample)) return "ta-IN";
        if (/[\u0C00-\u0C7F]/.test(sample)) return "te-IN";
        if (/[\u0C80-\u0CFF]/.test(sample)) return "kn-IN";
        if (/[\u0D00-\u0D7F]/.test(sample)) return "ml-IN";
        if (/[\u0E00-\u0E7F]/.test(sample)) return "th-TH";
        if (/[\u0E80-\u0EFF]/.test(sample)) return "lo-LA";
        if (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7AF]/.test(sample)) return "ko-KR";
        if (/[\u3040-\u30FF]/.test(sample)) return "ja-JP";
        if (/[\u4E00-\u9FFF]/.test(sample)) return "zh-CN";
        if (/[\u0590-\u05FF]/.test(sample)) return "he-IL";
        if (/[\u1780-\u17FF]/.test(sample)) return "km-KH";

        return navigator?.language || "en-US";
    };

    const pickReadableSpeechVoice = (preferredLang) => {
        if (typeof window === "undefined" || !("speechSynthesis" in window)) {
            return null;
        }

        const voices = window.speechSynthesis.getVoices?.() || [];

        if (!voices.length) {
            return null;
        }

        const normalizedPreferred = String(preferredLang || "").trim().toLowerCase();
        const preferredBase = normalizedPreferred.split("-")[0];
        const voicesInPreferredLang = normalizedPreferred
            ? voices.filter((voice) => {
                const lang = String(voice.lang || "").toLowerCase();
                return lang === normalizedPreferred || lang.startsWith(`${preferredBase}-`) || lang === preferredBase;
            })
            : [];
        const englishVoices = voices.filter((voice) => /^en(-|$)/i.test(voice.lang || ""));
        const candidateVoices = voicesInPreferredLang.length ? voicesInPreferredLang : englishVoices.length ? englishVoices : voices;

        if (!candidateVoices.length) {
            return null;
        }

        const scoredVoices = candidateVoices
            .map((voice) => {
                let score = 0;

                if (/(natural|premium|google|microsoft|siri|voice|enhanced)/i.test(voice.name || "")) {
                    score += 2;
                }

                if (voice.localService) {
                    score += 1;
                }

                if (/en-us/i.test(voice.lang || "")) {
                    score += 1;
                }

                if (normalizedPreferred) {
                    const voiceLang = String(voice.lang || "").toLowerCase();
                    if (voiceLang === normalizedPreferred) {
                        score += 3;
                    } else if (preferredBase && voiceLang.startsWith(`${preferredBase}-`)) {
                        score += 2;
                    }
                }

                return { voice, score };
            })
            .sort((left, right) => right.score - left.score);

        return scoredVoices[0]?.voice || candidateVoices[0];
    };

    const waitForReadableSpeechVoice = (preferredLang) =>
        new Promise((resolve) => {
            if (typeof window === "undefined" || !("speechSynthesis" in window)) {
                resolve(null);
                return;
            }

            const synth = window.speechSynthesis;
            try {
                // Some browsers only populate voices after the first getVoices() call.
                synth.getVoices?.();
            } catch {
                // ignore
            }

            const currentVoice = pickReadableSpeechVoice(preferredLang);
            if (currentVoice) {
                resolve(currentVoice);
                return;
            }

            let resolved = false;
            const finish = (voice) => {
                if (resolved) {
                    return;
                }

                resolved = true;
                resolve(voice || pickReadableSpeechVoice(preferredLang));
            };

            const handleVoicesChanged = () => finish(pickReadableSpeechVoice(preferredLang));
            let previousHandler = null;
            try {
                previousHandler = synth.onvoiceschanged;
                synth.onvoiceschanged = handleVoicesChanged;
            } catch {
                // ignore
            }
            synth.addEventListener?.("voiceschanged", handleVoicesChanged, { once: true });

            window.setTimeout(() => {
                synth.removeEventListener?.("voiceschanged", handleVoicesChanged);
                try {
                    if (synth.onvoiceschanged === handleVoicesChanged) {
                        synth.onvoiceschanged = previousHandler;
                    }
                } catch {
                    // ignore
                }
                finish(pickReadableSpeechVoice(preferredLang));
            }, 1500);
        });

    const handleBeginEditMessage = (messageIndex, content) => {
        const normalizedContent = String(content ?? "").trim();

        if (!normalizedContent) {
            return;
        }

        setEditingMessageIndex(messageIndex);
        setEditingMessageDraft(normalizedContent);
    };

    const handleCancelInlineEdit = () => {
        closeInlineMessageEdit();
    };

    const handleSaveInlineEdit = (messageIndex) => {
        const normalizedContent = editingMessageDraft.trim();
        const sourceAttachments = normalizeMessageAttachments(messages[messageIndex]?.attachments);

        if (!normalizedContent || editingMessageIndex !== messageIndex) {
            closeInlineMessageEdit();
            return;
        }

        const conversationSeed = messages.slice(0, messageIndex);
        closeInlineMessageEdit();
        setMessages([
            ...conversationSeed,
            { role: "user", content: normalizedContent, attachments: sourceAttachments },
            { role: "assistant", content: "", status: "loading" },
        ]);
        submitChatMessage(normalizedContent, {
            conversation: conversationSeed,
            appendUserToTranscript: false,
            editMessageIndex: messageIndex,
            attachments: sourceAttachments,
        });
    };

    const submitChatMessage = async (userMessage, options = {}) => {
        const normalizedUserMessage = String(userMessage ?? "").trim();
        const conversationSeed = Array.isArray(options.conversation) ? options.conversation : messages;
        const appendUserToTranscript = options.appendUserToTranscript !== false;
        const assistantMessageIndex = Number.isInteger(options.assistantMessageIndex) ? options.assistantMessageIndex : null;
        const editMessageIndex = Number.isInteger(options.editMessageIndex) ? options.editMessageIndex : null;
        const messageAttachments = normalizeMessageAttachments(options.attachments);

        if ((!normalizedUserMessage && messageAttachments.length === 0) || isSending) {
            return;
        }

        setMessageDraft("");
        setIsSending(true);
        console.log("[ChatPage] send:start", normalizedUserMessage);

        if (appendUserToTranscript) {
            setMessages([
                ...conversationSeed,
                { role: "user", content: normalizedUserMessage, attachments: messageAttachments },
                { role: "assistant", content: "", status: "loading" },
            ]);
            setSelectedAttachments([]);
        }
        const recentConversation = conversationSeed
            .slice(-8)
            .map((entry) => ({
                role: entry.role,
                content: entry.content,
            }))
            .filter((entry) => entry.content && entry.role);

        // const updateAssistantMessage = (content) => {
        //     setMessages((prev) => {
        //         const nextMessages = [...prev];
        //         if (
        //             assistantMessageIndex !== null &&
        //             assistantMessageIndex >= 0 &&
        //             assistantMessageIndex < nextMessages.length &&
        //             nextMessages[assistantMessageIndex]?.role === "assistant"
        //         ) {
        //             nextMessages[assistantMessageIndex] = { ...nextMessages[assistantMessageIndex], content, status: "complete" };
        //             return nextMessages;
        //         }

        //         const lastIndex = nextMessages.length - 1;
        //         if (lastIndex >= 0 && nextMessages[lastIndex]?.role === "assistant") {
        //             nextMessages[lastIndex] = { ...nextMessages[lastIndex], content, status: "complete" };
        //             return nextMessages;
        //         }
        //         return [...nextMessages, { role: "assistant", content, status: "complete" }];
        //     });
        // };

        // In submitChatMessage, after receiving the response
        const updateAssistantMessage = (content) => {
            setMessages((prev) => {
                const nextMessages = [...prev];

                // Check if the response is a follow-up request
                let isFollowUp = false;
                let followUpMessage = content;

                try {
                    // Try to parse as JSON for follow-up detection
                    if (typeof content === 'string' && content.startsWith('{')) {
                        const parsed = JSON.parse(content);
                        if (parsed.type === 'followup') {
                            isFollowUp = true;
                            followUpMessage = parsed.message;
                            // Store expected response type for future messages
                            setFollowUpExpected(parsed.expected);
                        }
                    }
                } catch (e) {
                    // Not JSON, proceed normally
                }

                if (
                    assistantMessageIndex !== null &&
                    assistantMessageIndex >= 0 &&
                    assistantMessageIndex < nextMessages.length &&
                    nextMessages[assistantMessageIndex]?.role === "assistant"
                ) {
                    nextMessages[assistantMessageIndex] = {
                        ...nextMessages[assistantMessageIndex],
                        content: followUpMessage,
                        status: "complete",
                        isFollowUp: isFollowUp
                    };
                    return nextMessages;
                }

                const lastIndex = nextMessages.length - 1;
                if (lastIndex >= 0 && nextMessages[lastIndex]?.role === "assistant") {
                    nextMessages[lastIndex] = {
                        ...nextMessages[lastIndex],
                        content: followUpMessage,
                        status: "complete",
                        isFollowUp: isFollowUp
                    };
                    return nextMessages;
                }
                return [...nextMessages, { role: "assistant", content: followUpMessage, status: "complete", isFollowUp: isFollowUp }];
            });
        };

        try {
            const userId = auth?.id ? String(auth.id) : null;
            const activeThreadId = isLoggedIn ? currentThreadId : "";
            const requestId = window.crypto?.randomUUID?.() || `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
            const res = await fetch(`${apiBaseUrl}/api/chat`, {
                method: "POST",
                cache: "no-store",
                credentials: auth ? "include" : "omit",
                headers: {
                    "Content-Type": "application/json",
                    "Cache-Control": "no-cache",
                    "X-Quantic-Request-Id": requestId,
                    ...(userId ? { "x-user-id": userId } : {}),
                    ...(activeThreadId ? { "x-chat-thread-id": activeThreadId } : {}),
                },
                // body: JSON.stringify({
                //     message: normalizedUserMessage,
                //     conversation: recentConversation,
                body: JSON.stringify({
                    message: normalizedUserMessage || (messageAttachments.length ? "Shared an attachment." : ""),
                    conversation: recentConversation,
                    attachments: messageAttachments,
                    userTime: new Date().toISOString(),
                    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    ...(!userId ? { guestId: getGuestDeviceId() } : {}),
                    ...(options.regenerate ? { regenerate: true } : {}),
                    ...(assistantMessageIndex !== null ? { assistantMessageIndex } : {}),
                    ...(editMessageIndex !== null ? { editMessageIndex } : {}),
                }),
            });

            console.log("[ChatPage] send:response status", res.status);

            if (!res.ok) {
                const errorText = await res.text();
                console.log("[ChatPage] send:non-ok response", errorText);
                throw new Error(errorText || `Request failed with status ${res.status}`);
            }

            const responseThreadId = String(res.headers.get("x-chat-thread-id") || "").trim();
            const rawResponseThreadTitle = String(res.headers.get("x-chat-thread-title") || "").trim();
            let responseThreadTitle = "";
            try {
                responseThreadTitle = rawResponseThreadTitle ? decodeURIComponent(rawResponseThreadTitle) : "";
            } catch {
                responseThreadTitle = rawResponseThreadTitle;
            }

            if (responseThreadId) {
                setCurrentThreadId(responseThreadId);

                setChatThreads((currentThreads) => {
                    const nowIso = new Date().toISOString();
                    const exists = currentThreads.some((thread) => thread.id === responseThreadId);

                    if (exists) {
                        if (!responseThreadTitle) {
                            return currentThreads;
                        }

                        return currentThreads.map((thread) =>
                            thread.id === responseThreadId
                                ? { ...thread, title: responseThreadTitle, lastMessageAt: nowIso }
                                : thread
                        );
                    }

                    // Insert on id alone, so a stripped title header still creates the sidebar row.
                    return [
                        {
                            id: responseThreadId,
                            title: responseThreadTitle || "New chat",
                            preview: "",
                            pinned: false,
                            lastMessageAt: nowIso,
                            createdAt: nowIso,
                            updatedAt: nowIso,
                            messageCount: 1,
                        },
                        ...currentThreads,
                    ];
                });
            }

            const contentType = res.headers.get("content-type") || "";
            const isStreamSupported = Boolean(res.body?.getReader) && contentType.includes("text/plain");
            const shouldSpeakVoiceReply = voiceConversationOpenRef.current;

            if (voiceConversationOpenRef.current) {
                stopVoiceListening({ keepVoiceMode: true });
            }

            if (isStreamSupported) {
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let botText = "";

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    const chunk = decoder.decode(value, { stream: true });
                    botText += chunk;
                    console.log("[ChatPage] send:stream chunk", chunk);
                    if (!stripSourcesMarker(botText).trim()) continue;
                    updateAssistantMessage(botText);
                }

                const trailingText = decoder.decode();
                if (trailingText) {
                    botText += trailingText;
                    updateAssistantMessage(botText);
                }

                updateAssistantMessage(botText);
                if (shouldSpeakVoiceReply && botText.trim()) {
                    window.setTimeout(() => {
                        void handleReadMessageAloud(botText, { resumeListening: true });
                    }, 100);
                }
                if (isLoggedIn) {
                    void refreshChatHistoryList({
                        nextThreadId: responseThreadId || activeThreadId,
                        preserveTitleForThreadId: responseThreadId,
                        preservedTitle: responseThreadTitle,
                    });
                }
                return;
            }

            const text = await res.text();
            console.log("[ChatPage] send:non-stream body", text);

            let parsedResponse = null;
            if (contentType.includes("application/json")) {
                try {
                    parsedResponse = JSON.parse(text);
                } catch {
                    parsedResponse = null;
                }
            }

            if (parsedResponse?.replyType === "image" && Array.isArray(parsedResponse.attachments) && parsedResponse.attachments.length) {
                setMessages((prev) => {
                    const nextMessages = [...prev];
                    const imageMessage = {
                        role: "assistant",
                        content: String(parsedResponse.content || ""),
                        attachments: normalizeMessageAttachments(parsedResponse.attachments),
                        status: "complete",
                    };

                    if (
                        assistantMessageIndex !== null &&
                        assistantMessageIndex >= 0 &&
                        assistantMessageIndex < nextMessages.length &&
                        nextMessages[assistantMessageIndex]?.role === "assistant"
                    ) {
                        nextMessages[assistantMessageIndex] = imageMessage;
                        return nextMessages;
                    }

                    const lastIndex = nextMessages.length - 1;
                    if (lastIndex >= 0 && nextMessages[lastIndex]?.role === "assistant") {
                        nextMessages[lastIndex] = imageMessage;
                        return nextMessages;
                    }

                    return [...nextMessages, imageMessage];
                });
            } else {
                updateAssistantMessage(text);
                if (shouldSpeakVoiceReply && String(text || "").trim()) {
                    window.setTimeout(() => {
                        void handleReadMessageAloud(text, { resumeListening: true });
                    }, 100);
                }
            }
            if (isLoggedIn) {
                void refreshChatHistoryList({
                    nextThreadId: responseThreadId || activeThreadId,
                    preserveTitleForThreadId: responseThreadId,
                    preservedTitle: responseThreadTitle,
                });
            }
        } catch (error) {
            console.error("[ChatPage] send:error", error);
            updateAssistantMessage(error instanceof Error ? error.message : "Unable to get a reply.");
        } finally {
            setIsSending(false);
        }
    };

    useEffect(() => {
        submitChatMessageRef.current = submitChatMessage;
    }, [submitChatMessage]);

    useEffect(() => {
        isSendingRef.current = isSending;
    }, [isSending]);

    useEffect(() => {
        isListeningRef.current = isListening;
    }, [isListening]);

    useEffect(() => {
        isSpeakingRef.current = isSpeaking;
    }, [isSpeaking]);

    useEffect(() => {
        voiceModeEnabledRef.current = voiceModeEnabled;
    }, [voiceModeEnabled]);

    useEffect(() => {
        voiceConversationOpenRef.current = voiceConversationOpen;
    }, [voiceConversationOpen]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return undefined;
        }

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            return undefined;
        }

        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.lang = voiceLangRef.current || navigator?.language || "en-US";

        recognition.onstart = () => {
            // A new session starts with an empty results list.
            voiceConsumedRef.current = 0;
            voiceSessionTextRef.current = "";
            setIsListening(true);
        };

        recognition.onspeechstart = () => {
            // The user is talking again: never send while they are still mid-thought.
            if (voiceAutoSendTimerRef.current) {
                window.clearTimeout(voiceAutoSendTimerRef.current);
                voiceAutoSendTimerRef.current = null;
            }
            orbEngineRef.current?.setUserSpeaking(true);
        };

        recognition.onspeechend = () => {
            orbEngineRef.current?.setUserSpeaking(false);
        };

        recognition.onend = () => {
            setIsListening(false);
            orbEngineRef.current?.setUserSpeaking(false);

            // Keep everything said in this session, so restarting the recogniser never wipes it.
            if (voiceSessionTextRef.current) {
                voiceBaseTextRef.current = joinVoiceTranscript([voiceBaseTextRef.current, voiceSessionTextRef.current], recognition.lang);
                voiceSessionTextRef.current = "";
            }
            voiceConsumedRef.current = 0;

            if (voiceModeEnabledRef.current && !isSpeakingRef.current && !isSendingRef.current) {
                restartVoiceListening();
            }
        };

        recognition.onerror = (event) => {
            const code = String(event?.error || "");
            setIsListening(false);

            if (code === "aborted") {
                return;
            }

            if (code === "no-speech") {
                noSpeechStreakRef.current += 1;

                // Dictating into the text box: stop after a few silent rounds instead of listening forever.
                if (!voiceConversationOpenRef.current && noSpeechStreakRef.current >= 3) {
                    noSpeechStreakRef.current = 0;
                    stopVoiceListening();
                    showToastRef.current?.("Microphone stopped because no speech was heard.", { type: "info" });
                }
                return;
            }

            const problems = {
                "not-allowed": "Microphone access is blocked. Allow the microphone for this site in your browser settings.",
                "service-not-allowed": "Microphone access is blocked. Allow the microphone for this site in your browser settings.",
                "audio-capture": "No microphone was found. Check that a microphone is connected.",
                network: "Speech recognition needs an internet connection. Please check your network.",
                "language-not-supported": "This browser can't recognise the selected language. Try another language.",
            };

            if (problems[code]) {
                // These will not fix themselves, so stop instead of retrying in a loop.
                stopVoiceListening();
                showToastRef.current?.(problems[code], { type: "error" });
            }
        };

        recognition.onresult = (event) => {
            noSpeechStreakRef.current = 0;

            const results = event.results;
            const lastResult = results[results.length - 1];

            // If the text box was typed in or cleared since our last write (or a message was just sent),
            // start again from what is there now instead of bringing old words back.
            const boxValue = messageInputRef.current?.value;
            if (typeof boxValue === "string" && boxValue !== voiceLastDraftRef.current) {
                voiceBaseTextRef.current = boxValue.trim();
                voiceConsumedRef.current = lastResult?.isFinal ? results.length : Math.max(0, results.length - 1);
            }

            // Rebuild the WHOLE utterance from every result of this session, not just the newest one.
            // (The old code only looked at results from event.resultIndex onward, so each pause replaced
            // the earlier words.)
            const segments = [];
            for (let index = voiceConsumedRef.current; index < results.length; index += 1) {
                const text = String(results[index]?.[0]?.transcript || "").replace(/\s+/g, " ").trim();
                if (text) {
                    segments.push(text);
                }
            }

            const sessionText = joinVoiceTranscript(segments, recognition.lang);
            voiceSessionTextRef.current = sessionText;

            const fullText = joinVoiceTranscript([voiceBaseTextRef.current, sessionText], recognition.lang);
            voiceLastDraftRef.current = fullText;
            setMessageDraft(fullText);

            orbEngineRef.current?.pulse(0.25);
            if (!lastResult?.isFinal) {
                orbEngineRef.current?.setUserSpeaking(true);
            }

            if (!voiceConversationOpenRef.current || !fullText || isSpeakingRef.current || isSendingRef.current) {
                return;
            }

            // Send only after real silence. Every new word restarts the wait, and the message that is
            // sent is always the full text captured so far.
            if (voiceAutoSendTimerRef.current) {
                window.clearTimeout(voiceAutoSendTimerRef.current);
            }

            voiceAutoSendTimerRef.current = window.setTimeout(() => {
                const pendingTranscript = String(voiceLastDraftRef.current || "").trim();

                if (!pendingTranscript || !voiceConversationOpenRef.current || isSpeakingRef.current || isSendingRef.current) {
                    return;
                }

                stopVoiceListening({ keepVoiceMode: true });
                resetVoiceTranscript();
                setMessageDraft("");
                void submitChatMessageRef.current?.(pendingTranscript, { attachments: [] });
            }, lastResult?.isFinal ? VOICE_SEND_AFTER_FINAL_MS : VOICE_SEND_AFTER_INTERIM_MS);
        };

        recognitionRef.current = recognition;

        return () => {
            if (voiceAutoSendTimerRef.current) {
                window.clearTimeout(voiceAutoSendTimerRef.current);
                voiceAutoSendTimerRef.current = null;
            }

            if (voiceRestartTimerRef.current) {
                window.clearTimeout(voiceRestartTimerRef.current);
                voiceRestartTimerRef.current = null;
            }

            try {
                recognition.abort();
            } catch {
                // ignore
            }

            recognitionRef.current = null;
        };
    }, []);

    useEffect(() => {
        showToastRef.current = showToast;
    });

    // The electric orb: created when the voice conversation opens, driven by the microphone level
    // (user) and by a speech envelope + word boundaries (Quantic).
    useEffect(() => {
        if (!voiceConversationOpen || !orbCanvasRef.current) {
            return undefined;
        }

        const meter = createMicLevelMeter();
        void meter.start();

        const engine = createLightningOrb(orbCanvasRef.current, {
            getUserLevel: () => meter.getLevel(),
            hasMeter: () => meter.isActive(),
            reduceMotion,
        });
        orbEngineRef.current = engine;

        return () => {
            engine.destroy();
            meter.stop();
            orbEngineRef.current = null;
        };
    }, [voiceConversationOpen, reduceMotion]);

    useEffect(() => {
        const nextMode = isSpeaking ? "speaking" : isSending ? "thinking" : isListening ? "listening" : "idle";
        orbEngineRef.current?.setMode(nextMode);
    }, [voiceConversationOpen, reduceMotion, isSpeaking, isSending, isListening]);

    useEffect(() => {
        const node = voiceCaptionRef.current;
        if (node) {
            node.scrollTop = node.scrollHeight;
        }
    }, [messageDraft, voiceConversationOpen]);

    useEffect(() => {
        autoResizeTextarea(messageInputRef.current);
    }, [messageDraft]);

    useEffect(() => {
        return () => {
            if (copiedMessageTimeoutRef.current) {
                window.clearTimeout(copiedMessageTimeoutRef.current);
            }
        };
    }, []);

    const handleRegenerateMessage = async (messageIndex) => {
        if (isSending) {
            return;
        }

        const sourceMessage = [...messages.slice(0, messageIndex)].reverse().find((entry) => entry.role === "user" && entry.content);

        if (!sourceMessage) {
            return;
        }

        setMessages((currentMessages) =>
            currentMessages.map((message, index) =>
                index === messageIndex
                    ? { role: "assistant", content: "", status: "loading" }
                    : message
            )
        );

        await submitChatMessage(sourceMessage.content, {
            conversation: messages.slice(0, messageIndex),
            attachments: normalizeMessageAttachments(sourceMessage.attachments),
            appendUserToTranscript: false,
            assistantMessageIndex: messageIndex,
            regenerate: true,
        });
    };

    const updateThreadList = (threadId, updater) => {
        if (!threadId) {
            return;
        }

        setChatThreads((currentThreads) =>
            currentThreads.map((thread) => (thread.id === threadId ? updater(thread) : thread))
        );
    };

    useEffect(() => {
        if (typeof window !== "undefined") {
            sessionStorage.setItem(activeViewStorageKey, activeView);
        }
    }, [activeView]);

    useEffect(() => {
        if (typeof window !== "undefined") {
            sessionStorage.setItem(sidebarOpenStorageKey, String(sidebarOpen));
        }
    }, [sidebarOpen]);

    // On mobile the sidebar is an overlay drawer — lock body scroll while open
    // and force the drawer closed when crossing the 900px breakpoint.
    useEffect(() => {
        if (typeof window === "undefined" || typeof document === "undefined") {
            return undefined;
        }

        const mobileQuery = window.matchMedia("(max-width: 900px)");

        const syncBodyScrollLock = () => {
            const shouldLock = mobileQuery.matches && sidebarOpen;
            document.body.classList.toggle("sidebar-drawer-open", shouldLock);
        };

        const handleBreakpointChange = (event) => {
            if (event.matches) {
                // Entered mobile: close the drawer so content is full-bleed
                setSidebarOpen(false);
            } else {
                // Left mobile: restore a sensible desktop default (open)
                setSidebarOpen(true);
            }
            syncBodyScrollLock();
        };

        syncBodyScrollLock();

        if (typeof mobileQuery.addEventListener === "function") {
            mobileQuery.addEventListener("change", handleBreakpointChange);
            return () => {
                mobileQuery.removeEventListener("change", handleBreakpointChange);
                document.body.classList.remove("sidebar-drawer-open");
            };
        }

        // Safari < 14
        mobileQuery.addListener(handleBreakpointChange);
        return () => {
            mobileQuery.removeListener(handleBreakpointChange);
            document.body.classList.remove("sidebar-drawer-open");
        };
    }, [sidebarOpen]);

    useEffect(() => {
        closeChatMenu();
    }, [currentThreadId]);

    useEffect(() => {
        return undefined;
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        if (!isLoggedIn) {
            writeStoredMessages(guestChatHistoryStorageKey, messages);
        }
    }, [messages, isLoggedIn]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        setSelectedAttachments(readStoredAttachments(draftAttachmentsStorageKey));
    }, [draftAttachmentsStorageKey]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        writeStoredAttachments(draftAttachmentsStorageKey, selectedAttachments);
    }, [draftAttachmentsStorageKey, selectedAttachments]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        if (!auth) {
            setChatThreads([]);
            setChatHistoryLoading(false);
            setChatHistoryError("");
            setCurrentThreadId("");
            setMessages(readStoredMessages(guestChatHistoryStorageKey));
            return;
        }

        let cancelled = false;

        const loadChatHistory = async () => {
            setChatHistoryLoading(true);
            setChatHistoryError("");

            try {
                const response = await fetch(`${apiBaseUrl}/api/chat/history`, {
                    cache: "no-store",
                    headers: { "Cache-Control": "no-cache" },
                    credentials: "include",
                });

                if (cancelled) {
                    return;
                }

                if (!response.ok) {
                    if (response.status === 401) {
                        sessionStorage.removeItem(authKnownStorageKey);
                        sessionStorage.removeItem(authProfileStorageKey);
                        sessionStorage.removeItem(activeViewStorageKey);
                        setAuth(null);
                        setActiveView("discover");
                    }
                    return;
                }

                const responseData = await readJsonResponse(response);
                const threads = Array.isArray(responseData?.threads) ? responseData.threads.map(normalizeThreadSummary).filter((thread) => thread.id) : [];

                if (cancelled) {
                    return;
                }

                setChatThreads(threads);

                if (threads.length === 0) {
                    setCurrentThreadId("");
                    setMessages([]);
                    return;
                }

                const selectedThread = threads[0];
                setCurrentThreadId(selectedThread.id);

                const threadResponse = await fetch(`${apiBaseUrl}/api/chat/history/${selectedThread.id}`, {
                    cache: "no-store",
                    headers: { "Cache-Control": "no-cache" },
                    credentials: "include",
                });

                if (cancelled) {
                    return;
                }

                if (threadResponse.ok) {
                    const threadData = await readJsonResponse(threadResponse);
                    setMessages(normalizeThreadMessages(threadData?.thread?.messages));
                } else {
                    setMessages([]);
                }
            } catch {
                if (!cancelled) {
                    setChatThreads([]);
                    setCurrentThreadId("");
                    setMessages([]);
                    setChatHistoryError("Unable to load chat history.");
                }
            } finally {
                if (!cancelled) {
                    setChatHistoryLoading(false);
                }
            }
        };

        loadChatHistory();

        return () => {
            cancelled = true;
        };
    }, [auth?.id]);

    useEffect(() => {
        if (typeof window === "undefined") {
            return;
        }

        const cachedProfile = readStoredJson(authProfileStorageKey, null);

        if (cachedProfile) {
            setAuth(cachedProfile);
        }

        if (sessionStorage.getItem(authKnownStorageKey) !== "true" && !cachedProfile) {
            setAuth(null);
            return;
        }

        let cancelled = false;
        const loadSession = async () => {
            try {
                const response = await fetch(`${apiBaseUrl}/api/auth/me`, {
                    credentials: "include",
                });

                if (cancelled) {
                    return;
                }

                if (!response.ok) {
                    if (response.status === 401 || response.status === 403) {
                        sessionStorage.removeItem(authKnownStorageKey);
                        sessionStorage.removeItem(authProfileStorageKey);
                        setAuth(null);

                        if (response.status === 403) {
                            setTimeout(() => {
                                showToast("Your account has been suspended.", { type: "error" });
                            }, 100);
                        }
                    }
                    return;
                }

                const responseData = await readJsonResponse(response);
                if (responseData?.user) {
                    setAuth(responseData.user);
                    sessionStorage.setItem(authKnownStorageKey, "true");
                    sessionStorage.setItem(authProfileStorageKey, JSON.stringify(responseData.user));
                } else {
                    if (!cachedProfile) {
                        setAuth(null);
                    }
                }
            } catch {
                return;
            }
        };

        loadSession();

        return () => {
            cancelled = true;
        };
    }, []);

    const legalCopySegments = getLegalCopySegments(isLoggedIn);

    const fetchChatThreadList = async () => {
        const response = await fetch(`${apiBaseUrl}/api/chat/history`, {
            credentials: "include",
        });

        if (!response.ok) {
            if (response.status === 401) {
                return [];
            }

            throw new Error("Unable to load chat history.");
        }

        const responseData = await readJsonResponse(response);
        return Array.isArray(responseData?.threads) ? responseData.threads.map(normalizeThreadSummary).filter((thread) => thread.id) : [];
    };

    const fetchChatThreadMessages = async (threadId) => {
        if (!threadId) {
            return [];
        }

        const response = await fetch(`${apiBaseUrl}/api/chat/history/${threadId}`, {
            credentials: "include",
        });

        if (!response.ok) {
            throw new Error("Unable to load chat thread.");
        }

        const responseData = await readJsonResponse(response);
        return normalizeThreadMessages(responseData?.thread?.messages);
    };

    const updateChatThread = async (threadId, payload) => {
        if (!threadId) {
            return null;
        }

        const response = await fetch(`${apiBaseUrl}/api/chat/history/${threadId}`, {
            method: "PATCH",
            credentials: "include",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });

        if (!response.ok) {
            throw new Error("Unable to update chat history.");
        }

        const responseData = await readJsonResponse(response);
        return normalizeThreadSummary(responseData?.thread);
    };

    const deleteChatThread = async (threadId) => {
        if (!threadId) {
            return false;
        }

        const response = await fetch(`${apiBaseUrl}/api/chat/history/${threadId}`, {
            method: "DELETE",
            credentials: "include",
        });

        if (!(response.ok || response.status === 204)) {
            throw new Error("Unable to delete chat history.");
        }

        return true;
    };

    const refreshChatHistoryList = async ({
        nextThreadId = "",
        loadThreadId = "",
        preserveTitleForThreadId = "",
        preservedTitle = "",
    } = {}) => {
        if (!auth?.id) {
            return;
        }

        try {
            const threads = await fetchChatThreadList();
            const normalizedPreservedTitle = String(preservedTitle || "").trim();

            setChatThreads(
                normalizedPreservedTitle && preserveTitleForThreadId
                    ? threads.map((thread) =>
                        thread.id === preserveTitleForThreadId && (!thread.title || thread.title === "New chat")
                            ? { ...thread, title: normalizedPreservedTitle }
                            : thread
                    )
                    : threads
            );

            const resolvedThreadId = loadThreadId || nextThreadId || currentThreadId || threads[0]?.id || "";
            if (resolvedThreadId && threads.some((thread) => thread.id === resolvedThreadId)) {
                setCurrentThreadId(resolvedThreadId);
            }
        } catch {
            return;
        }
    };
    const openHistoryThread = async (threadId) => {
        if (!threadId) {
            return;
        }

        stopVoicePlayback();
        stopVoiceListening();
        setActiveView("chat");
        setCurrentThreadId(threadId);
        setMessageDraft("");

        try {
            const threadMessages = await fetchChatThreadMessages(threadId);
            setMessages(threadMessages);
        } catch {
            setChatHistoryError("Unable to open that chat.");
        }
    };

    const openAuth = (mode) => {
        setAuthMode(mode);
        setAuthError("");
        setLoginOpen(true);
    };

    const handleAdminAccess = () => {
        if (!auth?.email) {
            return;
        }

        setAdminPrefillEmail(auth.email);
        setAuthMode("admin");
        setAuthError("");
        setLoginOpen(true);
    };

    const handleLogin = (profile) => {
        sessionStorage.setItem(authKnownStorageKey, "true");
        sessionStorage.setItem(authProfileStorageKey, JSON.stringify(profile));
        setAuth(profile);
        setMessages([]);
        setCurrentThreadId("");
        setChatThreads([]);
        setChatHistoryError("");
        setLoginOpen(false);
        setActiveView("chat");
        setAuthMode("login");
        setAuthError("");
        // Mobile: always close the drawer after login so the chat is full-bleed.
        // Desktop sidebar state is left alone.
        if (isMobileViewport()) {
            setSidebarOpen(false);
        }
        // Use setTimeout to ensure the toast shows after state updates
        setTimeout(() => {
            showToast(`Welcome back, ${profile?.name || 'User'}!`, { type: "success" });
        }, 100);
    };

    const handleProfileUpdate = (nextProfile) => {
        const nextAvatarUrl = nextProfile?.avatarUrl || nextProfile?.settings?.profileImage || nextProfile?.profileImage || auth?.avatarUrl || "";
        const nextDisplayName = nextProfile?.settings?.displayName || nextProfile?.name || auth?.name || "Quantic user";

        const mergedProfile = {
            ...auth,
            ...nextProfile,
            name: nextDisplayName,
            avatarUrl: nextAvatarUrl,
            settings: {
                ...(auth?.settings || {}),
                ...(nextProfile?.settings || {}),
            },
        };

        setAuth(mergedProfile);
        sessionStorage.setItem(authProfileStorageKey, JSON.stringify(mergedProfile));
    };

    const handleLogoutRequest = () => {
        setLogoutConfirmOpen(true);
    };

    const handleLogout = async () => {
        stopVoicePlayback();
        stopVoiceListening();

        try {
            await fetch(`${apiBaseUrl}/api/auth/logout`, {
                method: "POST",
                credentials: "include",
            });
        } catch (error) {
            console.error("Logout error:", error);
        } finally {
            setLogoutConfirmOpen(false);
            sessionStorage.removeItem(activeViewStorageKey);
            sessionStorage.removeItem(sidebarOpenStorageKey);
            sessionStorage.removeItem(authKnownStorageKey);
            sessionStorage.removeItem(authProfileStorageKey);
            sessionStorage.removeItem("quantic_admin_access_granted");
            localStorage.removeItem(guestChatHistoryStorageKey);
            setAuth(null);
            setActiveView("discover");
            setSidebarOpen(getDefaultSidebarOpenState());
            setArchivedThreadIds(new Set());
            setCurrentThreadId("");
            setChatThreads([]);
            setChatHistoryError("");
            setSelectedAttachments([]);
            setMessages([]);
            showToast("Logged out successfully", { type: "success" });
        }
    };

    const handleAccountDeleted = () => {
        stopVoicePlayback();
        stopVoiceListening();
        setLogoutConfirmOpen(false);
        sessionStorage.removeItem(activeViewStorageKey);
        sessionStorage.removeItem(sidebarOpenStorageKey);
        sessionStorage.removeItem(authKnownStorageKey);
        sessionStorage.removeItem(authProfileStorageKey);
        setAuth(null);
        setActiveView("discover");
        setSidebarOpen(getDefaultSidebarOpenState());
        setArchivedThreadIds(new Set());
        setCurrentThreadId("");
        setChatThreads([]);
        setChatHistoryError("");
        setSelectedAttachments([]);
        setMessages(readStoredMessages(guestChatHistoryStorageKey));
        setTimeout(() => {
            showToast("Account deletion scheduled. You've been signed out.", { type: "warning" });
        }, 100);
    };

    const handleNewChat = () => {
        stopVoicePlayback();
        stopVoiceListening();
        setActiveView("chat");
        setCurrentThreadId("");
        setMessageDraft("");
        setSelectedAttachments([]);
        setMessages([]);
        closeChatMenu();
    };

    const handleStarterPrompt = (prompt) => {
        setActiveView("chat");
        setMessageDraft(prompt);
        closeChatMenu();
    };

    const handleShareChat = async () => {
        const shareData = {
            title: "Quantic AI",
            text: "Chat in Quantic AI",
            url: window.location.href,
        };

        try {
            if (navigator.share) {
                await navigator.share(shareData);
            } else if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(window.location.href);
            }
        } catch {
            return;
        } finally {
            closeChatMenu();
        }
    };

    const handleTogglePinChat = () => {
        if (!currentThreadId || !activeChatThread) {
            closeChatMenu();
            showToast("Open a saved chat to pin it.", { type: "info" });
            return;
        }

        const nextPinned = !chatPinned;
        updateChatThread(currentThreadId, { pinned: nextPinned })
            .then((updatedThread) => {
                if (updatedThread) {
                    updateThreadList(currentThreadId, () => updatedThread);
                    showToast(nextPinned ? "Chat pinned" : "Chat unpinned", { type: "info" });
                }
            })
            .catch(() => {
                setChatHistoryError("Unable to update chat pin.");
            })
            .finally(() => {
                closeChatMenu();
            });
    };

    const handleToggleArchiveChat = () => {
        if (!currentThreadId || !activeChatThread) {
            closeChatMenu();
            showToast("Open a saved chat to archive it.", { type: "info" });
            return;
        }

        const nextArchived = !chatArchived;

        // Update on backend
        updateChatThread(currentThreadId, { archived: nextArchived })
            .then((updatedThread) => {
                if (updatedThread) {
                    updateThreadList(currentThreadId, () => updatedThread);
                    // Update local archive state
                    setArchivedThreadIds((current) => {
                        const next = new Set(current);
                        if (nextArchived) {
                            next.add(currentThreadId);
                        } else {
                            next.delete(currentThreadId);
                        }
                        return next;
                    });
                    showToast(nextArchived ? "Chat archived" : "Chat unarchived", { type: "info" });
                }
            })
            .catch(() => {
                setChatHistoryError("Unable to update chat archive status.");
                showToast("Unable to update chat archive status.", { type: "error" });
            })
            .finally(() => {
                closeChatMenu();
            });
    };

    const handleDeleteChat = async () => {
        if (!currentThreadId) {
            setMessageDraft("");
            closeChatMenu();
            showToast("Open a saved chat to delete it.", { type: "info" });
            return;
        }

        try {
            const deleted = await deleteChatThread(currentThreadId);

            if (!deleted) {
                return;
            }

            setArchivedThreadIds((current) => {
                if (!current.has(currentThreadId)) {
                    return current;
                }

                const nextArchived = new Set(current);
                nextArchived.delete(currentThreadId);
                return nextArchived;
            });
            setMessageDraft("");
            setChatThreads((currentThreads) => currentThreads.filter((thread) => thread.id !== currentThreadId));
            setCurrentThreadId("");
            setMessages([]);
            await refreshChatHistoryList();
            showToast("Chat deleted successfully", { type: "success" });
        } catch {
            setChatHistoryError("Unable to delete chat.");
        } finally {
            closeChatMenu();
        }
    };

    const handleBeginRenameChatThread = (threadId) => {
        const currentThread = chatThreads.find((thread) => thread.id === threadId);
        closeThreadMenu();
        setChatRenameSavingThreadId("");
        setChatRenamingThreadId(threadId);
        setChatRenameDraft(currentThread?.title || "New chat");
    };

    const handleCommitRenameChatThread = async (threadId) => {
        if (!threadId || chatRenameSavingThreadId === threadId) {
            return;
        }

        const normalizedTitle = chatRenameDraft.trim();

        if (!normalizedTitle) {
            setChatHistoryError("Chat title cannot be empty.");
            closeThreadRename();
            return;
        }

        try {
            setChatRenameSavingThreadId(threadId);
            const updatedThread = await updateChatThread(threadId, { title: normalizedTitle });

            if (updatedThread) {
                updateThreadList(threadId, () => updatedThread);
                showToast("Chat renamed successfully", { type: "success" });
            }

            closeThreadRename();
        } catch {
            setChatHistoryError("Unable to rename chat.");
        } finally {
            setChatRenameSavingThreadId("");
        }
    };

    const handleCancelRenameChatThread = () => {
        closeThreadRename();
    };

    const handleToggleChatThreadMenu = (threadId) => {
        setChatMenuThreadId((currentThreadId) => (currentThreadId === threadId ? "" : threadId));
    };

    const handleDeleteChatThread = (threadId) => {
        closeThreadMenu();
        closeThreadRename();
        setChatDeleteConfirmThreadId(threadId);
    };

    const confirmDeleteChatThread = async (threadId) => {
        if (!threadId) {
            closeDeleteChatThread();
            return;
        }

        try {
            const deleted = await deleteChatThread(threadId);

            if (!deleted) {
                return;
            }

            setChatThreads((currentThreads) => currentThreads.filter((thread) => thread.id !== threadId));

            if (currentThreadId === threadId) {
                setCurrentThreadId("");
                setMessages([]);
                setActiveView("chat");
            }

            // Add toast notification
            showToast("Chat deleted successfully", { type: "success" });
        } catch {
            setChatHistoryError("Unable to delete chat.");
            showToast("Unable to delete chat.", { type: "error" });
        } finally {
            closeDeleteChatThread();
        }
    };

    const activeLegalContent = activeLegalPage ? legalPages[activeLegalPage] : null;
    const voiceConversationStatus = isSpeaking
        ? "Speaking response..."
        : isSending
            ? "Thinking..."
            : isListening
                ? "Listening..."
                : "Say something...";
    const voiceLanguageOptions = getVoiceLanguageOptions(voiceLang);
    const activeVoiceLanguage = voiceLanguageOptions.find((option) => option.code === voiceLang) || voiceLanguageOptions[0];
    const openVoiceConversation = () => {
        startVoiceConversation();
    };
    const closeVoiceConversation = () => {
        handleStopVoiceMode();
    };
    const handleComposerVoiceButtonClick = () => {
        if (voiceConversationOpen) {
            closeVoiceConversation();
            return;
        }

        openVoiceConversation();
    };
    const composerHasTypedText = Boolean(messageDraft.trim());
    const composerPrimaryAction = composerHasTypedText && !voiceConversationOpen ? (
        <button className="chat-composer__send" type="submit" aria-label="Send message" disabled={isSending}>
            {isSending ? <SendingIcon /> : <SendIcon />}
        </button>
    ) : (
        <button
            type="button"
            className={`chat-composer__voice-button ${isSpeaking ? "is-speaking" : ""}`}
            onClick={handleComposerVoiceButtonClick}
            aria-label={isSpeaking ? "Stop voice playback" : "Use voice mode"}
            title={isSpeaking ? "Stop voice playback" : "Use voice mode"}
        >
            <span className="material-symbols-rounded">{isSpeaking ? "stop" : "graphic_eq"}</span>
        </button>
    );
    const voiceControls = (
        <div className="chat-composer__voice-controls" aria-label="Voice controls">
            {isListening || voiceModeEnabled ? (
                <button
                    type="button"
                    className="chat-composer__voice-lang"
                    onClick={handleCycleVoiceLanguage}
                    aria-label={`Speech language: ${activeVoiceLanguage.label}. Click to change.`}
                    title={`Speech language: ${activeVoiceLanguage.label} (click to change)`}
                >
                    {activeVoiceLanguage.short}
                </button>
            ) : null}
            <button
                type="button"
                className={`chat-composer__voice-button ${isListening ? "is-active" : ""}`}
                onClick={handleToggleVoiceMode}
                aria-label={isListening ? "Stop listening" : "Dictate"}
                title={isListening ? "Stop listening" : "Dictate"}
            >
                <span className="material-symbols-rounded">{isListening ? "mic_off" : "mic"}</span>
            </button>
            {composerPrimaryAction}
        </div>
    );

    const chatDeleteConfirmThread = chatDeleteConfirmThreadId
        ? chatThreads.find((thread) => thread.id === chatDeleteConfirmThreadId) || null
        : null;
    const rawChatDeleteConfirmTitle = chatDeleteConfirmThread?.title || "this chat";
    const chatDeleteConfirmTitle = rawChatDeleteConfirmTitle.length > 80
        ? `${rawChatDeleteConfirmTitle.slice(0, 80).trim()}…`
        : rawChatDeleteConfirmTitle;

    const handleAuthSubmit = async ({ mode, name, email, password, otp, newPassword }) => {
        setAuthLoading(true);
        setAuthError("");

        try {
            const trimmedEmail = email?.trim();
            const trimmedPassword = password?.trim();
            const trimmedName = name?.trim();
            const trimmedOtp = otp?.trim();
            const trimmedNewPassword = newPassword?.trim();

            // Forgot password flow
            if (mode === "forgot") {
                if (!trimmedEmail) {
                    throw new Error("Email is required.");
                }

                const response = await fetch(`${apiBaseUrl}/api/auth/forgot-password`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    credentials: "include",
                    body: JSON.stringify({ email: trimmedEmail }),
                });

                const responseData = await readJsonResponse(response);

                if (!response.ok) {
                    throw new Error(responseData?.message || "Failed to send OTP.");
                }

                setAuthError(responseData.message || "OTP sent to your email.");
                return;
            }

            // Verify OTP flow
            if (mode === "verify-otp") {
                if (!trimmedEmail || !trimmedOtp) {
                    throw new Error("Email and OTP are required.");
                }

                const response = await fetch(`${apiBaseUrl}/api/auth/verify-reset-otp`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    credentials: "include",
                    body: JSON.stringify({ email: trimmedEmail, otp: trimmedOtp }),
                });

                const responseData = await readJsonResponse(response);

                if (!response.ok) {
                    throw new Error(responseData?.message || "OTP verification failed.");
                }

                setAuthLoading(false);
                return { success: true };
            }

            // Verify login OTP flow (2FA)
            // if (mode === "verify-login-otp") {
            //     if (!trimmedEmail || !trimmedOtp) {
            //         throw new Error("Email and verification code are required.");
            //     }

            //     const response = await fetch(`${apiBaseUrl}/api/auth/verify-login-otp`, {
            //         method: "POST",
            //         headers: {
            //             "Content-Type": "application/json",
            //         },
            //         credentials: "include",
            //         body: JSON.stringify({ email: trimmedEmail, otp: trimmedOtp }),
            //     });

            //     const responseData = await readJsonResponse(response);

            //     if (!response.ok) {
            //         throw new Error(responseData?.message || "Verification failed.");
            //     }

            //     handleLogin(responseData.user);
            //     return { success: true, newBrowserLogin: responseData?.newBrowserLogin };
            // }

            // Verify login OTP flow (2FA)
            // if (mode === "verify-login-otp") {
            //     if (!trimmedEmail || !trimmedOtp) {
            //         throw new Error("Email and verification code are required.");
            //     }

            //     const response = await fetch(`${apiBaseUrl}/api/auth/verify-login-otp`, {
            //         method: "POST",
            //         headers: {
            //             "Content-Type": "application/json",
            //         },
            //         credentials: "include",
            //         body: JSON.stringify({ email: trimmedEmail, otp: trimmedOtp }),
            //     });

            //     const responseData = await readJsonResponse(response);

            //     if (!response.ok) {
            //         throw new Error(responseData?.message || "Verification failed.");
            //     }

            //     if (adminTwoFactorPending) {
            //         setAdminTwoFactorPending(false);

            //         if (responseData?.user?.role !== "admin") {
            //             throw new Error("This account does not have admin access.");
            //         }

            //         setLoginOpen(false);
            //         setAuthMode("login");
            //         window.location.href = "/admin";
            //         return { success: true };
            //     }

            //     handleLogin(responseData.user);
            //     return { success: true, newBrowserLogin: responseData?.newBrowserLogin };
            // }

            if (mode === "verify-login-otp") {
                if (!trimmedEmail || !trimmedOtp) {
                    throw new Error("Email and verification code are required.");
                }

                const response = await fetch(`${apiBaseUrl}/api/auth/verify-login-otp`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    credentials: "include",
                    body: JSON.stringify({ email: trimmedEmail, otp: trimmedOtp }),
                });

                const responseData = await readJsonResponse(response);

                if (!response.ok) {
                    throw new Error(responseData?.message || "Verification failed.");
                }

                if (adminTwoFactorPending) {
                    setAdminTwoFactorPending(false);

                    if (responseData?.user?.role !== "admin") {
                        throw new Error("This account does not have admin access.");
                    }

                    try {
                        sessionStorage.setItem("quantic_admin_access_granted", "true");
                    } catch {
                        // ignore storage errors
                    }

                    setLoginOpen(false);
                    setAuthMode("login");
                    window.location.href = "/admin";
                    return { success: true };
                }

                handleLogin(responseData.user);
                return { success: true, newBrowserLogin: responseData?.newBrowserLogin };
            }

            // Reset password flow
            if (mode === "reset-password") {
                if (!trimmedEmail || !trimmedNewPassword) {
                    throw new Error("Email and new password are required.");
                }

                const response = await fetch(`${apiBaseUrl}/api/auth/reset-password`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    credentials: "include",
                    body: JSON.stringify({ email: trimmedEmail, newPassword: trimmedNewPassword }),
                });

                const responseData = await readJsonResponse(response);

                if (!response.ok) {
                    throw new Error(responseData?.message || "Password reset failed.");
                }

                setAuthMode("login");
                setAuthError("Password reset successful. Please log in.");
                setAuthLoading(false);
                return;
            }

            // Admin step-up confirmation flow
            // if (mode === "admin") {
            //     if (!trimmedEmail || !trimmedPassword) {
            //         throw new Error("Email and password are required.");
            //     }

            //     const response = await fetch(`${apiBaseUrl}/api/auth/login`, {
            //         method: "POST",
            //         headers: {
            //             "Content-Type": "application/json",
            //         },
            //         credentials: "include",
            //         body: JSON.stringify({ email: trimmedEmail, password: trimmedPassword }),
            //     });

            //     const responseData = await readJsonResponse(response);

            //     if (!response.ok) {
            //         throw new Error(responseData?.message || "Authentication failed. Please try again.");
            //     }

            //     if (responseData?.twoFactorRequired) {
            //         setAdminTwoFactorPending(true);
            //         setAuthError("");
            //         return { twoFactorRequired: true, email: responseData?.email || trimmedEmail };
            //     }

            //     if (responseData?.user?.role !== "admin") {
            //         throw new Error("This account does not have admin access.");
            //     }

            //     setLoginOpen(false);
            //     setAuthMode("login");
            //     window.location.href = "/admin";
            //     return { success: true };
            // }

            if (mode === "admin") {
                if (!trimmedEmail || !trimmedPassword) {
                    throw new Error("Email and password are required.");
                }

                const response = await fetch(`${apiBaseUrl}/api/auth/login`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    credentials: "include",
                    body: JSON.stringify({ email: trimmedEmail, password: trimmedPassword }),
                });

                const responseData = await readJsonResponse(response);

                if (!response.ok) {
                    throw new Error(responseData?.message || "Authentication failed. Please try again.");
                }

                if (responseData?.twoFactorRequired) {
                    setAdminTwoFactorPending(true);
                    setAuthError("");
                    return { twoFactorRequired: true, email: responseData?.email || trimmedEmail };
                }

                if (responseData?.user?.role !== "admin") {
                    throw new Error("This account does not have admin access.");
                }

                try {
                    sessionStorage.setItem("quantic_admin_access_granted", "true");
                } catch {
                    // ignore storage errors
                }

                setLoginOpen(false);
                setAuthMode("login");
                window.location.href = "/admin";
                return { success: true };
            }

            // Original login/register logic
            if (!trimmedEmail || !trimmedPassword) {
                throw new Error("Email and password are required.");
            }

            if (mode === "register" && !trimmedName) {
                throw new Error("Name is required for registration.");
            }

            const endpoint = mode === "register" ? "/api/auth/register" : "/api/auth/login";
            const requestBody =
                mode === "register"
                    ? { name: trimmedName, email: trimmedEmail, password: trimmedPassword }
                    : { email: trimmedEmail, password: trimmedPassword };

            const response = await fetch(`${apiBaseUrl}${endpoint}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify(requestBody),
            });

            const responseData = await readJsonResponse(response);

            if (!response.ok) {
                throw new Error(responseData?.message || "Authentication failed. Please try again.");
            }

            if (mode === "register") {
                setAuthMode("login");
                setAuthError(responseData.message || "Account created. Please log in.");
                return;
            }

            if (mode === "login" && responseData?.twoFactorRequired) {
                setAuthError("");
                return { twoFactorRequired: true, email: responseData?.email || trimmedEmail };
            }

            handleLogin(responseData.user);
        } catch (error) {
            setAuthError(error instanceof Error ? error.message : "Something went wrong.");
        } finally {
            setAuthLoading(false);
        }
    };

    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (voiceAutoSendTimerRef.current) {
            window.clearTimeout(voiceAutoSendTimerRef.current);
            voiceAutoSendTimerRef.current = null;
        }

        const pastedAttachments = pastedTextBlocks
            .map((block) => ({
                key: block.key,
                name: "Pasted Text",
                size: block.charCount || block.content.length,
                type: "text/plain",
                dataUrl: encodeTextAsDataUrl(block.content),
            }))
            .filter((attachment) => attachment.dataUrl);

        const combinedAttachments = [...selectedAttachments, ...pastedAttachments];

        setPastedTextBlocks([]);
        submitChatMessage(messageDraft.trim(), { attachments: combinedAttachments });
    };

    // useEffect(() => {
    //     document.addEventListener('click', handleLinkClick);
    //     return () => {
    //         document.removeEventListener('click', handleLinkClick);
    //     };
    // }, []);

    const [announcement, setAnnouncement] = useState({ enabled: false, messages: [] });

    useEffect(() => {
        let cancelled = false;

        const loadAnnouncement = async () => {
            try {
                const response = await fetch(`${apiBaseUrl}/api/public/announcement`);
                if (!response.ok || cancelled) return;
                const data = await readJsonResponse(response);
                if (!cancelled && data?.announcement) {
                    setAnnouncement(data.announcement);
                }
            } catch {
                // ignore — banner just stays hidden until the next poll succeeds
            }
        };

        loadAnnouncement();
        const intervalId = window.setInterval(loadAnnouncement, 60000);

        return () => {
            cancelled = true;
            window.clearInterval(intervalId);
        };
    }, []);

    return (
        <div
            className={`app-shell ${isLoggedIn ? "app-shell--member" : "app-shell--guest"} ${sidebarOpen ? "" : "app-shell--sidebar-collapsed"} ${reduceMotion ? "app-shell--reduce-motion" : ""} ${activeView === "settings" ? "app-shell--settings" : ""}`}
        >
            <SideBar
                isLoggedIn={isLoggedIn}
                user={auth}
                activeView={activeView}
                onSelectView={setActiveView}
                onStartNewChat={handleNewChat}
                chatHistoryGroups={groupedChatThreads}
                activeChatId={currentThreadId}
                chatHistoryLoading={chatHistoryLoading}
                chatHistoryError={chatHistoryError}
                onSelectChatHistory={openHistoryThread}
                chatMenuThreadId={chatMenuThreadId}
                onToggleChatThreadMenu={handleToggleChatThreadMenu}
                renamingThreadId={chatRenamingThreadId}
                renameDraft={chatRenameDraft}
                onRenameDraftChange={setChatRenameDraft}
                onBeginRenameChatThread={handleBeginRenameChatThread}
                onCommitRenameChatThread={handleCommitRenameChatThread}
                onCancelRenameChatThread={handleCancelRenameChatThread}
                onDeleteChatThread={handleDeleteChatThread}
                onLoginOpen={() => setLoginOpen(true)}
                onLogout={handleLogoutRequest}
                onStartGuest={handleNewChat}
                onAdminAccess={handleAdminAccess}
                isOpen={sidebarOpen}
                onToggleOpen={() => setSidebarOpen((current) => !current)}
            />

            <button
                type="button"
                className={`sidebar-backdrop ${sidebarOpen ? "is-visible" : ""}`}
                onClick={() => setSidebarOpen(false)}
                aria-label="Close sidebar"
                tabIndex={sidebarOpen ? 0 : -1}
            />

            <main
                className={`workspace ${activeView === "settings" ? "workspace--settings" : "workspace--chat"}`}
            >
                <Navbar
                    isLoggedIn={isLoggedIn}
                    activeView={activeView}
                    onSelectView={setActiveView}
                    onLoginOpen={openAuth}
                    onLogout={handleLogoutRequest}
                    announcement={announcement}
                    chatPinned={chatPinned}
                    chatArchived={chatArchived}
                    chatMenuOpen={chatMenuOpen}
                    chatMenuEnabled={Boolean(currentThreadId) && messages.length > 0}
                    onToggleChatMenu={() => {
                        // Only toggle when an ongoing chat exists
                        if (!currentThreadId || messages.length === 0) {
                            setChatMenuOpen(false);
                            return;
                        }
                        setChatMenuOpen((current) => !current);
                    }}
                    onShareChat={handleShareChat}
                    onTogglePinChat={handleTogglePinChat}
                    onToggleArchiveChat={handleToggleArchiveChat}
                    onDeleteChat={handleDeleteChat}
                    sidebarOpen={sidebarOpen}
                    onToggleSidebar={() => setSidebarOpen((current) => !current)}
                />

                {activeView === "settings" ? (
                    <SettingsPage
                        user={auth}
                        onBackToChat={() => setActiveView("chat")}
                        onLogout={handleLogoutRequest}
                        onProfileUpdate={handleProfileUpdate}
                        onAccountDeleted={handleAccountDeleted}
                        showToast={showToast}
                    />
                ) : (
                    <section className="chat-shell" aria-label="Chat workspace">
                        {showEmptyStatePrompt ? (
                            <div className="chat-shell__welcome">
                                <div className="chat-shell__empty-state" aria-hidden="true">
                                    <h1>{isLoggedIn ? `How are you, ${auth?.name || 'there'}?` : "How can I help today?"}</h1>
                                </div>

                                <form className="chat-composer chat-composer--centered" onSubmit={handleSendMessage}>
                                    {(selectedAttachments.length || pastedTextBlocks.length) ? (
                                        <div className="chat-composer__attachments" aria-label="Selected attachments">
                                            {pastedTextBlocks.map((block) => (
                                                // <PastedTextChip key={block.key} block={block} onRemove={handleRemovePastedTextBlock} />
                                                <PastedTextChip key={block.key} block={block} onRemove={handleRemovePastedTextBlock} onPreview={openPastedTextViewer} />
                                            ))}
                                            {selectedAttachments.map((attachment) => (
                                                <AttachmentPreview key={attachment.key} attachment={attachment} onRemove={handleRemoveAttachment} />
                                            ))}
                                        </div>
                                    ) : null}

                                    {/* {composerFormatToolbar} */}
                                    <div className="chat-composer__inner">
                                        <div className="chat-composer__attachment">
                                            <button
                                                className="chat-composer__action"
                                                type="button"
                                                aria-label="Add attachment"
                                                onClick={handleAttachmentButtonClick}
                                                title="Attach files"
                                            >
                                                <AttachFileIcon width={26} height={26} />
                                            </button>
                                        </div>

                                        <input
                                            ref={attachmentInputRef}
                                            type="file"
                                            multiple
                                            className="chat-composer__file-input"
                                            onChange={handleAttachmentInputChange}
                                            aria-hidden="true"
                                            tabIndex={-1}
                                        />

                                        <textarea
                                            ref={messageInputRef}
                                            className="chat-composer__input"
                                            rows={1}
                                            value={messageDraft}
                                            autoComplete="off"
                                            autoCorrect="on"
                                            spellCheck="true"
                                            data-lpignore="true"
                                            data-1p-ignore="true"
                                            data-form-type="other"
                                            name="quantic-chat-composer"
                                            onChange={(event) => {
                                                setMessageDraft(event.target.value);
                                                autoResizeTextarea(event.target);
                                            }}
                                            onSelect={handleComposerSelect}
                                            onMouseUp={handleComposerSelect}
                                            onKeyUp={handleComposerSelect}
                                            onPaste={handleComposerPaste}
                                            onKeyDown={(event) => {
                                                if (event.ctrlKey && event.altKey) {
                                                    const shortcutMap = {
                                                        "0": "clearBlock",
                                                        "1": "heading1",
                                                        "2": "heading2",
                                                        "3": "heading3",
                                                        "4": "numbered",
                                                        "5": "bullet",
                                                    };
                                                    if (shortcutMap[event.key]) {
                                                        event.preventDefault();
                                                        applyComposerFormatting(shortcutMap[event.key]);
                                                        return;
                                                    }
                                                }

                                                if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
                                                    event.preventDefault();
                                                    if (!isSending) {
                                                        event.currentTarget.form?.requestSubmit();
                                                    }
                                                }
                                            }}
                                            placeholder="Ask anything..."
                                            aria-label="Chat message"
                                        />

                                        {voiceControls}
                                    </div>
                                </form>
                            </div>
                        ) : (
                            <>
                                <div className="chat-shell__stage">
                                    {messages.length ? (
                                        <div className="chat-transcript" aria-live="polite" aria-label="Conversation">
                                            <div className="chat-transcript__inner">
                                                {messages.map((message, index) => (
                                                    <div
                                                        key={`${message.role}-${index}`}
                                                        className={`chat-transcript__message chat-transcript__message--${message.role}`}
                                                    >
                                                        <div className={`chat-transcript__message-stack ${editingMessageIndex === index ? "chat-transcript__message-stack--editing" : ""}`}>
                                                            <div className={`chat-transcript__bubble ${editingMessageIndex === index ? "chat-transcript__bubble--editing" : ""}`}>
                                                                {message.role === "user" && editingMessageIndex === index ? (
                                                                    <div className="chat-transcript__inline-editor">
                                                                        <div className="chat-transcript__inline-editor-bar">
                                                                            <textarea
                                                                                className="chat-transcript__inline-input"
                                                                                value={editingMessageDraft}
                                                                                onChange={(event) => {
                                                                                    setEditingMessageDraft(event.target.value);  // ✅ Correct state setter
                                                                                    autoResizeTextarea(event.target);
                                                                                }}
                                                                                onKeyDown={(event) => {
                                                                                    if (event.key === "Escape") {
                                                                                        event.preventDefault();
                                                                                        handleCancelInlineEdit();
                                                                                        return;
                                                                                    }
                                                                                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                                                                                        event.preventDefault();
                                                                                        handleSaveInlineEdit(index);
                                                                                    }
                                                                                }}
                                                                                autoFocus
                                                                            />
                                                                            <div className="chat-transcript__inline-editor-actions">
                                                                                <button
                                                                                    type="button"
                                                                                    className="chat-transcript__inline-action-button chat-transcript__inline-action-button--secondary"
                                                                                    onClick={handleCancelInlineEdit}
                                                                                >
                                                                                    Cancel
                                                                                </button>
                                                                                <button
                                                                                    type="button"
                                                                                    className="chat-transcript__inline-action-button chat-transcript__inline-action-button--primary"
                                                                                    onClick={() => handleSaveInlineEdit(index)}
                                                                                >
                                                                                    Send
                                                                                </button>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                ) : message.role === "assistant" && message.status === "loading" ? (
                                                                    <div className="chat-transcript__typing" aria-label="Quantic is typing">
                                                                        <span />
                                                                        <span />
                                                                        <span />
                                                                    </div>
                                                                ) : (
                                                                    <div className="chat-transcript__content">
                                                                        {message.role === "user" ? (
                                                                            (() => {
                                                                                const rawContent = String(message.content || "");
                                                                                const isLong = rawContent.length > 320 || rawContent.split("\n").length > 6;
                                                                                const isExpanded = expandedMessageIndexes.has(index);
                                                                                const wrapperClassName = `chat-transcript__message-content-wrapper ${isLong && !isExpanded ? "chat-transcript__message-content-wrapper--collapsed" : ""
                                                                                    }`;

                                                                                return (
                                                                                    <>
                                                                                        <div className={wrapperClassName}>
                                                                                            <div className="chat-transcript__message-text chat-transcript__markdown">
                                                                                                {renderMarkdownContent(message.content)}
                                                                                            </div>
                                                                                        </div>
                                                                                        {isLong ? (
                                                                                            <button
                                                                                                type="button"
                                                                                                className="chat-transcript__show-more"
                                                                                                onClick={() => toggleMessageExpanded(index)}
                                                                                            >
                                                                                                {isExpanded ? "Show less" : "Show more"}
                                                                                                <span className="show-more-arrow">{isExpanded ? "▴" : "▾"}</span>
                                                                                            </button>
                                                                                        ) : null}
                                                                                    </>
                                                                                );
                                                                            })()
                                                                        ) : (
                                                                            <MarkdownMessage content={message.content} />
                                                                        )}
                                                                        {Array.isArray(message.attachments) && message.attachments.length ? (
                                                                            <div className="chat-transcript__attachments">
                                                                                {message.attachments.map((attachment) => (
                                                                                    // <AttachmentPreview key={attachment.key} attachment={attachment} variant="message" onImageClick={openLightbox} />
                                                                                    <AttachmentPreview key={attachment.key} attachment={attachment} variant="message" onImageClick={openLightbox} onPastedTextClick={openPastedTextViewer} />
                                                                                ))}
                                                                            </div>
                                                                        ) : null}
                                                                    </div>
                                                                )}
                                                            </div>
                                                            {message.role === "user" && message.content && editingMessageIndex !== index ? (
                                                                <div className="chat-transcript__message-actions" aria-label="Message actions">

                                                                    <button
                                                                        type="button"
                                                                        className={`chat-transcript__message-action ${copiedMessageIndex === index ? "is-copied" : ""}`}
                                                                        onClick={() => handleCopyMessage(message.content, index)}
                                                                        aria-label={copiedMessageIndex === index ? "Copied" : "Copy message"}
                                                                        title={copiedMessageIndex === index ? "Copied" : "Copy message"}
                                                                    >
                                                                        {copiedMessageIndex === index ? <CheckIcon /> : <ContentCopyIcon />}
                                                                    </button>

                                                                    <button
                                                                        type="button"
                                                                        className="chat-transcript__message-action"
                                                                        onClick={() => handleBeginEditMessage(index, message.content)}
                                                                        aria-label="Edit message"
                                                                        title="Edit message"
                                                                    >
                                                                        <EditIcon />
                                                                    </button>
                                                                </div>
                                                            ) : message.role === "assistant" && message.content ? (
                                                                <div className="chat-transcript__message-actions" aria-label="Message actions">

                                                                    <button
                                                                        type="button"
                                                                        className={`chat-transcript__message-action ${copiedMessageIndex === index ? "is-copied" : ""}`}
                                                                        onClick={() => handleCopyMessage(message.content, index)}
                                                                        aria-label={copiedMessageIndex === index ? "Copied" : "Copy message"}
                                                                        title={copiedMessageIndex === index ? "Copied" : "Copy message"}
                                                                    >
                                                                        {copiedMessageIndex === index ? <CheckIcon /> : <ContentCopyIcon />}
                                                                    </button>

                                                                    <button
                                                                        type="button"
                                                                        className="chat-transcript__message-action"
                                                                        onClick={() => handleRegenerateMessage(index)}
                                                                        aria-label="Regenerate answer"
                                                                        title="Regenerate answer"
                                                                    >
                                                                        <CachedIcon />
                                                                    </button>
                                                                    <button
                                                                        type="button"
                                                                        className="chat-transcript__message-action"
                                                                        onClick={() => handleReadMessageAloud(message.content)}
                                                                        aria-label="Read answer aloud"
                                                                        title="Read answer aloud"
                                                                    >
                                                                        <VolumeUpIcon />
                                                                    </button>
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                ))}
                                            </div>
                                        </div>
                                    ) : null}
                                </div>

                                <form className="chat-composer" onSubmit={handleSendMessage}>
                                    {(selectedAttachments.length || pastedTextBlocks.length) ? (
                                        <div className="chat-composer__attachments" aria-label="Selected attachments">
                                            {pastedTextBlocks.map((block) => (
                                                // <PastedTextChip key={block.key} block={block} onRemove={handleRemovePastedTextBlock} />
                                                <PastedTextChip key={block.key} block={block} onRemove={handleRemovePastedTextBlock} onPreview={openPastedTextViewer} />
                                            ))}
                                            {selectedAttachments.map((attachment) => (
                                                <AttachmentPreview key={attachment.key} attachment={attachment} onRemove={handleRemoveAttachment} />
                                            ))}
                                        </div>
                                    ) : null}

                                    {/* {composerFormatToolbar} */}
                                    <div className="chat-composer__inner">
                                        <div className="chat-composer__attachment">
                                            <button
                                                className="chat-composer__action"
                                                type="button"
                                                aria-label="Add attachment"
                                                onClick={handleAttachmentButtonClick}
                                            >
                                                <AttachFileIcon width={26} height={26} />
                                            </button>
                                        </div>

                                        <input
                                            ref={attachmentInputRef}
                                            type="file"
                                            multiple
                                            className="chat-composer__file-input"
                                            onChange={handleAttachmentInputChange}
                                            aria-hidden="true"
                                            tabIndex={-1}
                                        />

                                        <textarea
                                            ref={messageInputRef}
                                            className="chat-composer__input"
                                            rows={1}
                                            value={messageDraft}
                                            autoComplete="off"
                                            autoCorrect="on"
                                            spellCheck="true"
                                            data-lpignore="true"
                                            data-1p-ignore="true"
                                            data-form-type="other"
                                            name="quantic-chat-composer"
                                            onChange={(event) => {
                                                setMessageDraft(event.target.value);
                                                autoResizeTextarea(event.target);
                                            }}
                                            onSelect={handleComposerSelect}
                                            onMouseUp={handleComposerSelect}
                                            onKeyUp={handleComposerSelect}
                                            onPaste={handleComposerPaste}
                                            onKeyDown={(event) => {
                                                if (event.ctrlKey && event.altKey) {
                                                    const shortcutMap = {
                                                        "0": "clearBlock",
                                                        "1": "heading1",
                                                        "2": "heading2",
                                                        "3": "heading3",
                                                        "4": "numbered",
                                                        "5": "bullet",
                                                    };
                                                    if (shortcutMap[event.key]) {
                                                        event.preventDefault();
                                                        applyComposerFormatting(shortcutMap[event.key]);
                                                        return;
                                                    }
                                                }

                                                if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
                                                    event.preventDefault();
                                                    if (!isSending) {
                                                        event.currentTarget.form?.requestSubmit();
                                                    }
                                                }
                                            }}
                                            placeholder="Ask anything..."
                                            aria-label="Chat message"
                                        />

                                        {voiceControls}
                                    </div>
                                </form>
                            </>
                        )}

                        <p className="chat-legal">
                            {legalCopySegments.map((segment, index) =>
                                typeof segment === "string" ? (
                                    <Fragment key={`legal-text-${index}`}>{segment}</Fragment>
                                ) : (
                                    <button
                                        key={segment.id}
                                        type="button"
                                        className="chat-legal__underline"
                                        onClick={() => setActiveLegalPage(segment.id)}
                                    >
                                        {segment.text}
                                    </button>
                                )
                            )}
                        </p>
                    </section>
                )}
            </main>

            <div className="toast-stack">
                {toasts
                    .filter((toast) => !toast.scope || toast.scope === activeView)
                    .map((toast) => (
                        <div key={toast.id} className={`toast toast--${toast.type}`}>
                            {toast.message}
                        </div>
                    ))}
            </div>

            {voiceConversationOpen ? (
                <div className="ai-voice-orb" role="dialog" aria-modal="true" aria-label="Voice conversation">
                    <div className="ai-voice-orb__panel">
                        <div ref={orbInnerRef} className={`ai-voice-orb__plasma ${isSpeaking ? "is-speaking" : ""}`} aria-hidden="true">
                            <canvas ref={orbCanvasRef} className="ai-voice-orb__canvas" />
                        </div>

                        <div className="ai-voice-orb__status">
                            <span>{voiceConversationStatus}</span>
                        </div>

                        <p ref={voiceCaptionRef} className="ai-voice-orb__caption" aria-live="polite">
                            {messageDraft}
                        </p>

                        <div className="ai-voice-orb__langs" role="group" aria-label="Speech language">
                            {voiceLanguageOptions.map((option) => (
                                <button
                                    key={option.code}
                                    type="button"
                                    className={`ai-voice-orb__lang ${option.code === voiceLang ? "is-active" : ""}`}
                                    onClick={() => applyVoiceLanguage(option.code)}
                                    aria-pressed={option.code === voiceLang}
                                    title={option.label}
                                >
                                    {option.short}
                                </button>
                            ))}
                        </div>

                        <div className="ai-voice-orb__actions" aria-label="Voice conversation controls">
                            <button
                                type="button"
                                className="ai-voice-orb__action"
                                onClick={closeVoiceConversation}
                                aria-label="Stop voice conversation"
                                title="Stop voice conversation"
                            >
                                <span className="material-symbols-rounded">close</span>
                            </button>
                            <button
                                type="button"
                                className={`ai-voice-orb__action ${isListening ? "is-listening" : ""}`}
                                onClick={handleToggleVoiceConversationMic}
                                aria-label={isListening ? "Stop listening" : "Start listening"}
                                title={isListening ? "Stop listening" : "Start listening"}
                            >
                                <span className="material-symbols-rounded">{isListening ? "mic_off" : "mic"}</span>
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {activeLegalContent ? (
                <div className="legal-modal" role="dialog" aria-modal="true" aria-labelledby="legal-modal-title">
                    <div className="legal-modal__backdrop" onClick={() => setActiveLegalPage(null)} aria-hidden="true" />
                    <div className="legal-modal__panel">
                        <div className="legal-modal__header">
                            <h2 id="legal-modal-title">{activeLegalContent.title}</h2>
                            <button type="button" className="legal-modal__close" onClick={() => setActiveLegalPage(null)}>
                                Close
                            </button>
                        </div>
                        <div className="legal-modal__body">
                            {activeLegalContent.intro.map((paragraph) => (
                                <p key={paragraph}>{paragraph}</p>
                            ))}
                            {activeLegalContent.sections.map((section) => (
                                <section key={section.heading} className="legal-modal__section">
                                    <h3>{section.heading}</h3>
                                    <ul>
                                        {section.points.map((point) => (
                                            <li key={point}>{point}</li>
                                        ))}
                                    </ul>
                                </section>
                            ))}
                        </div>
                    </div>
                </div>
            ) : null}

            {chatDeleteConfirmThreadId ? (
                <div className="chat-delete-modal" role="dialog" aria-modal="true" aria-labelledby="chat-delete-modal-title" aria-describedby="chat-delete-modal-description">
                    <div className="chat-delete-modal__backdrop" onClick={closeDeleteChatThread} aria-hidden="true" />
                    <div className="chat-delete-modal__panel">
                        <h2 id="chat-delete-modal-title">Delete chat?</h2>
                        <p id="chat-delete-modal-description" className="chat-delete-modal__lead">
                            This will delete <strong>{chatDeleteConfirmTitle}</strong>.
                        </p>
                        {/* <p className="chat-delete-modal__note">
                                Visit settings to delete any memories saved during this chat.
                            </p> */}
                        <div className="chat-delete-modal__actions">
                            <button type="button" className="chat-delete-modal__button chat-delete-modal__button--ghost" onClick={closeDeleteChatThread}>
                                Cancel
                            </button>
                            <button type="button" className="chat-delete-modal__button chat-delete-modal__button--danger" onClick={() => confirmDeleteChatThread(chatDeleteConfirmThreadId)}>
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {logoutConfirmOpen ? (
                <div className="chat-delete-modal" role="dialog" aria-modal="true" aria-labelledby="logout-modal-title" aria-describedby="logout-modal-description">
                    <div className="chat-delete-modal__backdrop" onClick={() => setLogoutConfirmOpen(false)} aria-hidden="true" />
                    <div className="chat-delete-modal__panel">
                        <h2 id="logout-modal-title">Logout?</h2>
                        <p id="logout-modal-description" className="chat-delete-modal__lead">
                            This will sign you out of your current session.
                        </p>
                        <p className="chat-delete-modal__note">
                            Your chats and settings will stay saved for next time.
                        </p>
                        <div className="chat-delete-modal__actions">
                            <button type="button" className="chat-delete-modal__button chat-delete-modal__button--ghost" onClick={() => setLogoutConfirmOpen(false)}>
                                Cancel
                            </button>
                            <button type="button" className="chat-delete-modal__button chat-delete-modal__button--danger" onClick={handleLogout}>
                                Logout
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}

            {lightboxAttachment ? (
                <div className="image-lightbox" role="dialog" aria-modal="true" aria-label="Image preview">
                    <div className="image-lightbox__backdrop" onClick={closeLightbox} aria-hidden="true" />

                    <div className="image-lightbox__toolbar">
                        <button
                            type="button"
                            className="image-lightbox__tool"
                            onClick={handleLightboxZoomOut}
                            aria-label="Zoom out"
                            title="Zoom out"
                        >
                            <span className="material-symbols-rounded">zoom_out</span>
                        </button>
                        <button
                            type="button"
                            className="image-lightbox__tool"
                            onClick={handleLightboxZoomIn}
                            aria-label="Zoom in"
                            title="Zoom in"
                        >
                            <span className="material-symbols-rounded">zoom_in</span>
                        </button>
                        <button
                            type="button"
                            className="image-lightbox__tool"
                            onClick={handleLightboxResetZoom}
                            aria-label="Reset zoom"
                            title="Reset zoom"
                        >
                            <span className="material-symbols-rounded">fit_screen</span>
                        </button>
                        <button
                            type="button"
                            className="image-lightbox__tool"
                            onClick={handleLightboxDownload}
                            aria-label="Download image"
                            title="Download image"
                        >
                            <span className="material-symbols-rounded">download</span>
                        </button>
                        <button
                            type="button"
                            className="image-lightbox__tool"
                            onClick={closeLightbox}
                            aria-label="Close preview"
                            title="Close preview"
                        >
                            <span className="material-symbols-rounded">close</span>
                        </button>
                    </div>

                    <div className="image-lightbox__stage">
                        <img
                            className="image-lightbox__image"
                            src={lightboxAttachment.dataUrl}
                            alt={lightboxAttachment.name || "Attachment preview"}
                            style={{ transform: `scale(${lightboxZoom})` }}
                        />
                    </div>
                </div>
            ) : null}

            {pastedTextViewer ? (
                <div className="pasted-text-modal" role="dialog" aria-modal="true" aria-labelledby="pasted-text-modal-title">
                    <div className="pasted-text-modal__backdrop" onClick={closePastedTextViewer} aria-hidden="true" />
                    <div className="pasted-text-modal__panel">
                        <div className="pasted-text-modal__header">
                            <h2 id="pasted-text-modal-title">{pastedTextViewer.name}</h2>
                            <div className="pasted-text-modal__actions">
                                <button
                                    type="button"
                                    className="pasted-text-modal__action"
                                    onClick={handleCopyPastedTextViewer}
                                    aria-label="Copy pasted text"
                                    title="Copy"
                                >
                                    <ContentCopyIcon />
                                </button>
                                <button
                                    type="button"
                                    className="pasted-text-modal__close"
                                    onClick={closePastedTextViewer}
                                    aria-label="Close pasted text preview"
                                >
                                    <CloseIcon />
                                </button>
                            </div>
                        </div>
                        <div className="pasted-text-modal__body">
                            <pre className="pasted-text-modal__pre">{pastedTextViewer.content}</pre>
                        </div>
                    </div>
                </div>
            ) : null}

            <LoginModals
                isOpen={loginOpen}
                mode={authMode}
                prefillEmail={adminPrefillEmail}
                loading={authLoading}
                errorMessage={authError}
                onClose={() => {
                    setLoginOpen(false);
                    setAuthError("");
                    setAuthLoading(false);
                    setAdminPrefillEmail("");
                    setAdminTwoFactorPending(false);
                }}
                onSwitchMode={setAuthMode}
                onSubmit={handleAuthSubmit}
                showToast={showToast}
            />

            {selectionToolbar ? (
                <div
                    className="chat-composer__selection-toolbar"
                    style={{ top: `${selectionToolbar.top}px`, left: `${selectionToolbar.left}px` }}
                    onMouseDown={(event) => event.preventDefault()}
                >
                    <button type="button" onClick={() => applyComposerFormatting("link")} aria-label="Link" title="Link">
                        <span className="material-symbols-rounded">link</span>
                    </button>
                    <button type="button" onClick={() => applyComposerFormatting("bold")} aria-label="Bold" title="Bold">
                        <strong>B</strong>
                    </button>
                    <button type="button" onClick={() => applyComposerFormatting("italic")} aria-label="Italic" title="Italic">
                        <em>I</em>
                    </button>
                    <div className="chat-composer__selection-type-wrap">
                        <button
                            type="button"
                            className="chat-composer__selection-type-button"
                            onClick={() => setSelectionTypeMenuOpen((current) => !current)}
                        >
                            Text <span className="chat-composer__selection-caret">▾</span>
                        </button>
                        {selectionTypeMenuOpen ? (
                            <div className="chat-composer__selection-type-menu">
                                <button type="button" onClick={() => { applyComposerFormatting("clearBlock"); setSelectionTypeMenuOpen(false); }}>
                                    <span>Text</span><span className="chat-composer__selection-shortcut">Ctrl + Alt + 0</span>
                                </button>
                                <button type="button" onClick={() => { applyComposerFormatting("heading1"); setSelectionTypeMenuOpen(false); }}>
                                    <span>Heading 1</span><span className="chat-composer__selection-shortcut">Ctrl + Alt + 1</span>
                                </button>
                                <button type="button" onClick={() => { applyComposerFormatting("heading2"); setSelectionTypeMenuOpen(false); }}>
                                    <span>Heading 2</span><span className="chat-composer__selection-shortcut">Ctrl + Alt + 2</span>
                                </button>
                                <button type="button" onClick={() => { applyComposerFormatting("heading3"); setSelectionTypeMenuOpen(false); }}>
                                    <span>Heading 3</span><span className="chat-composer__selection-shortcut">Ctrl + Alt + 3</span>
                                </button>
                                <button type="button" onClick={() => { applyComposerFormatting("numbered"); setSelectionTypeMenuOpen(false); }}>
                                    <span>Numbered list</span><span className="chat-composer__selection-shortcut">Ctrl + Alt + 4</span>
                                </button>
                                <button type="button" onClick={() => { applyComposerFormatting("bullet"); setSelectionTypeMenuOpen(false); }}>
                                    <span>Bulleted list</span><span className="chat-composer__selection-shortcut">Ctrl + Alt + 5</span>
                                </button>
                            </div>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </div>
    );
}

export default ChatPage;
