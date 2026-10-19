//front-end/src/components/LoginModals.jsx
import { useCallback, useEffect, useRef, useState } from "react";
import image0 from "../assets/img1/image.png";
import image1 from "../assets/img1/image1.png";
import image2 from "../assets/img1/image2.png";
import image3 from "../assets/img1/image3.png";
import image4 from "../assets/img1/image4.png";
import image5 from "../assets/img/favicon3.png";

const SLIDE_INTERVAL_MS = 3000;
const RESEND_COOLDOWN_SECONDS = 60;

// The backend address comes from front-end/.env (VITE_API_URL). Without it, local
// development falls back to http://localhost:8000. The auth router is mounted at /api/auth.
const API_ORIGIN = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/+$/, "");
const AUTH_API_BASE_OVERRIDE = `${API_ORIGIN}/api/auth`;
const AUTH_BASE_CANDIDATES = ["/api/auth"];

let resolvedAuthBase = AUTH_API_BASE_OVERRIDE || null;

const authPost = async (path, body) => {
	const bases = resolvedAuthBase ? [resolvedAuthBase] : AUTH_BASE_CANDIDATES;
	let response = null;

	for (const base of bases) {
		try {
			response = await fetch(`${base}${path}`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch {
			throw new Error("Couldn't reach the server. Check your connection and try again.");
		}

		// A route that exists never answers 404, so keep looking only on 404.
		if (response.status !== 404) {
			if (response.status < 500 && !resolvedAuthBase) {
				resolvedAuthBase = base;
				console.info(`[auth] Using API base "${base}". Set AUTH_API_BASE_OVERRIDE to this to skip detection.`);
			}
			break;
		}
	}

	if (!response || response.status === 404) {
		throw new Error(
			"Couldn't find the sign-up endpoint on the server. Check VITE_API_URL in your .env file."
		);
	}

	const data = await response.json().catch(() => ({}));

	if (!response.ok) {
		throw new Error(data?.message || "Something went wrong. Please try again.");
	}

	return data;
};

// Each slide names one thing Quantic actually does, so the panel teaches while it waits.
const showcaseSlides = [
	{ src: image0, caption: "Ask anything and get an answer with its sources attached." },
	{ src: image1, caption: "Drop in PDFs, images, and spreadsheets — Quantic reads them." },
	{ src: image2, caption: "Switch to voice and keep working without touching the keyboard." },
	{ src: image3, caption: "Every conversation is titled, saved, and searchable." },
	{ src: image4, caption: "Follow the reasoning step by step, not just the conclusion." },
];

const IconMail = () => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<rect x="2.5" y="4.5" width="19" height="15" rx="2.5" />
		<path d="M3 7l9 6 9-6" />
	</svg>
);

const IconUser = () => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<circle cx="12" cy="8" r="3.75" />
		<path d="M4.5 20c0-3.6 3.35-6.25 7.5-6.25S19.5 16.4 19.5 20" />
	</svg>
);

const IconLock = () => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<rect x="4.5" y="10" width="15" height="10.5" rx="2.5" />
		<path d="M8.25 10V7.5a3.75 3.75 0 017.5 0V10" />
	</svg>
);

const IconEye = () => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M2.5 12S6 5.75 12 5.75 21.5 12 21.5 12 18 18.25 12 18.25 2.5 12 2.5 12z" />
		<circle cx="12" cy="12" r="3" />
	</svg>
);

const IconEyeOff = () => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<path d="M4 4l16 16" />
		<path d="M9.9 5.98A9.7 9.7 0 0112 5.75c6 0 9.5 6.25 9.5 6.25a17 17 0 01-2.53 3.3" />
		<path d="M6.6 7.6A16.7 16.7 0 002.5 12S6 18.25 12 18.25c1.2 0 2.3-.2 3.3-.55" />
		<path d="M9.9 9.95a3 3 0 004.2 4.2" />
	</svg>
);

const IconAlert = () => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
		<circle cx="12" cy="12" r="9" />
		<path d="M12 7.75v5" />
		<path d="M12 16.15h.01" />
	</svg>
);

const IconClose = () => (
	<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
		<path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />
	</svg>
);

