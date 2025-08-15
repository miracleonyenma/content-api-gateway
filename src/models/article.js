// ./src/models/article.js
const mongoose = require("mongoose");

const articleSchema = new mongoose.Schema({
  title: { type: String, required: true },
  content: { type: String, required: true },
  author: { type: String, required: true }, // User ID
  status: { type: String, enum: ["draft", "published"], default: "draft" },
  category: {
    type: String,
    enum: ["free", "premium"],
    default: "free",
  },
  tags: [String],
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Article", articleSchema);
