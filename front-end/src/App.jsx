//front-end/src/App.jsx
import "./App.css";
import { useEffect, useState } from "react";
import UserChatPage from "./pages/User/ChatPage";
import AdminPage from "./pages/Admin/AdminPage";

function App() {
	const [pathname, setPathname] = useState(window.location.pathname);

	useEffect(() => {
		const handlePopState = () => {
			const nextPath = window.location.pathname;
			if (!nextPath.startsWith("/admin")) {
				try {
					sessionStorage.removeItem("quantic_admin_access_granted");
				} catch {
					// ignore
				}
			}
			setPathname(nextPath);
		};

		window.addEventListener("popstate", handlePopState);
		return () => window.removeEventListener("popstate", handlePopState);
	}, []);

	if (pathname.startsWith("/admin")) {
		return <AdminPage />;
	}

	return <UserChatPage />;
}

export default App;