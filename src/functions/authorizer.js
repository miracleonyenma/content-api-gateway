// ./src/functions/authorizer.js

const jwt = require("jsonwebtoken");
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
      throw new Error("Access denied by RBAC policy");
    }

    // 2. ABAC: Additional attribute checks (rate limiting handled in main handler)
    const abacContext = {
      subscription_tier: user.subscription_tier || "free",
      user_role: user.role,
    };
    console.log("📊 ABAC Context:", abacContext);

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
    resourcePath = "/" + (parts[parts.length - 1] || "").replace("*", "");
  }

  // Map resource paths to Permit.io resources
  let resource = "Article"; // default
  let resourceId = null;

  if (resourcePath.includes("articles")) {
    resource = "Article";
    const pathParts = resourcePath.split("/");
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
