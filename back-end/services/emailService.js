// back-end/services/emailService.js
const nodemailer = require("nodemailer");

const escapeHtml = (value) =>
	String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");

const APP_URL = process.env.APP_URL || "http://localhost:5173";

/**
 * Shared high-performance transactional email shell.
 * Clean, high-contrast dark aesthetic optimized across desktop, mobile, and web mail clients.
 */
const wrapEmail = ({ title, preheader, bodyHtml }) => {
	const safeTitle = escapeHtml(title || "Quantic");
	const safePre = escapeHtml(preheader || "");

	return `<!doctype html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="X-UA-Compatible" content="IE=edge" />
	<meta name="color-scheme" content="dark" />
	<meta name="supported-color-schemes" content="dark" />
	<title>${safeTitle}</title>
	<!--[if mso]>
	<noscript>
		<xml>
			<o:OfficeDocumentSettings>
				<o:PixelsPerInch>96</o:PixelsPerInch>
			</o:OfficeDocumentSettings>
		</xml>
	</noscript>
	<style>
		body, table, td, p, a, h1, h2, span { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif !important; }
	</style>
	<![endif]-->
	<style>
		@media only screen and (max-width: 620px) {
			.email-container { width: 100% !important; max-width: 100% !important; border-radius: 0 !important; }
			.content-cell { padding: 24px 20px !important; }
			.otp-box { font-size: 30px !important; letter-spacing: 0.22em !important; padding: 16px 16px !important; }
		}
	</style>
</head>
<body style="margin: 0; padding: 0; background-color: #06080f; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; color: #f1f5f9; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-size-adjust: 100%; -webkit-text-size-adjust: 100%;">
	${
		safePre
			? `<div style="display: none; max-height: 0; overflow: hidden; opacity: 0; color: transparent; visibility: hidden; mso-hide: all; line-height: 1px; font-size: 1px;">
				${safePre}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;
			</div>`
			: ""
	}

	<!-- Outer Canvas -->
	<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #06080f; width: 100%; min-height: 100vh; padding: 36px 16px 48px;">
		<tr>
			<td align="center" style="vertical-align: top;">
				
				<!-- Main Card -->
				<table role="presentation" class="email-container" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width: 580px; width: 100%; background-color: #0d121f; border-radius: 18px; border: 1px solid rgba(255, 255, 255, 0.08); box-shadow: 0 24px 54px -12px rgba(0, 0, 0, 0.7); overflow: hidden;">
					
					<!-- Body Content -->
					${bodyHtml}

					<!-- Footer -->
					<tr>
						<td style="padding: 24px 36px 30px; background-color: #090e18; border-top: 1px solid rgba(255, 255, 255, 0.05); text-align: center;">
							<p style="margin: 0 0 8px; font-size: 12px; line-height: 1.6; color: #64748b;">
								This is an automated transmission from <strong style="color: #94a3b8;">Quantic</strong>. Please do not reply directly to this message.
							</p>
							<p style="margin: 0; font-size: 12px; line-height: 1.6; color: #475569;">
								&copy; ${new Date().getFullYear()} Quantic, Inc. &middot; Secure Cloud Intelligence &middot; All rights reserved.
							</p>
						</td>
					</tr>

				</table>
			</td>
		</tr>
	</table>
</body>
</html>`;
};

/** High-contrast 2FA / OTP code block */
const otpBlock = (otp) => `
	<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin: 20px 0 16px;">
		<tr>
			<td align="center">
				<div class="otp-box" style="display: inline-block; padding: 18px 36px; border-radius: 12px; background-color: #060912; border: 1px solid rgba(56, 189, 248, 0.35); font-family: 'SFMono-Regular', Consolas, 'Courier New', Courier, monospace; font-size: 34px; font-weight: 800; letter-spacing: 0.28em; color: #38bdf8; text-shadow: 0 0 20px rgba(56, 189, 248, 0.25); text-align: center;">
					${escapeHtml(String(otp || ""))}
				</div>
			</td>
		</tr>
	</table>
`;

