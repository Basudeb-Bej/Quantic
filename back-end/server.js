const express = require("express");
const cors = require("cors");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const mongoose = require("mongoose");
require("dotenv").config({ path: path.join(__dirname, ".env") });

const connectDB = require("./config/db");
const loginRoutes = require("./routes/LoginRouter");
const settingsRoutes = require("./routes/SettingsRouter");
const chatRoutes = require("./routes/chatRoutes.js");
//const voiceRoutes = require("./routes/voiceRoutes.js");
const { scheduleCleanupJob } = require("./controllers/login.Controller");
const memoryRoutes = require("./routes/memoryRoutes.js");
const adminRoute = require("./routes/adminRouter.js");
const { getPublicAnnouncement } = require("./controllers/adminController.js");


const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[90m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

const formatLog = (level, message, details) => {
  const timestamp = `${colors.dim}${new Date().toISOString()}${colors.reset}`;
  const levelColor = level === "info" ? colors.green : level === "warn" ? colors.yellow : colors.red;
  const levelText = `${levelColor}${level}${colors.reset}`;
  const payload = details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";

  return `${timestamp} ${levelText}: ${message}${payload}`;
};

const app = express();
const PORT = process.env.PORT || 8000;
// FRONTEND_URL = the address(es) of the website allowed to call this API.
// Separate several with commas, e.g. "https://quantic-nu.vercel.app,http://localhost:5173".
// A trailing "/" is ignored. Falls back to the local dev site.
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const requestBodyLimit = process.env.REQUEST_BODY_LIMIT || "1mb";
const chatRequestBodyLimit = process.env.CHAT_REQUEST_BODY_LIMIT || "100mb";
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: Number(process.env.RATE_LIMIT_MAX_REQUESTS || 200),
	standardHeaders: true,
	legacyHeaders: false,
});

let databaseStatus = "disconnected";

const isDatabaseConnectivityError = (error) => {
  if (!error) {
    return false;
  }

  const name = String(error.name || "");
  const code = String(error.code || "");
  const message = String(error.message || "");

  if (
    name === "MongoNetworkError" ||
    name === "MongoServerSelectionError" ||
    name === "MongooseServerSelectionError" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND"
  ) {
    return true;
  }

  if (/tlsv1 alert|ssl routines|topology is closed|read ECONNRESET/i.test(message)) {
    return true;
  }

  return false;
};

process.on("unhandledRejection", (reason) => {
  console.error(
    formatLog("error", "Unhandled promise rejection", {
      message: reason?.message || String(reason),
    })
  );
});

process.on("uncaughtException", (error) => {
  console.error(
    formatLog("error", "Uncaught exception", {
      message: error?.message || String(error),
      name: error?.name,
    })
  );
});

mongoose.connection.on("connected", () => {
  databaseStatus = "connected";
});

mongoose.connection.on("disconnected", () => {
  databaseStatus = "unavailable";
});

mongoose.connection.on("error", (error) => {
  databaseStatus = "unavailable";
  console.error(formatLog("error", "MongoDB connection error", { message: error?.message || String(error) }));
});

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
  cors({
    // Requests with no Origin header (health checks, curl) are allowed; browsers always send one.
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
    exposedHeaders: ["x-chat-thread-id"],
  })
);
app.use(helmet());
app.use(morgan("combined"));
const defaultJsonParser = express.json({ limit: requestBodyLimit });
const defaultUrlencodedParser = express.urlencoded({ extended: true, limit: requestBodyLimit });
const chatJsonParser = express.json({ limit: chatRequestBodyLimit });
const chatUrlencodedParser = express.urlencoded({ extended: true, limit: chatRequestBodyLimit });

app.use((req, res, next) => {
  if (req.path.startsWith("/api/chat")) {
    return chatJsonParser(req, res, next);
  }

  return defaultJsonParser(req, res, next);
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/chat")) {
    return chatUrlencodedParser(req, res, next);
  }

  return defaultUrlencodedParser(req, res, next);
});
app.use(apiLimiter);

app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    database: process.env.MONGO_URI ? "configured" : "missing",
    connection: databaseStatus,
  });
});

app.use("/api/auth", loginRoutes);
app.use("/api/auth", settingsRoutes);
app.use("/api/chat", chatRoutes);
//app.use("/api/voice", voiceRoutes);
app.use("/api/memories", memoryRoutes);
app.use("/api/admin", adminRoute);
app.get("/api/public/announcement", getPublicAnnouncement);

app.use((req, res) => {
	res.status(404).json({
		message: "Route not found.",
	});
});

app.use((err, req, res, next) => {
  const message = err?.message || String(err);
  const statusCode = err?.status || 500;
  console.error(formatLog("error", "Unhandled server error", { message }));

  if (isDatabaseConnectivityError(err)) {
    return res.status(503).json({
      message: "Database connection is temporarily unavailable. Please try again.",
    });
  }

  return res.status(statusCode).json({
    message: message || "Internal server error.",
  });
});

const startServer = async () => {
  try {
    await connectDB();
    databaseStatus = "connected";
    scheduleCleanupJob();
  } catch (error) {
    databaseStatus = "unavailable";
    console.error(formatLog("error", "MongoDB connection failed", { message: error.message }));
  }

  app.listen(PORT, () => console.log(formatLog("info", `Server running on ${PORT}`)));
};

startServer();
//console.log("JWT_SECRET:", process.env.JWT_SECRET);
//console.log(process.env.MONGO_URI);
