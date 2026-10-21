// front-end/src/services/authToken.js
const TOKEN_KEY = "quantic_auth_token";
const API_ORIGIN = (import.meta.env?.VITE_API_URL || "http://localhost:8000").replace(/\/+$/, "");
const TOKEN_ISSUING_PATHS = ["/api/auth/login", "/api/auth/verify-login-otp"];
const TOKEN_CLEARING_PATHS = ["/api/auth/logout", "/api/auth/delete-account"];

export const getAuthToken = () => {
	try {
		return window.localStorage.getItem(TOKEN_KEY) || "";
	} catch {
		return "";
	}
};

export const setAuthToken = (token) => {
	try {
		window.localStorage.setItem(TOKEN_KEY, String(token));
	} catch {
		// storage blocked: the cookie (where the browser allows it) still works
	}
};

export const clearAuthToken = () => {
	try {
		window.localStorage.removeItem(TOKEN_KEY);
	} catch {
		// ignore
	}
};

const parseUrl = (input) => {
	try {
		const raw = typeof input === "string" ? input : input?.url || String(input);
		return new URL(raw, window.location.href);
	} catch {
		return null;
	}
};

const isApiRequest = (url) => {
	if (!url || !url.pathname.startsWith("/api/")) {
		return false;
	}

	try {
		return url.origin === new URL(API_ORIGIN).origin || url.origin === window.location.origin;
	} catch {
		return url.origin === window.location.origin;
	}
};

export function installAuthFetch() {
	if (typeof window === "undefined" || window.__quanticAuthFetchInstalled) {
		return;
	}

	window.__quanticAuthFetchInstalled = true;
	const nativeFetch = window.fetch.bind(window);

	window.fetch = async (input, init = {}) => {
		const url = parseUrl(input);

		if (!isApiRequest(url)) {
			return nativeFetch(input, init);
		}

		const token = getAuthToken();
		let nextInit = init;

		if (token) {
			const headers = new Headers(init?.headers || (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined));

			if (!headers.has("Authorization")) {
				headers.set("Authorization", `Bearer ${token}`);
			}

			nextInit = { ...init, headers };
		}

		const response = await nativeFetch(input, nextInit);

		try {
			if (response.ok && TOKEN_ISSUING_PATHS.includes(url.pathname)) {
				const data = await response.clone().json().catch(() => null);

				if (data?.token) {
					setAuthToken(data.token);
				}
			} else if (TOKEN_CLEARING_PATHS.includes(url.pathname) && response.ok) {
				clearAuthToken();
			} else if (response.status === 401 && token) {
				// The stored token expired or was revoked (for example "log out of all sessions").
				clearAuthToken();
			}
		} catch {
			// never let bookkeeping break a request
		}

		return response;
	};
}
