// ./src/functions/handler.js

const mongoose = require("mongoose");
const Article = require("../models/article");
const { createResponse } = require("../utils/response");
const { Permit } = require("permitio");

const permit = new Permit({
  pdp: process.env.PERMIT_PDP_URL,
  token: process.env.PERMIT_API_KEY,
});

// MongoDB connection with reuse across Lambda invocations
let isConnected = false;
const connectDB = async () => {
  if (isConnected) return;

  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });
    isConnected = true;
    console.log("✅ Connected to MongoDB");
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
    throw error;
  }
};

exports.handler = async (event) => {
  await connectDB();

  console.log(
    "📨 Request:",
    JSON.stringify(
      {
        httpMethod: event.httpMethod,
        path: event.path,
        pathParameters: event.pathParameters,
        authorizer: event.requestContext?.authorizer,
      },
      null,
      2,
    ),
  );

  // Extract user context from authorizer
  const context = event.requestContext?.authorizer || {};
  const { userId, role, subscription_tier } = context;

  const { httpMethod, pathParameters = {}, body, path } = event;

  try {
    // ABAC: Check rate limits based on subscription tier
    await enforceRateLimiting(userId, subscription_tier);

    // Route to appropriate handler based on path
    if (path.includes("/articles")) {
      return await handleArticles(httpMethod, pathParameters, body, context);
    } else if (path.includes("/categories")) {
      return await handleCategories(httpMethod, pathParameters, body, context);
    } else if (path.includes("/comments")) {
      return await handleComments(httpMethod, pathParameters, body, context);
    } else if (path.includes("/media")) {
      return await handleMedia(httpMethod, pathParameters, body, context);
    }

    return createResponse(404, { error: "Resource not found" });
  } catch (error) {
    console.error("❌ Request failed:", error);
    return createResponse(500, { error: error.message });
  }
};

async function handleArticles(method, params = {}, body, context) {
  const { userId, role, subscription_tier } = context;

  // Extract article ID from path parameters
  const getArticleIdFromPath = () => {
    if (params.proxy) {
      const pathParts = params.proxy.split("/");
      const articleIndex = pathParts.indexOf("articles");
      if (
        articleIndex >= 0 &&
        pathParts[articleIndex + 1] &&
        !["publish"].includes(pathParts[articleIndex + 1])
      ) {
        return pathParts[articleIndex + 1];
      }
    }
    return params.id || null;
  };

  const articleId = getArticleIdFromPath();

  switch (method) {
    case "GET":
      if (articleId) {
        // Get single article
        const article = await Article.findById(articleId);
        if (!article) {
          return createResponse(404, { error: "Article not found" });
        }

        // Use Permit.io to check read permissions (covers both ReBAC and ABAC)
        const canRead = await permit.check(userId, "read", {
          type: "Article",

          id: articleId,
          category: article.category,
          attributes: {
            author: article.author,
            status: article.status,
            category: article.category,
          },
        });

        if (!canRead) {
          // Determine specific error based on article properties
          if (article.status === "draft" && article.author !== userId) {
            return createResponse(403, {
              error: "Cannot view draft articles of other users",
            });
          } else if (
            article.category === "premium" &&
            subscription_tier === "free"
          ) {
            return createResponse(403, {
              error: "Premium subscription required to access premium content",
            });
          } else {
            return createResponse(403, {
              error: "Access denied",
            });
          }
        }

        return createResponse(200, { article });
      } else {
        // List articles with proper filtering
        const articles = await getFilteredArticles(userId, role);
        return createResponse(200, {
          articles,
          total: articles.length,
          user_context: { userId, role },
        });
      }

    case "POST":
      if (params.proxy && params.proxy.includes("publish")) {
        // Publish article (POST /articles/{id}/publish)
        const pathParts = params.proxy.split("/");
        const articleIndex = pathParts.indexOf("articles");
        const publishArticleId =
          articleIndex >= 0 ? pathParts[articleIndex + 1] : null;
        return await publishArticle(publishArticleId, userId, role);
      } else {
        // Create new article
        return await createArticle(body, userId);
      }

    case "PUT":
      // Update article
      return await updateArticle(articleId, body, userId, role);

    case "DELETE":
      // Delete article
      return await deleteArticle(articleId, userId, role);

    default:
      return createResponse(405, { error: "Method not allowed" });
  }
}

// ReBAC: Create article with ownership tracking
async function createArticle(body, userId) {
  if (!body) {
    return createResponse(400, { error: "Request body is required" });
  }

  const articleData = JSON.parse(body);
  const article = new Article({
    ...articleData,
    author: userId, // Establish ownership relationship
  });

  await article.save();

  return createResponse(201, {
    message: "Article created successfully",
    article,
    ownership: { owner: userId },
  });
}

