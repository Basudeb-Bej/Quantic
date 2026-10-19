//back-end/routes/chatRoutes.js
const express = require("express");
const { authenticate, optionalAuthenticate } = require("../middleware/auth");
const {
	chat,
	getChatHistory,
	getChatHistoryThread,
	updateChatHistoryThread,
	deleteChatHistoryThread,
} = require("../controllers/chatController.js");

const router = express.Router();

router.get("/history", authenticate, getChatHistory);
router.get("/history/:threadId", authenticate, getChatHistoryThread);
router.patch("/history/:threadId", authenticate, updateChatHistoryThread);
router.delete("/history/:threadId", authenticate, deleteChatHistoryThread);
router.post("/", optionalAuthenticate, chat);

module.exports = router;