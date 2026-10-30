// back-end/services/emailService.js
const nodemailer = require("nodemailer");

const EMAILJS_ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send";
const EMAILJS_TIMEOUT_MS = Number(process.env.EMAILJS_TIMEOUT_MS || 15000);
const OTP_EXPIRY_MINUTES = Number(process.env.OTP_EXPIRY_MINUTES || 10); // keep in sync with your OTP validity
const APP_URL = process.env.APP_URL || (process.env.NODE_ENV === "production"
	? "https://quantic-nu.vercel.app"
	: "http://localhost:5173");

const getEmailProvider = () =>
	String(process.env.EMAIL_PROVIDER || "emailjs")
		.trim()
		.toLowerCase();

const escapeHtml = (value) =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const normalizeRecipient = (value) => String(value ?? "").trim().toLowerCase();

const maskEmail = (value) => {
	const email = normalizeRecipient(value);
	const at = email.lastIndexOf("@");

	if (at <= 0 || at === email.length - 1) {
		return email ? "[invalid-email]" : "[missing-email]";
	}

	return email.slice(0, 1) + "***@" + email.slice(at + 1);
};

const requireRecipient = (to) => {
	if (!normalizeRecipient(to)) {
		throw new Error("Recipient email is required.");
	}
};

const formatRequestTime = (date = new Date()) =>
	`${new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(date)} UTC`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let smtpTransport = null;
let smtpTransportKey = "";

const getSmtpTransport = ({ host, port, secure, user, pass }) => {
	const key = JSON.stringify([host, port, secure, user]);

	if (!smtpTransport || key !== smtpTransportKey) {
		smtpTransport = nodemailer.createTransport({
			host,
			port,
			secure,
			auth: { user, pass },
			connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
			greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
			socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000),
		});
		smtpTransportKey = key;
	}

	return smtpTransport;
};

