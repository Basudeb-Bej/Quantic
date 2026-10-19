// front-end/src/pages/User/Settings.jsx
import { useEffect, useState } from "react";
import AppearanceSettings from "./AppearanceSettings";

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

const apiBaseUrl = (import.meta.env.VITE_API_URL || "http://localhost:8000").replace(/\/+$/, "");

const defaultSettings = {
    displayName: "",
    username: "",
    email: "",
    description: "",
    profileImage: "",
    emailNotifications: true,
    loginAlerts: true,
    twoFactorEnabled: false,
    saveConversationHistory: true,
    compactSidebar: false,
    reduceMotion: false,
    shareUsageData: false,
    responseStyle: "balanced",
};

const passwordDefaults = {
    currentPassword: "",
    newPassword: "",
    confirmPassword: "",
};

const passwordVisibilityDefaults = {
    currentPassword: false,
    newPassword: false,
    confirmPassword: false,
};

const responseStyleOptions = [
    {
        value: "focused",
        label: "Focused",
        description: "Short, direct answers with tighter structure.",
    },
    {
        value: "balanced",
        label: "Balanced",
        description: "A mix of clarity, detail, and context.",
    },
    {
        value: "exploratory",
        label: "Exploratory",
        description: "Broader answers with more background and options.",
    },
];

const securityToggleOptions = [
    {
        key: "loginAlerts",
        title: "Login alerts",
        description: "Get notified when a new browser signs in.",
    },
    {
        key: "twoFactorEnabled",
        title: "Two-factor authentication",
        description: "Add an extra verification step at sign in.",
    },
];

const feedbackToggleOptions = [
    {
        key: "bugReport",
        title: "Bug report",
        description: "Tell the Quantic team when something is broken.",
    },
    {
        key: "featureRequest",
        title: "Feature request",
        description: "Request a new capability or workflow improvement.",
    },
    {
        key: "uxFeedback",
        title: "UX feedback",
        description: "Share a design, layout, or usability suggestion.",
    },
];

const getInitialSettings = (user) => ({
    ...defaultSettings,
    ...(user?.settings || {}),
    displayName: user?.settings?.displayName || user?.name || "Quantic user",
    username: user?.settings?.username || user?.username || user?.email?.split("@")[0] || "",
    email: user?.email || "",
    description: user?.settings?.description || user?.description || "",
    profileImage: user?.settings?.profileImage || user?.avatarUrl || "",
});

const getDisplayName = (user) => user?.settings?.displayName || user?.name || "your account";

const formatSavedAt = (timestamp) => {
    if (!timestamp) {
        return "";
    }

    return new Intl.DateTimeFormat("en", {
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(timestamp));
};

const buildProfileSettings = (user, draftSettings, profileImage) => ({
    ...draftSettings,
    displayName: draftSettings.displayName.trim() || user?.name || "Quantic user",
    username: draftSettings.username.trim() || user?.username || "",
    email: user?.email || draftSettings.email.trim() || "",
    description: draftSettings.description.trim(),
    profileImage,
});

const getSecuritySummaryOptions = (draftSettings) => [
    {
        label: "Last sign-in",
        value: "Just now",
    },
    {
        label: "Security score",
        value: draftSettings.twoFactorEnabled ? "Strong" : "Needs review",
    },
    {
        label: "Protected chats",
        value: draftSettings.saveConversationHistory ? "Enabled" : "Limited",
    },
];

const computeSecurityScore = (settings) => {
    let score = 35;
    if (settings.twoFactorEnabled) score += 35;
    if (settings.loginAlerts) score += 20;
    if (settings.saveConversationHistory) score += 10;
    return Math.min(100, score);
};

const describeSecurityToggleChange = (key, value) => {
    const labels = {
        loginAlerts: "Login alerts",
        twoFactorEnabled: "Two-factor authentication",
    };
    const label = labels[key] || "Security setting";
    return `${label} ${value ? "enabled" : "disabled"}.`;
};

const describeProfileChanges = (previous, next) => {
    const changedFields = [];
    if (previous.displayName !== next.displayName) changedFields.push("display name");
    if (previous.description !== next.description) changedFields.push("description");
    if (previous.profileImage !== next.profileImage) changedFields.push("avatar");
    if (previous.username !== next.username) changedFields.push("username");

    if (changedFields.length === 0) return "Profile saved.";
    if (changedFields.length === 1) {
        return `${changedFields[0][0].toUpperCase()}${changedFields[0].slice(1)} updated.`;
    }
    return `Updated ${changedFields.join(", ")}.`;
};

const getFeedbackSummaryOptions = (feedbackDraft) => {
    const selectedTopics = feedbackToggleOptions.filter((option) => feedbackDraft[option.key]);

    return [
        {
            label: "Selected topics",
            value: selectedTopics.length > 0 ? selectedTopics.map((option) => option.title).join(", ") : "General feedback",
        },
        {
            label: "Message length",
            value: `${feedbackDraft.message.trim().length} chars`,
        },
        {
            label: "Delivery",
            value: feedbackDraft.message.trim() ? "Ready to send" : "Add a message",
        },
    ];
};

const MAX_PROFILE_IMAGE_SIZE = 256;

const compressProfileImage = (source) =>
    new Promise((resolve, reject) => {
        const image = new Image();

        image.onload = () => {
            const longestSide = Math.max(image.width, image.height);
            const scale = Math.min(1, MAX_PROFILE_IMAGE_SIZE / longestSide);
            const width = Math.max(1, Math.round(image.width * scale));
            const height = Math.max(1, Math.round(image.height * scale));
            const canvas = document.createElement("canvas");
            const context = canvas.getContext("2d");

            if (!context) {
                reject(new Error("Unable to process profile image."));
                return;
            }

            canvas.width = width;
            canvas.height = height;
            context.fillStyle = "#050c18";
            context.fillRect(0, 0, width, height);
            context.drawImage(image, 0, 0, width, height);

            try {
                resolve(canvas.toDataURL("image/jpeg", 0.86));
            } catch (error) {
                reject(error);
            }
        };

        image.onerror = () => reject(new Error("Unable to process profile image."));
        image.src = source;
    });

const readJsonResponse = async (response) => {
    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("application/json")) {
        return null;
    }

    try {
        return await response.json();
    } catch {
        return null;
    }
};

