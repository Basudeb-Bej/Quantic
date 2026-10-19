// const mongoose = require("mongoose");

// const connectDB = async () => {
// 	try {
// 		const conn = await mongoose.connect(process.env.MONGO_URI, {
// 			serverSelectionTimeoutMS: 30000,
// 			family: 4,
// 		});

// 		console.log("MongoDB Connected:", conn.connection.host);
// 	} catch (error) {
// 		console.error("MongoDB connection error:", error.message);
// 	}
// };

// module.exports = connectDB;


const mongoose = require("mongoose");

const colors = {
	reset: "\x1b[0m",
	dim: "\x1b[90m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
};

const formatLog = (level, message, details = {}) => {
	const timestamp = `${colors.dim}${new Date().toISOString()}${colors.reset}`;

	let levelColor = colors.green;

	if (level === "warn") {
		levelColor = colors.yellow;
	}

	if (level === "error") {
		levelColor = colors.red;
	}

	const levelText = `${levelColor}${level.toUpperCase()}${colors.reset}`;

	const payload =
		Object.keys(details).length > 0
			? ` ${JSON.stringify(details)}`
			: "";

	return `${timestamp} ${levelText}: ${message}${payload}`;
};

const connectDB = async () => {
	try {
		const conn = await mongoose.connect(process.env.MONGO_URI, {
			serverSelectionTimeoutMS: 30000,
			connectTimeoutMS: 15000,
		});

		console.log(
			formatLog("info", "MongoDB Connected", {
				host: conn.connection.host,
			})
		);

		return conn.connection;
	} catch (error) {
		console.error(
			formatLog("error", "MongoDB connection failed", {
				message: error.message,
				name: error.name,
				code: error.code,
			})
		);
		throw error;
	}
};

module.exports = connectDB;