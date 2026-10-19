//front-end/src/pages/Admin/AdminPage.jsx
import { useEffect, useState } from "react";
import AdminUsersTab from "./AdminUsersTab";
import AdminAnalyticsTab from "./AdminAnalyticsTab";
import AdminSettingsTab from "./AdminSettingsTab";
import { fetchAnalytics, fetchCurrentAdmin, logoutAdmin } from "../../services/adminApi";
import "../../AdminPage.css";

function AnalyticsNavIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="M4 20V10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
			<path d="M10 20V4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
			<path d="M16 20v-7" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
			<path d="M20 20V13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
		</svg>
	);
}

function UsersNavIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<circle cx="9" cy="8" r="2.9" fill="none" stroke="currentColor" strokeWidth="1.7" />
			<path d="M3.6 19c1.1-3 3-4.6 5.4-4.6s4.3 1.6 5.4 4.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
			<circle cx="17" cy="8.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
			<path d="M15.4 14.7c1.9.4 3.2 1.8 4 4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
		</svg>
	);
}

function SettingsNavIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path
				d="M10.2 3.4h3.6l.4 2a7.8 7.8 0 0 1 1.4.6l1.8-1.1 2.6 2.6-1.1 1.8c.2.5.4.9.6 1.4l2 .4v3.6l-2 .4a7.8 7.8 0 0 1-.6 1.4l1.1 1.8-2.6 2.6-1.8-1.1a7.8 7.8 0 0 1-1.4.6l-.4 2h-3.6l-.4-2a7.8 7.8 0 0 1-1.4-.6l-1.8 1.1-2.6-2.6 1.1-1.8a7.8 7.8 0 0 1-.6-1.4l-2-.4v-3.6l2-.4a7.8 7.8 0 0 1 .6-1.4L4.4 7.3 7 4.7l1.8 1.1c.5-.2.9-.4 1.4-.6l.4-2Z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			/>
			<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.7" />
		</svg>
	);
}

function ShieldMark() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path
				d="M12 3.5 5.5 6.2v5.4c0 4.4 2.8 8.1 6.5 9.4 3.7-1.3 6.5-5 6.5-9.4V6.2L12 3.5Z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinejoin="round"
			/>
			<path d="M9.5 12.2 11.3 14l3.4-3.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function LockIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<rect x="5.5" y="10.5" width="13" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
			<path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
			<circle cx="12" cy="14.8" r="1.3" fill="currentColor" />
		</svg>
	);
}

function LogoutIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="M9 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M15.5 16.5 20 12l-4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M20 12H10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
		</svg>
	);
}

function ArrowLeftIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function MenuIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="M4 7h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			<path d="M4 12h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
			<path d="M4 17h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		</svg>
	);
}

function CloseMenuIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		</svg>
	);
}

const TABS = [
	{ id: "analytics", label: "Analytics", icon: AnalyticsNavIcon },
	{ id: "users", label: "Users", icon: UsersNavIcon },
	{ id: "settings", label: "Settings", icon: SettingsNavIcon },
];

const ADMIN_ACCESS_KEY = "quantic_admin_access_granted";

