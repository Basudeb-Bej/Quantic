//back-end/models/PendingRegistrationModel.js
const mongoose = require("mongoose");

const pendingRegistrationSchema = new mongoose.Schema({
	email: {
		type: String,
		required: true,
		unique: true,
		lowercase: true,
		trim: true,
	},
	name: { type: String, required: true, trim: true },
	passwordHash: { type: String, required: true },
	otpHash: { type: String, required: true }, // SHA-256 of the code, never the code itself
	otpExpires: { type: Date, required: true },
	otpAttempts: { type: Number, default: 0 },
	otpSentAt: { type: Date, default: Date.now },
	// MongoDB removes the document automatically once this time passes.
	expiresAt: { type: Date, required: true, index: { expireAfterSeconds: 0 } },
});

module.exports = mongoose.model("PendingRegistration", pendingRegistrationSchema);