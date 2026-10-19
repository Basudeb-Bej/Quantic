//back-end/rag/vectorStore.js
const fs = require("fs");
const path = require("path");

const dbPath = path.join(__dirname, "..", "vectorstore", "db.json");

const loadDB = () => {
  if (!fs.existsSync(dbPath)) return [];

  try {
    const raw = fs.readFileSync(dbPath, "utf-8").trim();

    if (!raw) return [];

    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const saveDB = (data) => {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
};

module.exports = {
  loadDB,
  saveDB,
};