const smtpShell = ({ title, eyebrow, bodyHtml, footer }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f4f6f8;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:560px;">
<tr><td style="padding:0 4px 18px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
<td width="32" height="32" align="center" style="width:32px;height:32px;background-color:#2563eb;border-radius:8px;color:#ffffff;font-size:17px;font-weight:700;line-height:32px;">Q</td>
<td style="padding-left:10px;font-size:18px;font-weight:700;color:#111827;">Quantic</td></tr></table></td></tr>
<tr><td style="background-color:#ffffff;border:1px solid #e3e7ec;border-top:4px solid #2563eb;border-radius:14px;padding:36px 36px 32px;">
${eyebrow ? `<div style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#2563eb;">${escapeHtml(eyebrow)}</div>` : ""}
${bodyHtml}
</td></tr>
<tr><td align="center" style="padding:20px 8px 0;font-size:12px;line-height:1.6;color:#9ca3af;">${escapeHtml(footer)}<br>&copy; ${new Date().getFullYear()} Quantic</td></tr>
</table></td></tr></table></body></html>`;

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
	const name = String(templateParams?.name || "there");
	const otp = String(templateParams?.otp || "");
	const appUrl = String(templateParams?.app_url || APP_URL);
	const isFeedback = templateKey === "general" && templateParams?.feedback_display === "block";
	const isWelcome = templateKey === "general" && templateParams?.welcome_display === "block";

	let eyebrow = "";
	let bodyHtml = "";
	let contentText = "";
	let footer = `You received this email because a request was made with ${recipient}.`;

	if (otp) {
		const intro = String(templateParams?.intro || "");
		const hint = String(templateParams?.hint || "");
		const heading = String(templateParams?.heading || "Verification code");
		const expiry = String(templateParams?.expiry_minutes || OTP_EXPIRY_MINUTES);
		const requestTime = String(templateParams?.request_time || formatRequestTime());
		eyebrow = String(templateParams?.purpose || "Verification");
		bodyHtml = `
<h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;font-weight:700;color:#111827;">${escapeHtml(heading)}</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#374151;">Hello ${escapeHtml(name)},</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(intro)}</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="background-color:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:20px 12px;">
<div style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#64748b;margin-bottom:8px;">Verification code</div>
<div style="font-family:Consolas,'SFMono-Regular','Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:10px;color:#0f172a;">${escapeHtml(otp)}</div>
<div style="font-size:13px;color:#64748b;margin-top:10px;">Expires in ${escapeHtml(expiry)} minutes</div></td></tr></table>
${hint ? `<p style="margin:20px 0 0;font-size:14px;line-height:1.6;color:#4b5563;">${escapeHtml(hint)}</p>` : ""}
<p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">Requested ${escapeHtml(requestTime)}</p>
<div style="margin-top:24px;background-color:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;font-size:13px;line-height:1.6;color:#78350f;"><strong>Keep this code private.</strong> Quantic will never ask you for it. If you did not request it, you can ignore this email.</div>`;
		contentText = [
			`Hello ${name},`,
			intro,
			`Verification code: ${otp}`,
			`This code expires in ${expiry} minutes.`,
			hint,
			"Keep this code private. Quantic will never ask you for it. If you did not request it, ignore this email.",
		].filter(Boolean).join("\n\n");
	} else if (isFeedback) {
		const feedback = String(templateParams?.fb_message_html || "");
		eyebrow = "Feedback";
		footer = "Internal notification from the Quantic feedback form.";
		bodyHtml = `
<h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;font-weight:700;color:#111827;">New feedback</h1>
<p style="margin:0 0 4px;font-size:14px;color:#374151;"><strong>User:</strong> ${escapeHtml(templateParams?.fb_name || "Unknown")}</p>
<p style="margin:0 0 4px;font-size:14px;color:#374151;"><strong>Email:</strong> ${escapeHtml(templateParams?.fb_email || "Unknown")}</p>
<p style="margin:0 0 4px;font-size:14px;color:#374151;"><strong>User ID:</strong> ${escapeHtml(templateParams?.fb_user_id || "Unknown")}</p>
<p style="margin:0 0 4px;font-size:14px;color:#374151;"><strong>Category:</strong> ${escapeHtml(templateParams?.fb_topics || "General")}</p>
<p style="margin:0 0 16px;font-size:14px;color:#374151;"><strong>Date:</strong> ${escapeHtml(templateParams?.fb_date || "")}</p>
<div style="background-color:#f9fafb;border-left:3px solid #2563eb;border-radius:6px;padding:14px 16px;font-size:14px;line-height:1.7;color:#1f2937;">${feedback}</div>`;
		contentText = [
			`Feedback from: ${templateParams?.fb_name || "Unknown"}`,
			`Email: ${templateParams?.fb_email || "Unknown"}`,
			`Topics: ${templateParams?.fb_topics || "General"}`,
			feedback.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, ""),
		].join("\n\n");
	} else if (isWelcome) {
		eyebrow = "Account created";
		footer = `You received this email because an account was created with ${recipient}.`;
		bodyHtml = `
<h1 style="margin:0 0 18px;font-size:24px;line-height:1.3;font-weight:700;color:#111827;">Welcome to Quantic</h1>
<p style="margin:0 0 8px;font-size:15px;line-height:1.6;color:#374151;">Hello ${escapeHtml(name)},</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#374151;">Your account is ready. Sign in to start chatting, exploring ideas and working with your files.</p>
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" style="background-color:#2563eb;border-radius:8px;"><a href="${escapeHtml(appUrl)}" target="_blank" style="display:inline-block;padding:12px 26px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;">Open Quantic</a></td></tr></table>
<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#6b7280;">If you did not create this account, you can ignore this email.</p>`;
		contentText = `Hello ${name},\n\nYour Quantic account is ready. Sign in to start chatting, exploring ideas and working with your files.\n\nOpen Quantic: ${appUrl}\n\nIf you did not create this account, ignore this email.`;
	} else {
		bodyHtml = `<p style="margin:0;font-size:15px;line-height:1.6;color:#374151;">Hello ${escapeHtml(name)},</p><p style="margin:12px 0 0;font-size:15px;line-height:1.6;color:#374151;">${escapeHtml(templateParams?.intro || title)}</p>`;
		contentText = `Hello ${name},\n\n${templateParams?.intro || title}`;
	}

	const result = await getSmtpTransport({ host, port, secure, user, pass }).sendMail({
		from: { name: fromName, address: fromEmail },
		replyTo: fromEmail,
		to: recipient,
		subject,
		text: contentText,
		html: smtpShell({ title, eyebrow, bodyHtml, footer }),
		headers: { "Auto-Submitted": "auto-generated" },
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

// One HTTP attempt. Errors carry `retriable` so the caller knows whether a retry is worthwhile.
const callEmailJs = async (config, templateId, params) => {
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
				template_params: params,
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
			error.retriable = response.status >= 500;
			throw error;
		}

		return response.status;
	} catch (error) {
		if (error?.name === "AbortError") {
			const timeoutError = new Error("EmailJS did not respond in time.");
			timeoutError.retriable = true;
			throw timeoutError;
		}
		if (error instanceof TypeError) {
			error.retriable = true; // network-level failure
		}
		throw error;
	} finally {
		clearTimeout(timer);
	}
};