async function updateArticle(articleId, body, userId, role) {
  if (!articleId) {
    return createResponse(400, { error: "Article ID is required" });
  }

  const article = await Article.findById(articleId);
  if (!article) {
    return createResponse(404, { error: "Article not found" });
  }

  // Use Permit.io to check update permissions (ReBAC - ownership)
  const canUpdate = await permit.check(userId, "update", {
    type: "Article",

    id: articleId,
    attributes: {
      author: article.author,
      status: article.status,
      category: article.category,
    },
  });

  if (!canUpdate) {
    return createResponse(403, { error: "Can only edit your own articles" });
  }

  const updateData = JSON.parse(body);
  Object.assign(article, updateData);
  article.updatedAt = new Date();
  await article.save();

  return createResponse(200, {
    message: "Article updated successfully",
    article,
    updated_by: userId,
  });
}

async function deleteArticle(articleId, userId, role) {
  if (!articleId) {
    return createResponse(400, { error: "Article ID is required" });
  }

  const article = await Article.findById(articleId);
  if (!article) {
    return createResponse(404, { error: "Article not found" });
  }

  // Use Permit.io to check delete permissions (ReBAC - ownership)
  const canDelete = await permit.check(userId, "delete", {
    type: "Article",

    id: articleId,
    attributes: {
      author: article.author,
      status: article.status,
      category: article.category,
    },
  });

  if (!canDelete) {
    return createResponse(403, { error: "Can only delete your own articles" });
  }

  await Article.findByIdAndDelete(articleId);

  return createResponse(200, {
    message: "Article deleted successfully",
    deleted_by: userId,
  });
}

async function publishArticle(articleId, userId, role) {
  if (!articleId) {
    return createResponse(400, { error: "Article ID is required" });
  }

  const article = await Article.findById(articleId);
  if (!article) {
    return createResponse(404, { error: "Article not found" });
  }

  // Use Permit.io to check publish permissions
  const canPublish = await permit.check(userId, "publish", {
    type: "Article",

    id: articleId,
    attributes: {
      author: article.author,
      status: article.status,
      category: article.category,
    },
  });

  if (!canPublish) {
    return createResponse(403, {
      error: "Only editors and admins can publish articles",
    });
  }

  article.status = "published";
  article.updatedAt = new Date();
  await article.save();

  return createResponse(200, {
    message: "Article published successfully",
    article,
    published_by: userId,
  });
}

async function getFilteredArticles(userId, role) {
  // For listing, we'll keep the MongoDB filtering for performance
  // In a more sophisticated setup, you could use permit.check for each article
  const query = {};

  // Use permit.check for listing permissions
  const canListAll = await permit.check(userId, "read", {
    type: "Article",

    attributes: {
      category: "premium",
    },
  });

  if (!canListAll || !["editor", "admin"].includes(role)) {
    // Non-editors see published articles + their own drafts
    query.$or = [{ status: "published" }, { author: userId }];
  }

  return await Article.find(query).sort({ createdAt: -1 }).limit(20);
}

// ABAC: Rate limiting based on subscription tier
const rateLimits = new Map(); // In production, use Redis or DynamoDB

async function enforceRateLimiting(userId, subscriptionTier) {
  if (!userId) return; // Skip for public endpoints

  const now = Date.now();
  const windowMs = 60 * 60 * 1000; // 1 hour window

  const limits = {
    free: 100,
    premium: 1000,
    enterprise: Infinity,
  };

  const limit = limits[subscriptionTier] || limits.free;
  if (limit === Infinity) return; // No limit for enterprise

  const key = `${userId}:${Math.floor(now / windowMs)}`;
  const current = rateLimits.get(key) || 0;

  if (current >= limit) {
    throw new Error(
      `Rate limit exceeded. ${subscriptionTier} tier allows ${limit} requests/hour`,
    );
  }

  rateLimits.set(key, current + 1);
  console.log(
    `🚦 Rate limit: ${current + 1}/${limit} for ${userId} (${subscriptionTier})`,
  );

  // Cleanup old entries occasionally
  if (Math.random() < 0.01) {
    for (const [k] of rateLimits) {
      const keyTime = parseInt(k.split(":")[1]) * windowMs;
      if (now - keyTime > windowMs) {
        rateLimits.delete(k);
      }
    }
  }
}

// Placeholder handlers for other resources
async function handleCategories(method, params, body, context) {
  return createResponse(200, {
    message: "Categories endpoint working",
    method,
    user: context.userId,
    role: context.role,
  });
}

async function handleComments(method, params, body, context) {
  return createResponse(200, {
    message: "Comments endpoint working",
    method,
    user: context.userId,
    role: context.role,
  });
}

async function handleMedia(method, params, body, context) {
  return createResponse(200, {
    message: "Media endpoint working",
    method,
    user: context.userId,
    role: context.role,
  });
}
