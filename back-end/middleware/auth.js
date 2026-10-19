//back-end/middleware/auth.js
const jwt = require("jsonwebtoken");
const User = require("../models/LoginModel");
const Settings = require("../models/SettingsModel");
const { getSystemSettings } = require("../models/SystemSettingsModel");

const isTokenRevoked = async (decoded) => {
	try {
		const systemSettings = await getSystemSettings();
		const revokedAt = systemSettings?.security?.sessionsRevokedAt;

		if (!revokedAt || !decoded?.iat) {
			return false;
		}

		return decoded.iat * 1000 < new Date(revokedAt).getTime();
	} catch {
		return false;
	}
};

const defaultUserSettings = {
	displayName: "",
	username: "",
	email: "",
	description: "",
	profileImage: "",
	emailNotifications: true,
	loginAlerts: true,
	twoFactorEnabled: false,
	saveConversationHistory: true,
	compactSidebar: false,
	reduceMotion: false,
	shareUsageData: false,
	responseStyle: "balanced",
};

const isNonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;

const normalizeUserSettings = (settings = {}, user = {}) => {
	const {
		_id,
		createdAt,
		updatedAt,
		__v,
		...restSettings
	} = settings || {};

	return {
		...defaultUserSettings,
		...restSettings,
		displayName: isNonEmptyString(restSettings.displayName)
			? restSettings.displayName.trim()
			: user.name || defaultUserSettings.displayName,
		username: isNonEmptyString(restSettings.username)
			? restSettings.username.trim()
			: user.email
				? user.email.split("@")[0]
				: defaultUserSettings.username,
		email: user.email || (isNonEmptyString(restSettings.email) ? restSettings.email.trim() : defaultUserSettings.email),
		description: isNonEmptyString(restSettings.description)
			? restSettings.description.trim()
			: defaultUserSettings.description,
		profileImage: isNonEmptyString(restSettings.profileImage)
			? restSettings.profileImage.trim()
			: defaultUserSettings.profileImage,
		emailNotifications:
			typeof restSettings.emailNotifications === "boolean"
				? restSettings.emailNotifications
				: defaultUserSettings.emailNotifications,
		loginAlerts:
			typeof restSettings.loginAlerts === "boolean"
				? restSettings.loginAlerts
				: defaultUserSettings.loginAlerts,
		twoFactorEnabled:
			typeof restSettings.twoFactorEnabled === "boolean"
				? restSettings.twoFactorEnabled
				: defaultUserSettings.twoFactorEnabled,
		saveConversationHistory:
			typeof restSettings.saveConversationHistory === "boolean"
				? restSettings.saveConversationHistory
				: defaultUserSettings.saveConversationHistory,
		compactSidebar:
			typeof restSettings.compactSidebar === "boolean"
				? restSettings.compactSidebar
				: defaultUserSettings.compactSidebar,
		reduceMotion:
			typeof restSettings.reduceMotion === "boolean"
				? restSettings.reduceMotion
				: defaultUserSettings.reduceMotion,
		shareUsageData:
			typeof restSettings.shareUsageData === "boolean"
				? restSettings.shareUsageData
				: defaultUserSettings.shareUsageData,
		responseStyle:
			typeof restSettings.responseStyle === "string" && restSettings.responseStyle.trim()
				? restSettings.responseStyle.trim()
				: defaultUserSettings.responseStyle,
	};
};

// In production the site (Vercel) and the API (Render) are on different domains, so the
// cookies must be SameSite=None; Secure or the browser will not send them with API calls.
// Locally (same site, http) Lax is used because SameSite=None requires HTTPS.
const isProduction = () => process.env.NODE_ENV === "production";
const sameSiteValue = () => (isProduction() ? "SameSite=None" : "SameSite=Lax");

const TOKEN_COOKIE_NAME = "quantic_token";
const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEVICE_COOKIE_NAME = "device_id";
const DEVICE_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const getJwtSecret = () => process.env.JWT_SECRET || "quantic-ai-development-secret";

const buildUserProfile = async (user) => {
	const settingsDocument = await Settings.findById(user._id).lean();
	const normalizedSettings = normalizeUserSettings(settingsDocument || {}, user);

	return {
		id: user._id,
		name: user.name,
		email: user.email,
		role: user.role,
		createdAt: user.createdAt,
		updatedAt: user.updatedAt,
		avatarUrl: normalizedSettings.profileImage,
		settings: normalizedSettings,
	};
};

