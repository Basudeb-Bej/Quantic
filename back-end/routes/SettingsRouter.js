// back-end/routes/SettingsRouter.js
const express = require("express");
const { authenticate } = require("../middleware/auth");
const { getSettings, updateSettings } = require("../controllers/settings.Controller");

const router = express.Router();

router.get("/settings", authenticate, getSettings);
router.put("/settings", authenticate, updateSettings);

module.exports = router;
