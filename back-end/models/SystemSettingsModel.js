//back-end/models/SystemSettingsModel.js
const mongoose = require("mongoose");

const systemSettingsSchema = new mongoose.Schema(
	{
		_id: { type: String, default: "global" },
		features: {
			webSearch: { type: Boolean, default: true },
			imageGeneration: { type: Boolean, default: true },
			memory: { type: Boolean, default: true },
			registrationOpen: { type: Boolean, default: true },
		},
		model: {
			chatModel: { type: String, default: "openai/gpt-oss-120b" },
			maxTokens: { type: Number, default: 4096 },
		},
		maintenance: {
			enabled: { type: Boolean, default: false },
			message: {
				type: String,
				default: "Quantic is currently undergoing maintenance. Please check back shortly.",
			},
		},
		announcement: {
			enabled: { type: Boolean, default: false },
			messages: { type: [mongoose.Schema.Types.Mixed], default: [] },
		},
		moderation: {
			enabled: { type: Boolean, default: false },
			bannedWords: { type: [String], default: [] },
		},
		security: {
			sessionsRevokedAt: { type: Date, default: null },
		},
		updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
	},
	{ timestamps: true }
);

const SystemSettings = mongoose.model("SystemSettings", systemSettingsSchema);

const getSystemSettings = async () => {
	let settings = await SystemSettings.findById("global");

	if (!settings) {
		settings = await SystemSettings.create({ _id: "global" });
	}

	return settings;
};

module.exports = SystemSettings;
module.exports.getSystemSettings = getSystemSettings;