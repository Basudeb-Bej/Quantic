// back-end/services/emailService.js
const EMAILJS_ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send";
const EMAILJS_TIMEOUT_MS = Number(process.env.EMAILJS_TIMEOUT_MS || 15000);
const APP_URL = process.env.APP_URL || "http://localhost:5173";

const getConfig = () => {
	const config = {
		serviceId: String(process.env.EMAILJS_SERVICE_ID || "").trim(),
		publicKey: String(process.env.EMAILJS_PUBLIC_KEY || "").trim(),
		privateKey: String(process.env.EMAILJS_PRIVATE_KEY || "").trim(),
		otpTemplateId: String(process.env.EMAILJS_OTP_TEMPLATE_ID || "").trim(),
		generalTemplateId: String(process.env.EMAILJS_GENERAL_TEMPLATE_ID || "").trim(),
	};

	const missing = [
		["EMAILJS_SERVICE_ID", config.serviceId],
		["EMAILJS_PUBLIC_KEY", config.publicKey],
		["EMAILJS_OTP_TEMPLATE_ID", config.otpTemplateId],
		["EMAILJS_GENERAL_TEMPLATE_ID", config.generalTemplateId],
	]
		.filter(([, value]) => !value)
		.map(([name]) => name);

	if (missing.length) {
		throw new Error(`Email service is not configured. Missing: ${missing.join(", ")}`);
	}

	return config;
};

const sendWithEmailJs = async (templateKey, templateParams) => {
	if (typeof fetch !== "function") {
		throw new Error("Email service needs Node.js 18 or newer (global fetch).");
	}

	const config = getConfig();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), EMAILJS_TIMEOUT_MS);

	try {
		const response = await fetch(EMAILJS_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				service_id: config.serviceId,
				template_id: templateKey === "otp" ? config.otpTemplateId : config.generalTemplateId,
				user_id: config.publicKey,
				...(config.privateKey ? { accessToken: config.privateKey } : {}),
				template_params: templateParams,
			}),
			signal: controller.signal,
		});

		const body = await response.text();

		if (!response.ok) {
			const hint = /non-browser/i.test(body)
				? " Turn on \"Allow EmailJS API for non-browser applications\" in EmailJS > Account > Security."
				: "";
			const error = new Error(`EmailJS rejected the email (${response.status}): ${body.slice(0, 200)}.${hint}`);
			error.status = response.status;
			throw error;
		}

		return { ok: true, status: response.status };
	} catch (error) {
		if (error?.name === "AbortError") {
			throw new Error("EmailJS did not respond in time.");
		}

		throw error;
	} finally {
		clearTimeout(timer);
	}
};

const requireRecipient = (to) => {
	if (!to) {
		throw new Error("Recipient email is required.");
	}
};

const escapeHtml = (value) =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const OTP_EMAILS = {
	login: {
		subject: "Quantic Sign-in Verification Code",
		icon: "🔐",
		heading: "Verification Code",
		intro: "A sign-in request was initiated for your Quantic account. Enter the one-time verification code below to authenticate:",
		title: "Quantic — Sign-in Code",
		preheader: (otp) => `Your authentication code is ${otp}.`,
	},
	reset: {
		subject: "Quantic Password Reset OTP",
		icon: "🔑",
		heading: "Reset Password",
		intro: "We received a request to reset your password. Enter the one-time authorization code below to complete the reset process:",
		title: "Quantic — Password Reset",
		preheader: (otp) => `Your password reset code is ${otp}.`,
	},
	register: {
		subject: "Verify your Quantic email address",
		icon: "✉️",
		heading: "Verify Your Email",
		intro: "Thanks for signing up for Quantic. Enter the one-time code below to confirm your email address and finish creating your account:",
		title: "Quantic — Verify Your Email",
		preheader: (otp) => `Your email verification code is ${otp}.`,
		steps: [
			"Go back to the Quantic sign-up window you just used (it should still be open on the “Verify email” screen).",
			"Type or paste the 6-digit code into the boxes under “Verification code”.",
			"Click “Verify email”. Your account is created, and you can then log in.",
		],
		stepsNote: "Closed the window? Open Quantic and register again with the same email. We’ll send you a fresh code.",
		ctaLabel: "Open Quantic",
	},
};

const sendOtpEmail = async ({ kind, to, name, otp }) => {
	requireRecipient(to);

	const content = OTP_EMAILS[kind];
	const steps = content.steps || [];

	return sendWithEmailJs("otp", {
		to_email: to,
		subject: content.subject,
		title: content.title,
		preheader: content.preheader(otp),
		icon: content.icon,
		heading: content.heading,
		name: name || "there",
		intro: content.intro,
		otp: String(otp ?? ""),
		// The setup-steps box and button exist in the template; this switch shows or hides them.
		steps_display: steps.length ? "block" : "none",
		step_1: steps[0] || "",
		step_2: steps[1] || "",
		step_3: steps[2] || "",
		steps_note: content.stepsNote || "",
		cta_label: content.ctaLabel || "",
		app_url: APP_URL,
		year: String(new Date().getFullYear()),
	});
};

const sendLoginOtpEmail = ({ to, name, otp }) => sendOtpEmail({ kind: "login", to, name, otp });
const sendResetOtpEmail = ({ to, name, otp }) => sendOtpEmail({ kind: "reset", to, name, otp });
const sendRegistrationOtpEmail = ({ to, name, otp }) => sendOtpEmail({ kind: "register", to, name, otp });

/* ------------------------------------------------------------------------- *
 * Template 2: General (welcome + feedback)
 * ------------------------------------------------------------------------- */

// Every field the template reads, so the section that is not being sent stays blank.
const generalDefaults = () => ({
	welcome_display: "none",
	feedback_display: "none",
	name: "",
	fb_name: "",
	fb_email: "",
	fb_user_id: "",
	fb_topics: "",
	fb_date: "",
	fb_message_html: "",
	app_url: APP_URL,
	year: String(new Date().getFullYear()),
});

const sendWelcomeEmail = async ({ to, name }) => {
	requireRecipient(to);

	return sendWithEmailJs("general", {
		...generalDefaults(),
		to_email: to,
		subject: "Welcome to Quantic",
		title: "Welcome to Quantic",
		preheader: "Your Quantic account is ready. Get started with your workspace.",
		welcome_display: "block",
		name: name || "there",
	});
};

const sendFeedbackEmail = async ({ name, email, userId, message, topics, createdAt }) => {
	const recipient = process.env.FEEDBACK_TEAM_EMAIL || process.env.EMAIL_USER;

	if (!recipient) {
		throw new Error("Feedback recipient is not configured.");
	}

	return sendWithEmailJs("general", {
		...generalDefaults(),
		to_email: recipient,
		subject: `Quantic feedback from ${name || email || "user"}`,
		title: `Quantic Feedback from ${name || email || "User"}`,
		preheader: `New feedback submitted by ${name || email || "a user"}.`,
		feedback_display: "block",
		fb_name: name || "Unknown",
		fb_email: email || "Unknown",
		fb_user_id: userId || "Unknown",
		fb_topics: topics || "General",
		fb_date: createdAt || new Date().toISOString(),
		fb_message_html: escapeHtml(message || "(empty)").replace(/\n/g, "<br>"),
	});
};

module.exports = {
	sendRegistrationOtpEmail,
	sendWelcomeEmail,
	sendFeedbackEmail,
	sendResetOtpEmail,
	sendLoginOtpEmail,
};