const parseCookies = (cookieHeader = "") =>
	cookieHeader.split(";").reduce((cookies, cookiePair) => {
		const [rawKey, ...rawValue] = cookiePair.trim().split("=");

		if (!rawKey) {
			return cookies;
		}

		cookies[rawKey] = rawValue.join("=");
		return cookies;
	}, {});

const buildCookie = (token) => {
	const parts = [
		`${TOKEN_COOKIE_NAME}=${token}`,
		"Path=/",
		"HttpOnly",
		sameSiteValue(),
		`Max-Age=${Math.floor(TOKEN_MAX_AGE_MS / 1000)}`,
	];

	if (process.env.NODE_ENV === "production") {
		parts.push("Secure");
	}

	return parts.join("; ");
};

// Must carry the same attributes as the cookie it removes, or the browser keeps the old one.
const buildClearedCookie = () =>
	`${TOKEN_COOKIE_NAME}=; Path=/; HttpOnly; ${sameSiteValue()}; Max-Age=0${isProduction() ? "; Secure" : ""}`;

const buildDeviceCookie = (deviceId) => {
	const parts = [
		`${DEVICE_COOKIE_NAME}=${deviceId}`,
		"Path=/",
		"HttpOnly",
		sameSiteValue(),
		`Max-Age=${Math.floor(DEVICE_COOKIE_MAX_AGE_MS / 1000)}`,
	];

	if (process.env.NODE_ENV === "production") {
		parts.push("Secure");
	}

	return parts.join("; ");
};

const getDeviceIdFromRequest = (req) => {
	const cookies = parseCookies(req.headers.cookie || "");
	return cookies[DEVICE_COOKIE_NAME] || "";
};

const getTokenFromRequest = (req) => {
	const authorizationHeader = req.headers.authorization || "";

	if (authorizationHeader.startsWith("Bearer ")) {
		return authorizationHeader.slice(7).trim();
	}

	const cookies = parseCookies(req.headers.cookie || "");
	return cookies[TOKEN_COOKIE_NAME] || "";
};

const authenticate = async (req, res, next) => {
	try {
		const token = getTokenFromRequest(req);

		if (!token) {
			return res.status(401).json({ message: "Not authenticated." });
		}

		const decoded = jwt.verify(token, getJwtSecret());
		const userId = decoded.sub || decoded.userId || decoded.id;

		if (!userId) {
			return res.status(401).json({ message: "Not authenticated." });
		}

		if (await isTokenRevoked(decoded)) {
			return res.status(401).json({ message: "Session expired. Please log in again." });
		}

		const user = await User.findById(userId);

		if (!user) {
			return res.status(401).json({ message: "Not authenticated." });
		}

		if (user.banned) {
			return res.status(403).json({ message: "Your account has been suspended." });
		}

		req.auth = {
			userId: String(user._id),
			role: user.role,
		};
		req.user = await buildUserProfile(user);
		return next();
	} catch (error) {
		if (error.name === "TokenExpiredError" || error.name === "JsonWebTokenError") {
			return res.status(401).json({ message: "Not authenticated." });
		}

		return next(error);
	}
};

const optionalAuthenticate = async (req, res, next) => {
	try {
		const token = getTokenFromRequest(req);

		if (!token) {
			return next();
		}

		const decoded = jwt.verify(token, getJwtSecret());
		const userId = decoded.sub || decoded.userId || decoded.id;

		if (!userId) {
			return next();
		}

		if (await isTokenRevoked(decoded)) {
			return next();
		}

		const user = await User.findById(userId);

		if (!user) {
			return next();
		}

		if (user.banned) {
			req.authBanned = true;
			return next();
		}

		req.auth = {
			userId: String(user._id),
			role: user.role,
		};
		req.user = await buildUserProfile(user);
		return next();
	} catch (error) {
		return next();
	}
};

const requireAdmin = (req, res, next) => {
	if (!req.auth?.userId) {
		return res.status(401).json({ message: "Not authenticated." });
	}

	if (req.auth.role !== "admin") {
		return res.status(403).json({ message: "Admin access required." });
	}

	return next();
};

module.exports = {
	authenticate,
	optionalAuthenticate,
	requireAdmin,
	buildClearedCookie,
	buildCookie,
	buildDeviceCookie,
	getDeviceIdFromRequest,
	buildUserProfile,
	getJwtSecret,
	normalizeUserSettings,
	defaultUserSettings,
	parseCookies,
	TOKEN_COOKIE_NAME,
	DEVICE_COOKIE_NAME,
};