function AdminPage() {
	const [activeTab, setActiveTab] = useState("analytics");
	const [accessState, setAccessState] = useState("checking");
	const [adminProfile, setAdminProfile] = useState(null);
	const [loggingOut, setLoggingOut] = useState(false);
	const [logoutConfirmOpen, setLogoutConfirmOpen] = useState(false);
	const [mobileNavOpen, setMobileNavOpen] = useState(false);

	const handleAdminLogout = async () => {
		if (loggingOut) {
			return;
		}

		setLoggingOut(true);
		await logoutAdmin();
		clearAdminAccessFlag();
		window.location.replace("/");
	};

	const openLogoutConfirm = () => {
		if (loggingOut) {
			return;
		}
		setLogoutConfirmOpen(true);
	};

	const confirmAndLogout = async () => {
		setLogoutConfirmOpen(false);
		await handleAdminLogout();
	};

	const clearAdminAccessFlag = () => {
		try {
			sessionStorage.removeItem(ADMIN_ACCESS_KEY);
		} catch {
			// ignore storage errors
		}
	};

	const hasAdminAccessFlag = () => {
		try {
			return sessionStorage.getItem(ADMIN_ACCESS_KEY) === "true";
		} catch {
			return false;
		}
	};

	const handleBackToChat = (event) => {
		event?.preventDefault?.();
		clearAdminAccessFlag();
		window.location.replace("/");
	};

	useEffect(() => {
		let isMounted = true;

		if (!hasAdminAccessFlag()) {
			if (isMounted) setAccessState("unauthenticated");
			return () => {
				isMounted = false;
			};
		}

		fetchAnalytics()
			.then(() => {
				if (isMounted) setAccessState("granted");
			})
			.catch((error) => {
				if (!isMounted) return;
				clearAdminAccessFlag();
				const messageText = (error?.message || "").toLowerCase();
				setAccessState(messageText.includes("not authenticated") ? "unauthenticated" : "denied");
			});

		return () => {
			isMounted = false;
		};
	}, []);

	useEffect(() => {
		if (accessState !== "granted") {
			return;
		}

		let isMounted = true;

		fetchCurrentAdmin()
			.then((result) => {
				if (isMounted) setAdminProfile(result?.user || null);
			})
			.catch(() => {
				// Non-fatal — the profile card just falls back to a generic label.
			});

		return () => {
			isMounted = false;
		};
	}, [accessState]);

	useEffect(() => {
		const handlePopState = () => {
			if (!window.location.pathname.startsWith("/admin")) {
				clearAdminAccessFlag();
			}
		};

		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, []);

	if (accessState === "checking") {
		return (
			<div className="admin-page admin-page--center">
				<div className="admin-page__state-card">
					<div className="admin-page__state-spinner" aria-hidden="true" />
					<p className="admin-page__state-message">Checking access…</p>
				</div>
			</div>
		);
	}

	if (accessState === "unauthenticated") {
		return (
			<div className="admin-page admin-page--center">
				<div className="admin-page__state-card">
					<div className="admin-page__state-icon admin-page__state-icon--neutral">
						<LockIcon />
					</div>
					<h1 className="admin-page__state-title">Sign in required</h1>
					<p className="admin-page__state-message">You need to sign in as an admin to view this page.</p>
					<a className="admin-page__state-link" href="/" onClick={handleBackToChat}>
						Go back home
					</a>
				</div>
			</div>
		);
	}

	if (accessState === "denied") {
		return (
			<div className="admin-page admin-page--center">
				<div className="admin-page__state-card">
					<div className="admin-page__state-icon admin-page__state-icon--danger">
						<ShieldMark />
					</div>
					<h1 className="admin-page__state-title">Access denied</h1>
					<p className="admin-page__state-message">You don't have permission to access the admin dashboard.</p>
					<a className="admin-page__state-link" href="/" onClick={handleBackToChat}>
						Go back home
					</a>
				</div>
			</div>
		);
	}

	const profileInitial = (adminProfile?.name || "A").trim().charAt(0).toUpperCase();

	return (
		<div className={`admin-page${mobileNavOpen ? " admin-page--nav-open" : ""}`}>
			{/* Mobile top bar with hamburger */}
			<header className="admin-page__mobile-bar">
				<button
					type="button"
					className="admin-page__mobile-toggle"
					onClick={() => setMobileNavOpen((open) => !open)}
					aria-label={mobileNavOpen ? "Close menu" : "Open menu"}
					aria-expanded={mobileNavOpen}
				>
					{mobileNavOpen ? <CloseMenuIcon /> : <MenuIcon />}
				</button>
				<button
					type="button"
					className="admin-page__mobile-shield"
					title="Quantic Admin Panel"
					aria-label="Quantic Admin Panel"
				>
					<span className="admin-page__brand-mark" aria-hidden="true">
						<ShieldMark />
					</span>
					<span className="admin-page__mobile-shield-tip" role="tooltip">
						Admin Panel
					</span>
				</button>
			</header>

			{/* Backdrop when mobile drawer is open */}
			<button
				type="button"
				className={`admin-page__nav-backdrop${mobileNavOpen ? " is-visible" : ""}`}
				aria-label="Close menu"
				tabIndex={mobileNavOpen ? 0 : -1}
				onClick={() => setMobileNavOpen(false)}
			/>

			<aside className={`admin-page__sidebar${mobileNavOpen ? " is-open" : ""}`}>
				<div className="admin-page__brand">
					<span className="admin-page__brand-mark" aria-hidden="true">
						<ShieldMark />
					</span>
					<div>
						<h2 className="admin-page__eyebrow">Quantic</h2>
						{/* <h1 className="admin-page__title">Admin</h1> */}
					</div>
				</div>

				<nav className="admin-page__nav">
					{TABS.map((tab) => (
						<button
							key={tab.id}
							type="button"
							className={`admin-page__nav-item ${activeTab === tab.id ? "is-active" : ""}`}
							onClick={() => {
								setActiveTab(tab.id);
								setMobileNavOpen(false);
							}}
						>
							<span className="admin-page__nav-icon" aria-hidden="true">
								<tab.icon />
							</span>
							<span>{tab.label}</span>
						</button>
					))}
				</nav>

				<div className="admin-page__profile">
					<div className="admin-page__profile-avatar" aria-hidden="true">
						{adminProfile?.avatarUrl ? (
							<img src={adminProfile.avatarUrl} alt="" />
						) : (
							<span>{profileInitial}</span>
						)}
					</div>
					<div className="admin-page__profile-copy">
						<strong>{adminProfile?.name || "Admin"}</strong>
						<span>{adminProfile?.email || "Signed in"}</span>
					</div>
					<div className="admin-page__profile-actions">
						<button
							type="button"
							className="admin-page__profile-action"
							onClick={handleBackToChat}
							aria-label="Back to chat"
							title="Back to chat"
						>
							<ArrowLeftIcon />
						</button>
						<button
							type="button"
							className="admin-page__profile-action admin-page__profile-action--danger"
							onClick={openLogoutConfirm}
							disabled={loggingOut}
							aria-label="Log out"
							title="Log out"
						>
							<LogoutIcon />
						</button>
					</div>
				</div>
			</aside>

			<main className="admin-page__content">
				{activeTab === "analytics" && <AdminAnalyticsTab />}
				{activeTab === "users" && <AdminUsersTab />}
				{activeTab === "settings" && <AdminSettingsTab />}
			</main>

			{logoutConfirmOpen ? (
				<div className="admin-dialog-backdrop" role="presentation" onClick={() => setLogoutConfirmOpen(false)}>
					<div className="admin-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
						<h3 className="admin-dialog__title">Log out of the admin panel?</h3>
						<p className="admin-dialog__description">
							You'll need to sign in again to access analytics, users, and settings.
						</p>
						<div className="admin-dialog__actions">
							<button
								type="button"
								className="admin-dialog__cancel"
								onClick={() => setLogoutConfirmOpen(false)}
								disabled={loggingOut}
							>
								Cancel
							</button>
							<button
								type="button"
								className="admin-dialog__confirm admin-dialog__confirm--danger"
								onClick={confirmAndLogout}
								disabled={loggingOut}
							>
								{loggingOut ? "Logging out…" : "Log out"}
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}

export default AdminPage;