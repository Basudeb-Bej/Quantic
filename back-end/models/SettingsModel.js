const mongoose = require("mongoose");

const settingsSchema = new mongoose.Schema(
    {
        _id: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },
        displayName: {
            type: String,
            default: "",
            trim: true,
        },
        username: {
            type: String,
            default: "",
            trim: true,
        },
        email: {
            type: String,
            default: "",
            trim: true,
            lowercase: true,
        },
        description: {
            type: String,
            default: "",
            trim: true,
        },
        profileImage: {
            type: String,
            default: "",
        },
        emailNotifications: {
            type: Boolean,
            default: true,
        },
        loginAlerts: {
            type: Boolean,
            default: true,
        },
        twoFactorEnabled: {
            type: Boolean,
            default: false,
        },
        deletionScheduledAt: {
            type: Date,
            default: null,
        },
        saveConversationHistory: {
            type: Boolean,
            default: true,
        },
        compactSidebar: {
            type: Boolean,
            default: false,
        },
        reduceMotion: {
            type: Boolean,
            default: false,
        },
        shareUsageData: {
            type: Boolean,
            default: false,
        },
        responseStyle: {
            type: String,
            enum: ["focused", "balanced", "exploratory", "structured"],
            default: "balanced",
        },
    },
    {
        timestamps: true,
    }
);

module.exports = mongoose.model("Settings", settingsSchema);