const sendWithEmailJs = async (templateKey, templateParams) => {
	const provider = getEmailProvider();

	if (provider === "smtp") {
		return sendWithSmtp(templateKey, templateParams);
	}
	if (provider !== "emailjs") {
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

	let status;
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			status = await callEmailJs(config, templateId, safeTemplateParams);
			break;
		} catch (error) {
			if (attempt === 2 || !error?.retriable) throw error;
			console.warn("[EmailJS] Transient failure, retrying once", { template: templateKey, to: maskEmail(recipient), reason: error.message });
			await sleep(600);
		}
	}


	console.info("[EmailJS] Send request accepted", {
		template: templateKey,
		templateId,
		to: maskEmail(recipient),
		status,
	});

	return { ok: true, status };
};


const OTP_EMAILS = {
	login: {
		subject: (otp) => `Your Quantic sign-in code: ${otp}`,
		title: "Quantic sign-in code",
		purpose: "Sign-in verification",
		heading: "Confirm it's you",
		intro: "Use the code below to finish signing in to your Quantic account.",
		hint: "Enter this code on the sign-in screen where you were asked for it.",
	},
	reset: {
		subject: (otp) => `Your Quantic password reset code: ${otp}`,
		title: "Quantic password reset code",
		purpose: "Password reset",
		heading: "Reset your password",
		intro: "Use the code below to reset your Quantic password.",
		hint: "Enter this code on the password reset screen, then choose a new password.",
	},
	register: {
		subject: (otp) => `Your Quantic verification code: ${otp}`,
		title: "Quantic email verification code",
		purpose: "Email verification",
		heading: "Verify your email",
		intro: "Welcome to Quantic. Use the code below to verify your email address and finish creating your account.",
		hint: "Go back to the Quantic sign-up window and enter the code on the \u201cVerify email\u201d screen. If you closed it, register again with the same email to get a new code.",
	},
};

const sendOtpEmail = async ({ kind, to, name, otp }) => {
	requireRecipient(to);

	const content = OTP_EMAILS[kind];
	if (!content) {
		throw new Error(`Unknown OTP email kind: ${kind}`);
	}

	const code = String(otp ?? "").trim();
	if (!code) {
		throw new Error("OTP code is required.");
	}

	return sendWithEmailJs("otp", {
		to_email: to,
		subject: content.subject(code),
		title: content.title,
		purpose: content.purpose,
		heading: content.heading,
		name: name || "there",
		intro: content.intro,
		hint: content.hint,
		otp: code,
		expiry_minutes: String(OTP_EXPIRY_MINUTES),
		request_time: formatRequestTime(),
		year: String(new Date().getFullYear()),
	});
};

const sendLoginOtpEmail = ({ to, name, otp }) => sendOtpEmail({ kind: "login", to, name, otp });
const sendResetOtpEmail = ({ to, name, otp }) => sendOtpEmail({ kind: "reset", to, name, otp });
const sendRegistrationOtpEmail = ({ to, name, otp }) => sendOtpEmail({ kind: "register", to, name, otp });


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
	footer_note: "",
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
		welcome_display: "block",
		name: name || "there",
		footer_note: `You received this email because an account was created with ${normalizeRecipient(to)}.`,
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
		title: `Quantic feedback from ${name || email || "User"}`,
		feedback_display: "block",
		fb_name: name || "Unknown",
		fb_email: email || "Unknown",
		fb_user_id: userId || "Unknown",
		fb_topics: topics || "General",
		fb_date: createdAt || new Date().toISOString(),
		fb_message_html: escapeHtml(message || "(empty)").replace(/\n/g, "<br>"),
		footer_note: "Internal notification from the Quantic feedback form.",
	});
};

