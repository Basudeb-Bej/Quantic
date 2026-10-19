// front-end/src/components/Navbar.jsx
import { useEffect, useState } from "react";
import logo from "../assets/img/favicon.png";
// Side-effect import: applies the saved theme before first paint, on every page.
import "../theme/appearance";

// Announcements arrive as { text, url } from /api/public/announcement. Older
// records may still be plain strings, so both shapes are accepted here.
function normalizeAnnouncements(list) {
	return (Array.isArray(list) ? list : [])
		.map((entry) =>
			typeof entry === "string"
				? { text: entry.trim(), url: "" }
				: { text: String(entry?.text ?? "").trim(), url: String(entry?.url ?? "").trim() }
		)
		.filter((entry) => entry.text);
}

// Move LogoutIcon outside or keep it here
function LogoutIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="M9 4.5H6.5a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2H9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M15.5 16.5 20 12l-4.5-4.5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
			<path d="M20 12H10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
		</svg>
	);
}

function AnnouncementIcon() {
	/* Megaphone outline — matches the product reference icon */
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			{/* Horn / cone body */}
			<path
				d="M8.2 8.6 18.5 5.2c.7-.22 1.35.35 1.2 1.05L17.9 17.8c-.15.7-.85 1.05-1.45.7L8.2 14.9"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinejoin="round"
			/>
			{/* Mouthpiece + handle */}
			<path
				d="M8.2 8.6v6.3c0 .55-.45 1-1 1H5.4c-.55 0-1-.45-1-1v-4.3c0-.55.45-1 1-1h1.8c.55 0 1 .45 1 1Z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinejoin="round"
			/>
			{/* Grip under handle */}
			<path
				d="M5.9 15.9v1.6c0 .7.55 1.25 1.25 1.25h.35"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
			/>
		</svg>
	);
}

function CloseIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
		</svg>
	);
}

function ChatBackIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path d="M15 6 9 12l6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function Navbar({
	isLoggedIn,
	activeView,
	onSelectView,
	onLoginOpen,
	onLogout,
	chatPinned,
	chatArchived,
	chatMenuOpen,
	onToggleChatMenu,
	onShareChat,
	onTogglePinChat,
	onToggleArchiveChat,
	onDeleteChat,
	chatMenuEnabled = true,
	loggingOut = false,
	announcement,
	sidebarOpen,        // NEW
	onToggleSidebar,    // NEW
}) {
	const announcementMessages = normalizeAnnouncements(announcement?.messages);
	const hasAnnouncement = Boolean(announcement?.enabled && announcementMessages.length);
	// The settings page keeps the full-width navbar as-is; every other view
	// (chat, whether logged in or as a guest) gets the compact floating pill.
	const isSettingsView = isLoggedIn && activeView === "settings";

	const [isAnnouncementOpen, setAnnouncementOpen] = useState(false);

	useEffect(() => {
		if (!hasAnnouncement) {
			setAnnouncementOpen(false);
		}
	}, [hasAnnouncement]);

	useEffect(() => {
		if (!isAnnouncementOpen) return undefined;

		const handleKeyDown = (event) => {
			if (event.key === "Escape") {
				setAnnouncementOpen(false);
			}
		};

		document.addEventListener("keydown", handleKeyDown);
		return () => document.removeEventListener("keydown", handleKeyDown);
	}, [isAnnouncementOpen]);

	return (
		<>
		{/* Guest mobile: hamburger stays fixed top-left (outside the floating pill) */}
		{typeof onToggleSidebar === "function" && !isLoggedIn && !isSettingsView && !sidebarOpen ? (
			<button
				type="button"
				className="app-navbar__mobile-toggle app-navbar__mobile-toggle--guest"
				onClick={onToggleSidebar}
				aria-label="Open menu"
				aria-expanded={false}
			>
				<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
					<path d="M4 7h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
					<path d="M4 12h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
					<path d="M4 17h16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
				</svg>
			</button>
		) : null}

		<header className={`app-navbar app-navbar--floating${isSettingsView ? " app-navbar--settings" : ""}${isLoggedIn ? " app-navbar--logged-in" : " app-navbar--guest"}`}>

			{isSettingsView ? (
				<div className="app-navbar__pill app-navbar__pill--settings">
					<span className="workspace__status workspace__status--signin">SIGN IN</span>

					{hasAnnouncement ? (
						<button
							type="button"
							className="app-navbar__announcement-button"
							onClick={() => setAnnouncementOpen(true)}
							aria-label="View announcement"
							aria-haspopup="dialog"
							aria-expanded={isAnnouncementOpen}
							title="Announcement"
						>
							<AnnouncementIcon />
						</button>
					) : null}

					<button
						className="workspace__link-button workspace__link-button--back"
						type="button"
						onClick={() => onSelectView("chat")}
					>
						<span className="workspace__link-button-icon" aria-hidden="true">
							<ChatBackIcon />
						</span>
						<span>Back to chat</span>
					</button>
					<button
						className="workspace__logout-button"
						type="button"
						onClick={onLogout}
						disabled={loggingOut}
					>
						<span className="workspace__logout-icon" aria-hidden="true">
							<LogoutIcon />
						</span>
						<span>{loggingOut ? "Logging out…" : "Logout"}</span>
					</button>
				</div>
			) : (
				<div className="app-navbar__pill">
					{isLoggedIn ? <span className="workspace__status workspace__status--signin">SIGN IN</span> : null}
					{chatPinned ? <span className="workspace__status workspace__status--chat">Pinned</span> : null}
					{chatArchived ? <span className="workspace__status workspace__status--chat">Archived</span> : null}

					{hasAnnouncement ? (
						<button
							type="button"
							className="app-navbar__announcement-button"
							onClick={() => setAnnouncementOpen(true)}
							aria-label="View announcement"
							aria-haspopup="dialog"
							aria-expanded={isAnnouncementOpen}
							title="Announcement"
						>
							<AnnouncementIcon />
						</button>
					) : null}

					{isLoggedIn ? (
						<div className={`app-navbar__menu${chatMenuEnabled ? "" : " app-navbar__menu--disabled"}`}>
							<button
								type="button"
								className="workspace__menu-button"
								onClick={chatMenuEnabled ? onToggleChatMenu : undefined}
								aria-label="Chat options"
								aria-expanded={chatMenuEnabled ? chatMenuOpen : false}
								aria-disabled={!chatMenuEnabled}
								disabled={!chatMenuEnabled}
								title={chatMenuEnabled ? "Chat options" : "Available during an active chat"}
							>
								<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
									<path d="M5 7h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
									<path d="M5 12h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
									<path d="M5 17h14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
								</svg>
							</button>

							{chatMenuEnabled && chatMenuOpen ? (
								<div className="workspace__menu-panel" role="menu" aria-label="Chat actions">
									<button className="workspace__menu-item" type="button" onClick={onShareChat} role="menuitem">
										<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
											<path d="M12 16v-9" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
											<path d="M8.5 7.5 12 4l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
											<path d="M6 13.5v2.5a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-2.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
										</svg>
										<span>Share</span>
									</button>
									<button className="workspace__menu-item" type="button" onClick={onTogglePinChat} role="menuitem">
										<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
											<path d="M14.5 3.8 20.2 9.5l-2.2 2.2-2.2-.5-3.1 3.1v2.4l-2.2 2.2-1.8-1.8 2.2-2.2h2.4l3.1-3.1-.5-2.2 2.2-2.2-5.7-5.7 2.2-2.2Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
										</svg>
										<span>{chatPinned ? "Unpin chat" : "Pin chat"}</span>
									</button>
									<button className="workspace__menu-item" type="button" onClick={onToggleArchiveChat} role="menuitem">
										<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
											<path d="M4.5 7h15v3.2h-15V7Z" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" />
											<path d="M6.5 10.2V17h11V10.2" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
											<path d="M10 13h4" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
										</svg>
										<span>{chatArchived ? "Unarchive chat" : "Archive chat"}</span>
									</button>
									<button className="workspace__menu-item workspace__menu-item--danger" type="button" onClick={onDeleteChat} role="menuitem">
										<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
											<path d="M9 4.5h6m-8 3h10m-8 0v10m6-10v10M8 7.5h8l-.6 10.1a1.5 1.5 0 0 1-1.5 1.4H10.1a1.5 1.5 0 0 1-1.5-1.4L8 7.5Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
										</svg>
										<span>Delete chat</span>
									</button>
								</div>
							) : null}
						</div>
					) : (
						<>
							<button className="workspace__link-button" type="button" onClick={() => onLoginOpen("login")}>Login</button>
							<button className="workspace__primary-button" type="button" onClick={() => onLoginOpen("register")}>Register for free</button>
						</>
					)}
				</div>
			)}
		</header>

		{hasAnnouncement && isAnnouncementOpen ? (
			<div
				className="app-navbar__announcement-overlay"
				role="presentation"
				onClick={() => setAnnouncementOpen(false)}
			>
				<div
					className="app-navbar__announcement-modal"
					role="dialog"
					aria-modal="true"
					aria-label="Announcement"
					onClick={(event) => event.stopPropagation()}
				>
					<div className="app-navbar__announcement-modal-header">
						<h2>Announcement</h2>
						<button
							type="button"
							className="app-navbar__announcement-modal-close"
							onClick={() => setAnnouncementOpen(false)}
							aria-label="Close announcement"
						>
							<CloseIcon />
						</button>
					</div>
					<ul className="app-navbar__announcement-modal-list">
						{announcementMessages.map((item, index) => (
							<li key={`announcement-modal-${index}`} className="app-navbar__announcement-modal-item">
								{item.url ? (
									<a href={item.url} target="_blank" rel="noopener noreferrer">
										{item.text}
									</a>
								) : (
									<span>{item.text}</span>
								)}
							</li>
						))}
					</ul>
				</div>
			</div>
		) : null}
		</>
	);
}

export default Navbar;