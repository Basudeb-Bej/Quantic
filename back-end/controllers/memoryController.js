//back-end/controllers/memoryController.js
const mongoose = require("mongoose");
const { listAllMemories, deleteMemoryById, deleteMemoryByKey } = require("../services/memoryService.js");

const normalizeText = (value) => String(value ?? "").trim();
const isValidUserId = (value) => mongoose.Types.ObjectId.isValid(String(value ?? ""));

const getUserMemories = async (req, res) => {
	const userId = normalizeText(req.auth?.userId);

	if (!userId || !isValidUserId(userId)) {
		return res.status(401).json({ message: "Not authenticated." });
	}

	const memories = await listAllMemories(userId);
	return res.json({ memories });
};

const deleteUserMemoryById = async (req, res) => {
	const userId = normalizeText(req.auth?.userId);
	const memoryId = normalizeText(req.params?.memoryId);

	if (!userId || !isValidUserId(userId)) {
		return res.status(401).json({ message: "Not authenticated." });
	}

	if (!memoryId) {
		return res.status(400).json({ message: "Memory id required." });
	}

	const deleted = await deleteMemoryById(userId, memoryId);

	if (!deleted) {
		return res.status(404).json({ message: "Memory not found." });
	}

	return res.status(204).send();
};

const deleteUserMemoryByKey = async (req, res) => {
	const userId = normalizeText(req.auth?.userId);
	const key = normalizeText(req.params?.key);

	if (!userId || !isValidUserId(userId)) {
		return res.status(401).json({ message: "Not authenticated." });
	}

	if (!key) {
		return res.status(400).json({ message: "Memory key required." });
	}

	const deleted = await deleteMemoryByKey(userId, key);

	if (!deleted) {
		return res.status(404).json({ message: "Memory not found." });
	}

	return res.status(204).send();
};

module.exports = {
	getUserMemories,
	deleteUserMemoryById,
	deleteUserMemoryByKey,
};