//back-end/controllers/login.Controller.js
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const User = require("../models/LoginModel");
const PendingRegistration = require("../models/PendingRegistrationModel");
const Settings = require("../models/SettingsModel");
const { sendWelcomeEmail, sendFeedbackEmail, sendResetOtpEmail, sendLoginOtpEmail, sendRegistrationOtpEmail } = require("../services/emailService");
const {
	buildClearedCookie,
	buildCookie,
	buildDeviceCookie,
	getDeviceIdFromRequest,
	buildUserProfile,
	getJwtSecret,
} = require("../middleware/auth");
const { getSystemSettings } = require("../models/SystemSettingsModel");

const isDatabaseConnected = () => User?.db?.readyState === 1;

const rejectIfDatabaseUnavailable = (res) => {
	if (isDatabaseConnected()) {
		return false;
	}

	res.status(503).json({
		message: "Database connection is unavailable. Please try again in a moment.",
	});

	return true;
};

const HASH_ITERATIONS = 120000;
const HASH_LENGTH = 64;
const HASH_DIGEST = "sha512";

const createToken = (user) =>
	jwt.sign(
		{
			email: user.email,
			name: user.name,
			role: user.role,
		},
		getJwtSecret(),
		{
			subject: String(user._id),
			expiresIn: "7d",
		}
	);

const hashPassword = (password, salt = crypto.randomBytes(16).toString("hex")) => {
	const derivedKey = crypto
		.pbkdf2Sync(password, salt, HASH_ITERATIONS, HASH_LENGTH, HASH_DIGEST)
		.toString("hex");

	return `pbkdf2$${HASH_ITERATIONS}$${salt}$${derivedKey}`;
};

const verifyPassword = (password, storedHash) => {
	const [scheme, iterationsText, salt, derivedKey] = storedHash.split("$");

	if (scheme !== "pbkdf2" || !iterationsText || !salt || !derivedKey) {
		return false;
	}

	const iterations = Number(iterationsText);
	const computedHash = crypto
		.pbkdf2Sync(password, salt, iterations, derivedKey.length / 2, HASH_DIGEST)
		.toString("hex");

	return crypto.timingSafeEqual(Buffer.from(computedHash, "hex"), Buffer.from(derivedKey, "hex"));
};

// const getDeviceFingerprint = (req) => {
// 	const userAgent = String(req?.headers?.["user-agent"] || "unknown");
// 	return crypto.createHash("sha256").update(userAgent).digest("hex");
// };
const resolveDeviceId = (req) => {
	const existingDeviceId = getDeviceIdFromRequest(req);
	return existingDeviceId || crypto.randomBytes(20).toString("hex");
};

const registerLoginDevice = async (user, deviceId, req) => {
	const userAgent = String(req?.headers?.["user-agent"] || "");
	const knownDevices = Array.isArray(user.knownDevices) ? user.knownDevices : [];
	const existingDevice = knownDevices.find((device) => device.fingerprint === deviceId);
	const now = new Date();

	if (existingDevice) {
		existingDevice.lastSeenAt = now;
		await user.save();
		return { isNewDevice: false };
	}

	knownDevices.push({
		fingerprint: deviceId,
		userAgent,
		firstSeenAt: now,
		lastSeenAt: now,
	});
	user.knownDevices = knownDevices;
	await user.save();

	// If this is the account's very first-ever recorded device, don't treat it as a "new browser" alert.
	return { isNewDevice: knownDevices.length > 1 };
};

// ---------------------------------------------------------------------------
// OTP helpers (registration)
// ---------------------------------------------------------------------------
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const UNVERIFIED_ACCOUNT_TTL_MS = 24 * 60 * 60 * 1000;

const generateOtp = () => String(crypto.randomInt(100000, 1000000));

const hashOtp = (otp) => crypto.createHash("sha256").update(String(otp)).digest("hex");

