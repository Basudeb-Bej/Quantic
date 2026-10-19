//back-end/scripts/ingest.js
const fs = require("fs");
const path = require("path");

const run = async () => {
  const [{ chunkText }, { createEmbedding }, { saveDB }] = await Promise.all([
    import("../rag/chunker.js"),
    import("../rag/embedder.js"),
    import("../rag/vectorStore.js"),
  ]);
  const sampleFilePath = path.resolve(__dirname, "../data/sample.txt");

  if (!fs.existsSync(sampleFilePath)) {
    throw new Error(`Missing ingest source file: ${sampleFilePath}`);
  }

  const text = fs.readFileSync(sampleFilePath, "utf-8");
  const chunks = chunkText(text, 300, 50, {
		source: path.basename(sampleFilePath),
		type: "knowledge_base",
		date: new Date().toISOString(),
		title: "sample knowledge base",
	});
  const db = [];

  for (const chunk of chunks) {
	const embedding = await createEmbedding(chunk.text);
	db.push({
		text: chunk.text,
		embedding,
		metadata: chunk.metadata,
	});
  }

  saveDB(db);
  console.log("Done");
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});