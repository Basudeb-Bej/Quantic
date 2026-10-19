//back-end/routes/memoryRoutes.js
const express = require("express");
const {
	getUserMemories,
	deleteUserMemoryById,
	deleteUserMemoryByKey,
} = require("../controllers/memoryController.js");

const router = express.Router();

router.get("/", getUserMemories);
router.delete("/id/:memoryId", deleteUserMemoryById);
router.delete("/key/:key", deleteUserMemoryByKey);

module.exports = router;