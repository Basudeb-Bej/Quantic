// back-end/models/RevokedTokenModel.js
// Denylist of logged-out JWTs. Rows delete themselves (TTL) once the token would have expired anyway.
const mongoose = require("mongoose");

const revokedTokenSchema = new mongoose.Schema({
	jti: { type: String, required: true, unique: true },
	expiresAt: { type: Date, required: true, index: { expires: 0 } },
});

module.exports = mongoose.models.RevokedToken || mongoose.model("RevokedToken", revokedTokenSchema);
