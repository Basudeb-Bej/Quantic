//back-end/controllers/adminController.js
const mongoose = require("mongoose");
const User = require("../models/LoginModel.js");
const Settings = require("../models/SettingsModel.js");
const Chat = require("../models/ChatModel.js");
const Message = require("../models/MessageModel.js");
const { getSystemSettings } = require("../models/SystemSettingsModel.js");
const { sanitizeAnnouncementMessages, normalizeAnnouncementMessages } = require("../utils/announcements.js");

const normalizeText = (value) => String(value ?? "").trim();
const isValidObjectId = (value) => mongoose.Types.ObjectId.isValid(String(value ?? ""));

const parsePagination = (query) => {
	const page = Math.max(1, parseInt(query?.page, 10) || 1);
	const limit = Math.min(100, Math.max(1, parseInt(query?.limit, 10) || 20));
	return { page, limit, skip: (page - 1) * limit };
};

const listUsers = async (req, res) => {
	const { page, limit, skip } = parsePagination(req.query);
	const search = normalizeText(req.query?.search);

	const filter = search
		? {
			$or: [
				{ name: { $regex: search, $options: "i" } },
				{ email: { $regex: search, $options: "i" } },
			],
		}
		: {};

	const [users, total] = await Promise.all([
		User.find(filter)
			.select("name email role banned bannedAt createdAt updatedAt")
			.sort({ createdAt: -1 })
			.skip(skip)
			.limit(limit)
			.lean(),
		User.countDocuments(filter),
	]);

	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);

	const userIds = users.map((user) => user._id);
	let tokensByUserId = new Map();

	if (userIds.length > 0) {
		const tokenUsageAggregate = await Chat.aggregate([
			{ $match: { userId: { $in: userIds } } },
			{
				$lookup: {
					from: Message.collection.name,
					let: { chatId: "$_id" },
					pipeline: [
						{
							$match: {
								$expr: { $eq: ["$chatId", "$$chatId"] },
								createdAt: { $gte: startOfToday },
							},
						},
						{ $project: { length: { $strLenCP: { $ifNull: ["$content", ""] } } } },
					],
					as: "todayMessages",
				},
			},
			{
				$project: {
					userId: 1,
					charsToday: { $sum: "$todayMessages.length" },
				},
			},
			{
				$group: {
					_id: "$userId",
					charsToday: { $sum: "$charsToday" },
				},
			},
		]).catch(() => []);

		tokensByUserId = new Map(
			tokenUsageAggregate.map((entry) => [String(entry._id), Math.ceil((entry.charsToday || 0) / 4)])
		);
	}

	const usersWithTokens = users.map((user) => ({
		...user,
		tokensUsed: tokensByUserId.get(String(user._id)) || 0,
	}));

	return res.json({
		users: usersWithTokens,
		pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
	});
};

const getUser = async (req, res) => {
	const userId = normalizeText(req.params?.userId);

	if (!isValidObjectId(userId)) {
		return res.status(400).json({ message: "Invalid user id." });
	}

	const user = await User.findById(userId)
		.select("name email role banned bannedAt bannedReason createdAt updatedAt")
		.lean();

	if (!user) {
		return res.status(404).json({ message: "User not found." });
	}

	const chatIds = await Chat.find({ userId: user._id }).distinct("_id");
	const [chatCount, messageCount] = await Promise.all([
		Chat.countDocuments({ userId: user._id }),
		Message.countDocuments({ chatId: { $in: chatIds } }),
	]);

	return res.json({ user: { ...user, chatCount, messageCount } });
};

const updateUser = async (req, res) => {
	const userId = normalizeText(req.params?.userId);

	if (!isValidObjectId(userId)) {
		return res.status(400).json({ message: "Invalid user id." });
	}

	const user = await User.findById(userId);

	if (!user) {
		return res.status(404).json({ message: "User not found." });
	}

	const name = normalizeText(req.body?.name);
	const email = normalizeText(req.body?.email).toLowerCase();
	const role = normalizeText(req.body?.role);

	if (name) user.name = name;
	if (email) user.email = email;

	if (role === "admin" || role === "user") {
		if (String(req.auth.userId) === String(user._id) && role !== "admin") {
			return res.status(400).json({ message: "You cannot remove your own admin role." });
		}
		user.role = role;
	}

	await user.save();

	return res.json({
		user: {
			id: user._id,
			name: user.name,
			email: user.email,
			role: user.role,
			banned: user.banned,
		},
	});
};

