//front-end/src/main.jsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

if (import.meta.env.DEV) {
	const originalConsoleError = console.error;
	console.error = (...args) => {
		const isBfcacheHmrNotice = typeof args[0] === "string" && args[0].includes("Page entered Back-Forward Cache");
		if (isBfcacheHmrNotice) {
			return;
		}
		originalConsoleError(...args);
	};
}

if (typeof window !== "undefined") {
	window.addEventListener("pageshow", (event) => {
		if (event.persisted) {
			window.location.reload();
		}
	});
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