function SettingsPage({ user, onBackToChat, onLogout, onProfileUpdate, onAccountDeleted, showToast }) {
    const [draftSettings, setDraftSettings] = useState(defaultSettings);
    const [savedSettings, setSavedSettings] = useState(defaultSettings);
    const [passwordDraft, setPasswordDraft] = useState(passwordDefaults);
    const [passwordVisibility, setPasswordVisibility] = useState(passwordVisibilityDefaults);
    const [profileMessage, setProfileMessage] = useState("");
    const [passwordMessage, setPasswordMessage] = useState("");
    const [securityMessage, setSecurityMessage] = useState("");
    const [feedbackDraft, setFeedbackDraft] = useState({
        message: "",
        bugReport: false,
        featureRequest: false,
        uxFeedback: false,
    });
    const [feedbackMessage, setFeedbackMessage] = useState("");
    const [feedbackSending, setFeedbackSending] = useState(false);
    const [profilePreview, setProfilePreview] = useState("");
    const [lastSavedAt, setLastSavedAt] = useState(null);
    const [loadingSettings, setLoadingSettings] = useState(true);
    const [savingSettings, setSavingSettings] = useState(false);
    const [savingPassword, setSavingPassword] = useState(false);
    const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
    const [deleteAccountMessage, setDeleteAccountMessage] = useState("");
    const [deletionScheduledAt, setDeletionScheduledAt] = useState(null);
    const [deleteAccountPending, setDeleteAccountPending] = useState(false);
    const [cancelDeletionPending, setCancelDeletionPending] = useState(false);

    const syncProfileUpdate = (nextProfile) => {
        if (typeof onProfileUpdate !== "function") {
            return;
        }

        onProfileUpdate({
            ...user,
            name: nextProfile.displayName || user?.name || "Quantic user",
            username: nextProfile.username,
            email: nextProfile.email,
            description: nextProfile.description,
            avatarUrl: nextProfile.profileImage,
            settings: nextProfile,
        });
    };

    useEffect(() => {
        let cancelled = false;

        const loadSettings = async () => {
            if (!user?.id || !user?.email) {
                const baseSettings = getInitialSettings(user);

                if (!cancelled) {
                    setDraftSettings(baseSettings);
                    setSavedSettings(baseSettings);
                    setProfilePreview(baseSettings.profileImage || user?.avatarUrl || "");
                    setLastSavedAt(Date.now());
                    setProfileMessage("");
                    setPasswordMessage("");
                    setSecurityMessage("");
                    setFeedbackMessage("");
                    setFeedbackDraft({
                        message: "",
                        bugReport: false,
                        featureRequest: false,
                        uxFeedback: false,
                    });
                    setLoadingSettings(false);
                }

                return;
            }

            try {
                const response = await fetch(`${apiBaseUrl}/api/auth/settings`, {
                    credentials: "include",
                });

                const responseData = await readJsonResponse(response);

                if (!response.ok) {
                    throw new Error(responseData?.message || "Unable to load settings.");
                }

                const nextSettings = responseData?.settings || getInitialSettings(responseData?.user || user);

                if (!cancelled) {
                    const savedAt = responseData?.updatedAt || responseData?.user?.updatedAt || Date.now();

                    setDraftSettings(nextSettings);
                    setSavedSettings(nextSettings);
                    setProfilePreview(nextSettings.profileImage || responseData?.user?.avatarUrl || user?.avatarUrl || "");
                    setLastSavedAt(savedAt ? new Date(savedAt).getTime() : Date.now());
                    setProfileMessage("");
                    setPasswordMessage("");
                    setSecurityMessage("");
                    setDeletionScheduledAt(responseData?.user?.markedForDeletionAt || null);
                }
            } catch {
                const baseSettings = getInitialSettings(user);

                if (!cancelled) {
                    setDraftSettings(baseSettings);
                    setSavedSettings(baseSettings);
                    setProfilePreview(baseSettings.profileImage || user?.avatarUrl || "");
                    setLastSavedAt(Date.now());
                    setProfileMessage("");
                    setPasswordMessage("");
                    setSecurityMessage("");
                    setFeedbackMessage("");
                    setFeedbackDraft({
                        message: "",
                        bugReport: false,
                        featureRequest: false,
                        uxFeedback: false,
                    });
                }
            } finally {
                if (!cancelled) {
                    setLoadingSettings(false);
                }
            }
        };

        loadSettings();

        return () => {
            cancelled = true;
        };
    }, [user?.avatarUrl, user?.email, user?.name, user?.settings, user?.username]);

    const hasUnsavedChanges = JSON.stringify(draftSettings) !== JSON.stringify(savedSettings);
    const activeResponseStyle = responseStyleOptions.find((option) => option.value === draftSettings.responseStyle) || responseStyleOptions[1];
    const activePreferencesCount = [
        draftSettings.emailNotifications,
        draftSettings.loginAlerts,
        draftSettings.twoFactorEnabled,
        draftSettings.saveConversationHistory,
        draftSettings.compactSidebar,
        draftSettings.reduceMotion,
        draftSettings.shareUsageData,
    ].filter(Boolean).length;
    const displayInitial = (draftSettings.displayName || user?.name || "Q").charAt(0).toUpperCase();

    const updateSetting = (key, value) => {
        setDraftSettings((current) => ({
            ...current,
            [key]: value,
        }));
        setProfileMessage("");
        setPasswordMessage("");
        setSecurityMessage("");
    };

    const updateFeedbackDraft = (key, value) => {
        setFeedbackDraft((current) => ({
            ...current,
            [key]: value,
        }));
        setFeedbackMessage("");
    };

    const handleSecurityToggleChange = async (key, value) => {
        const nextDraft = { ...draftSettings, [key]: value };
        const nextProfile = buildProfileSettings(user, nextDraft, draftSettings.profileImage);

        setDraftSettings(nextDraft);
        setSecurityMessage("");
        await saveProfileSettings(nextProfile, describeSecurityToggleChange(key, value));
    };

    const saveProfileSettings = async (nextProfile, successMessage = "Settings saved.") => {
        setSavingSettings(true);
        setProfileMessage("");

        try {
            const response = await fetch(`${apiBaseUrl}/api/auth/settings`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify(nextProfile),
            });

            const responseData = await readJsonResponse(response);

            if (!response.ok) {
                throw new Error(responseData?.message || "Unable to save settings.");
            }

            const savedProfile = responseData?.settings || nextProfile;
            const savedUser = responseData?.user || {
                ...user,
                name: savedProfile.displayName || user?.name,
                email: user?.email || savedProfile.email,
                avatarUrl: savedProfile.profileImage || user?.avatarUrl || "",
                settings: savedProfile,
            };

            const savedAt = responseData?.updatedAt || responseData?.user?.updatedAt || Date.now();

            setDraftSettings(savedProfile);
            setSavedSettings(savedProfile);
            setProfilePreview(savedProfile.profileImage || savedUser.avatarUrl || "");
            setLastSavedAt(savedAt ? new Date(savedAt).getTime() : Date.now());
            setProfileMessage(successMessage);
            setPasswordMessage("");
            setSecurityMessage("");
            syncProfileUpdate(savedUser);

            // Show toast notification, scoped to the Settings page only
            if (typeof showToast === 'function') {
                showToast(successMessage, { type: "success", scope: "settings" });
            }
        } catch (error) {
            setProfileMessage(error instanceof Error ? error.message : "Unable to save settings.");
            if (typeof showToast === 'function') {
                showToast(error instanceof Error ? error.message : "Unable to save settings.", { type: "error", scope: "settings" });
            }
        } finally {
            setSavingSettings(false);
        }
    };

    const handleImageUpload = (event) => {
        const file = event.target.files?.[0];
        if (!file) {
            return;
        }

        const reader = new FileReader();
        reader.onload = async () => {
            const result = typeof reader.result === "string" ? reader.result : "";

            try {
                const resizedImage = await compressProfileImage(result);
                const nextProfile = buildProfileSettings(user, draftSettings, resizedImage);

                setProfilePreview(resizedImage);
                await saveProfileSettings(nextProfile, "Profile image updated.");
            } catch {
                const nextProfile = buildProfileSettings(user, draftSettings, result);

                setProfilePreview(result);
                await saveProfileSettings(nextProfile, "Profile image updated.");
            }
        };
        reader.readAsDataURL(file);
        event.target.value = "";
    };

    // const handleProfileSave = async () => {
    //     const nextProfile = buildProfileSettings(user, draftSettings, draftSettings.profileImage);
    //     await saveProfileSettings(nextProfile);
    // };

    const handleProfileSave = async () => {
        const nextProfile = buildProfileSettings(user, draftSettings, draftSettings.profileImage);
        await saveProfileSettings(nextProfile, describeProfileChanges(savedSettings, nextProfile));
    };

    const handleProfileReset = () => {
        const revertedProfile = {
            ...savedSettings,
            email: user?.email || savedSettings.email || "",
        };

        setDraftSettings(revertedProfile);
        setProfilePreview(revertedProfile.profileImage || user?.avatarUrl || "");
        syncProfileUpdate(revertedProfile);
        setProfileMessage("Changes discarded.");
        setPasswordMessage("");
        setSecurityMessage("");
    };

    const handlePasswordSave = async (event) => {
        event.preventDefault();

        if (!passwordDraft.currentPassword || !passwordDraft.newPassword || !passwordDraft.confirmPassword) {
            setPasswordMessage("Fill in all password fields.");
            if (typeof showToast === 'function') {
                showToast("Fill in all password fields.", { type: "warning", scope: "settings" });
            }
            return;
        }

        if (passwordDraft.newPassword !== passwordDraft.confirmPassword) {
            setPasswordMessage("New password and confirmation do not match.");
            if (typeof showToast === 'function') {
                showToast("New password and confirmation do not match.", { type: "error", scope: "settings" });
            }
            return;
        }

        if (passwordDraft.newPassword.length < 6) {
            setPasswordMessage("Use at least 6 characters for the new password.");
            if (typeof showToast === 'function') {
                showToast("Use at least 6 characters for the new password.", { type: "warning", scope: "settings" });
            }
            return;
        }

        setSavingPassword(true);
        setPasswordMessage("");

        try {
            const response = await fetch(`${apiBaseUrl}/api/auth/password`, {
                method: "PUT",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify({
                    currentPassword: passwordDraft.currentPassword,
                    newPassword: passwordDraft.newPassword,
                }),
            });

            const responseData = await readJsonResponse(response);

            if (!response.ok) {
                throw new Error(responseData?.message || "Unable to update password.");
            }

            setPasswordMessage("Password updated successfully.");
            setPasswordDraft(passwordDefaults);
            setPasswordVisibility(passwordVisibilityDefaults);
            if (typeof showToast === 'function') {
                showToast("Password updated successfully!", { type: "success", scope: "settings" });
            }
        } catch (error) {
            setPasswordMessage(error instanceof Error ? error.message : "Unable to update password.");
            if (typeof showToast === 'function') {
                showToast(error instanceof Error ? error.message : "Unable to update password.", { type: "error", scope: "settings" });
            }
        } finally {
            setSavingPassword(false);
        }
    };

    const togglePasswordVisibility = (field) => {
        setPasswordVisibility((current) => ({
            ...current,
            [field]: !current[field],
        }));
    };

    const renderPasswordField = (fieldId, label, placeholder) => {
        const isVisible = passwordVisibility[fieldId];
        const autoComplete =
            fieldId === "currentPassword"
                ? "current-password"
                : "new-password";

        return (
            <div className="settings-field settings-field--password">
                <label htmlFor={fieldId}>{label}</label>
                <div className="settings-password-input">
                    <input
                        id={fieldId}
                        type={isVisible ? "text" : "password"}
                        value={passwordDraft[fieldId]}
                        onChange={(event) => setPasswordDraft((current) => ({ ...current, [fieldId]: event.target.value }))}
                        placeholder={placeholder}
                        autoComplete={autoComplete}
                    />
                    <button
                        type="button"
                        className="settings-password-toggle"
                        onClick={() => togglePasswordVisibility(fieldId)}
                        aria-label={isVisible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
                        aria-pressed={isVisible}
                    >
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                            {isVisible ? (
                                <>
                                    <path d="M3.5 12s3.5-6 8.5-6 8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                    <circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
                                    <path d="M4.5 4.5 19.5 19.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                                </>
                            ) : (
                                <>
                                    <path d="M3.5 12s3.5-6 8.5-6 8.5 6 8.5 6-3.5 6-8.5 6-8.5-6-8.5-6Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                    <circle cx="12" cy="12" r="2.8" fill="none" stroke="currentColor" strokeWidth="1.8" />
                                </>
                            )}
                        </svg>
                    </button>
                </div>
            </div>
        );
    };

    // const runSecurityCheck = () => {
    //     const checks = [];

    //     checks.push(`Assistant style is set to ${activeResponseStyle.label.toLowerCase()}.`);
    //     checks.push(draftSettings.twoFactorEnabled ? "Two-factor authentication is enabled." : "Two-factor authentication is disabled.");
    //     checks.push(draftSettings.loginAlerts ? "Login alerts are enabled." : "Login alerts are disabled.");
    //     checks.push(draftSettings.reduceMotion ? "Reduced motion is enabled." : "Animations are enabled.");
    //     checks.push(passwordDraft.newPassword ? "A password change is staged." : "No password change pending.");

    //     setSecurityMessage(checks.join(" "));
    // };

    const runSecurityCheck = () => {
        const score = computeSecurityScore(draftSettings);
        const checks = [`Security score: ${score}/100.`];

        checks.push(draftSettings.twoFactorEnabled ? "Two-factor authentication is on." : "Two-factor authentication is off — turn it on for stronger protection.");
        checks.push(draftSettings.loginAlerts ? "Login alerts are on." : "Login alerts are off — you won't be notified of new sign-ins.");
        checks.push(draftSettings.saveConversationHistory ? "Chat history is saved to your account." : "Chat history saving is limited.");
        checks.push(lastSavedAt ? `Settings last saved ${formatSavedAt(lastSavedAt)}.` : "Settings have not been saved yet.");

        setSecurityMessage(checks.join(" "));

        if (typeof showToast === 'function') {
            showToast(`Security check complete — score ${score}/100.`, { type: score >= 80 ? "success" : "warning", scope: "settings" });
        }
    };

    const openDeleteAccountPopup = () => {
        setDeleteAccountMessage("");
        setDeleteAccountOpen(true);
    };

    const closeDeleteAccountPopup = () => {
        setDeleteAccountOpen(false);
    };

    // const confirmDeleteAccount = async () => {
    //     if (deleteAccountPending) {
    //         return;
    //     }

    //     setDeleteAccountPending(true);

    //     try {
    //         const response = await fetch(`${apiBaseUrl}/api/auth/delete-account`, {
    //             method: "POST",
    //             credentials: "include",
    //         });

    //         const responseData = await readJsonResponse(response);

    //         if (!response.ok) {
    //             throw new Error(responseData?.message || "Unable to schedule account deletion.");
    //         }

    //         setDeleteAccountMessage("After 1 hour your account will be permanently deleted from Quantic.");
    //         setDeleteAccountOpen(false);
    //         setDeletionScheduledAt(responseData?.deletionDate || null);
    //         if (typeof showToast === 'function') {
    //             const deletionTime = deletionScheduledAt ? new Date(deletionScheduledAt).toLocaleString() : "in 1 hour";
    //             showToast(`Account deletion scheduled for ${deletionTime}. You can cancel before then.`, { type: "warning", scope: "settings" });
    //         }
    //     } catch (error) {
    //         setDeleteAccountMessage(error instanceof Error ? error.message : "Unable to schedule account deletion.");
    //         if (typeof showToast === 'function') {
    //             showToast(error instanceof Error ? error.message : "Unable to schedule account deletion.", { type: "error", scope: "settings" });
    //         }
    //     } finally {
    //         setDeleteAccountPending(false);
    //     }
    // };

const confirmDeleteAccount = async () => {
        if (deleteAccountPending) {
            return;
        }

        setDeleteAccountPending(true);

        try {
            const response = await fetch(`${apiBaseUrl}/api/auth/delete-account`, {
                method: "POST",
                credentials: "include",
            });

            const responseData = await readJsonResponse(response);

            if (!response.ok) {
                throw new Error(responseData?.message || "Unable to schedule account deletion.");
            }

            setDeleteAccountMessage("After 1 hour your account will be permanently deleted from Quantic.");
            setDeleteAccountOpen(false);
            setDeletionScheduledAt(responseData?.deletionDate || null);
            if (typeof onAccountDeleted === 'function') {
                onAccountDeleted();
            }
        } catch (error) {
            setDeleteAccountMessage(error instanceof Error ? error.message : "Unable to schedule account deletion.");
            if (typeof showToast === 'function') {
                showToast(error instanceof Error ? error.message : "Unable to schedule account deletion.", { type: "error", scope: "settings" });
            }
        } finally {
            setDeleteAccountPending(false);
        }
    };

    const cancelAccountDeletion = async () => {
        if (cancelDeletionPending) {
            return;
        }

        setCancelDeletionPending(true);

        try {
            const response = await fetch(`${apiBaseUrl}/api/auth/cancel-deletion`, {
                method: "POST",
                credentials: "include",
            });

            const responseData = await readJsonResponse(response);

            if (!response.ok) {
                throw new Error(responseData?.message || "Unable to cancel account deletion.");
            }

            setDeletionScheduledAt(null);
            setDeleteAccountMessage("");
            if (typeof showToast === 'function') {
                showToast("Account deletion has been cancelled.", { type: "success", scope: "settings" });
            }
        } catch (error) {
            if (typeof showToast === 'function') {
                showToast(error instanceof Error ? error.message : "Unable to cancel account deletion.", { type: "error", scope: "settings" });
            }
        } finally {
            setCancelDeletionPending(false);
        }
    };

    const runFeedbackCheck = async () => {
        const message = feedbackDraft.message.trim();
        const selectedTopics = feedbackToggleOptions
            .filter((option) => feedbackDraft[option.key])
            .map((option) => option.title);

        if (!message) {
            setFeedbackMessage("Write a message for the Quantic team first.");
            if (typeof showToast === 'function') {
                showToast("Write a message for the Quantic team first.", { type: "warning", scope: "settings" });
            }
            return;
        }

        setFeedbackSending(true);
        setFeedbackMessage("");

        try {
            const response = await fetch(`${apiBaseUrl}/api/auth/feedback`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                credentials: "include",
                body: JSON.stringify({
                    message,
                    topics: selectedTopics,
                }),
            });

            const responseData = await readJsonResponse(response);

            if (!response.ok) {
                throw new Error(responseData?.message || "Unable to send feedback.");
            }

            setFeedbackMessage(responseData?.message || "Feedback sent to the Quantic team.");
            setFeedbackDraft({
                message: "",
                bugReport: false,
                featureRequest: false,
                uxFeedback: false,
            });
            if (typeof showToast === 'function') {
                showToast("Feedback sent successfully!", { type: "success", scope: "settings" });
            }
        } catch (error) {
            setFeedbackMessage(error instanceof Error ? error.message : "Unable to send feedback.");
            if (typeof showToast === 'function') {
                showToast(error instanceof Error ? error.message : "Unable to send feedback.", { type: "error", scope: "settings" });
            }
        } finally {
            setFeedbackSending(false);
        }
    };

    const saveLabel = savingSettings ? "Saving..." : hasUnsavedChanges ? "Save changes" : "Saved";

    return (
        <section className="settings-page" aria-label="User settings">
            <div className="settings-page__hero">
                <div className="settings-page__hero-copy">
                    <p className="settings-page__eyebrow">Account preferences</p>
                    <h1>Settings</h1>
                    <p>
                        Update your profile, email, password, and security options for {getDisplayName(user)}.
                    </p>
                    <p>
                        {loadingSettings
                            ? "Loading your saved settings from the account database..."
                            : lastSavedAt
                                ? `Last saved ${formatSavedAt(lastSavedAt)}.`
                                : "Your settings are stored in your account."}
                    </p>
                </div>

                <div className="settings-page__hero-actions">
                    {/* <button type="button" className="workspace__link-button" onClick={onBackToChat}>
                        Back to chat
                    </button> */}
                    <button type="button" className="workspace__link-button" onClick={handleProfileReset} disabled={!hasUnsavedChanges}>
                        Discard changes
                    </button>
                    <button type="button" className="workspace__primary-button" onClick={handleProfileSave} disabled={!hasUnsavedChanges || loadingSettings || savingSettings}>
                        {saveLabel}
                    </button>
                </div>
            </div>

            <div className="settings-grid">
                <section className="settings-card settings-card--profile">
                    <div className="settings-card__header">
                        <div>
                            <p className="settings-card__label">Profile</p>
                            <h2 className="settings-card__title--small">{getDisplayName(user)}</h2>
                            <p className="settings-card__subtext">
                                {draftSettings.description.trim() || "Add a description to your profile."}
                            </p>
                        </div>
                        <div className="settings-card__avatar-shell">
                            <div className="settings-card__avatar settings-card__avatar--photo" aria-hidden="true">
                                {profilePreview ? <img src={profilePreview} alt="" /> : UserIcon()}
                            </div>
                            <label className="settings-card__avatar-action" htmlFor="profileImage" aria-label="Change profile picture">
                                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                    <path d="M4 7h3l2-3h6l2 3h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                                    <circle cx="12" cy="13" r="3.25" fill="none" stroke="currentColor" strokeWidth="1.8" />
                                </svg>
                            </label>
                        </div>
                    </div>

                    <input id="profileImage" className="settings-upload__input" type="file" accept="image/*" onChange={handleImageUpload} />
                    {/* <p className="settings-upload__hint">PNG, JPG, or WEBP. Stored locally in this browser.</p> */}

                    <div className="settings-field settings-field--split">
                        <label htmlFor="displayName">Display name</label>
                        <input
                            id="displayName"
                            type="text"
                            value={draftSettings.displayName}
                            onChange={(event) => updateSetting("displayName", event.target.value)}
                            placeholder="Your display name"
                        />
                    </div>

                    <div className="settings-field settings-field--split">
                        <label htmlFor="email">Email address</label>
                        <input
                            id="email"
                            type="email"
                            value={draftSettings.email}
                            readOnly
                            placeholder="name@example.com"
                        />
                    </div>

                    <div className="settings-field settings-field--split">
                        <label htmlFor="description">Description</label>
                        <input
                            id="description"
                            type="text"
                            value={draftSettings.description}
                            onChange={(event) => updateSetting("description", event.target.value)}
                            placeholder="Describe yourself in a few words"
                        />
                    </div>

                    <ul className="settings-summary">
                        <li>
                            <span>Display name</span>
                            <strong>{draftSettings.displayName || "Quantic user"}</strong>
                        </li>
                        <li>
                            <span>Username</span>
                            <strong>{draftSettings.username || "Not set"}</strong>
                        </li>
                        <li>
                            <span>Avatar</span>
                            <strong>{draftSettings.profileImage ? "Custom image" : "Initials"}</strong>
                        </li>
                    </ul>

                    {/* {profileMessage ? <p className="settings-card__status">{profileMessage}</p> : null} */}
                </section>

                <section className="settings-card settings-card--security settings-card--security-form settings-card--password">
                    <div className="settings-card__header">
                        <div>
                            <p className="settings-card__label">Password</p>
                            <h2>Change password</h2>
                        </div>
                    </div>

                    <form className="settings-form" onSubmit={handlePasswordSave}>
                        <input
                            type="text"
                            name="username"
                            autoComplete="username"
                            value={draftSettings.username || user?.username || user?.email || ""}
                            readOnly
                            tabIndex={-1}
                            aria-hidden="true"
                            style={{
                                position: "absolute",
                                width: 1,
                                height: 1,
                                margin: -1,
                                border: 0,
                                padding: 0,
                                clip: "rect(0 0 0 0)",
                                clipPath: "inset(50%)",
                                overflow: "hidden",
                                whiteSpace: "nowrap",
                            }}
                        />

                        {renderPasswordField("currentPassword", "Current password", "Current password")}

                        {renderPasswordField("newPassword", "New password", "New password")}

                        {renderPasswordField("confirmPassword", "Confirm password", "Confirm new password")}

                        <div className="settings-card__actions settings-card__actions--left">
                            <button type="submit" className="workspace__primary-button" disabled={savingPassword}>
                                {savingPassword ? "Updating..." : "Update password"}
                            </button>
                        </div>

                        {/* {passwordMessage ? <p className="settings-card__status">{passwordMessage}</p> : null} */}
                    </form>
                </section>

                <section className="settings-card settings-card--security">
                    <div className="settings-card__header">
                        <div>
                            <p className="settings-card__label">Security</p>
                        </div>
                    </div>

                    <div className="settings-switches">
                        {securityToggleOptions.map((option) => (
                            <label key={option.key} className="settings-switch">
                                <span>
                                    <strong>{option.title}</strong>
                                    <small>{option.description}</small>
                                </span>
                                <input
                                    type="checkbox"
                                    checked={draftSettings[option.key]}
                                    disabled={savingSettings}
                                    onChange={(event) => handleSecurityToggleChange(option.key, event.target.checked)}
                                />
                            </label>
                        ))}
                    </div>

                    <div className="settings-card__actions-row">
                        <button type="button" className="workspace__link-button settings-card__secondary-action" onClick={runSecurityCheck}>
                            Run security check
                        </button>

                        {/* <button
                            type="button"
                            className="workspace__link-button settings-card__secondary-action settings-card__secondary-action--danger"
                            onClick={openDeleteAccountPopup}
                            disabled={deleteAccountPending}
                        >
                            {deleteAccountPending ? "Scheduling..." : "Delete account"}
                        </button> */}

                        {deletionScheduledAt ? (
                            <button
                                type="button"
                                className="workspace__link-button settings-card__secondary-action"
                                onClick={cancelAccountDeletion}
                                disabled={cancelDeletionPending}
                            >
                                {cancelDeletionPending ? "Cancelling..." : "Cancel account deletion"}
                            </button>
                        ) : (
                            <button
                                type="button"
                                className="workspace__link-button settings-card__secondary-action settings-card__secondary-action--danger"
                                onClick={openDeleteAccountPopup}
                                disabled={deleteAccountPending}
                            >
                                {deleteAccountPending ? "Scheduling..." : "Delete account"}
                            </button>
                        )}

                    </div>

                    {/* {deletionScheduledAt ? (
                        <p className="settings-card__status">
                            Your account is scheduled for deletion at {new Date(deletionScheduledAt).toLocaleString()}. You can cancel any time before then.
                        </p>
                    ) : null} */}

                    <ul className="settings-summary settings-summary--security">
                        {getSecuritySummaryOptions(draftSettings).map((item) => (
                            <li key={item.label}>
                                <span>{item.label}</span>
                                <strong>{item.value}</strong>
                            </li>
                        ))}
                    </ul>

                </section>

                <section className="settings-card settings-card--feedback">
                    <div className="settings-card__header">
                        <div>
                            <p className="settings-card__label">Feedback</p>
                            <h2>Send a message to the Quantic team</h2>
                        </div>
                    </div>

                    <div className="settings-field settings-field--split">
                        <label htmlFor="feedbackMessage">Message</label>
                        <textarea
                            id="feedbackMessage"
                            value={feedbackDraft.message}
                            onChange={(event) => updateFeedbackDraft("message", event.target.value)}
                            placeholder="Tell the Quantic team what is working, what is broken, or what should change."
                            rows={5}
                        />
                    </div>

                    <button type="button" className="workspace__link-button settings-card__secondary-action" onClick={runFeedbackCheck} disabled={feedbackSending}>
                        {feedbackSending ? "Sending..." : "Send to Quantic team"}
                    </button>
                    {/* {feedbackMessage ? <p className="settings-card__status">{feedbackMessage}</p> : null} */}
                </section>

                <AppearanceSettings showToast={showToast} />
            </div>

            {deleteAccountOpen ? (
                <div className="chat-delete-modal" role="dialog" aria-modal="true" aria-labelledby="delete-account-modal-title" aria-describedby="delete-account-modal-description">
                    <div className="chat-delete-modal__backdrop" onClick={closeDeleteAccountPopup} aria-hidden="true" />
                    <div className="chat-delete-modal__panel">
                        <h2 id="delete-account-modal-title">Delete account?</h2>
                        <p id="delete-account-modal-description" className="chat-delete-modal__lead">
                            This is a permanent account request.
                        </p>
                        <p className="chat-delete-modal__note">
                            After 1 hour your account will be permanently deleted from Quantic.
                        </p>
                        <div className="chat-delete-modal__actions">
                            <button type="button" className="chat-delete-modal__button chat-delete-modal__button--ghost" onClick={closeDeleteAccountPopup}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="chat-delete-modal__button chat-delete-modal__button--danger"
                                onClick={confirmDeleteAccount}
                                disabled={deleteAccountPending}
                            >
                                {deleteAccountPending ? "Scheduling..." : "Delete account"}
                            </button>
                        </div>
                    </div>
                </div>
            ) : null}
        </section>
    );
}

export default SettingsPage;