const banUser = async (req, res) => {
	const userId = normalizeText(req.params?.userId);
	const reason = normalizeText(req.body?.reason);

	if (!isValidObjectId(userId)) {
		return res.status(400).json({ message: "Invalid user id." });
	}

	if (String(req.auth.userId) === userId) {
		return res.status(400).json({ message: "You cannot ban yourself." });
	}

	const user = await User.findByIdAndUpdate(
		userId,
		{ banned: true, bannedAt: new Date(), bannedReason: reason },
		{ new: true }
	).select("name email role banned bannedAt bannedReason");

	if (!user) {
		return res.status(404).json({ message: "User not found." });
	}

	return res.json({ user });
};

const unbanUser = async (req, res) => {
	const userId = normalizeText(req.params?.userId);

	if (!isValidObjectId(userId)) {
		return res.status(400).json({ message: "Invalid user id." });
	}

	const user = await User.findByIdAndUpdate(
		userId,
		{ banned: false, bannedAt: null, bannedReason: "" },
		{ new: true }
	).select("name email role banned bannedAt bannedReason");

	if (!user) {
		return res.status(404).json({ message: "User not found." });
	}

	return res.json({ user });
};

const deleteUser = async (req, res) => {
	const userId = normalizeText(req.params?.userId);

	if (!isValidObjectId(userId)) {
		return res.status(400).json({ message: "Invalid user id." });
	}

	if (String(req.auth.userId) === userId) {
		return res.status(400).json({ message: "You cannot delete your own account." });
	}

	const user = await User.findById(userId);

	if (!user) {
		return res.status(404).json({ message: "User not found." });
	}

	const chatIds = await Chat.find({ userId: user._id }).distinct("_id");
	await Message.deleteMany({ chatId: { $in: chatIds } });
	await Chat.deleteMany({ userId: user._id });
	await Settings.findByIdAndDelete(user._id);
	await User.deleteOne({ _id: user._id });

	return res.status(204).send();
};

const getAnalytics = async (req, res) => {
	const now = new Date();
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
	const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
	const twelveMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 11, 1);

	const [
		totalUsers,
		bannedUsers,
		adminUsers,
		newUsersToday,
		newUsersLast7Days,
		newUsersLast30Days,
		totalChats,
		totalMessages,
		messagesLast7Days,
		signupSeries,
		signupSeriesMonthly,
		messageSeriesMonthly,
		twoFactorEnabledResult,
		loginAlertsDisabledCount,
		fullyProtectedResult,
	] = await Promise.all([
		User.countDocuments({}),
		User.countDocuments({ banned: true }),
		User.countDocuments({ role: "admin" }),
		User.countDocuments({ createdAt: { $gte: startOfToday } }),
		User.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
		User.countDocuments({ createdAt: { $gte: thirtyDaysAgo } }),

		Chat.countDocuments({}),
		Message.countDocuments({ role: "user" }),
		Message.countDocuments({ role: "user", createdAt: { $gte: sevenDaysAgo } }),
		User.aggregate([
			{ $match: { createdAt: { $gte: thirtyDaysAgo } } },
			{
				$group: {
					_id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
					count: { $sum: 1 },
				},
			},
			{ $sort: { _id: 1 } },
		]),
		User.aggregate([
			{ $match: { createdAt: { $gte: twelveMonthsAgo } } },
			{
				$group: {
					_id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
					count: { $sum: 1 },
				},
			},
			{ $sort: { _id: 1 } },
		]),
		Message.aggregate([
			{ $match: { role: "user", createdAt: { $gte: twelveMonthsAgo } } },
			{
				$group: {
					_id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
					count: { $sum: 1 },
				},
			},
			{ $sort: { _id: 1 } },
		]),

		User.aggregate([
			{ $lookup: { from: Settings.collection.name, localField: "_id", foreignField: "_id", as: "settings" } },
			{ $match: { "settings.twoFactorEnabled": true } },
			{ $count: "count" },
		]),
		Settings.countDocuments({ loginAlerts: false }),
		User.aggregate([
			{ $lookup: { from: Settings.collection.name, localField: "_id", foreignField: "_id", as: "settings" } },
			{
				$match: {
					"settings.twoFactorEnabled": true,
					$or: [{ "settings.loginAlerts": { $ne: false } }, { settings: { $size: 0 } }],
				},
			},
			{ $count: "count" },
		]),
	]);

	return res.json({
		users: {
			total: totalUsers,
			banned: bannedUsers,
			admins: adminUsers,
			newToday: newUsersToday,
			newLast7Days: newUsersLast7Days,
			newLast30Days: newUsersLast30Days,
		},
		chats: { total: totalChats },
		messages: { total: totalMessages, last7Days: messagesLast7Days },
		signupSeries: signupSeries.map((entry) => ({ date: entry._id, count: entry.count })),
		signupSeriesMonthly: signupSeriesMonthly.map((entry) => ({ date: entry._id, count: entry.count })),
		messageSeriesMonthly: messageSeriesMonthly.map((entry) => ({ date: entry._id, count: entry.count })),

		security: {
			totalUsers,
			twoFactorEnabled: twoFactorEnabledResult?.[0]?.count || 0,
			loginAlertsEnabled: Math.max(0, totalUsers - loginAlertsDisabledCount),
			fullyProtected: fullyProtectedResult?.[0]?.count || 0,
		},
	});
};