module.exports = {
	sendRegistrationOtpEmail,
	sendWelcomeEmail,
	sendFeedbackEmail,
	sendResetOtpEmail,
	sendLoginOtpEmail,
};






// // back-end/services/emailService.js
// const nodemailer = require("nodemailer");
// const EMAILJS_ENDPOINT = "https://api.emailjs.com/api/v1.0/email/send";
// const EMAILJS_TIMEOUT_MS = Number(process.env.EMAILJS_TIMEOUT_MS || 15000);
// const APP_URL = process.env.APP_URL || (process.env.NODE_ENV === "production"
// 	? "https://quantic-nu.vercel.app"
// 	: "http://localhost:5173");

// const getEmailProvider = () =>
// 	String(process.env.EMAIL_PROVIDER || "emailjs")
// 		.trim()
// 		.toLowerCase();

// const sendWithSmtp = async (templateKey, templateParams) => {
// 	const host = String(process.env.SMTP_HOST || "").trim();
// 	const user = String(process.env.SMTP_USER || "").trim();
// 	const pass = String(process.env.SMTP_PASS || "");
// 	const fromEmail = String(process.env.SMTP_FROM_EMAIL || "").trim();
// 	const fromName = String(process.env.SMTP_FROM_NAME || "Quantic").trim();
// 	const port = Number(process.env.SMTP_PORT || 587);
// 	const secure = String(process.env.SMTP_SECURE || "").toLowerCase() === "true" || port === 465;

// 	const missing = [
// 		["SMTP_HOST", host],
// 		["SMTP_USER", user],
// 		["SMTP_PASS", pass],
// 		["SMTP_FROM_EMAIL", fromEmail],
// 	].filter(([, value]) => !value).map(([name]) => name);

// 	if (missing.length) {
// 		throw new Error(`SMTP email provider is not configured. Missing: ${missing.join(", ")}`);
// 	}

// 	const recipient = normalizeRecipient(templateParams?.to_email);
// 	if (!recipient) throw new Error("Recipient email is required.");

// 	const subject = String(templateParams?.subject || "Message from Quantic");
// 	const title = String(templateParams?.title || subject);
// 	const preheader = String(templateParams?.preheader || "");
// 	const name = String(templateParams?.name || "there");
// 	const intro = String(templateParams?.intro || "");
// 	const otp = String(templateParams?.otp || "");
// 	const appUrl = String(templateParams?.app_url || APP_URL);
// 	const isFeedback = templateKey === "general" && templateParams?.feedback_display === "block";
// 	const isWelcome = templateKey === "general" && templateParams?.welcome_display === "block";

// 	let contentHtml = "";
// 	let contentText = "";

