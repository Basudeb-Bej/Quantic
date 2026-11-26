// back-end/services/pastChats.js
// Lets the agent recall what a signed-in user discussed in earlier chats.
"use strict";
const mongoose = require("mongoose");
const Chat = require("../models/ChatModel.js");
const Message = require("../models/MessageModel.js");

const SOURCES_MARKER = /^<!--SRC:[\s\S]*?-->\r?\n?/;
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const STOP = new Set(["the", "and", "that", "this", "with", "what", "when", "where", "which", "about", "last", "time", "chat", "talked", "discussed", "remember", "earlier", "before", "again", "you", "your", "was", "were", "have", "had", "for", "from", "said", "told", "gave", "give"]);

const extractKeywords = (query) => {
	const words = String(query || "").toLowerCase().match(/[\p{L}\p{N}_#+.-]{3,}/gu) || [];
	return [...new Set(words.filter((word) => !STOP.has(word)))].slice(0, 6);
};

const excerpt = (text, keywords, size = 320) => {
	const clean = String(text || "").replace(SOURCES_MARKER, "").replace(/\s+/g, " ").trim();
	const lower = clean.toLowerCase();
	const hit = keywords.map((word) => lower.indexOf(word)).filter((index) => index >= 0).sort((a, b) => a - b)[0] ?? 0;
	const start = Math.max(0, hit - Math.floor(size / 3));
	return `${start > 0 ? "…" : ""}${clean.slice(start, start + size)}${start + size < clean.length ? "…" : ""}`;
};

const searchPastChats = async ({ userId, query, excludeChatId = null, limit = 6 }) => {
	if (!userId || !mongoose.Types.ObjectId.isValid(String(userId))) return "No chat history is available.";

	const keywords = extractKeywords(query);
	if (!keywords.length) return "Give 1-5 specific keywords to search past chats.";

	const chats = await Chat.find({ userId, ...(excludeChatId ? { _id: { $ne: excludeChatId } } : {}) })
		.sort({ lastMessageAt: -1 }).limit(300).select("_id title").lean();
	if (!chats.length) return "The user has no earlier chats.";

	const titles = new Map(chats.map((chat) => [String(chat._id), chat.title || "Untitled chat"]));
	const matcher = new RegExp(keywords.map(escapeRegex).join("|"), "i");
	const messages = await Message.find({ chatId: { $in: chats.map((chat) => chat._id) }, content: matcher })
		.sort({ createdAt: -1 }).limit(60).select("chatId role content createdAt").lean();

	const scored = messages.map((message) => {
		const lower = String(message.content).toLowerCase();
		return { message, score: keywords.filter((word) => lower.includes(word)).length };
	}).sort((a, b) => b.score - a.score || new Date(b.message.createdAt) - new Date(a.message.createdAt)).slice(0, limit);

	if (!scored.length) return `No earlier messages matched: ${keywords.join(", ")}.`;

	return scored.map(({ message }) => {
		const when = message.createdAt ? new Date(message.createdAt).toISOString().slice(0, 10) : "unknown date";
		return `[${when}] Chat "${titles.get(String(message.chatId))}" (${message.role}): ${excerpt(message.content, keywords)}`;
	}).join("\n");
};

module.exports = { searchPastChats, extractKeywords };