/** High-contrast CTA button */
const primaryButton = (href, label) => `
	<table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin: 24px auto 0;">
		<tr>
			<td align="center" style="border-radius: 10px; background: linear-gradient(135deg, #38bdf8 0%, #2dd4bf 100%);">
				<a href="${escapeHtml(href)}" target="_blank" style="display: inline-block; padding: 14px 32px; font-size: 14px; font-weight: 700; letter-spacing: 0.02em; color: #06111f; text-decoration: none; border-radius: 10px; border: 1px solid rgba(255, 255, 255, 0.2);">
					${escapeHtml(label)} &rarr;
				</a>
			</td>
		</tr>
	</table>
`;

const buildWelcomeEmailText = (displayName) =>
	[
		`Hi ${displayName},`,
		"",
		"Welcome to Quantic. Your workspace is ready.",
		"Log in now to begin collaborating and explore your intelligent AI tools:",
		`${APP_URL}`,
		"",
		"If you did not create this account, you can safely disregard this email.",
	].join("\n");

const buildWelcomeEmailHtml = (displayName) => {
	const safeName = escapeHtml(displayName);
	const bodyHtml = `
		<tr>
			<td class="content-cell" style="padding: 36px 36px 32px;">
				<h1 style="margin: 0 0 12px; font-size: 26px; line-height: 1.3; font-weight: 800; letter-spacing: -0.02em; color: #ffffff; text-align: left;">
					Welcome to Quantic
				</h1>
				<p style="margin: 0 0 24px; font-size: 15px; line-height: 1.65; color: #94a3b8; text-align: left;">
					Hi <strong style="color: #f1f5f9;">${safeName}</strong>, your account has been provisioned and is ready for action. Step into your next-generation intelligent workspace.
				</p>

				<!-- Feature Highlights Card -->
				<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #080c16; border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 14px; margin-bottom: 24px;">
					<tr>
						<td style="padding: 22px 24px;">
							<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
								<tr>
									<td style="vertical-align: top; width: 28px; font-size: 16px; line-height: 1.4;">⚡</td>
									<td style="padding-left: 10px; vertical-align: top;">
										<div style="font-size: 14px; font-weight: 700; color: #f1f5f9; margin-bottom: 3px;">Real-Time AI Intelligence</div>
										<div style="font-size: 13px; line-height: 1.5; color: #94a3b8;">Execute complex multi-modal workflows with low-latency LLM assistance.</div>
									</td>
								</tr>
								<tr><td colspan="2" style="height: 16px;"></td></tr>
								<tr>
									<td style="vertical-align: top; width: 28px; font-size: 16px; line-height: 1.4;">🛡️</td>
									<td style="padding-left: 10px; vertical-align: top;">
										<div style="font-size: 14px; font-weight: 700; color: #f1f5f9; margin-bottom: 3px;">Enterprise Security</div>
										<div style="font-size: 13px; line-height: 1.5; color: #94a3b8;">Multi-factor verification and end-to-end encrypted session controls.</div>
									</td>
								</tr>
							</table>
						</td>
					</tr>
				</table>

				${primaryButton(APP_URL, "Launch Quantic")}

				<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top: 32px; border-top: 1px solid rgba(255, 255, 255, 0.06); padding-top: 20px;">
					<tr>
						<td style="font-size: 13px; line-height: 1.6; color: #64748b; text-align: left;">
							If you did not sign up for Quantic, you can safely ignore this email.
						</td>
					</tr>
				</table>
			</td>
		</tr>
	`;

	return wrapEmail({
		title: "Welcome to Quantic",
		preheader: "Your Quantic account is ready. Get started with your workspace.",
		bodyHtml,
	});
};

const buildFeedbackEmailText = ({ name, email, userId, message, topics, createdAt }) =>
	[
		"Quantic — New User Feedback",
		"==============================",
		`Name:       ${name || "Unknown"}`,
		`Email:      ${email || "Unknown"}`,
		`User ID:    ${userId || "Unknown"}`,
		`Topic:      ${topics || "General"}`,
		`Submitted:  ${createdAt || new Date().toISOString()}`,
		"",
		"Message:",
		"------------------------------",
		message || "(empty)",
	].join("\n");

