//front-end/src/hooks/useToasts.js
import { useCallback, useRef, useState, useEffect } from "react";

export function useToasts() {
    const [toasts, setToasts] = useState([]);
    const idRef = useRef(0);
    const timersRef = useRef({});

    const dismissToast = useCallback((id) => {
        setToasts((current) => {
            const filtered = current.filter((toast) => toast.id !== id);
            return filtered;
        });
        if (timersRef.current[id]) {
            clearTimeout(timersRef.current[id]);
            delete timersRef.current[id];
        }
    }, []);

    const showToast = useCallback((message, options = {}) => {
        // Early return if message is empty
        const normalizedMessage = String(message ?? "").trim();
        if (!normalizedMessage) {
            console.warn("[useToasts] showToast called with empty message");
            return;
        }

        try {
            const id = `toast-${Date.now()}-${idRef.current}`;
            idRef.current += 1;
            const duration = Number.isFinite(options?.duration) ? options.duration : 3200;
            const type = options?.type || "info";

            // Log for debugging
            console.log("[useToasts] Showing toast:", normalizedMessage, { type, duration });

            setToasts((current) => [...current, { 
                id, 
                message: normalizedMessage, 
                type, 
                duration 
            }]);

            // Auto-dismiss
            if (timersRef.current[id]) {
                clearTimeout(timersRef.current[id]);
            }
            timersRef.current[id] = setTimeout(() => {
                dismissToast(id);
            }, duration);
        } catch (error) {
            console.error("[useToasts] Error showing toast:", error);
        }
    }, [dismissToast]);

    // Cleanup timers on unmount
    useEffect(() => {
        return () => {
            Object.values(timersRef.current).forEach(timer => clearTimeout(timer));
        };
    }, []);

    return { toasts, showToast, dismissToast };
}

export default useToasts;