// 	if (otp) {
// 		const steps = [templateParams?.step_1, templateParams?.step_2, templateParams?.step_3]
// 			.map((step) => String(step || "").trim()).filter(Boolean);
// 		contentHtml = `
// 			<p>Hello ${escapeHtml(name)},</p>
// 			<p>${escapeHtml(intro)}</p>
// 			<div style="margin:24px 0;padding:18px;text-align:center;background:#f3f4f6;border-radius:12px;font-size:30px;font-weight:700;letter-spacing:8px;color:#111827">${escapeHtml(otp)}</div>
// 			<p>This code is time-limited. If you did not request it, you can ignore this email.</p>
// 			${steps.length ? `<ol>${steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol>` : ""}
// 			<p><a href="${escapeHtml(appUrl)}">Open Quantic</a></p>`;
// 		contentText = [`Hello ${name},`, intro, `Verification code: ${otp}`, "This code is time-limited. If you did not request it, ignore this email.", ...steps, appUrl].filter(Boolean).join("\n\n");
// 	} else if (isFeedback) {
// 		const feedback = String(templateParams?.fb_message_html || "");
// 		contentHtml = `<p>New feedback from ${escapeHtml(templateParams?.fb_name || "Unknown")} (${escapeHtml(templateParams?.fb_email || "Unknown")}).</p><p>Topics: ${escapeHtml(templateParams?.fb_topics || "General")}</p><div style="white-space:normal;border:1px solid #ddd;padding:16px;border-radius:8px">${feedback}</div>`;
// 		contentText = [`Feedback from: ${templateParams?.fb_name || "Unknown"}`, `Email: ${templateParams?.fb_email || "Unknown"}`, `Topics: ${templateParams?.fb_topics || "General"}`, feedback.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]*>/g, "")].join("\n\n");
// 	} else if (isWelcome) {
// 		contentHtml = `<p>Hello ${escapeHtml(name)},</p><p>Your Quantic account is ready. You can now start chatting, exploring ideas, and working with your files.</p><p><a href="${escapeHtml(appUrl)}">Open Quantic</a></p>`;
// 		contentText = `Hello ${name},\n\nYour Quantic account is ready.\n\nOpen Quantic: ${appUrl}`;
// 	} else {
// 		contentHtml = `<p>Hello ${escapeHtml(name)},</p><p>${escapeHtml(preheader || intro || title)}</p>`;
// 		contentText = [`Hello ${name},`, preheader || intro || title].join("\n\n");
// 	}

// 	const transporter = nodemailer.createTransport({
// 		host,
// 		port,
// 		secure,
// 		auth: { user, pass },
// 		connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
// 		greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
// 		socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000),
// 	});

// 	const result = await transporter.sendMail({
// 		from: { name: fromName, address: fromEmail },
// 		to: recipient,
// 		subject,
// 		text: contentText,
// 		html: `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f7fb;font-family:Arial,sans-serif;color:#1f2937"><div style="max-width:600px;margin:0 auto;background:#fff;padding:28px;border-radius:14px"><div style="font-size:20px;font-weight:700;margin-bottom:20px">Quantic</div><h1 style="font-size:22px">${escapeHtml(title)}</h1>${preheader ? `<div style="color:#6b7280;font-size:13px;margin-bottom:20px">${escapeHtml(preheader)}</div>` : ""}${contentHtml}<hr style="border:0;border-top:1px solid #e5e7eb;margin-top:28px"><p style="color:#6b7280;font-size:12px">This message was sent by Quantic. Email delivery depends on the receiving provider's filtering and sender authentication.</p></div></body></html>`,
// 	});

// 	console.info("[Email SMTP] Send request accepted", {
// 		template: templateKey,
// 		to: maskEmail(recipient),
// 		messageId: result.messageId,
// 		accepted: Array.isArray(result.accepted) ? result.accepted.length : 0,
// 		rejected: Array.isArray(result.rejected) ? result.rejected.length : 0,
// 	});

// 	if (Array.isArray(result.rejected) && result.rejected.length) {
// 		throw new Error("SMTP server rejected one or more email recipients.");
// 	}

// 	return { ok: true, messageId: result.messageId };
// };

// const getConfig = () => {
// 	const config = {
// 		serviceId: String(process.env.EMAILJS_SERVICE_ID || "").trim(),
// 		publicKey: String(process.env.EMAILJS_PUBLIC_KEY || "").trim(),
// 		privateKey: String(process.env.EMAILJS_PRIVATE_KEY || "").trim(),
// 		otpTemplateId: String(process.env.EMAILJS_OTP_TEMPLATE_ID || "").trim(),
// 		generalTemplateId: String(process.env.EMAILJS_GENERAL_TEMPLATE_ID || process.env.EMAILJS_WELCOME_TEMPLATE_ID || "").trim(),
// 	};

// 	const missing = [
// 		["EMAILJS_SERVICE_ID", config.serviceId],
// 		["EMAILJS_PUBLIC_KEY", config.publicKey],
// 		["EMAILJS_OTP_TEMPLATE_ID", config.otpTemplateId],
// 		["EMAILJS_GENERAL_TEMPLATE_ID", config.generalTemplateId],
// 	]
// 		.filter(([, value]) => !value)
// 		.map(([name]) => name);

// 	if (missing.length) {
// 		throw new Error(`Email service is not configured. Missing: ${missing.join(", ")}`);
// 	}

