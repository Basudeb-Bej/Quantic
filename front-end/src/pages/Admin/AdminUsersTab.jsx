//front-end/src/pages/Admin/AdminUsersTab.jsx
import { useEffect, useState } from "react";
import { fetchUsers, updateUser, banUser, unbanUser, deleteUser } from "../../services/adminApi";

function ShieldPlusIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="20" height="20">
			<path d="M12 3.5 5.5 6.2v5.4c0 4.4 2.8 8.1 6.5 9.4 3.7-1.3 6.5-5 6.5-9.4V6.2L12 3.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
			<path d="M12 9.5v5M9.5 12h5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
		</svg>
	);
}

function ShieldMinusIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="20" height="20">
			<path d="M12 3.5 5.5 6.2v5.4c0 4.4 2.8 8.1 6.5 9.4 3.7-1.3 6.5-5 6.5-9.4V6.2L12 3.5Z" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
			<path d="M9.5 12h5" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
		</svg>
	);
}

function BanIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="20" height="20">
			<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
			<path d="M6.7 6.7 17.3 17.3" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
		</svg>
	);
}

function CheckCircleIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="20" height="20">
			<circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" strokeWidth="1.7" />
			<path d="M8.7 12.3 11 14.6l4.5-4.9" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function TrashIcon() {
	return (
		<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" width="20" height="20">
			<path
				d="M9 4.5h6m-8 3h10m-8 0v10m6-10v10M8 7.5h8l-.6 10.1a1.5 1.5 0 0 1-1.5 1.4H10.1a1.5 1.5 0 0 1-1.5-1.4L8 7.5Z"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.7"
				strokeLinecap="round"
				strokeLinejoin="round"
			/>
		</svg>
	);
}

