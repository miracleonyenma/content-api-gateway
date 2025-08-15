// ./src/functions/authorizer.js

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const Article = require("../models/article");
const { Permit } = require("permitio");

const permit = new Permit({
  pdp: process.env.PERMIT_PDP_URL,
  token: process.env.PERMIT_API_KEY,
});

exports.handler = async (event) => {
  console.log("🔐 Authorization request:", JSON.stringify(event, null, 2));

  try {
    // Extract JWT token from Authorization header
    const token = extractToken(event);
    if (!token) {
      throw new Error("No token provided");
    }

    // Verify and decode JWT
    const user = jwt.verify(token, process.env.JWT_SECRET);
    console.log("👤 User:", user);

    // Extract resource and action from request
    const { resource, action, resourceId } = extractResourceInfo(event);
    console.log("🎯 Checking:", {
      user: user.userId,
      action,
      resource,
      resourceId,
    });

    // 1. RBAC: Check basic role permissions
    const rbacAllowed = await permit.check(user.userId, action, resource);
    console.log("🏷️ RBAC Result:", rbacAllowed);

    if (!rbacAllowed) {
      console.log(
        `🚫 Access denied: User ${user.userId} (${user.role}) cannot perform '${action}' on ${resource?.type}`,
      );
      throw new Error("Forbidden");
    }

    // 2. ABAC: Policy-level attribute-based access control
    let abacAllowed = true;
    if (resource === "Article" && resourceId && action === "read") {
      try {
        // For premium content access, check against article attributes

        // Ensure database connection
        if (!mongoose.connection.readyState) {
          await mongoose.connect(process.env.MONGODB_URI, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
          });
        }

        const article = await Article.findById(resourceId);
        if (article?.category === "premium") {
          // Policy-level ABAC: Check if user can access premium content
          abacAllowed = await permit.check(user.userId, "read", {
            type: "Article",
            key: "Article",
            attributes: { category: "premium" },
          });

          console.log("📊 ABAC Result (premium content):", abacAllowed);

          if (!abacAllowed) {
            console.log(
              `🚫 ABAC denied: User ${user.userId} cannot access premium content`,
            );
            throw new Error("Forbidden - Premium subscription required");
          }
        }
      } catch (dbError) {
        console.error("Database error in ABAC check:", dbError);
        // Fail securely on database errors
        if (dbError.message.includes("Forbidden")) throw dbError;
        throw new Error("Forbidden");
      }
    }

    // ABAC context for application-level decisions (rate limiting)
    const abacContext = {
      subscription_tier: user.subscription_tier || "free",
      user_role: user.role,
    };
    console.log("📊 ABAC Context for rate limiting:", abacContext);

    // 3. Basic ReBAC: For update/delete operations, add ownership context
    let rebacContext = {};
    if (resourceId && ["update", "delete"].includes(action)) {
      rebacContext.resource_owner_check = true;
      console.log("🔗 ReBAC: Ownership check required for", resourceId);
    }

    // Generate allow policy with user context
    return generatePolicy(user.userId, "Allow", event.methodArn, {
      userId: user.userId,
      email: user.email,
      role: user.role,
      subscription_tier: user.subscription_tier || "free",
      resource,
      action,
      resourceId: resourceId || "",
    });
  } catch (error) {
    console.error("❌ Authorization failed:", error.message);
    throw new Error("Unauthorized");
  }
};

function extractToken(event) {
  // Handle different token locations
  if (event.authorizationToken) {
    return event.authorizationToken.replace("Bearer ", "");
  }

  if (event.headers?.Authorization) {
    return event.headers.Authorization.replace("Bearer ", "");
  }

  if (event.headers?.authorization) {
    return event.headers.authorization.replace("Bearer ", "");
  }

  return null;
}

function extractResourceInfo(event) {
  // Parse method ARN or path to determine resource and action
  const methodArn = event.methodArn || "";
  const path = event.path || "";

  console.log("🔍 Parsing request:", { methodArn, path });

  // Extract HTTP method and resource path
  let method = event.httpMethod;
  let resourcePath = path;

  if (methodArn) {
    const parts = methodArn.split("/");
    method = parts[parts.length - 2] || method;
  }

  // Map resource paths to Permit.io resources
  let resource = {
    type: "Article",
    key: "Article",
    attributes: {
      category: "free",
    },
  }; // default
  let resourceId = null;
  const pathParts = resourcePath.split("/");

  if (resourcePath.includes("articles")) {
    resource = {
      type: "Article",
      key: "Article",
      attributes: {
        category: "free",
      },
    };
    const articleIndex = pathParts.indexOf("articles");
    if (
      articleIndex >= 0 &&
      pathParts[articleIndex + 1] &&
      pathParts[articleIndex + 1] !== "publish"
    ) {
      resourceId = pathParts[articleIndex + 1];
    }
  } else if (resourcePath.includes("categories")) {
    resource = "Category";
    const pathParts = resourcePath.split("/");
    const categoryIndex = pathParts.indexOf("categories");
    if (categoryIndex >= 0 && pathParts[categoryIndex + 1]) {
      resourceId = pathParts[categoryIndex + 1];
    }
  } else if (resourcePath.includes("comments")) {
    resource = "Comment";
    const pathParts = resourcePath.split("/");
    const commentIndex = pathParts.indexOf("comments");
    if (commentIndex >= 0 && pathParts[commentIndex + 1]) {
      resourceId = pathParts[commentIndex + 1];
    }
  } else if (resourcePath.includes("media")) {
    resource = "Media";
    const pathParts = resourcePath.split("/");
    const mediaIndex = pathParts.indexOf("media");
    if (mediaIndex >= 0 && pathParts[mediaIndex + 1]) {
      resourceId = pathParts[mediaIndex + 1];
    }
  }

  // Map HTTP methods to actions
  const actionMap = {
    GET: "read",
    POST: resourcePath.includes("publish") ? "publish" : "create",
    PUT: "update",
    DELETE: "delete",
  };

  return {
    resource,
    action: actionMap[method] || "read",
    resourceId,
  };
}

function generatePolicy(principalId, effect, resource, context = {}) {
  return {
    principalId,
    policyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Action: "execute-api:Invoke",
          Effect: effect,
          Resource: resource,
        },
      ],
    },
    context: {
      // Convert all values to strings (API Gateway requirement)
      ...Object.fromEntries(
        Object.entries(context).map(([key, value]) => [
          key,
          String(value || ""),
        ]),
      ),
    },
  };
}