const IconSpark = () => (
	<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path d="M12 2.5l1.9 5.35 5.35 1.9-5.35 1.9L12 17l-1.9-5.35L4.75 9.75l5.35-1.9L12 2.5z" />
		<path d="M18.75 15.5l.85 2.4 2.4.85-2.4.85-.85 2.4-.85-2.4-2.4-.85 2.4-.85.85-2.4z" opacity="0.7" />
	</svg>
);

const scorePassword = (value) => {
	const password = String(value || "");

	if (!password) {
		return 0;
	}

	let score = 0;

	if (password.length >= 8) score += 1;
	if (password.length >= 12) score += 1;
	if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score += 1;
	if (/\d/.test(password) && /[^A-Za-z0-9]/.test(password)) score += 1;

	return Math.min(score, 4);
};

const STRENGTH_LABELS = ["", "Weak — add length", "Fair — mix in a symbol", "Strong", "Excellent"];

function OtpField({ value, onChange, autoFocus = false, disabled = false }) {
	const inputsRef = useRef([]);
	const code = String(value || "").slice(0, 6);

	const focusIndex = (index) => {
		const target = inputsRef.current[Math.max(0, Math.min(5, index))];
		if (target) {
			target.focus();
			target.select?.();
		}
	};

	const writeDigit = (index, digit) => {
		const chars = code.split("");

		while (chars.length < index) {
			chars.push("");
		}

		chars[index] = digit;
		onChange(chars.join("").replace(/\D/g, "").slice(0, 6));
	};

	const handleChange = (index) => (event) => {
		const typed = event.target.value.replace(/\D/g, "");

		if (!typed) {
			writeDigit(index, "");
			return;
		}

		if (typed.length > 1) {
			onChange((code.slice(0, index) + typed).replace(/\D/g, "").slice(0, 6));
			focusIndex(index + typed.length);
			return;
		}

		writeDigit(index, typed);
		focusIndex(index + 1);
	};

	const handleKeyDown = (index) => (event) => {
		if (event.key === "Backspace" && !code[index] && index > 0) {
			event.preventDefault();
			writeDigit(index - 1, "");
			focusIndex(index - 1);
			return;
		}

		if (event.key === "ArrowLeft" && index > 0) {
			event.preventDefault();
			focusIndex(index - 1);
			return;
		}

		if (event.key === "ArrowRight" && index < 5) {
			event.preventDefault();
			focusIndex(index + 1);
		}
	};

	const handlePaste = (event) => {
		const pasted = event.clipboardData.getData("text").replace(/\D/g, "").slice(0, 6);

		if (!pasted) {
			return;
		}

		event.preventDefault();
		onChange(pasted);
		focusIndex(pasted.length);
	};

	return (
		<div className="qa-otp" onPaste={handlePaste}>
			{[0, 1, 2, 3, 4, 5].map((index) => (
				<input
					key={index}
					ref={(node) => {
						inputsRef.current[index] = node;
					}}
					className={code[index] ? "is-filled" : ""}
					type="text"
					inputMode="numeric"
					autoComplete="one-time-code"
					maxLength={1}
					value={code[index] || ""}
					disabled={disabled}
					autoFocus={autoFocus && index === 0}
					aria-label={`Digit ${index + 1} of 6`}
					onChange={handleChange(index)}
					onKeyDown={handleKeyDown(index)}
					onFocus={(event) => event.target.select()}
				/>
			))}
		</div>
	);
}