function ConfirmDialog({ title, description, confirmLabel, tone = "default", inputLabel, onConfirm, onCancel }) {
	const [inputValue, setInputValue] = useState("");
	const [submitting, setSubmitting] = useState(false);

	const handleConfirm = async () => {
		setSubmitting(true);
		try {
			await onConfirm(inputValue);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="admin-dialog-backdrop" role="presentation" onClick={onCancel}>
			<div className="admin-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
				<h3 className="admin-dialog__title">{title}</h3>
				<p className="admin-dialog__description">{description}</p>

				{inputLabel ? (
					<label className="admin-dialog__field">
						<span>{inputLabel}</span>
						<input
							type="text"
							value={inputValue}
							onChange={(event) => setInputValue(event.target.value)}
							autoFocus
						/>
					</label>
				) : null}

				<div className="admin-dialog__actions">
					<button type="button" className="admin-dialog__cancel" onClick={onCancel} disabled={submitting}>
						Cancel
					</button>
					<button
						type="button"
						className={`admin-dialog__confirm ${tone === "danger" ? "admin-dialog__confirm--danger" : ""}`}
						onClick={handleConfirm}
						disabled={submitting}
					>
						{submitting ? "Working…" : confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}

function Toast({ message, tone = "success", onDismiss }) {
	useEffect(() => {
		const timer = setTimeout(onDismiss, 3200);
		return () => clearTimeout(timer);
	}, [onDismiss]);

	return (
		<div className={`admin-toast admin-toast--${tone}`} role="status">
			{message}
		</div>
	);
}

function AdminUsersTab() {
	const [users, setUsers] = useState([]);
	const [pagination, setPagination] = useState({ page: 1, totalPages: 1 });
	const [search, setSearch] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [pendingRowId, setPendingRowId] = useState(null);
	const [dialog, setDialog] = useState(null);
	const [toast, setToast] = useState(null);

	const loadUsers = (page = 1, searchTerm = search) => {
		setLoading(true);
		setError("");

		fetchUsers({ page, search: searchTerm })
			.then((result) => {
				setUsers(result.users);
				setPagination(result.pagination);
			})
			.catch((err) => setError(err?.message || "Failed to load users."))
			.finally(() => setLoading(false));
	};

	useEffect(() => {
		loadUsers(1, "");
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const handleSearchSubmit = (event) => {
		event.preventDefault();
		loadUsers(1, search);
	};

	const showToast = (message, tone = "success") => setToast({ message, tone });

	const handleRoleToggle = async (user) => {
		const nextRole = user.role === "admin" ? "user" : "admin";
		setPendingRowId(user._id);

		try {
			await updateUser(user._id, { role: nextRole });
			showToast(`${user.name || user.email} is now ${nextRole === "admin" ? "an admin" : "a regular user"}.`);
			loadUsers(pagination.page, search);
		} catch (err) {
			showToast(err?.message || "Failed to update role.", "danger");
		} finally {
			setPendingRowId(null);
		}
	};

	const handleUnban = async (user) => {
		setPendingRowId(user._id);

		try {
			await unbanUser(user._id);
			showToast(`${user.name || user.email} has been unbanned.`);
			loadUsers(pagination.page, search);
		} catch (err) {
			showToast(err?.message || "Failed to unban user.", "danger");
		} finally {
			setPendingRowId(null);
		}
	};

	const openBanDialog = (user) => {
		setDialog({
			type: "ban",
			user,
			title: `Ban ${user.name || user.email}?`,
			description: "They won't be able to sign in until you unban them.",
			confirmLabel: "Ban user",
			tone: "danger",
			inputLabel: "Reason (optional)",
		});
	};

	const openDeleteDialog = (user) => {
		setDialog({
			type: "delete",
			user,
			title: `Delete ${user.name || user.email}?`,
			description: "This permanently removes their account, chats, and settings. This cannot be undone.",
			confirmLabel: "Delete permanently",
			tone: "danger",
		});
	};

	const handleDialogConfirm = async (inputValue) => {
		if (!dialog) return;
		const { type, user } = dialog;
		setPendingRowId(user._id);

		try {
			if (type === "ban") {
				await banUser(user._id, inputValue || "");
				showToast(`${user.name || user.email} has been banned.`);
			} else if (type === "delete") {
				await deleteUser(user._id);
				showToast(`${user.name || user.email} has been deleted.`);
			}
			setDialog(null);
			loadUsers(pagination.page, search);
		} catch (err) {
			showToast(err?.message || "Action failed.", "danger");
		} finally {
			setPendingRowId(null);
		}
	};

	return (
		<div className="admin-users">
			{/* <h2>Users</h2> */}

			<form className="admin-users__search" onSubmit={handleSearchSubmit}>
				<input
					type="text"
					value={search}
					onChange={(event) => setSearch(event.target.value)}
					placeholder="Search by name or email"
				/>
				<button type="submit">Search</button>
			</form>

			{error ? <p className="admin-error">{error}</p> : null}

			{loading ? (
				<p>Loading users…</p>
			) : (
				<div className="admin-table-scroll">
					<table className="admin-users__table">
						<thead>
							<tr>
								<th>Name</th>
								<th>Email</th>
								<th>Role</th>
								<th>Status</th>
								<th>Joined</th>
								<th>Actions</th>
								<th>Tokens (today)</th>
							</tr>
						</thead>
						<tbody>
							{users.length === 0 && (
								<tr>
									<td colSpan={7} className="admin-users__empty">
										No users match this search.
									</td>
								</tr>
							)}
							{users.map((user) => (
								<tr key={user._id}>
									<td>{user.name}</td>
									<td>{user.email}</td>
									<td>
										<span className={`admin-badge ${user.role === "admin" ? "admin-badge--admin" : "admin-badge--user"}`}>
											{user.role}
										</span>
									</td>
									<td>
										<span className={`admin-badge ${user.banned ? "admin-badge--banned" : "admin-badge--active"}`}>
											{user.banned ? "Banned" : "Active"}
										</span>
									</td>
									<td>{user.createdAt ? new Date(user.createdAt).toLocaleDateString() : "—"}</td>

									<td className="admin-users__actions">
										<button
											type="button"
											disabled={pendingRowId === user._id}
											onClick={() => handleRoleToggle(user)}
											title={user.role === "admin" ? "Revoke admin access" : "Grant admin access"}
										>
											{user.role === "admin" ? <ShieldMinusIcon /> : <ShieldPlusIcon />}
											{/* <span>{user.role === "admin" ? "Revoke admin" : "Make admin"}</span> */}
										</button>
										<button
											type="button"
											disabled={pendingRowId === user._id}
											onClick={() => (user.banned ? handleUnban(user) : openBanDialog(user))}
											title={user.banned ? "Restore account access" : "Suspend this account"}
										>
											{user.banned ? <CheckCircleIcon /> : <BanIcon />}
											{/* <span>{user.banned ? "Unban" : "Ban"}</span> */}
										</button>
										<button
											type="button"
											className="admin-users__delete"
											disabled={pendingRowId === user._id}
											onClick={() => openDeleteDialog(user)}
											title="Permanently delete this account"
										>
											<TrashIcon />
											{/* <span>Delete</span> */}
										</button>
									</td>
									<td>{user.tokensUsed ?? 0}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<div className="admin-pagination">
				<button type="button" disabled={pagination.page <= 1} onClick={() => loadUsers(pagination.page - 1, search)}>
					Previous
				</button>
				<span>
					Page {pagination.page} of {pagination.totalPages}
				</span>
				<button
					type="button"
					disabled={pagination.page >= pagination.totalPages}
					onClick={() => loadUsers(pagination.page + 1, search)}
				>
					Next
				</button>
			</div>

			{dialog ? (
				<ConfirmDialog
					title={dialog.title}
					description={dialog.description}
					confirmLabel={dialog.confirmLabel}
					tone={dialog.tone}
					inputLabel={dialog.inputLabel}
					onConfirm={handleDialogConfirm}
					onCancel={() => setDialog(null)}
				/>
			) : null}

			{toast ? <Toast message={toast.message} tone={toast.tone} onDismiss={() => setToast(null)} /> : null}
		</div>
	);
}

export default AdminUsersTab;