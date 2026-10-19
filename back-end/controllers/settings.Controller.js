// back-end/controllers/settings.Controller.js
const mongoose = require("mongoose");
const User = require("../models/LoginModel");
const Settings = require("../models/SettingsModel");
const { normalizeUserSettings } = require("../middleware/auth");

const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value ?? ""));

let legacySettingsIndexCleanupPromise = null;

const dropLegacySettingsUserIdIndex = async () => {
	if (legacySettingsIndexCleanupPromise) {
		return legacySettingsIndexCleanupPromise;
	}

	legacySettingsIndexCleanupPromise = (async () => {
		try {
			const indexes = await Settings.collection.indexes();
			const hasLegacyIndex = indexes.some((index) => index?.name === "userId_1");

			if (hasLegacyIndex) {
				await Settings.collection.dropIndex("userId_1");
				console.info("[settings] dropped legacy userId index");
			}
		} catch (error) {
			const message = String(error?.message || error || "");

			if (!/index not found/i.test(message)) {
				console.warn("[settings] legacy index cleanup failed", {
					message,
				});
			}
		}
	})();

	return legacySettingsIndexCleanupPromise;
};

const buildSettingsUser = (user, settings) => ({
	id: user?._id,
	name: user?.name || "",
	email: user?.email || "",
	role: user?.role || "user",
	createdAt: user?.createdAt || null,
	updatedAt: user?.updatedAt || null,
	avatarUrl: settings?.profileImage || "",
	markedForDeletionAt: user?.markedForDeletionAt || null,
	settings: settings || normalizeUserSettings({}, user),
});

const getSettings = async (req, res, next) => {
	try {
		const { userId } = req.auth || {};

		if (!userId) {
			return res.status(401).json({ message: "Not authenticated." });
		}

		await dropLegacySettingsUserIdIndex();

		const user = await User.findById(userId);

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const settingsDocument = await Settings.findById(userId).lean();
		const normalizedSettings = normalizeUserSettings(settingsDocument || {}, user);

		return res.status(200).json({
			settings: normalizedSettings,
			updatedAt: settingsDocument?.updatedAt || user.updatedAt || null,
			user: buildSettingsUser(user, normalizedSettings),
		});
	} catch (error) {
		console.error("[settings] getSettings failed", {
			message: error?.message || String(error),
		});
		return next(error);
	}
};

const updateSettings = async (req, res, next) => {
	try {
		const { userId } = req.auth || {};
		const settingsPayload = req.body || {};

		if (!userId) {
			return res.status(401).json({ message: "Not authenticated." });
		}

		await dropLegacySettingsUserIdIndex();

		const user = await User.findById(userId);

		if (!user) {
			return res.status(404).json({ message: "User not found." });
		}

		const nextSettings = normalizeUserSettings(settingsPayload, user);
		let savedSettingsDocument;

		try {
			savedSettingsDocument = await Settings.findOneAndUpdate(
				{ _id: userId },
				{
					...nextSettings,
					_id: userId,
				},
				{
					upsert: true,
					new: true,
					setDefaultsOnInsert: true,
				}
			);
		} catch (saveError) {
				console.warn("[settings] save failed", {
				userId: String(userId),
				message: saveError?.message || String(saveError),
			});
			return res.status(500).json({ message: "Unable to save settings." });
		}

		user.name = nextSettings.displayName || user.name;
		await user.save();

		return res.status(200).json({
			message: "Settings saved successfully.",
			settings: nextSettings,
			updatedAt: savedSettingsDocument?.updatedAt || user.updatedAt || null,
			user: buildSettingsUser(user, nextSettings),
		});
	} catch (error) {
		console.error("[settings] updateSettings failed", {
			message: error?.message || String(error),
		});
		return next(error);
	}
};

module.exports = {
	getSettings,
	updateSettings,
};
