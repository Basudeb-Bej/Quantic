// models/MessageModel.js
const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
	{
		chatId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "Chat",
			required: true,
			index: true,
		},
		role: {
			type: String,
			required: true,
			trim: true,
		},
		content: {
			type: String,
			required() {
				return !Array.isArray(this.attachments) || this.attachments.length === 0;
			},
			default: "",
			trim: true,
		},
		attachments: {
			type: [
				{
					key: { type: String, trim: true },
					name: { type: String, trim: true },
					size: { type: Number },
					type: { type: String, trim: true },
					dataUrl: { type: String },
				},
			],
			default: [],
		},
	},
	{
		timestamps: true,
		collection: "messages",
	}
);

messageSchema.index({ chatId: 1, createdAt: 1 });

module.exports = mongoose.model("Message", messageSchema);