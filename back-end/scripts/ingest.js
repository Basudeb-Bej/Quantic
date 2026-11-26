// back-end/scripts/ingest.js
// Builds vectorstore/db.json from every .txt and .md file in back-end/data/.
//   npm run ingest            embed and save
//   npm run ingest -- --dry   only show how the files would be chunked (no model download)
// Add your own documents to back-end/data/ and re-run to extend the knowledge base.
"use strict";
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.resolve(__dirname, "../data");
const DRY_RUN = process.argv.includes("--dry");

const titleFromFile = (file) => path.basename(file, path.extname(file)).replace(/[-_]+/g, " ");

const run = async () => {
  const { chunkText } = require("../rag/chunker.js");
  const files = fs.readdirSync(DATA_DIR).filter((name) => /\.(txt|md)$/i.test(name)).sort();

  if (!files.length) {
    throw new Error(`No .txt or .md files found in ${DATA_DIR}`);
  }

  const chunks = [];

  for (const name of files) {
    const filePath = path.join(DATA_DIR, name);
    const text = fs.readFileSync(filePath, "utf-8").replace(/\r\n/g, "\n");
    const pieces = chunkText(text, 300, 50, {
      source: name,
      type: "knowledge_base",
      date: new Date().toISOString(),
      title: titleFromFile(name),
    });
    console.log(`${name}: ${pieces.length} chunks`);
    chunks.push(...pieces);
  }

  if (DRY_RUN) {
    console.log(`Dry run: ${chunks.length} chunks from ${files.length} files (nothing saved).`);
    return;
  }

  const { createEmbedding } = require("../rag/embedder.js");
  const { saveDB } = require("../rag/vectorStore.js");
  const db = [];

  for (const [index, chunk] of chunks.entries()) {
    db.push({ text: chunk.text, embedding: await createEmbedding(chunk.text), metadata: chunk.metadata });
    if ((index + 1) % 10 === 0) console.log(`embedded ${index + 1}/${chunks.length}`);
  }

  saveDB(db);
  console.log(`Done: ${db.length} chunks saved.`);
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
