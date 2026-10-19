//back-end/models/LoginModel.js
const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
	{
		name: {
			type: String,
			required: true,
			trim: true,
		},
		email: {
			type: String,
			required: true,
			unique: true,
			lowercase: true,
			trim: true,
		},
		passwordHash: {
			type: String,
			required: true,
			select: false,
		},
		role: {
			type: String,
			enum: ["user", "admin"],
			default: "user",
		},
		banned: {
			type: Boolean,
			default: false,
		},
		bannedAt: {
			type: Date,
			default: null,
		},
		bannedReason: {
			type: String,
			default: "",
		},

		markedForDeletionAt: {
			type: Date,
			default: null,
		},

		// New accounts are only created after the emailed OTP is verified (see PendingRegistrationModel).
		// Kept so rows saved by an earlier version (emailVerified: false) can still be recognised.
		emailVerified: {
			type: Boolean,
			default: true,
		},

		// Login rate limiting.
		failedLoginAttempts: {
			type: Number,
			default: 0,
			select: false,
		},
		lockUntil: {
			type: Date,
			default: null,
			select: false,
		},
		resetOtp: {
			type: String,
			default: null,
			select: false,
		},
		resetOtpExpires: {
			type: Date,
			default: null,
			select: false,
		},
		otpVerified: {
			type: Boolean,
			default: false,
			select: false,
		},
		twoFactorOtp: {
			type: String,
			default: null,
			select: false,
		},
		twoFactorOtpExpires: {
			type: Date,
			default: null,
			select: false,
		},
		knownDevices: {
			type: [
				{
					fingerprint: { type: String, required: true },
					userAgent: { type: String, default: "" },
					firstSeenAt: { type: Date, default: Date.now },
					lastSeenAt: { type: Date, default: Date.now },
				},
			],
			default: [],
			select: false,
		},
	},
	{
		timestamps: true,
	}
);

module.exports = mongoose.model("User", userSchema);