//front-end/src/components/SideBar.jsx
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import logo from "../assets/img/favicon2.png";
import { SettingsIcon, NewChatIcon } from "../components/GoogleIcons";

function DotsIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<circle cx="6" cy="12" r="1.5" fill="currentColor" />
			<circle cx="12" cy="12" r="1.5" fill="currentColor" />
			<circle cx="18" cy="12" r="1.5" fill="currentColor" />
		</svg>
	);
}

function EditIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path
				d="M4 16.8V20h3.2L18.9 8.3l-3.2-3.2L4 16.8Z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinejoin="round"
			/>
			<path d="m14 5.1 3.2 3.2" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
		</svg>
	);
}

function TrashIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path
				d="M9 4.5h6m-8 3h10m-8 0v10m6-10v10M8 7.5h8l-.6 10.1a1.5 1.5 0 0 1-1.5 1.4H10.1a1.5 1.5 0 0 1-1.5-1.4L8 7.5Z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function SparkIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path
				d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2Z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function GearIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<path
				d="M10.2 3.4h3.6l.4 2a7.8 7.8 0 0 1 1.4.6l1.8-1.1 2.6 2.6-1.1 1.8c.2.5.4.9.6 1.4l2 .4v3.6l-2 .4a7.8 7.8 0 0 1-.6 1.4l1.1 1.8-2.6 2.6-1.8-1.1a7.8 7.8 0 0 1-1.4.6l-.4 2h-3.6l-.4-2a7.8 7.8 0 0 1-1.4-.6l-1.8 1.1-2.6-2.6 1.1-1.8a7.8 7.8 0 0 1-.6-1.4l-2-.4v-3.6l2-.4a7.8 7.8 0 0 1 .6-1.4L4.4 7.3 7 4.7l1.8 1.1c.5-.2.9-.4 1.4-.6l.4-2Z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.4"
				strokeLinejoin="round"
			/>
			<circle cx="12" cy="12" r="3.2" fill="none" stroke="currentColor" strokeWidth="1.8" />
		</svg>
	);
}

function UserIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
			<circle cx="12" cy="8.5" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
			<path
				d="M5.5 19.2c1.6-3.1 4.1-4.7 6.5-4.7s4.9 1.6 6.5 4.7"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.8"
				strokeLinecap="round"
			/>
		</svg>
	);
}

