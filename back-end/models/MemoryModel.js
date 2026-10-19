//back-end/models/MemoryModel.js
const mongoose = require("mongoose");

const memorySchema = new mongoose.Schema(
	{
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "User",
			required: true,
			index: true,
		},
		content: {
			type: String,
			default: "",
			trim: true,
		},
		embedding: {
			type: [Number],
			default: [],
		},
		type: {
			type: String,
			enum: ["preference", "fact", "behavior", "context"],
			default: "fact",
		},
		key: {
			type: String,
			required: true,
			trim: true,
		},
		value: {
			type: String,
			required: true,
			trim: true,
		},
		confidence: {
			type: Number,
			default: 0.7,
		},
		importance: {
			type: Number,
			default: 1,
		},
		source: {
			type: String,
			default: "",
			trim: true,
		},
		expiresAt: {
			type: Date,
			default: null,
		},
		lastUsedAt: {
			type: Date,
			default: Date.now,
		},
	},
	{
		timestamps: true,
		collection: "memories",
	}
);

memorySchema.index({ userId: 1, key: 1 }, { unique: true });
memorySchema.index({ userId: 1, lastUsedAt: -1 });
memorySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Memory", memorySchema);