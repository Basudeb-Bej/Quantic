const express = require("express");
const { authenticate, requireAdmin } = require("../middleware/auth.js");
const { getSystemSettings } = require("../models/SystemSettingsModel.js");
const {
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
} = require("../controllers/adminController.js");
const router = express.Router();

// Public: no auth required, so guests and non-admin users can see the banner too.
router.get("/announcement", async (req, res) => {
	try {
		const settings = await getSystemSettings();
		const announcement = settings?.announcement || {};
		res.json({
			announcement: {
				enabled: Boolean(announcement.enabled),
				messages: Array.isArray(announcement.messages) ? announcement.messages.filter(Boolean) : [],
			},
		});
	} catch (error) {
		res.status(200).json({ announcement: { enabled: false, messages: [] } });
	}
});

router.use(authenticate, requireAdmin);

router.get("/users", listUsers);
router.get("/users/:userId", getUser);
router.patch("/users/:userId", updateUser);
router.post("/users/:userId/ban", banUser);
router.post("/users/:userId/unban", unbanUser);
router.delete("/users/:userId", deleteUser);

router.get("/analytics", getAnalytics);

router.get("/settings", getSettings);
router.patch("/settings", updateSettings);
router.post("/settings/force-logout", forceLogoutAllSessions);

module.exports = router;