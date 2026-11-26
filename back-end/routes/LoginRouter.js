const express = require("express");
const { changePassword, getCurrentUser, loginUser, verifyLoginOtp, logoutUser, registerUser, submitFeedback, deleteAccount, cancelAccountDeletion, forgotPassword, verifyResetOtp, resetPassword, verifyRegistrationOtp, resendRegistrationOtp } = require("../controllers/login.Controller");
const { authenticate } = require("../middleware/auth");
const rateLimit = require("express-rate-limit");

const router = express.Router();

// Per-IP throttle for every credential / OTP endpoint, so guessing is slow even though the
// per-account lockout alone would let anyone lock a victim out.
const authLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: Number(process.env.AUTH_RATE_LIMIT || 30),
	standardHeaders: true,
	legacyHeaders: false,
	message: { message: "Too many attempts. Please wait a few minutes and try again." },
});

router.post("/register", authLimiter, registerUser);
router.post("/verify-registration-otp", authLimiter, verifyRegistrationOtp);
router.post("/resend-registration-otp", authLimiter, resendRegistrationOtp);
router.post("/login", authLimiter, loginUser);
router.post("/verify-login-otp", authLimiter, verifyLoginOtp);
router.get("/me", authenticate, getCurrentUser);
router.put("/password", authenticate, changePassword);
router.post("/feedback", authenticate, submitFeedback);
router.post("/logout", logoutUser);
router.post("/delete-account", authenticate, deleteAccount);
router.post("/cancel-deletion", authenticate, cancelAccountDeletion);
router.post("/forgot-password", authLimiter, forgotPassword);
router.post("/verify-reset-otp", authLimiter, verifyResetOtp);
router.post("/reset-password", authLimiter, resetPassword);

module.exports = router;