const getSettings = async (req, res) => {
	const settings = await getSystemSettings();
	return res.json({ settings });
};

const updateSettings = async (req, res) => {
	const settings = await getSystemSettings();
	const features = req.body?.features;
	const modelConfig = req.body?.model;
	const maintenance = req.body?.maintenance;
	const announcement = req.body?.announcement;
	const moderation = req.body?.moderation;

	if (features && typeof features === "object") {
		const currentFeatures = settings.features.toObject();
		for (const key of Object.keys(features)) {
			if (key in currentFeatures) {
				settings.features[key] = Boolean(features[key]);
			}
		}
	}

	if (modelConfig && typeof modelConfig === "object") {
		if (typeof modelConfig.chatModel === "string" && modelConfig.chatModel.trim()) {
			settings.model.chatModel = modelConfig.chatModel.trim();
		}
		if (Number.isFinite(Number(modelConfig.maxTokens))) {
			settings.model.maxTokens = Number(modelConfig.maxTokens);
		}
	}

	if (maintenance && typeof maintenance === "object") {
		if (typeof maintenance.enabled === "boolean") {
			settings.maintenance.enabled = maintenance.enabled;
		}
		if (typeof maintenance.message === "string") {
			settings.maintenance.message = maintenance.message.trim().slice(0, 500);
		}
	}

	if (announcement && typeof announcement === "object") {
		if (typeof announcement.enabled === "boolean") {
			settings.announcement.enabled = announcement.enabled;
		}
		if (Array.isArray(announcement.messages)) {
			const { messages, invalid } = sanitizeAnnouncementMessages(announcement.messages);
			if (invalid.length > 0) {
				return res.status(400).json({
					message: `That announcement link is not allowed: "${invalid[0]}". Use an https:// URL or an in-app path starting with /.`,
				});
			}
			settings.announcement.messages = messages;
			settings.markModified("announcement.messages");
		}
	}

	if (moderation && typeof moderation === "object") {
		if (typeof moderation.enabled === "boolean") {
			settings.moderation.enabled = moderation.enabled;
		}
		if (Array.isArray(moderation.bannedWords)) {
			settings.moderation.bannedWords = moderation.bannedWords
				.map((word) => normalizeText(word).toLowerCase())
				.filter(Boolean)
				.slice(0, 200);
		}
	}

	settings.updatedBy = req.auth.userId;
	await settings.save();

	return res.json({ settings });
};

const forceLogoutAllSessions = async (req, res) => {
	const settings = await getSystemSettings();
	settings.security.sessionsRevokedAt = new Date();
	settings.updatedBy = req.auth.userId;
	await settings.save();

	return res.json({
		settings,
		message: "All active sessions have been revoked. Every signed-in user, including you, will need to log in again.",
	});
};

const getPublicAnnouncement = async (req, res) => {
	try {
		const settings = await getSystemSettings();
		const announcement = settings?.announcement || {};
		res.json({
			announcement: {
				enabled: Boolean(announcement.enabled),
				messages: normalizeAnnouncementMessages(announcement.messages),
			},
		});
	} catch (error) {
		res.status(200).json({ announcement: { enabled: false, messages: [] } });
	}
};

module.exports = {
	listUsers,
	getUser,
	updateUser,
	banUser,
	unbanUser,
	deleteUser,
	getAnalytics,
	getSettings,
	updateSettings,
	forceLogoutAllSessions,
	getPublicAnnouncement,
};