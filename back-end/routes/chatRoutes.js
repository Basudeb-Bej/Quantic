//back-end/routes/chatRoutes.js
const express = require("express");
const rateLimit = require("express-rate-limit");
const { ipKeyGenerator } = rateLimit;
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
// Each chat turn costs LLM tokens, so cap it per signed-in user and, more tightly, per anonymous IP.
const chatLimiter = rateLimit({
	windowMs: 60 * 60 * 1000,
	limit: (req) => (req.auth?.userId ? Number(process.env.CHAT_LIMIT_USER || 200) : Number(process.env.CHAT_LIMIT_GUEST || 30)),
	keyGenerator: (req) => (req.auth?.userId ? `u:${req.auth.userId}` : `ip:${ipKeyGenerator(req.ip)}`),
	standardHeaders: true,
	legacyHeaders: false,
	message: { message: "You have sent a lot of messages in a short time. Please wait a while, or sign in for a higher limit." },
});

router.post("/", optionalAuthenticate, chatLimiter, chat);

module.exports = router;