function AdminShieldIcon() {
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

function LoadingIcon() {
	return (
		<svg
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
			style={{
				width: "16px",
				height: "16px",
				animation: "spin 1s linear infinite",
				display: "inline-block"
			}}
		>
			<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
			<path
				d="M12 2a10 10 0 0 1 10 10"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			/>
			<style>{`
				@keyframes spin {
					from { transform: rotate(0deg); }
					to { transform: rotate(360deg); }
				}
			`}</style>
		</svg>
	);
}

function SideBar({
	isLoggedIn,
	user,
	activeView,
	onSelectView,
	onStartNewChat,
	chatHistoryGroups,
	activeChatId,
	chatHistoryLoading,
	chatHistoryError,
	onSelectChatHistory,
	chatMenuThreadId,
	onToggleChatThreadMenu,
	renamingThreadId,
	renameDraft,
	onRenameDraftChange,
	onBeginRenameChatThread,
	onCommitRenameChatThread,
	onCancelRenameChatThread,
	onDeleteChatThread,
	onLoginOpen,
	onLogout,
	onStartGuest,
	onAdminAccess,
	isOpen,
	onToggleOpen,
}) {
	const getDisplayName = () => user?.settings?.displayName || user?.name || "Quantic user";
	const isAdmin = user?.role === "admin";
	const memberViews = [
		{ id: "new chat", label: "New Chat", icon: NewChatIcon, iconModifier: "new-chat" },
		{ id: "settings", label: "Settings", icon: SettingsIcon, iconModifier: "settings" },
	];

	const views = isLoggedIn ? memberViews : [];
	const sidebarAvatar = user?.settings?.profileImage || user?.avatarUrl || user?.profileImage || "";

	// Anchor the thread action menu to the three-dots button so it is not
	// clipped by the scrollable history panel (overflow: auto).
	const menuButtonRefs = useRef({});
	const [menuPosition, setMenuPosition] = useState(null);

	const updateMenuPosition = useCallback((threadId) => {
		const button = menuButtonRefs.current[threadId];
		if (!button || typeof window === "undefined") {
			setMenuPosition(null);
			return;
		}
		const rect = button.getBoundingClientRect();
		const menuWidth = 130;
		const gap = 6;
		const left = Math.min(
			Math.max(8, rect.right - menuWidth),
			window.innerWidth - menuWidth - 8
		);
		let top = rect.bottom + gap;
		const estimatedHeight = 96;
		if (top + estimatedHeight > window.innerHeight - 8) {
			top = Math.max(8, rect.top - estimatedHeight - gap);
		}
		setMenuPosition({ top, left });
	}, []);

	useEffect(() => {
		if (!chatMenuThreadId) {
			setMenuPosition(null);
			return;
		}
		updateMenuPosition(chatMenuThreadId);

		const handleReposition = () => updateMenuPosition(chatMenuThreadId);
		window.addEventListener("resize", handleReposition);
		window.addEventListener("scroll", handleReposition, true);
		return () => {
			window.removeEventListener("resize", handleReposition);
			window.removeEventListener("scroll", handleReposition, true);
		};
	}, [chatMenuThreadId, updateMenuPosition]);

	// On mobile, the sidebar should start closed and only open when the user asks for it.
	useEffect(() => {
		const isMobile = typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)").matches;
		if (isMobile && isOpen) {
			onToggleOpen?.();
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// Once an option is picked on mobile, tuck the drawer back away.
	const closeSidebarOnMobile = useCallback(() => {
		const isMobile = typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)").matches;
		if (isMobile && isOpen) {
			onToggleOpen?.();
		}
	}, [isOpen, onToggleOpen]);

	return (
		<aside
			className={`sidebar ${isLoggedIn ? "sidebar--member" : "sidebar--guest"} ${isOpen ? "" : "sidebar--collapsed"}`}
		>
			<div className="sidebar__brand">
				{isOpen ? (
					<div className="sidebar__brand-copy">
						<div className="sidebar__logo" aria-hidden="true">
							<img src={logo} alt="" className="sidebar__logo-image" title="Hello, I'm Quantic, How can I help you?" />
						</div>
						<div>
							<h1>Quantic</h1>
						</div>
					</div>
				) : (
					<button
						type="button"
						className="sidebar__brand-copy sidebar__brand-copy--button sidebar__brand-copy--collapsed"
						onClick={onToggleOpen}
						aria-label="Open sidebar"
						aria-expanded={isOpen}
					>
						<div className="sidebar__logo" aria-hidden="true">
							<img src={logo} alt="" className="sidebar__logo-image" />
						</div>
					</button>
				)}

				{isOpen ? (
					<button
						type="button"
						className="sidebar__toggle"
						onClick={onToggleOpen}
						aria-label="Collapse sidebar"
						aria-expanded={isOpen}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
							<path
								d="M15 6l-6 6 6 6"
								fill="none"
								stroke="currentColor"
								strokeWidth="2.2"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
				) : null}
			</div>

			{isLoggedIn ? (
				<>
					<div className="sidebar__body">
						<nav className="sidebar__nav" aria-label="Sidebar navigation">
							{views.map((view) => (
								<button
									key={view.id}
									type="button"
									className={`sidebar__nav-item ${activeView === view.id ? "is-active" : ""}`}
									title={view.label}
									onClick={() => {
										if (view.id === "new chat") {
											onStartNewChat();
											closeSidebarOnMobile();
											return;
										}

										onSelectView(view.id);
										closeSidebarOnMobile();
									}}
								>
									<span className={`sidebar__nav-icon sidebar__nav-icon--${view.iconModifier}`} aria-hidden="true">
										<view.icon />
									</span>
									<span className="sidebar__nav-label">{view.label}</span>
								</button>
							))}
						</nav>

						{isAdmin ? (
							<div className="sidebar__admin-section" aria-label="Admin tools">
								<button
									type="button"
									className="sidebar__admin-button"
									onClick={() => {
										onAdminAccess();
										closeSidebarOnMobile();
									}}
									aria-label="Admin Panel"
									title="Admin Panel"
								>
									<span className="sidebar__admin-icon" aria-hidden="true">
										<AdminShieldIcon />
									</span>
									<span className="sidebar__admin-label">Admin Panel</span>
								</button>
							</div>
						) : null}

						<div className="sidebar__history" aria-label="Saved chats">
							<div className="sidebar__history-header">
								{chatHistoryLoading ? <span className="sidebar__history-state"><LoadingIcon /></span> : null}
							</div>
							{chatHistoryError ? <p className="sidebar__history-error">{chatHistoryError}</p> : null}
							{chatHistoryGroups?.length ? (
								<div className="sidebar__history-groups">
									{chatHistoryGroups.map((group) => (
										<section key={group.label} className="sidebar__history-group">
											<h3 className="sidebar__history-title" title={group.label}>{group.label}</h3>
											<div className="sidebar__history-list">
												{group.items.map((thread) => (
													<div key={thread.id} className="sidebar__history-item-shell">
														{renamingThreadId === thread.id ? (
															<div className="sidebar__history-rename">
																<input
																	type="text"
																	className="sidebar__history-rename-input"
																	value={renameDraft}
																	onChange={(event) => onRenameDraftChange(event.target.value)}
																	onKeyDown={(event) => {
																		if (event.key === "Enter") {
																			event.preventDefault();
																			onCommitRenameChatThread(thread.id);
																			return;
																		}

																		if (event.key === "Escape") {
																			event.preventDefault();
																			onCancelRenameChatThread();
																		}
																	}}
																	onBlur={() => onCommitRenameChatThread(thread.id)}
																	autoFocus
																/>
															</div>
														) : (
															<>
																<button
																	type="button"
																	className={`sidebar__history-item ${activeChatId === thread.id ? "is-active" : ""}`}
																	onClick={() => {
																		onSelectChatHistory(thread.id);
																		closeSidebarOnMobile();
																	}}
																	aria-pressed={activeChatId === thread.id}
																	title={thread.title}
																>
																	<strong>{thread.title}</strong>
																</button>
																<div className={`sidebar__history-menu-wrap${chatMenuThreadId === thread.id ? " is-open" : ""}`}>
																	<button
																		type="button"
																		className="sidebar__history-menu-button"
																		ref={(node) => {
																			if (node) {
																				menuButtonRefs.current[thread.id] = node;
																			} else {
																				delete menuButtonRefs.current[thread.id];
																			}
																		}}
																		onClick={(event) => {
																			event.stopPropagation();
																			onToggleChatThreadMenu(thread.id);
																		}}
																		aria-label={`Chat options for ${thread.title}`}
																		aria-expanded={chatMenuThreadId === thread.id}
																	>
																		<DotsIcon />
																	</button>
																</div>
															</>
														)}
													</div>
												))}
											</div>
										</section>
									))}
								</div>
							) : (
								<p className="sidebar__history-empty">No saved chats yet.</p>
							)}
						</div>

						<div className="sidebar__footer">
							<div className="sidebar__footer-content">
								<div className="sidebar__profile sidebar__profile--footer">
									<div className="sidebar__avatar" aria-hidden="true">
										{sidebarAvatar ? (
											<img src={sidebarAvatar} alt="" className="sidebar__avatar-image" />
										) : (
											<span className="sidebar__avatar-icon">
												<UserIcon />
											</span>
										)}
									</div>


									<div className="sidebar__profile-copy">
										<div className="sidebar__profile-name-row" title={getDisplayName()}>
											<strong>{getDisplayName()}</strong>
											{isAdmin ? <span className="sidebar__admin-badge">Admin</span> : null}
										</div>
										<span>{user?.email || "Signed in"}</span>
									</div>
								</div>
							</div>
						</div>
					</div>
				</>
			) : isOpen ? (
				<div className="sidebar__footer">
					<div className="sidebar__guest-card">
						<h4>Get responses tailored to you</h4>
						<p>Log in to get answers based on saved chats, plus create images and upload files.</p>
						<button className="sidebar__primary" type="button" onClick={() => { onStartGuest(); closeSidebarOnMobile(); }}>
							New Chat
						</button>
						<button className="sidebar__secondary" type="button" onClick={() => { onLoginOpen(); closeSidebarOnMobile(); }}>
							Log in
						</button>
					</div>
				</div>
			) : null}

			{/* Portaled thread menu — avoids being clipped by sidebar__history overflow */}
			{chatMenuThreadId && menuPosition && typeof document !== "undefined"
				? createPortal(
						<div
							className="sidebar__history-menu sidebar__history-menu--portal"
							role="menu"
							aria-label="Thread actions"
							style={{
								position: "fixed",
								top: menuPosition.top,
								left: menuPosition.left,
								zIndex: 200,
							}}
						>
							<button
								className="sidebar__history-menu-item"
								type="button"
								role="menuitem"
								onClick={() => onBeginRenameChatThread(chatMenuThreadId)}
							>
								<EditIcon />
								<span>Rename</span>
							</button>
							<button
								className="sidebar__history-menu-item sidebar__history-menu-item--danger"
								type="button"
								role="menuitem"
								onClick={() => onDeleteChatThread(chatMenuThreadId)}
							>
								<TrashIcon />
								<span>Delete</span>
							</button>
						</div>,
						document.body
					)
				: null}
		</aside>
	);
}

export default SideBar;