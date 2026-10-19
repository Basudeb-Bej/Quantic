//back-end/rag/embedder.js
let model;

const getPipeline = async () => {
  const { pipeline } = await import("@xenova/transformers");
  return pipeline;
};

const getModel = async () => {
  if (!model) {
    const pipeline = await getPipeline();
    model = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
  }

  return model;
};

const createEmbedding = async (text) => {
  const currentModel = await getModel();
  const output = await currentModel(text, { pooling: "mean", normalize: true });
  return Array.from(output.data);
};

module.exports = {
  getModel,
  createEmbedding,
};