const buildFeedbackEmailHtml = ({ name, email, userId, message, topics, createdAt }) => {
	const safeName = escapeHtml(name || "Unknown");
	const safeEmail = escapeHtml(email || "Unknown");
	const safeUserId = escapeHtml(userId || "Unknown");
	const safeTopics = escapeHtml(topics || "General");
	const safeCreatedAt = escapeHtml(createdAt || new Date().toISOString());
	const safeMessage = escapeHtml(message || "(empty)").replace(/\n/g, "<br>");

	const bodyHtml = `
		<tr>
			<td class="content-cell" style="padding: 32px 36px 28px;">
				<h1 style="margin: 0 0 8px; font-size: 24px; line-height: 1.3; font-weight: 800; letter-spacing: -0.02em; color: #ffffff;">
					User Feedback Submission
				</h1>
				<p style="margin: 0 0 24px; font-size: 14px; line-height: 1.6; color: #94a3b8;">
					A user has submitted feedback through the application settings console.
				</p>

				<!-- Structured Key-Value Metadata Table -->
				<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #080c16; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 12px; margin-bottom: 24px; overflow: hidden;">
					<tr>
						<td style="padding: 18px 22px;">
							<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
								<tr>
									<td style="padding: 6px 0; width: 100px; font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em;">User</td>
									<td style="padding: 6px 0; font-size: 14px; font-weight: 600; color: #f1f5f9;">${safeName}</td>
								</tr>
								<tr>
									<td style="padding: 6px 0; width: 100px; font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em;">Email</td>
									<td style="padding: 6px 0; font-size: 14px; color: #38bdf8;"><a href="mailto:${safeEmail}" style="color: #38bdf8; text-decoration: none;">${safeEmail}</a></td>
								</tr>
								<tr>
									<td style="padding: 6px 0; width: 100px; font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em;">User ID</td>
									<td style="padding: 6px 0; font-size: 13px; font-family: 'SFMono-Regular', Consolas, monospace; color: #cbd5e1;">${safeUserId}</td>
								</tr>
								<tr>
									<td style="padding: 6px 0; width: 100px; font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em;">Category</td>
									<td style="padding: 6px 0;">
										<span style="display: inline-block; padding: 2px 8px; border-radius: 6px; background-color: rgba(45, 212, 191, 0.12); border: 1px solid rgba(45, 212, 191, 0.3); font-size: 12px; font-weight: 700; color: #2dd4bf;">
											${safeTopics}
										</span>
									</td>
								</tr>
								<tr>
									<td style="padding: 6px 0; width: 100px; font-size: 13px; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em;">Date</td>
									<td style="padding: 6px 0; font-size: 13px; color: #94a3b8;">${safeCreatedAt}</td>
								</tr>
							</table>
						</td>
					</tr>
				</table>

				<!-- Message Box -->
				<div style="margin-bottom: 8px; font-size: 12px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #94a3b8;">User Message</div>
				<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #060912; border-left: 3px solid #38bdf8; border-radius: 4px 8px 8px 4px; border-top: 1px solid rgba(255, 255, 255, 0.05); border-right: 1px solid rgba(255, 255, 255, 0.05); border-bottom: 1px solid rgba(255, 255, 255, 0.05);">
					<tr>
						<td style="padding: 18px 20px; font-size: 14px; line-height: 1.7; color: #e2e8f0;">
							${safeMessage}
						</td>
					</tr>
				</table>
			</td>
		</tr>
	`;

	return wrapEmail({
		title: `Quantic Feedback from ${name || email || "User"}`,
		preheader: `New feedback submitted by ${name || email || "a user"}.`,
		bodyHtml,
	});
};