const otpMatches = (storedHash, suppliedOtp) => {
	if (!storedHash || !suppliedOtp) {
		return false;
	}

	const a = Buffer.from(storedHash, "hex");
	const b = Buffer.from(hashOtp(suppliedOtp), "hex");

	return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const PENDING_TTL_MS = 60 * 60 * 1000; // an unconfirmed signup is discarded after 1 hour

const getRegistrationResendWaitMs = (pending) => {
	if (!pending?.otpSentAt) {
		return 0;
	}

	return Math.max(0, pending.otpSentAt.getTime() + OTP_RESEND_COOLDOWN_MS - Date.now());
};

// Stores (or refreshes) the pending signup with a new hashed code, then emails the plain code.
// Only the pending collection is touched: no user account exists yet.
const issueRegistrationOtp = async ({ email, name, passwordHash, discardOnFailure }) => {
	const otp = generateOtp();
	const now = Date.now();

	const fields = {
		otpHash: hashOtp(otp),
		otpExpires: new Date(now + OTP_TTL_MS),
		otpAttempts: 0,
		otpSentAt: new Date(now),
		expiresAt: new Date(now + PENDING_TTL_MS),
	};

	if (name) fields.name = name;
	if (passwordHash) fields.passwordHash = passwordHash;

	const pending = await PendingRegistration.findOneAndUpdate(
		{ email },
		{ $set: fields },
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	);

	try {
		await sendRegistrationOtpEmail({ to: email, name: pending.name, otp });
	} catch (error) {
		if (discardOnFailure) {
			await PendingRegistration.deleteOne({ _id: pending._id });
		}
		throw error;
	}
};

// ---------------------------------------------------------------------------
// Login rate limiting: 3 failures => locked for 15 minutes
// ---------------------------------------------------------------------------
const MAX_LOGIN_ATTEMPTS = 3;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

const getLockRemainingMs = (user) =>
	user?.lockUntil ? Math.max(0, new Date(user.lockUntil).getTime() - Date.now()) : 0;

const respondLocked = (res, remainingMs) => {
	const seconds = Math.ceil(remainingMs / 1000);
	const minutes = Math.max(1, Math.ceil(seconds / 60));

	res.setHeader("Retry-After", String(seconds));

	return res.status(429).json({
		message: `Too many failed attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
		locked: true,
		retryAfterSeconds: seconds,
	});
};

// Atomic $inc so parallel guesses can't slip past the counter.
const recordFailedLogin = async (user) => {
	const updated = await User.findOneAndUpdate(
		{ _id: user._id },
		{ $inc: { failedLoginAttempts: 1 } },
		{ new: true }
	).select("+failedLoginAttempts");

	const attempts = updated?.failedLoginAttempts || 0;

	if (attempts >= MAX_LOGIN_ATTEMPTS) {
		await User.updateOne(
			{ _id: user._id },
			{ $set: { failedLoginAttempts: 0, lockUntil: new Date(Date.now() + LOGIN_LOCK_MS) } }
		);
		return { locked: true, remainingMs: LOGIN_LOCK_MS };
	}

	return { locked: false, attemptsRemaining: MAX_LOGIN_ATTEMPTS - attempts };
};

// Called only once a login is fully complete (after the 2FA step, if any).
const clearLoginFailures = (user) => {
	user.failedLoginAttempts = 0;
	user.lockUntil = null;
};

const changePassword = async (req, res, next) => {
	try {
		const { userId } = req.auth || {};
		const { currentPassword, newPassword } = req.body || {};

		const trimmedCurrentPassword = typeof currentPassword === "string" ? currentPassword.trim() : "";
		const trimmedNewPassword = typeof newPassword === "string" ? newPassword.trim() : "";

		if (!userId) {
			return res.status(401).json({ message: "Not authenticated." });
		}

		if (!trimmedCurrentPassword || !trimmedNewPassword) {
			return res.status(400).json({ message: "Current password and new password are required." });
		}

		if (rejectIfDatabaseUnavailable(res)) {
			return;
		}

		if (trimmedNewPassword.length < 6) {
			return res.status(400).json({ message: "New password must be at least 6 characters long." });
		}

		const user = await User.findById(userId).select("+passwordHash");

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		if (!verifyPassword(trimmedCurrentPassword, user.passwordHash)) {
			return res.status(401).json({ message: "Current password is incorrect." });
		}

		user.passwordHash = hashPassword(trimmedNewPassword);
		await user.save();

		return res.status(200).json({
			message: "Password updated successfully.",
			user: await buildUserProfile(user),
		});
	} catch (error) {
		return next(error);
	}
};

const registerUser = async (req, res, next) => {
	try {
		const { name, email, password } = req.body;

		const trimmedName = typeof name === "string" ? name.trim() : "";
		const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
		const trimmedPassword = typeof password === "string" ? password.trim() : "";

		if (!trimmedName || !trimmedEmail || !trimmedPassword) {
			return res.status(400).json({ message: "Name, email, and password are required." });
		}

		if (trimmedPassword.length < 6) {
			return res.status(400).json({ message: "Password must be at least 6 characters long." });
		}

		if (rejectIfDatabaseUnavailable(res)) {
			return;
		}

		const systemSettings = await getSystemSettings().catch(() => null);

		if (systemSettings?.features?.registrationOpen === false) {
			return res.status(403).json({ message: "New account registration is currently closed. Please check back later." });
		}

		const existingUser = await User.findOne({ email: trimmedEmail });

		if (existingUser && existingUser.emailVerified !== false) {
			return res.status(409).json({ message: "An account with that email already exists." });
		}

		// Leftover from an earlier version that saved unverified accounts: clear it so signup can restart.
		if (existingUser) {
			await User.deleteOne({ _id: existingUser._id });
		}

		const pending = await PendingRegistration.findOne({ email: trimmedEmail });
		const waitMs = getRegistrationResendWaitMs(pending);

		if (waitMs > 0) {
			return res.status(429).json({
				message: `A code was just sent. Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting another.`,
			});
		}

		try {
			await issueRegistrationOtp({
				email: trimmedEmail,
				name: trimmedName,
				passwordHash: hashPassword(trimmedPassword),
				discardOnFailure: !pending,
			});
		} catch (error) {
			console.error("Failed to send registration OTP email", { message: error?.message || String(error) });
			return res.status(502).json({
				message: "We couldn't send the verification email. Please check the address and try again.",
			});
		}

		return res.status(201).json({
			message: "Verification code sent to your email.",
			verificationRequired: true,
			email: trimmedEmail,
		});
	} catch (error) {
		return next(error);
	}
};

const verifyRegistrationOtp = async (req, res, next) => {
	try {
		const { email, otp } = req.body || {};

		const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
		const trimmedOtp = typeof otp === "string" ? otp.trim() : "";

		if (!trimmedEmail || !trimmedOtp) {
			return res.status(400).json({ message: "Email and verification code are required." });
		}

		if (rejectIfDatabaseUnavailable(res)) {
			return;
		}

		const pending = await PendingRegistration.findOne({ email: trimmedEmail });

		if (!pending) {
			return res.status(400).json({ message: "There is no pending verification for this email. Please register again." });
		}

		if (pending.otpExpires < new Date()) {
			return res.status(400).json({ message: "Verification code expired. Please request a new one." });
		}

		if ((pending.otpAttempts || 0) >= MAX_OTP_ATTEMPTS) {
			return res.status(429).json({ message: "Too many incorrect codes. Please request a new one." });
		}

		if (!otpMatches(pending.otpHash, trimmedOtp)) {
			await PendingRegistration.updateOne({ _id: pending._id }, { $inc: { otpAttempts: 1 } });
			return res.status(400).json({ message: "Invalid verification code." });
		}

		if (await User.exists({ email: trimmedEmail })) {
			await PendingRegistration.deleteOne({ _id: pending._id });
			return res.status(409).json({ message: "An account with that email already exists." });
		}

		// The code is correct: only now is the account created.
		const user = await User.create({
			name: pending.name,
			email: pending.email,
			passwordHash: pending.passwordHash,
		});

		await PendingRegistration.deleteOne({ _id: pending._id });

		sendWelcomeEmail({
			to: user.email,
			name: user.name,
		}).catch((error) => {
			console.warn("Failed to send welcome email", { message: error?.message || String(error) });
		});

		return res.status(200).json({
			message: "Email verified. You can now log in.",
		});
	} catch (error) {
		return next(error);
	}
};

const resendRegistrationOtp = async (req, res, next) => {
	try {
		const { email } = req.body || {};
		const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

		if (!trimmedEmail) {
			return res.status(400).json({ message: "Email is required." });
		}

		if (rejectIfDatabaseUnavailable(res)) {
			return;
		}

		const pending = await PendingRegistration.findOne({ email: trimmedEmail });

		// Same answer whether or not a pending signup exists, so this endpoint
		// can't be used to probe which emails are registered.
		if (!pending) {
			return res.status(200).json({ message: "If a pending signup exists for this email, a new code was sent." });
		}

		const waitMs = getRegistrationResendWaitMs(pending);

		if (waitMs > 0) {
			return res.status(429).json({
				message: `Please wait ${Math.ceil(waitMs / 1000)} seconds before requesting another code.`,
				retryAfterSeconds: Math.ceil(waitMs / 1000),
			});
		}

		try {
			await issueRegistrationOtp({ email: trimmedEmail });
		} catch (error) {
			console.error("Failed to resend registration OTP email", { message: error?.message || String(error) });
			return res.status(502).json({ message: "We couldn't send the verification email. Please try again." });
		}

		return res.status(200).json({ message: "A new verification code has been sent." });
	} catch (error) {
		return next(error);
	}
};

// const loginUser = async (req, res, next) => {
// 	try {
// 		const { email, password } = req.body;

// 		const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
// 		const trimmedPassword = typeof password === "string" ? password.trim() : "";

// 		if (!trimmedEmail || !trimmedPassword) {
// 			return res.status(400).json({ message: "Email and password are required." });
// 		}

// 		if (rejectIfDatabaseUnavailable(res)) {
// 			return;
// 		}

// 		const user = await User.findOne({ email: trimmedEmail }).select("+passwordHash +knownDevices");

// 		if (!user || !verifyPassword(trimmedPassword, user.passwordHash)) {
// 			return res.status(401).json({ message: "Invalid email or password." });
// 		}

// 		const deviceId = resolveDeviceId(req);
// 		const { isNewDevice } = await registerLoginDevice(user, deviceId, req);
// 		const settingsDocument = await Settings.findById(user._id).select("loginAlerts").lean();
// 		const loginAlertsEnabled = settingsDocument?.loginAlerts !== false;
// 		const newBrowserLogin = isNewDevice && loginAlertsEnabled;

// 		const token = createToken(user);
// 		res.setHeader("Set-Cookie", [buildCookie(token), buildDeviceCookie(deviceId)]);

// 		return res.status(200).json({
// 			message: "Login successful.",
// 			user: await buildUserProfile(user),
// 			token,
// 			newBrowserLogin,
// 		});
// 	} catch (error) {
// 		return next(error);
// 	}
// };

const loginUser = async (req, res, next) => {
	try {
		const { email, password } = req.body;

		const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
		const trimmedPassword = typeof password === "string" ? password.trim() : "";

		if (!trimmedEmail || !trimmedPassword) {
			return res.status(400).json({ message: "Email and password are required." });
		}

		if (rejectIfDatabaseUnavailable(res)) {
			return;
		}

		const user = await User.findOne({ email: trimmedEmail }).select(
			"+passwordHash +knownDevices +failedLoginAttempts +lockUntil"
		);

		// Check the lock before the password, so a correct guess can't get in mid-lockout.
		const lockRemainingMs = getLockRemainingMs(user);

		if (lockRemainingMs > 0) {
			return respondLocked(res, lockRemainingMs);
		}

		if (!user || !verifyPassword(trimmedPassword, user.passwordHash)) {
			if (user) {
				const failure = await recordFailedLogin(user);

				if (failure.locked) {
					return respondLocked(res, failure.remainingMs);
				}

				return res.status(401).json({
					message: `Invalid email or password. ${failure.attemptsRemaining} attempt${failure.attemptsRemaining === 1 ? "" : "s"} remaining before a 15-minute lock.`,
				});
			}

			return res.status(401).json({ message: "Invalid email or password." });
		}

		// Legacy row from an earlier version that saved accounts before the code was entered.
		if (user.emailVerified === false) {
			return res.status(403).json({ message: "This email was never verified. Please register again." });
		}

		const settingsDocument = await Settings.findById(user._id).select("loginAlerts twoFactorEnabled").lean();
		const twoFactorEnabled = settingsDocument?.twoFactorEnabled === true;

		if (twoFactorEnabled) {
			const otp = Math.floor(100000 + Math.random() * 900000).toString();

			user.twoFactorOtp = otp;
			user.twoFactorOtpExpires = new Date(Date.now() + 10 * 60 * 1000);
			await user.save();

			sendLoginOtpEmail({
				to: user.email,
				name: user.name,
				otp,
			}).catch((error) => {
				console.warn("Failed to send login verification email", { message: error?.message || String(error) });
			});

			return res.status(200).json({
				message: "Verification code sent to your email.",
				twoFactorRequired: true,
				email: user.email,
			});
		}

		clearLoginFailures(user);

		const deviceId = resolveDeviceId(req);
		const { isNewDevice } = await registerLoginDevice(user, deviceId, req);
		const loginAlertsEnabled = settingsDocument?.loginAlerts !== false;
		const newBrowserLogin = isNewDevice && loginAlertsEnabled;

		const token = createToken(user);
		res.setHeader("Set-Cookie", [buildCookie(token), buildDeviceCookie(deviceId)]);

		return res.status(200).json({
			message: "Login successful.",
			user: await buildUserProfile(user),
			token,
			newBrowserLogin,
		});
	} catch (error) {
		return next(error);
	}
};

const verifyLoginOtp = async (req, res, next) => {
	try {
		const { email, otp } = req.body;

		const trimmedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";
		const trimmedOtp = typeof otp === "string" ? otp.trim() : "";

		if (!trimmedEmail || !trimmedOtp) {
			return res.status(400).json({ message: "Email and verification code are required." });
		}

		if (rejectIfDatabaseUnavailable(res)) {
			return;
		}

		const user = await User.findOne({ email: trimmedEmail }).select(
			"+knownDevices +twoFactorOtp +twoFactorOtpExpires +failedLoginAttempts +lockUntil"
		);

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const lockRemainingMs = getLockRemainingMs(user);

		if (lockRemainingMs > 0) {
			return respondLocked(res, lockRemainingMs);
		}

		if (!user.twoFactorOtp || user.twoFactorOtp !== trimmedOtp) {
			// Wrong 2FA codes count toward the same lock, otherwise a 6-digit code could be brute-forced.
			const failure = await recordFailedLogin(user);

			if (failure.locked) {
				return respondLocked(res, failure.remainingMs);
			}

			return res.status(400).json({ message: "Invalid verification code." });
		}

		if (!user.twoFactorOtpExpires || user.twoFactorOtpExpires < new Date()) {
			return res.status(400).json({ message: "Verification code expired." });
		}

		user.twoFactorOtp = null;
		user.twoFactorOtpExpires = null;
		clearLoginFailures(user);

		const deviceId = resolveDeviceId(req);
		const { isNewDevice } = await registerLoginDevice(user, deviceId, req);
		const settingsDocument = await Settings.findById(user._id).select("loginAlerts").lean();
		const loginAlertsEnabled = settingsDocument?.loginAlerts !== false;
		const newBrowserLogin = isNewDevice && loginAlertsEnabled;

		const token = createToken(user);
		res.setHeader("Set-Cookie", [buildCookie(token), buildDeviceCookie(deviceId)]);

		return res.status(200).json({
			message: "Login successful.",
			user: await buildUserProfile(user),
			token,
			newBrowserLogin,
		});
	} catch (error) {
		return next(error);
	}
};

const forgotPassword = async (req, res, next) => {
	try {
		const { email } = req.body;

		console.log("[forgotPassword] Received request for email:", email);

		const trimmedEmail =
			typeof email === "string"
				? email.trim().toLowerCase()
				: "";

		if (!trimmedEmail) {
			console.log("[forgotPassword] Email is empty");
			return res.status(400).json({
				message: "Email is required.",
			});
		}

		console.log("[forgotPassword] Looking up user with email:", trimmedEmail);

		const user = await User.findOne({
			email: trimmedEmail,
		}).select("+resetOtp +resetOtpExpires +otpVerified");

		if (!user) {
			console.log("[forgotPassword] User not found for email:", trimmedEmail);
			return res.status(404).json({
				message: "No account found with this email.",
			});
		}

		console.log("[forgotPassword] User found:", user.name);

		const otp = Math.floor(
			100000 + Math.random() * 900000
		).toString();

		console.log("[forgotPassword] Generated OTP:", otp, "for user:", user.email);

		user.resetOtp = otp;
		user.otpVerified = false;
		user.resetOtpExpires = new Date(Date.now() + 10 * 60 * 1000);

		await user.save();

		console.log("[forgotPassword] OTP saved. Sending email to:", user.email);

		sendResetOtpEmail({
			to: user.email,
			name: user.name,
			otp,
		}).catch((error) => {
			console.error("[forgotPassword] Failed to send reset OTP email", {
				email: user.email,
				message: error?.message || String(error),
				stack: error?.stack
			});
		});

		console.log("[forgotPassword] Response sent successfully");

		return res.status(200).json({
			message: "OTP sent to your email.",
		});
	} catch (error) {
		console.error("[forgotPassword] Error:", error?.message || String(error), error?.stack);
		return next(error);
	}
};

const verifyResetOtp = async (req, res, next) => {
	try {
		const { email, otp } = req.body;

		const trimmedEmail =
			typeof email === "string"
				? email.trim().toLowerCase()
				: "";

		const trimmedOtp =
			typeof otp === "string"
				? otp.trim()
				: "";

		const user = await User.findOne({
			email: trimmedEmail,
		}).select("+resetOtp +resetOtpExpires +otpVerified");

		if (!user) {
			return res.status(404).json({
				message: "User not found.",
			});
		}

		if (
			!user.resetOtp ||
			user.resetOtp !== trimmedOtp
		) {
			return res.status(400).json({
				message: "Invalid OTP.",
			});
		}

		if (
			!user.resetOtpExpires ||
			user.resetOtpExpires < new Date()
		) {
			return res.status(400).json({
				message: "OTP expired.",
			});
		}

		user.otpVerified = true;
		await user.save();

		return res.status(200).json({
			message: "OTP verified successfully.",
		});
	} catch (error) {
		return next(error);
	}
};

const resetPassword = async (req, res, next) => {
	try {
		const { email, newPassword } = req.body;

		const trimmedEmail =
			typeof email === "string"
				? email.trim().toLowerCase()
				: "";

		const trimmedPassword =
			typeof newPassword === "string"
				? newPassword.trim()
				: "";

		if (trimmedPassword.length < 6) {
			return res.status(400).json({
				message: "Password must be at least 6 characters.",
			});
		}

		const user = await User.findOne({
			email: trimmedEmail,
		}).select("+otpVerified");

		if (!user) {
			return res.status(404).json({
				message: "User not found.",
			});
		}

		if (!user.otpVerified) {
			return res.status(403).json({
				message: "OTP verification required.",
			});
		}

		user.passwordHash = hashPassword(trimmedPassword);

		user.resetOtp = null;
		user.resetOtpExpires = null;
		user.otpVerified = false;

		await user.save();

		return res.status(200).json({
			message: "Password reset successful.",
		});
	} catch (error) {
		return next(error);
	}
};

const getCurrentUser = async (req, res) => {
	return res.status(200).json({
		user: req.user,
	});
};

const logoutUser = async (req, res) => {
	res.setHeader("Set-Cookie", buildClearedCookie());
	return res.status(200).json({ message: "Logged out successfully." });
};

const submitFeedback = async (req, res, next) => {
	try {
		const { userId } = req.auth || {};
		const user = req.user || {};
		const { message, topics } = req.body || {};
		const trimmedMessage = typeof message === "string" ? message.trim() : "";
		const selectedTopics = Array.isArray(topics)
			? topics.map((topic) => String(topic ?? "").trim()).filter(Boolean).slice(0, 5)
			: [];

		if (!userId) {
			return res.status(401).json({ message: "Not authenticated." });
		}

		if (!trimmedMessage) {
			return res.status(400).json({ message: "Feedback message is required." });
		}

		if (trimmedMessage.length > 2000) {
			return res.status(400).json({ message: "Feedback message must be 2000 characters or less." });
		}

		await sendFeedbackEmail({
			name: user?.name || "Quantic user",
			email: user?.email || "",
			userId,
			message: trimmedMessage,
			topics: selectedTopics.join(", "),
			createdAt: new Date().toISOString(),
		});

		return res.status(200).json({
			message: "Feedback sent to the Quantic team.",
		});
	} catch (error) {
		return next(error);
	}
};

const deleteAccount = async (req, res, next) => {
	try {
		const { userId } = req.auth || {};

		if (!userId) {
			return res.status(401).json({ message: "Not authenticated." });
		}

		if (rejectIfDatabaseUnavailable(res)) {
			return;
		}

		const user = await User.findById(userId);

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		if (user.markedForDeletionAt) {
			return res.status(400).json({ message: "Account deletion is already scheduled." });
		}

		const oneHourFromNow = new Date(Date.now() + 60 * 60 * 1000);
		user.markedForDeletionAt = oneHourFromNow;
		await user.save();

		res.setHeader("Set-Cookie", buildClearedCookie());

		return res.status(200).json({
			message: "Account deletion scheduled. Your account will be permanently deleted after 1 hour.",
			deletionDate: oneHourFromNow.toISOString(),
		});
	} catch (error) {
		return next(error);
	}
};

const cancelAccountDeletion = async (req, res, next) => {
	try {
		const { userId } = req.auth || {};

		if (!userId) {
			return res.status(401).json({ message: "Not authenticated." });
		}

		if (rejectIfDatabaseUnavailable(res)) {
			return;
		}

		const user = await User.findById(userId);

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		if (!user.markedForDeletionAt) {
			return res.status(400).json({ message: "No account deletion is currently scheduled." });
		}

		user.markedForDeletionAt = null;
		await user.save();

		return res.status(200).json({
			message: "Account deletion has been cancelled.",
			user: await buildUserProfile(user),
		});
	} catch (error) {
		return next(error);
	}
};

const cleanupExpiredAccounts = async () => {
	try {
		if (!isDatabaseConnected()) {
			console.warn("[Cleanup] Skipping account cleanup because database is unavailable.");
			return null;
		}

		const now = new Date();
		const result = await User.deleteMany({
			markedForDeletionAt: { $lte: now },
		});

		if (result.deletedCount > 0) {
			console.log(`[Cleanup] Deleted ${result.deletedCount} account(s) marked for deletion.`);
		}

		const abandoned = await User.deleteMany({
			emailVerified: false,
			updatedAt: { $lte: new Date(Date.now() - UNVERIFIED_ACCOUNT_TTL_MS) },
		});

		if (abandoned.deletedCount > 0) {
			console.log(`[Cleanup] Deleted ${abandoned.deletedCount} unverified signup(s) older than 24h.`);
		}

		return result;
	} catch (error) {
		console.error("[Cleanup] Error during account cleanup:", error);
	}
};

// const scheduleCleanupJob = () => {
// 	setInterval(cleanupExpiredAccounts, 24 * 60 * 60 * 1000);
// 	console.log("[Startup] Account cleanup job scheduled to run daily.");
// };

const scheduleCleanupJob = () => {
	cleanupExpiredAccounts();
	setInterval(cleanupExpiredAccounts, 60 * 1000);
	console.log("[Startup] Account cleanup job scheduled to run every minute.");
};

module.exports = {
	registerUser,
	verifyRegistrationOtp,
	resendRegistrationOtp,
	loginUser,
	verifyLoginOtp,
	getCurrentUser,
	changePassword,
	logoutUser,
	submitFeedback,
	deleteAccount,
	cancelAccountDeletion,
	scheduleCleanupJob,
	forgotPassword,
	verifyResetOtp,
	resetPassword,
};