// 	return config;
// };

// const normalizeRecipient = (value) => String(value ?? "").trim().toLowerCase();

// const maskEmail = (value) => {
// 	const email = normalizeRecipient(value);
// 	const at = email.lastIndexOf("@");

// 	if (at <= 0 || at === email.length - 1) {
// 		return email ? "[invalid-email]" : "[missing-email]";
// 	}

// 	const local = email.slice(0, at);
// 	const domain = email.slice(at + 1);
// 	return local.slice(0, 1) + "***@" + domain;
// };

// const sendWithEmailJs = async (templateKey, templateParams) => {
// 	if (getEmailProvider() === "smtp") {
// 		return sendWithSmtp(templateKey, templateParams);
// 	}
// 	if (getEmailProvider() !== "emailjs") {
// 		throw new Error('Invalid EMAIL_PROVIDER. Use "smtp" or "emailjs".');
// 	}
// 	if (typeof fetch !== "function") {
// 		throw new Error("Email service needs Node.js 18 or newer (global fetch).");
// 	}

// 	const config = getConfig();
// 	const recipient = normalizeRecipient(templateParams?.to_email);

// 	if (!recipient) {
// 		throw new Error("Recipient email is required.");
// 	}

// 	const safeTemplateParams = { ...templateParams, to_email: recipient };
// 	const templateId = templateKey === "otp" ? config.otpTemplateId : config.generalTemplateId;
// 	const controller = new AbortController();
// 	const timer = setTimeout(() => controller.abort(), EMAILJS_TIMEOUT_MS);

// 	try {
// 		const response = await fetch(EMAILJS_ENDPOINT, {
// 			method: "POST",
// 			headers: { "Content-Type": "application/json" },
// 			body: JSON.stringify({
// 				service_id: config.serviceId,
// 				template_id: templateId,
// 				user_id: config.publicKey,
// 				...(config.privateKey ? { accessToken: config.privateKey } : {}),
// 				template_params: safeTemplateParams,
// 			}),
// 			signal: controller.signal,
// 		});

// 		const body = await response.text();

// 		if (!response.ok) {
// 			const hint = /non-browser/i.test(body)
// 				? " Turn on \"Allow EmailJS API for non-browser applications\" in EmailJS > Account > Security."
// 				: "";
// 			const error = new Error(`EmailJS rejected the email (${response.status}): ${body.slice(0, 200)}.${hint}`);
// 			error.status = response.status;
// 			throw error;
// 		}

// 		console.info("[EmailJS] Send request accepted", {
// 			template: templateKey,
// 			templateId,
// 			to: maskEmail(recipient),
// 			status: response.status,
// 		});

// 		return { ok: true, status: response.status };
// 	} catch (error) {
// 		if (error?.name === "AbortError") {
// 			throw new Error("EmailJS did not respond in time.");
// 		}

// 		throw error;
// 	} finally {
// 		clearTimeout(timer);
// 	}
// };

// const requireRecipient = (to) => {
// 	if (!to) {
// 		throw new Error("Recipient email is required.");
// 	}
// };


// const escapeHtml = (value) =>
// 	String(value ?? "")
// 		.replace(/&/g, "&amp;")
// 		.replace(/</g, "&lt;")
// 		.replace(/>/g, "&gt;")
// 		.replace(/"/g, "&quot;")
// 		.replace(/'/g, "&#39;");


// const OTP_EMAILS = {
// 	login: {
// 		subject: "Quantic Sign-in Verification Code",
// 		icon: "🔐",
// 		heading: "Verification Code",
// 		intro: "A sign-in request was initiated for your Quantic account. Enter the one-time verification code below to authenticate:",
// 		title: "Quantic — Sign-in Code",
// 		preheader: (otp) => `Your authentication code is ${otp}.`,
// 	},
// 	reset: {
// 		subject: "Quantic Password Reset OTP",
// 		icon: "🔑",
// 		heading: "Reset Password",
// 		intro: "We received a request to reset your password. Enter the one-time authorization code below to complete the reset process:",
// 		title: "Quantic — Password Reset",
// 		preheader: (otp) => `Your password reset code is ${otp}.`,
// 	},
// 	register: {
// 		subject: "Verify your Quantic email address",
// 		icon: "✉️",
// 		heading: "Verify Your Email",
// 		intro: "Thanks for signing up for Quantic. Enter the one-time code below to confirm your email address and finish creating your account:",
// 		title: "Quantic — Verify Your Email",
// 		preheader: (otp) => `Your email verification code is ${otp}.`,
// 		steps: [
// 			"Go back to the Quantic sign-up window you just used (it should still be open on the “Verify email” screen).",
// 			"Type or paste the 6-digit code into the boxes under “Verification code”.",
// 			"Click “Verify email”. Your account is created, and you can then log in.",
// 		],
// 		stepsNote: "Closed the window? Open Quantic and register again with the same email. We’ll send you a fresh code.",
// 		ctaLabel: "Open Quantic",
// 	},
// };

