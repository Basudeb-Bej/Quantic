//back-end/rag/chunker.js
const normalizeText = (value) => String(value ?? "").trim();

const buildChunkMetadata = (metadata = {}, chunkIndex = 0, totalChunks = 0) => ({
  ...metadata,
  chunkIndex,
  totalChunks,
});

const chunkText = (text, size = 300, overlap = 50, metadata = {}) => {
  const normalizedText = normalizeText(text);
  if (!normalizedText) {
    return [];
  }

  const words = normalizedText.split(/\s+/);
  const step = Math.max(1, size - overlap);
  const chunks = [];

  for (let index = 0; index < words.length; index += step) {
    const chunkTextValue = words.slice(index, index + size).join(" ").trim();
    if (chunkTextValue) {
      chunks.push({
        text: chunkTextValue,
        metadata: buildChunkMetadata(metadata, chunks.length, 0),
      });
    }
  }

  const totalChunks = chunks.length;
  return chunks.map((chunk) => ({
    ...chunk,
    metadata: buildChunkMetadata(chunk.metadata, chunk.metadata.chunkIndex, totalChunks),
  }));
};

module.exports = {
  chunkText,
};