function LoginModals({
	isOpen,
	mode,
	prefillEmail = "",
	loading: parentLoading,
	errorMessage,
	onClose,
	onSwitchMode,
	onSubmit,
	showToast,
}) {
	const isRegisterMode = mode === "register";
	const isForgotMode = mode === "forgot";
	const isAdminMode = mode === "admin";

	const [formData, setFormData] = useState({
		name: "",
		email: "",
		password: "",
		otp: "",
		newPassword: "",
		confirmPassword: "",
	});

	const [otpVerified, setOtpVerified] = useState(false);
	const [twoFactorPending, setTwoFactorPending] = useState(false);
	const [pendingLoginEmail, setPendingLoginEmail] = useState("");
	// Registration email-verification step (after the form, before the account is usable).
	const [busy, setBusy] = useState(false);
	const loading = parentLoading || busy;
	const [verifyPending, setVerifyPending] = useState(false);
	// Keeps the verify step alive if the parent switches `mode` while it is showing.
	const keepVerifyRef = useRef(false);
	const [pendingVerifyEmail, setPendingVerifyEmail] = useState("");
	const [resendSeconds, setResendSeconds] = useState(0);
	const [activeSlide, setActiveSlide] = useState(0);
	const [localError, setLocalError] = useState("");
	const [revealPassword, setRevealPassword] = useState(false);
	const [revealNewPassword, setRevealNewPassword] = useState(false);
	const [capsLockOn, setCapsLockOn] = useState(false);

	// Rotate the showcase, but sit still for anyone who asked for reduced motion.
	useEffect(() => {
		if (!isOpen) return;

		setActiveSlide(0);

		const prefersReducedMotion =
			typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

		if (prefersReducedMotion) return;

		const timer = setInterval(() => {
			setActiveSlide((current) => (current + 1) % showcaseSlides.length);
		}, SLIDE_INTERVAL_MS);

		return () => clearInterval(timer);
	}, [isOpen]);

	useEffect(() => {
		if (!isOpen) {
			keepVerifyRef.current = false;
			return;
		}

		if (keepVerifyRef.current) {
			return;
		}

		if (isOpen) {
			setFormData({
				name: "",
				email: mode === "admin" ? (prefillEmail || "") : "",
				password: "",
				otp: "",
				newPassword: "",
				confirmPassword: "",
			});
			setOtpVerified(false);
			setTwoFactorPending(false);
			setPendingLoginEmail("");
			setVerifyPending(false);
			setPendingVerifyEmail("");
			setResendSeconds(0);
			setLocalError("");
			setRevealPassword(false);
			setRevealNewPassword(false);
			setCapsLockOn(false);
		}
	}, [isOpen, mode, prefillEmail]);

	// Escape closes, and the page behind stops scrolling while the dialog is up.
	useEffect(() => {
		if (!isOpen) return;

		const handleKeyDown = (event) => {
			if (event.key === "Escape") {
				onClose?.();
			}
		};

		const previousOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		window.addEventListener("keydown", handleKeyDown);

		return () => {
			document.body.style.overflow = previousOverflow;
			window.removeEventListener("keydown", handleKeyDown);
		};
	}, [isOpen, onClose]);

	// Tick the "resend code" countdown down once a second.
	useEffect(() => {
		if (resendSeconds <= 0) return;

		const timer = setTimeout(() => setResendSeconds((current) => Math.max(0, current - 1)), 1000);

		return () => clearTimeout(timer);
	}, [resendSeconds]);

	const handleChange = useCallback((event) => {
		const { name, value } = event.target;
		setFormData((current) => ({
			...current,
			[name]: value,
		}));
	}, []);

	const setOtp = useCallback((nextOtp) => {
		setFormData((current) => ({ ...current, otp: nextOtp }));
	}, []);

	const trackCapsLock = (event) => {
		setCapsLockOn(Boolean(event.getModifierState?.("CapsLock")));
	};

	if (!isOpen) {
		return null;
	}

	const startVerifyStep = (email) => {
		keepVerifyRef.current = true;
		setVerifyPending(true);
		setPendingVerifyEmail(email);
		setResendSeconds(RESEND_COOLDOWN_SECONDS);
		setFormData((current) => ({ ...current, email, otp: "", password: "" }));
	};

	const handleResendCode = async () => {
		if (resendSeconds > 0 || loading) {
			return;
		}

		setLocalError("");

		setBusy(true);

		try {
			await authPost("/resend-registration-otp", { email: pendingVerifyEmail });
			setFormData((current) => ({ ...current, otp: "" }));
			setResendSeconds(RESEND_COOLDOWN_SECONDS);
			if (typeof showToast === "function") {
				showToast("A new verification code is on its way.", { type: "success" });
			}
		} catch (error) {
			setLocalError(error.message);
		} finally {
			setBusy(false);
		}
	};

	const handleBackFromVerify = () => {
		keepVerifyRef.current = false;
		setVerifyPending(false);
		setPendingVerifyEmail("");
		setResendSeconds(0);
		setLocalError("");
		setFormData((current) => ({ ...current, otp: "" }));
		if (mode !== "register") {
			onSwitchMode("register");
		}
	};

	const handleSubmit = async (event) => {
		event.preventDefault();

		setLocalError("");

		if (verifyPending) {
			if (formData.otp.length !== 6) {
				setLocalError("Enter all six digits of the code.");
				return;
			}

			setBusy(true);

			try {
				await authPost("/verify-registration-otp", { email: pendingVerifyEmail, otp: formData.otp });
				keepVerifyRef.current = false;
				setVerifyPending(false);
				if (typeof showToast === "function") {
					showToast("Email verified. You can log in now.", { type: "success" });
				}
				onSwitchMode("login");
			} catch (error) {
				setLocalError(error.message);
			} finally {
				setBusy(false);
			}

			return;
		}

		if (isRegisterMode) {
			setBusy(true);

			try {
				const data = await authPost("/register", {
					name: formData.name,
					email: formData.email,
					password: formData.password,
				});
				startVerifyStep(data.email || formData.email);
			} catch (error) {
				setLocalError(error.message);
			} finally {
				setBusy(false);
			}

			return;
		}

		if (twoFactorPending) {
			const result = await onSubmit({
				mode: "verify-login-otp",
				email: pendingLoginEmail,
				otp: formData.otp,
			});

			if (result?.success) {
				setTwoFactorPending(false);
				if (result?.newBrowserLogin && typeof showToast === "function") {
					showToast("New login detected from a new browser.", { type: "warning" });
				}
			}

			return;
		}

		if (isForgotMode && !formData.otp) {
			await onSubmit({
				mode: "forgot",
				email: formData.email,
			});
			return;
		}

		if (isForgotMode && formData.otp && !otpVerified) {
			const result = await onSubmit({
				mode: "verify-otp",
				email: formData.email,
				otp: formData.otp,
			});

			if (result?.success) {
				setOtpVerified(true);
			}

			return;
		}

		if (isForgotMode && otpVerified) {
			if (!formData.newPassword || formData.newPassword.length < 6) {
				setLocalError("Use at least 6 characters for the new password.");
				return;
			}

			if (formData.newPassword !== formData.confirmPassword) {
				setLocalError("The two passwords don't match.");
				return;
			}

			await onSubmit({
				mode: "reset-password",
				email: formData.email,
				newPassword: formData.newPassword,
			});

			return;
		}

		const result = await onSubmit({
			mode,
			...formData,
		});

		if (mode === "login" && result?.verificationRequired) {
			startVerifyStep(result.email || formData.email);
			return;
		}

		if ((mode === "login" || mode === "admin") && result?.twoFactorRequired) {
			setTwoFactorPending(true);
			setPendingLoginEmail(formData.email);
			return;
		}

		if ((mode === "login" || mode === "admin") && result?.newBrowserLogin && typeof showToast === "function") {
			showToast("New login detected from a new browser.", { type: "warning" });
		}
	};

	const showcase = showcaseSlides[activeSlide];

	const headline = verifyPending
		? "Check your inbox"
		: twoFactorPending
			? "One more check"
		: isRegisterMode
			? "Start your workspace"
			: isForgotMode
				? "Get back in"
				: isAdminMode
					? "Confirm it's you"
					: "Welcome back";

	const lede = verifyPending
		? "Confirm your email address to finish creating your account."
		: twoFactorPending
			? "We sent a 6-digit code to your email. Enter it to finish signing in."
		: isRegisterMode
			? "Your chats, files, and projects stay together from the first message on."
			: isForgotMode
				? "We'll email you a 6-digit code, then you choose a new password."
				: isAdminMode
					? "Admin tools need your password again, even in an open session."
					: "Pick up any conversation exactly where you left it.";

	const panelTitle = verifyPending
		? "Verify email"
		: twoFactorPending
			? "Verify code"
		: isRegisterMode
			? "Create account"
			: isForgotMode
				? "Reset password"
				: isAdminMode
					? "Admin access"
					: "Log in";

	const panelSub = verifyPending
		? `Code sent to ${pendingVerifyEmail || "your email"}.`
		: twoFactorPending
			? `Code sent to ${pendingLoginEmail || "your email"}.`
		: "";

	const submitLabel = verifyPending
		? "Verify email"
		: twoFactorPending
			? "Verify code"
		: isForgotMode
			? otpVerified
				? "Set new password"
				: "Verify code"
			: isRegisterMode
				? "Create account"
				: isAdminMode
					? "Confirm admin access"
					: "Log in";

	const forgotStep = otpVerified ? 2 : formData.otp ? 1 : 0;
	const passwordScore = scorePassword(isForgotMode ? formData.newPassword : formData.password);
	const visibleError = verifyPending ? localError : localError || errorMessage;
	const isPasswordActive = Boolean(
		String(formData.password || "").length > 0 ||
		String(formData.newPassword || "").length > 0 ||
		String(formData.confirmPassword || "").length > 0 ||
		twoFactorPending ||
		verifyPending
	);

	return (
		<div className="qa-backdrop" role="presentation" onClick={onClose}>
			<div
				className={`qa-modal${isPasswordActive ? " qa-modal--password-active" : ""}`}
				role="dialog"
				aria-modal="true"
				aria-labelledby="qa-headline"
				onClick={(event) => event.stopPropagation()}
			>
				<section className="qa-showcase">
					<div className="qa-showcase__media">
						<img
							key={activeSlide}
							className="qa-showcase__image"
							src={showcase.src}
							alt=""
							aria-hidden="true"
						/>
					</div>
					<div className="qa-showcase__scrim" aria-hidden="true" />
					<div className="qa-showcase__mesh" aria-hidden="true" />

					<div className="qa-showcase__content">
						<div className="qa-brand">
							<span className="qa-brand__mark" aria-hidden="true" style={{ background: "transparent", boxShadow: "none", border: "none" }}>
								<img className="qa-brand__logo" src={image5} alt="" />
							</span>
							<span className="qa-brand__text">
								<span className="qa-brand__name">Quantic</span>
								<span className="qa-brand__tag">Workspace access</span>
							</span>
						</div>

						<div>
							<h2 className="qa-showcase__headline" id="qa-headline">{headline}</h2>
							<p className="qa-showcase__lede">{lede}</p>
						</div>

						<div className="qa-rail">
							<p className="qa-rail__caption">{showcase.caption}</p>
							<div className="qa-rail__segments" role="presentation">
								{showcaseSlides.map((slide, index) => (
									<span
										key={slide.src}
										className={`qa-rail__segment${index === activeSlide ? " is-active" : index < activeSlide ? " is-done" : ""
											}`}
									/>
								))}
							</div>
							{/* <div className="qa-facts">
								<div className="qa-fact">
									<strong>Sourced</strong>
									<span>Every claim cited</span>
								</div>
								<div className="qa-fact">
									<strong>Private</strong>
									<span>Your files, your account</span>
								</div>
								<div className="qa-fact">
									<strong>Saved</strong>
									<span>History always on</span>
								</div>
							</div> */}
						</div>
					</div>
				</section>

				<section className="qa-panel">
					<div className="qa-panel__head">
						<div>
							<h3 className="qa-panel__title">{panelTitle}</h3>
							{panelSub ? <p className="qa-panel__sub">{panelSub}</p> : null}
						</div>
						<button type="button" className="qa-close" onClick={onClose} aria-label="Close">
							<IconClose />
						</button>
					</div>

					{!isForgotMode && !isAdminMode && !twoFactorPending && !verifyPending && (
						<div className="qa-tabs" data-active={mode} role="tablist" aria-label="Authentication mode">
							<span className="qa-tabs__pill" aria-hidden="true" />
							<button
								type="button"
								role="tab"
								className={`qa-tab ${mode === "login" ? "is-active" : ""}`}
								onClick={() => onSwitchMode("login")}
								aria-selected={mode === "login"}
							>
								Log in
							</button>
							<button
								type="button"
								role="tab"
								className={`qa-tab ${mode === "register" ? "is-active" : ""}`}
								onClick={() => onSwitchMode("register")}
								aria-selected={mode === "register"}
							>
								Register
							</button>
						</div>
					)}

					{isForgotMode && (
						<div className="qa-steps" aria-label="Reset progress">
							{["Email", "Code", "New password"].map((stepName, index) => (
								<div
									key={stepName}
									className={`qa-step${index === forgotStep ? " is-current" : index < forgotStep ? " is-done" : ""
										}`}
								>
									<span className="qa-step__bar" />
									<span className="qa-step__name">{stepName}</span>
								</div>
							))}
						</div>
					)}

					<form className="qa-form" onSubmit={handleSubmit} noValidate={false}>
						{isRegisterMode && !verifyPending ? (
						<div className="qa-field">
							<div className="qa-field__label">
								<label htmlFor="qa-name">Name</label>
								</div>
								<span className="qa-input">
									<span className="qa-input__icon" aria-hidden="true"><IconUser /></span>
									<input
										id="qa-name"
										name="name"
										type="text"
										value={formData.name}
										onChange={handleChange}
										placeholder="Ada Lovelace"
										autoComplete="name"
										required
									/>
								</span>
							</div>
						) : null}

						<div className="qa-field">
							<div className="qa-field__label">
								<label htmlFor="qa-email">Email</label>
							</div>
							<span className="qa-input">
								<span className="qa-input__icon" aria-hidden="true"><IconMail /></span>
								<input
									id="qa-email"
									name="email"
									type="email"
									value={formData.email}
									onChange={handleChange}
									placeholder="you@company.com"
									autoComplete="email"
									required
									readOnly={isAdminMode || verifyPending}
								/>
							</span>
						</div>

						{!isForgotMode && !twoFactorPending && !verifyPending && (
						<div className="qa-field">
							<div className="qa-field__label">
								<label htmlFor="qa-password">Password</label>
									{/* {!isRegisterMode && !isAdminMode && (
										<button
											type="button"
											className="qa-textlink qa-textlink--micro"
											onClick={() => onSwitchMode("forgot")}
										>
											Forgot password!
										</button>
									)} */}
								</div>
								<span className="qa-input">
									<span className="qa-input__icon" aria-hidden="true"><IconLock /></span>
									<input
										id="qa-password"
										name="password"
										type={revealPassword ? "text" : "password"}
										value={formData.password}
										onChange={handleChange}
										onKeyUp={trackCapsLock}
										placeholder={isRegisterMode ? "At least 6 characters" : "Your password"}
										autoComplete={isRegisterMode ? "new-password" : "current-password"}
										required
										minLength={6}
										autoFocus={isAdminMode}
									/>
									<button
										type="button"
										className="qa-input__ghost"
										onClick={() => setRevealPassword((current) => !current)}
										aria-label={revealPassword ? "Hide password" : "Show password"}
									>
										{revealPassword ? <IconEyeOff /> : <IconEye />}
									</button>
								</span>

								{!isRegisterMode && !isAdminMode && (
									<button
										type="button"
										className="qa-textlink qa-textlink--forgot"
										onClick={() => onSwitchMode("forgot")}
									>
										Forgot password?
									</button>
								)}

								{isRegisterMode && formData.password ? (
									<span className="qa-strength" data-score={passwordScore}>
										<span className="qa-strength__bars" aria-hidden="true">
											{[0, 1, 2, 3].map((index) => (
												<span
													key={index}
													className={`qa-strength__bar${index < passwordScore ? " is-on" : ""}`}
												/>
											))}
										</span>
										<span className="qa-strength__hint">{STRENGTH_LABELS[passwordScore]}</span>
									</span>
								) : null}
							</div>
						)}

						{verifyPending && (
						<div className="qa-field">
							<span className="qa-field__label">Verification code</span>
							<OtpField value={formData.otp} onChange={setOtp} autoFocus />
							<span className="qa-strength__hint">Six digits, from the email we just sent. It expires in 10 minutes.</span>
						</div>
					)}

					{twoFactorPending && (
						<div className="qa-field">
							<span className="qa-field__label">Verification code</span>
								<OtpField value={formData.otp} onChange={setOtp} autoFocus />
								<span className="qa-strength__hint">Six digits, from the email we just sent.</span>
							</div>
						)}

						{isForgotMode && !otpVerified && (
							<div className="qa-field">
								<span className="qa-field__label">Verification code</span>
								<OtpField value={formData.otp} onChange={setOtp} />
								{formData.otp ? (
									<span className="qa-strength__hint">Enter all six digits, then verify.</span>
								) : null}
							</div>
						)}

						{isForgotMode && otpVerified && (
							<>
								<div className="qa-field">
									<div className="qa-field__label">
										<label htmlFor="qa-new-password">New password</label>
									</div>
									<span className="qa-input">
										<span className="qa-input__icon" aria-hidden="true"><IconLock /></span>
										<input
											autoFocus
											id="qa-new-password"
											name="newPassword"
											type={revealNewPassword ? "text" : "password"}
											value={formData.newPassword}
											onChange={handleChange}
											onKeyUp={trackCapsLock}
											placeholder="At least 6 characters"
											autoComplete="new-password"
											required
											minLength={6}
										/>
										<button
											type="button"
											className="qa-input__ghost"
											onClick={() => setRevealNewPassword((current) => !current)}
											aria-label={revealNewPassword ? "Hide password" : "Show password"}
										>
											{revealNewPassword ? <IconEyeOff /> : <IconEye />}
										</button>
									</span>

									{formData.newPassword ? (
										<span className="qa-strength" data-score={passwordScore}>
											<span className="qa-strength__bars" aria-hidden="true">
												{[0, 1, 2, 3].map((index) => (
													<span
														key={index}
														className={`qa-strength__bar${index < passwordScore ? " is-on" : ""}`}
													/>
												))}
											</span>
											<span className="qa-strength__hint">{STRENGTH_LABELS[passwordScore]}</span>
										</span>
									) : null}
								</div>

								<div className="qa-field">
									<div className="qa-field__label">
										<label htmlFor="qa-confirm-password">Confirm password</label>
									</div>
									<span className="qa-input">
										<span className="qa-input__icon" aria-hidden="true"><IconLock /></span>
										<input
											id="qa-confirm-password"
											name="confirmPassword"
											type={revealNewPassword ? "text" : "password"}
											value={formData.confirmPassword}
											onChange={handleChange}
											placeholder="Type it again"
											autoComplete="new-password"
											required
											minLength={6}
										/>
									</span>
								</div>
							</>
						)}

						{capsLockOn && (
							<p className="qa-note">
								<IconAlert />
								<span>Caps Lock is on.</span>
							</p>
						)}

						{visibleError ? (
							<p className="qa-alert" role="alert" aria-live="polite">
								<IconAlert />
								<span>{visibleError}</span>
							</p>
						) : null}

						{isForgotMode && !formData.otp && (
							<button type="submit" className="qa-submit" disabled={loading}>
								{loading ? <span className="qa-spinner" aria-hidden="true" /> : null}
								<span>{loading ? "Sending code" : "Send code"}</span>
							</button>
						)}

						{(!isForgotMode || formData.otp) && (
							<button type="submit" className="qa-submit" disabled={loading}>
								{loading ? <span className="qa-spinner" aria-hidden="true" /> : null}
								<span>{loading ? "Working" : submitLabel}</span>
							</button>
						)}

						{verifyPending && (
						<p className="qa-foot">
							Didn't get it?{" "}
							<button
								type="button"
								className="qa-textlink"
								onClick={handleResendCode}
								disabled={resendSeconds > 0 || loading}
							>
								{resendSeconds > 0 ? `Resend code in ${resendSeconds}s` : "Resend code"}
							</button>
							{" · "}
							<button type="button" className="qa-textlink" onClick={handleBackFromVerify}>
								Use a different email
							</button>
						</p>
					)}

					{!isForgotMode && !isAdminMode && !twoFactorPending && !verifyPending && (
						<p className="qa-foot">
								{isRegisterMode ? "Already have an account? " : "New to Quantic? "}
								<button
									type="button"
									className="qa-textlink"
									onClick={() => onSwitchMode(isRegisterMode ? "login" : "register")}
								>
									{isRegisterMode ? "Log in instead" : "Create one"}
								</button>
							</p>
						)}

						{isForgotMode && (
							<p className="qa-foot">
								Remembered it?{" "}
								<button type="button" className="qa-textlink" onClick={() => onSwitchMode("login")}>
									Back to log in
								</button>
							</p>
						)}

						{isAdminMode && (
							<p className="qa-foot">Closing this dialog leaves your chat session signed in.</p>
						)}
					</form>
				</section>
			</div>
		</div>
	);
}

export default LoginModals;