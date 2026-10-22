// back-end/services/emailService.js
const nodemailer = require("nodemailer");
const EMAILJS_ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send";
const EMAILJS_TIMEOUT_MS = Number(process.env.EMAILJS_TIMEOUT_MS || 15000);
const APP_URL = process.env.APP_URL || (process.env.NODE_ENV === "production"
	? "https://quantic-nu.vercel.app"
	: "http://localhost:5173");

// Production defaults to authenticated SMTP. EmailJS remains available for local
// development or an explicitly selected provider, but neither provider can
// guarantee Gmail inbox placement without correct sender-domain authentication.
const getEmailProvider = () =>
	String(process.env.EMAIL_PROVIDER || (process.env.NODE_ENV === "production" ? "smtp" : "emailjs"))
		.trim()
		.toLowerCase();

const sendWithSmtp = async (templateKey, templateParams) => {
	const host = String(process.env.SMTP_HOST || "").trim();
	const user = String(process.env.SMTP_USER || "").trim();
	const pass = String(process.env.SMTP_PASS || "");
	const fromEmail = String(process.env.SMTP_FROM_EMAIL || "").trim();
	const fromName = String(process.env.SMTP_FROM_NAME || "Quantic").trim();
	const port = Number(process.env.SMTP_PORT || 587);
	const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

	const missing = [
		["SMTP_HOST", host],
		["SMTP_USER", user],
		["SMTP_PASS", pass],
		["SMTP_FROM_EMAIL", fromEmail],
	].filter(([, value]) => !value).map(([name]) => name);

	if (missing.length) {
		throw new Error(`SMTP email provider is not configured. Missing: ${missing.join(", ")}`);
	}

	const recipient = normalizeRecipient(templateParams?.to_email);
	if (!recipient) throw new Error("Recipient email is required.");

	const subject = String(templateParams?.subject || "Message from Quantic");
	const title = String(templateParams?.title || subject);
	const preheader = String(templateParams?.preheader || "");
	const name = String(templateParams?.name || "there");
	const intro = String(templateParams?.intro || "");
	const otp = String(templateParams?.otp || "");
	const appUrl = String(templateParams?.app_url || APP_URL);
	const isFeedback = templateKey === "general" && templateParams?.feedback_display === "block";
	const isWelcome = templateKey === "general" && templateParams?.welcome_display === "block";

	let contentHtml = "";
	let contentText = "";

	if (otp) {
		const steps = [templateParams?.step_1, templateParams?.step_2, templateParams?.step_3]
			.map((step) => String(step || "").trim()).filter(Boolean);
		contentHtml = `
			<p>Hello ${escapeHtml(name)},</p>
			<p>${escapeHtml(intro)}</p>
			<div style="margin:24px 0;padding:18px;text-align:center;background:#f3f4f6;border-radius:12px;font-size:30px;font-weight:700;letter-spacing:8px;color:#111827">${escapeHtml(otp)}</div>
			<p>This code is time-limited. If you did not request it, you can ignore this email.</p>
			${steps.length ? `<ol>${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>` : ""}
			<p><a href="${escapeHtml(appUrl)}">Open Quantic</a></p>`;
		contentText = [`Hello ${name},`, intro, `Verification code: ${otp}`, "This code is time-limited. If you did not request it, ignore this email.", ...steps, appUrl].filter(Boolean).join("\n\n");
	} else if (isFeedback) {
		const feedback = String(templateParams?.fb_message_html || "");
		contentHtml = `<p>New feedback from ${escapeHtml(templateParams?.fb_name || "Unknown")} (${escapeHtml(templateParams?.fb_email || "Unknown")}).</p><p>Topics: ${escapeHtml(templateParams?.fb_topics || "General")}</p><div style="white-space:normal;border:1px solid #ddd;padding:16px;border-radius:8px">${feedback}</div>`;
		contentText = [`Feedback from: ${templateParams?.fb_name || "Unknown"}`, `Email: ${templateParams?.fb_email || "Unknown"}`, `Topics: ${templateParams?.fb_topics || "General"}`, feedback.replace(/<br\\s*\\/?\\s*>/gi, "\n").replace(/<[^>]*>/g, "")].join("\n\n");
	} else if (isWelcome) {
		contentHtml = `<p>Hello ${escapeHtml(name)},</p><p>Your Quantic account is ready. You can now start chatting, exploring ideas, and working with your files.</p><p><a href="${escapeHtml(appUrl)}">Open Quantic</a></p>`;
		contentText = `Hello ${name},\n\nYour Quantic account is ready.\n\nOpen Quantic: ${appUrl}`;
	} else {
		contentHtml = `<p>Hello ${escapeHtml(name)},</p><p>${escapeHtml(preheader || intro || title)}</p>`;
		contentText = [`Hello ${name},`, preheader || intro || title].join("\n\n");
	}

	const transporter = nodemailer.createTransport({
		host,
		port,
		secure,
		auth: { user, pass },
		connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
		greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
		socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000),
	});

	const result = await transporter.sendMail({
		from: { name: fromName, address: fromEmail },
		to: recipient,
		subject,
		text: contentText,
		html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7fb;font-family:Arial,sans-serif;color:#1f2937"><div style="max-width:600px;margin:0 auto;background:#fff;padding:28px;border-radius:14px"><div style="font-size:20px;font-weight:700;margin-bottom:20px">Quantic</div><h1 style="font-size:22px">${escapeHtml(title)}</h1>${preheader ? `<div style="color:#6b7280;font-size:13px;margin-bottom:20px">${escapeHtml(preheader)}</div>` : ""}${contentHtml}<hr style="border:0;border-top:1px solid #e5e7eb;margin-top:28px"><p style="color:#6b7280;font-size:12px">This message was sent by Quantic. Email delivery depends on the receiving provider's filtering and sender authentication.</p></div></body></html>`,
	});

	console.info("[Email SMTP] Send request accepted", {
		template: templateKey,
		to: maskEmail(recipient),
		messageId: result.messageId,
		accepted: Array.isArray(result.accepted) ? result.accepted.length : 0,
		rejected: Array.isArray(result.rejected) ? result.rejected.length : 0,
	});

	if (Array.isArray(result.rejected) && result.rejected.length) {
		throw new Error("SMTP server rejected one or more email recipients.");
	}

	return { ok: true, messageId: result.messageId };
};