const OTP_EMAIL_VARIANTS = {
	login: {
		icon: "🔐",
		heading: "Verification Code",
		intro: "A sign-in request was initiated for your Quantic account. Enter the one-time verification code below to authenticate:",
		title: "Quantic — Sign-in Code",
		preheader: (otp) => `Your authentication code is ${otp}.`,
	},
	reset: {
		icon: "🔑",
		heading: "Reset Password",
		intro: "We received a request to reset your password. Enter the one-time authorization code below to complete the reset process:",
		title: "Quantic — Password Reset",
		preheader: (otp) => `Your password reset code is ${otp}.`,
	},
	register: {
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

const buildOtpEmailHtml = ({ name, otp, kind }) => {
	const safeName = escapeHtml(name || "there");
	const variant = OTP_EMAIL_VARIANTS[kind] || OTP_EMAIL_VARIANTS.reset;
	const { heading, intro } = variant;

	const bodyHtml = `
		<tr>
			<td class="content-cell" style="padding: 36px 36px 28px; text-align: center;">
				<!-- Icon Pill -->
				<div style="display: inline-block; width: 44px; height: 44px; line-height: 44px; border-radius: 12px; background-color: rgba(56, 189, 248, 0.12); border: 1px solid rgba(56, 189, 248, 0.25); font-size: 20px; margin-bottom: 16px;">
					${variant.icon}
				</div>

				<h1 style="margin: 0 0 10px; font-size: 26px; line-height: 1.25; font-weight: 800; letter-spacing: -0.02em; color: #ffffff;">
					${heading}
				</h1>
				
				<p style="margin: 0 auto 14px; max-width: 440px; font-size: 15px; line-height: 1.65; color: #94a3b8;">
					Hello <strong style="color: #f1f5f9;">${safeName}</strong>,
				</p>
				<p style="margin: 0 auto 20px; max-width: 460px; font-size: 15px; line-height: 1.65; color: #94a3b8;">
					${intro}
				</p>

				<!-- Hero OTP Box -->
				${otpBlock(otp)}

				<!-- Expiry Badge -->
				<div style="display: inline-block; margin-top: 8px; padding: 6px 14px; border-radius: 9999px; background-color: rgba(239, 68, 68, 0.12); border: 1px solid rgba(239, 68, 68, 0.25); font-size: 12px; font-weight: 600; color: #f87171;">
					⏱ Code expires in 10 minutes
				</div>

				${
					variant.steps
						? `<!-- How to use this code -->
				<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top: 28px; background-color: #080c16; border: 1px solid rgba(56, 189, 248, 0.2); border-radius: 12px; text-align: left;">
					<tr>
						<td style="padding: 18px 20px;">
							<div style="font-size: 13px; font-weight: 700; color: #f1f5f9; margin-bottom: 10px;">Where do I enter this code?</div>
							<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
								${variant.steps
									.map(
										(step, index) => `<tr>
									<td style="vertical-align: top; width: 26px; padding: 4px 0; font-size: 13px; font-weight: 800; color: #38bdf8;">${index + 1}.</td>
									<td style="vertical-align: top; padding: 4px 0; font-size: 13px; line-height: 1.6; color: #cbd5e1;">${escapeHtml(step)}</td>
								</tr>`
									)
									.join("")}
							</table>
							${variant.stepsNote ? `<div style="margin-top: 10px; font-size: 12px; line-height: 1.6; color: #64748b;">${escapeHtml(variant.stepsNote)}</div>` : ""}
						</td>
					</tr>
				</table>
				${variant.ctaLabel ? primaryButton(APP_URL, variant.ctaLabel) : ""}`
						: ""
				}

				<!-- Security Warning Box -->
				<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top: 32px; background-color: #080c16; border: 1px solid rgba(255, 255, 255, 0.06); border-radius: 12px; text-align: left;">
					<tr>
						<td style="padding: 16px 20px;">
							<div style="font-size: 13px; font-weight: 700; color: #f1f5f9; margin-bottom: 4px;">Security Notice</div>
							<div style="font-size: 12px; line-height: 1.6; color: #64748b;">
								Never disclose this code to anyone. Quantic team members will never ask for your authentication codes. If you did not initiate this request, please secure your account immediately.
							</div>
						</td>
					</tr>
				</table>
			</td>
		</tr>
	`;

	return wrapEmail({
		title: variant.title,
		preheader: variant.preheader(otp),
		bodyHtml,
	});
};

const getTransport = () => {
	const emailUser = process.env.EMAIL_USER;
	const emailPass = process.env.EMAIL_PASS;

	if (!emailUser || !emailPass) {
		throw new Error("Email service is not configured.");
	}

	return nodemailer.createTransport({
		service: "gmail",
		auth: {
			user: emailUser,
			pass: emailPass,
		},
	});
};

const sendWelcomeEmail = async ({ to, name }) => {
	if (!to) {
		throw new Error("Recipient email is required.");
	}

	const transport = getTransport();
	const fromAddress = process.env.EMAIL_USER;
	const displayName = name || "there";
	const text = buildWelcomeEmailText(displayName);

	return transport.sendMail({
		from: `Quantic <${fromAddress}>`,
		to,
		subject: "Welcome to Quantic",
		text,
		html: buildWelcomeEmailHtml(displayName),
	});
};

const sendFeedbackEmail = async ({ name, email, userId, message, topics, createdAt }) => {
	const recipient = process.env.FEEDBACK_TEAM_EMAIL || process.env.EMAIL_USER;

	if (!recipient) {
		throw new Error("Feedback recipient is not configured.");
	}

	const transport = getTransport();
	const fromAddress = process.env.EMAIL_USER;
	const feedbackText = buildFeedbackEmailText({ name, email, userId, message, topics, createdAt });

	return transport.sendMail({
		from: `Quantic <${fromAddress}>`,
		to: recipient,
		subject: `Quantic feedback from ${name || email || "user"}`,
		text: feedbackText,
		html: buildFeedbackEmailHtml({ name, email, userId, message, topics, createdAt }),
	});
};

const sendResetOtpEmail = async ({ to, name, otp }) => {
	if (!to) {
		throw new Error("Recipient email is required.");
	}

	const transport = getTransport();
	const fromAddress = process.env.EMAIL_USER;
	const displayName = name || "there";

	return transport.sendMail({
		from: `Quantic <${fromAddress}>`,
		to,
		subject: "Quantic Password Reset OTP",
		text: `Hello ${displayName}, your password reset OTP is ${otp}. This OTP will expire in 10 minutes.`,
		html: buildOtpEmailHtml({ name: displayName, otp, kind: "reset" }),
	});
};

const sendLoginOtpEmail = async ({ to, name, otp }) => {
	if (!to) {
		throw new Error("Recipient email is required.");
	}

	const transport = getTransport();
	const fromAddress = process.env.EMAIL_USER;
	const displayName = name || "there";

	return transport.sendMail({
		from: `Quantic <${fromAddress}>`,
		to,
		subject: "Quantic Sign-in Verification Code",
		text: `Hello ${displayName}, your sign-in verification code is ${otp}. This code will expire in 10 minutes. If you did not attempt to sign in, you can ignore this email.`,
		html: buildOtpEmailHtml({ name: displayName, otp, kind: "login" }),
	});
};

const sendRegistrationOtpEmail = async ({ to, name, otp }) => {
	if (!to) {
		throw new Error("Recipient email is required.");
	}

	const transport = getTransport();
	const fromAddress = process.env.EMAIL_USER;
	const displayName = name || "there";

	return transport.sendMail({
		from: `Quantic <${fromAddress}>`,
		to,
		subject: "Verify your Quantic email address",
		text: [
			`Hello ${displayName},`,
			"",
			`Your Quantic email verification code is: ${otp}`,
			"This code expires in 10 minutes.",
			"",
			"Where to enter it:",
			"1. Go back to the Quantic sign-up window you just used (the \"Verify email\" screen).",
			"2. Type or paste the 6-digit code into the \"Verification code\" boxes.",
			"3. Click \"Verify email\". Your account is created, and you can then log in.",
			"",
			`Closed the window? Open ${APP_URL} and register again with the same email. We'll send you a fresh code.`,
			"",
			"If you did not create a Quantic account, you can ignore this email.",
		].join("\n"),
		html: buildOtpEmailHtml({ name: displayName, otp, kind: "register" }),
	});
};

module.exports = {
	sendRegistrationOtpEmail,
	sendWelcomeEmail,
	sendFeedbackEmail,
	sendResetOtpEmail,
	sendLoginOtpEmail,
};