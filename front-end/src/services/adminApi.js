//front-end/src/services/adminApi.js
const API_ORIGIN = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/+$/, "");
const API_BASE = `${API_ORIGIN}/api`;
const AUTH_API_BASE = API_ORIGIN;

const request = async (path, options = {}) => {
	const response = await fetch(`${API_BASE}/admin${path}`, {
		credentials: "include",
		headers: { "Content-Type": "application/json", ...(options.headers || {}) },
		...options,
	});

	const contentType = response.headers.get("content-type") || "";
	const body = contentType.includes("application/json") ? await response.json().catch(() => null) : null;

	if (!response.ok) {
		throw new Error(body?.message || `Request failed with status ${response.status}`);
	}

	return body;
};

export const fetchUsers = ({ page = 1, limit = 20, search = "" } = {}) => {
	const params = new URLSearchParams({ page: String(page), limit: String(limit) });
	if (search) params.set("search", search);
	return request(`/users?${params.toString()}`);
};

export const fetchUser = (userId) => request(`/users/${userId}`);
export const updateUser = (userId, payload) => request(`/users/${userId}`, { method: "PATCH", body: JSON.stringify(payload) });
export const banUser = (userId, reason = "") => request(`/users/${userId}/ban`, { method: "POST", body: JSON.stringify({ reason }) });
export const unbanUser = (userId) => request(`/users/${userId}/unban`, { method: "POST" });
export const deleteUser = (userId) => request(`/users/${userId}`, { method: "DELETE" });
export const fetchAnalytics = () => request(`/analytics`);
export const fetchSettings = () => request(`/settings`);
export const updateSettings = (payload) => request(`/settings`, { method: "PATCH", body: JSON.stringify(payload) });

export const logoutAdmin = async () => {
	try {
		await fetch(`${AUTH_API_BASE}/api/auth/logout`, {
			method: "POST",
			credentials: "include",
		});
	} catch {
		// Continue with client-side cleanup even if the network call fails.
	}
};

export const fetchCurrentAdmin = async () => {
	const response = await fetch(`${AUTH_API_BASE}/api/auth/me`, { credentials: "include" });
	const contentType = response.headers.get("content-type") || "";
	const body = contentType.includes("application/json") ? await response.json().catch(() => null) : null;

	if (!response.ok) {
		throw new Error(body?.message || `Request failed with status ${response.status}`);
	}

	return body;
};

export const forceLogoutAllSessions = () => request(`/settings/force-logout`, { method: "POST" });