// const sendOtpEmail = async ({ kind, to, name, otp }) => {
// 	requireRecipient(to);

// 	const content = OTP_EMAILS[kind];
// 	const steps = content.steps || [];

// 	return sendWithEmailJs("otp", {
// 		to_email: to,
// 		subject: content.subject,
// 		title: content.title,
// 		preheader: content.preheader(otp),
// 		icon: content.icon,
// 		heading: content.heading,
// 		name: name || "there",
// 		intro: content.intro,
// 		otp: String(otp ?? ""),
		
// 		steps_display: steps.length ? "block" : "none",
// 		step_1: steps[0] || "",
// 		step_2: steps[1] || "",
// 		step_3: steps[2] || "",
// 		steps_note: content.stepsNote || "",
// 		cta_label: content.ctaLabel || "",
// 		app_url: APP_URL,
// 		year: String(new Date().getFullYear()),
// 	});
// };

// const sendLoginOtpEmail = ({ to, name, otp }) => sendOtpEmail({ kind: "login", to, name, otp });
// const sendResetOtpEmail = ({ to, name, otp }) => sendOtpEmail({ kind: "reset", to, name, otp });
// const sendRegistrationOtpEmail = ({ to, name, otp }) => sendOtpEmail({ kind: "register", to, name, otp });


// const generalDefaults = () => ({
// 	welcome_display: "none",
// 	feedback_display: "none",
// 	name: "",
// 	fb_name: "",
// 	fb_email: "",
// 	fb_user_id: "",
// 	fb_topics: "",
// 	fb_date: "",
// 	fb_message_html: "",
// 	app_url: APP_URL,
// 	year: String(new Date().getFullYear()),
// });

// const sendWelcomeEmail = async ({ to, name }) => {
// 	requireRecipient(to);

// 	return sendWithEmailJs("general", {
// 		...generalDefaults(),
// 		to_email: to,
// 		subject: "Welcome to Quantic",
// 		title: "Welcome to Quantic",
// 		preheader: "Your Quantic account is ready. Get started with your workspace.",
// 		welcome_display: "block",
// 		name: name || "there",
// 	});
// };

// const sendFeedbackEmail = async ({ name, email, userId, message, topics, createdAt }) => {
// 	const recipient = process.env.FEEDBACK_TEAM_EMAIL || process.env.EMAIL_USER;

// 	if (!recipient) {
// 		throw new Error("Feedback recipient is not configured.");
// 	}

// 	return sendWithEmailJs("general", {
// 		...generalDefaults(),
// 		to_email: recipient,
// 		subject: `Quantic feedback from ${name || email || "user"}`,
// 		title: `Quantic Feedback from ${name || email || "User"}`,
// 		preheader: `New feedback submitted by ${name || email || "a user"}.`,
// 		feedback_display: "block",
// 		fb_name: name || "Unknown",
// 		fb_email: email || "Unknown",
// 		fb_user_id: userId || "Unknown",
// 		fb_topics: topics || "General",
// 		fb_date: createdAt || new Date().toISOString(),
// 		fb_message_html: escapeHtml(message || "(empty)").replace(/\n/g, "<br>"),
// 	});
// };

// module.exports = {
// 	sendRegistrationOtpEmail,
// 	sendWelcomeEmail,
// 	sendFeedbackEmail,
// 	sendResetOtpEmail,
// 	sendLoginOtpEmail,
// };
