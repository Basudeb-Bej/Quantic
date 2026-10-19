const express = require("express");
const { changePassword, getCurrentUser, loginUser, verifyLoginOtp, logoutUser, registerUser, submitFeedback, deleteAccount, cancelAccountDeletion, forgotPassword, verifyResetOtp, resetPassword, verifyRegistrationOtp, resendRegistrationOtp } = require("../controllers/login.Controller");
const { authenticate } = require("../middleware/auth");

const router = express.Router();

router.post("/register", registerUser);
router.post("/verify-registration-otp", verifyRegistrationOtp);
router.post("/resend-registration-otp", resendRegistrationOtp);
router.post("/login", loginUser);
router.post("/verify-login-otp", verifyLoginOtp);
router.get("/me", authenticate, getCurrentUser);
router.put("/password", authenticate, changePassword);
router.post("/feedback", authenticate, submitFeedback);
router.post("/logout", logoutUser);
router.post("/delete-account", authenticate, deleteAccount);
router.post("/cancel-deletion", authenticate, cancelAccountDeletion);
router.post("/forgot-password", forgotPassword);
router.post("/verify-reset-otp", verifyResetOtp);
router.post("/reset-password", resetPassword);

module.exports = router;