const getConfig = () => {
	const config = {
		serviceId: String(process.env.EMAILJS_SERVICE_ID || "").trim(),
		publicKey: String(process.env.EMAILJS_PUBLIC_KEY || "").trim(),
		privateKey: String(process.env.EMAILJS_PRIVATE_KEY || "").trim(),
		otpTemplateId: String(process.env.EMAILJS_OTP_TEMPLATE_ID || "").trim(),
		generalTemplateId: String(process.env.EMAILJS_GENERAL_TEMPLATE_ID || process.env.EMAILJS_WELCOME_TEMPLATE_ID || "").trim(),
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

const normalizeRecipient = (value) => String(value ?? "").trim().toLowerCase();

const maskEmail = (value) => {
	const email = normalizeRecipient(value);
	const at = email.lastIndexOf("@");

	if (at <= 0 || at === email.length - 1) {
		return email ? "[invalid-email]" : "[missing-email]";
	}

	const local = email.slice(0, at);
	const domain = email.slice(at + 1);
	return local.slice(0, 1) + "***@" + domain;
};

const sendWithEmailJs = async (templateKey, templateParams) => {
	if (getEmailProvider() === "smtp") {
		return sendWithSmtp(templateKey, templateParams);
	}
	if (getEmailProvider() !== "emailjs") {
		throw new Error('Invalid EMAIL_PROVIDER. Use "smtp" or "emailjs".');
	}
	if (typeof fetch !== "function") {
		throw new Error("Email service needs Node.js 18 or newer (global fetch).");
	}

	const config = getConfig();
	const recipient = normalizeRecipient(templateParams?.to_email);

	if (!recipient) {
		throw new Error("Recipient email is required.");
	}

	const safeTemplateParams = { ...templateParams, to_email: recipient };
	const templateId = templateKey === "otp" ? config.otpTemplateId : config.generalTemplateId;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), EMAILJS_TIMEOUT_MS);

	try {
		const response = await fetch(EMAILJS_ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				service_id: config.serviceId,
				template_id: templateId,
				user_id: config.publicKey,
				...(config.privateKey ? { accessToken: config.privateKey } : {}),
				template_params: safeTemplateParams,
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

		// EmailJS 200 means the request was accepted, not that the recipient's inbox received it.
		// Log only a masked destination so production logs can help verify routing without exposing full addresses.
		console.info("[EmailJS] Send request accepted", {
			template: templateKey,
			templateId,
			to: maskEmail(recipient),
			status: response.status,
		});

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

// Values are passed RAW: EmailJS escapes {{variables}} itself.
// The one exception is the feedback message, which is escaped here so line breaks can become <br>.
const escapeHtml = (value) =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

/* ------------------------------------------------------------------------- *
 * Template 1: OTP emails (login 2FA / password reset / registration)
 * ------------------------------------------------------------------------- */

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
