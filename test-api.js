// ./test-api.js

const axios = require("axios");
const jwt = require("jsonwebtoken");

// Replace with your deployed API endpoint
const API_BASE = "http://localhost:3000/dev"; // For local testing with dev stage
// const API_BASE = 'https://your-api-id.execute-api.us-east-1.amazonaws.com/dev'; // For deployed API

const JWT_SECRET = "your-super-secret-jwt-key-here";

// Create test tokens for different user types
const createToken = (user) => {
  return jwt.sign(user, JWT_SECRET, { expiresIn: "1h" });
};

const users = {
  freeViewer: createToken({
    userId: "viewer1",
    email: "viewer@example.com",
    role: "viewer",
    subscription_tier: "free",
  }),
  premiumViewer: createToken({
    userId: "viewer2",
    email: "viewer2@example.com",
    role: "viewer",
    subscription_tier: "premium",
  }),
  premiumAuthor: createToken({
    userId: "author1",
    email: "author@example.com",
    role: "author",
    subscription_tier: "premium",
  }),
  editor: createToken({
    userId: "editor1",
    email: "editor@example.com",
    role: "editor",
    subscription_tier: "premium",
  }),
  admin: createToken({
    userId: "admin1",
    email: "admin@example.com",
    role: "admin",
    subscription_tier: "enterprise",
  }),
};

async function testEndpoint(description, token, method, path, data = null) {
  try {
    const config = {
      method,
      url: `${API_BASE}${path}`,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    };

    if (data) config.data = data;

    const response = await axios(config);
    console.log(
      `✅ ${description}: ${response.status} - ${response.data.message || "Success"}`,
    );
    return response.data;
  } catch (error) {
    const status = error.response?.status || "Network Error";
    const errorMsg = error.response?.data?.error || error.message;
    console.log(`❌ ${description}: ${status} - ${errorMsg}`);
    return null;
  }
}

async function setupTestUsers() {
  console.log("🔧 Setting up test users in Permit.io...\n");

  const testUsers = [
    {
      userId: "viewer1",
      email: "viewer@example.com",
      role: "viewer",
      subscriptionTier: "free",
      firstName: "John",
      lastName: "Viewer",
    },
    {
      userId: "viewer2",
      email: "viewer2@example.com",
      role: "viewer",
      subscriptionTier: "premium",
      firstName: "Jane",
      lastName: "Viewer",
    },
    {
      userId: "author1",
      email: "author@example.com",
      role: "author",
      subscriptionTier: "premium",
      firstName: "Jane",
      lastName: "Author",
    },
    {
      userId: "editor1",
      email: "editor@example.com",
      role: "editor",
      subscriptionTier: "premium",
      firstName: "Bob",
      lastName: "Editor",
    },
    {
      userId: "admin1",
      email: "admin@example.com",
      role: "admin",
      subscriptionTier: "enterprise",
      firstName: "Alice",
      lastName: "Admin",
    },
  ];

  for (const user of testUsers) {
    // Sync user
    await testEndpoint(
      `Sync user ${user.role}`,
      users.admin, // Use admin token for user management
      "POST",
      "/admin/users/sync",
      { action: "sync", userData: user },
    );

    // Assign role
    await testEndpoint(
      `Assign role ${user.role}`,
      users.admin,
      "POST",
      "/admin/users/assign-role",
      {
        action: "assign-role",
        userData: { userId: user.userId, role: user.role },
      },
    );
  }

  console.log("\n⏳ Waiting 5 seconds for Permit.io to sync...\n");
  await new Promise((resolve) => setTimeout(resolve, 5000));
}

async function runTests() {
  console.log("🧪 Starting API Authorization Tests...\n");

  await setupTestUsers();

  // Test 1: RBAC - Role-based permissions
  console.log("=== RBAC TESTS ===");

  // Viewers can only read
  await testEndpoint(
    "Viewer reads articles",
    users.freeViewer,
    "GET",
    "/articles",
  );
  await testEndpoint(
    "Viewer creates article (should fail)",
    users.freeViewer,
    "POST",
    "/articles",
    {
      title: "Unauthorized Article",
      content: "This should fail",
    },
  );

  // Authors can create and read
  const articleResponse = await testEndpoint(
    "Author creates article",
    users.premiumAuthor,
    "POST",
    "/articles",
    {
      title: "My First Article",
      content: "This is my first article content",
      category: "free",
    },
  );

  let articleId = null;
  if (articleResponse?.article?._id) {
    articleId = articleResponse.article._id;
    console.log(`📝 Created article ID: ${articleId}`);
  }

  await testEndpoint(
    "Author reads articles",
    users.premiumAuthor,
    "GET",
    "/articles",
  );

  // Editors can publish
  if (articleId) {
    await testEndpoint(
      "Editor publishes article",
      users.editor,
      "POST",
      `/articles/${articleId}/publish`,
    );
    await testEndpoint(
      "Author publishes own article (should fail)",
      users.premiumAuthor,
      "POST",
      `/articles/${articleId}/publish`,
    );
  }

  // Test 2: ABAC - Policy-level + Application-level attribute-based controls
  console.log("\n=== ABAC TESTS ===");

  // First create premium content to test policy-level ABAC
  const premiumArticleResponse = await testEndpoint(
    "Editor creates premium article",
    users.editor,
    "POST",
    "/articles",
    {
      title: "Premium Investment Guide",
      content: "This premium content covers advanced investment strategies",
      category: "premium",
    },
  );

  let premiumArticleId = premiumArticleResponse?.article?._id;

  if (premiumArticleId) {
    console.log(`💎 Created premium article ID: ${premiumArticleId}`);

    // Publish the premium article first so it can be accessed
    await testEndpoint(
      "Editor publishes premium article",
      users.editor,
      "POST",
      `/articles/${premiumArticleId}/publish`,
    );

    // Policy-level ABAC: Premium content access through User Sets
    await testEndpoint(
      "Premium user accesses premium content",
      users.premiumAuthor,
      "GET",
      `/articles/${premiumArticleId}`,
    );
    await testEndpoint(
      "Free user accesses premium content (should fail)",
      users.freeViewer,
      "GET",
      `/articles/${premiumArticleId}`,
    );
    await testEndpoint(
      "Admin accesses premium content",
      users.admin,
      "GET",
      `/articles/${premiumArticleId}`,
    );
  }

  // Application-level ABAC: Rate limiting by subscription tier
  console.log("\nTesting subscription-tier rate limiting...");
  for (let i = 1; i <= 3; i++) {
    await testEndpoint(
      `Free user request ${i}/100`,
      users.freeViewer,
      "GET",
      "/articles",
    );
    await testEndpoint(
      `Premium user request ${i}/1000`,
      users.premiumViewer,
      "GET",
      "/articles",
    );
  }

  // Test 4: Different resource types
  console.log("\n=== RESOURCE TESTS ===");

  await testEndpoint(
    "Author accesses categories",
    users.premiumAuthor,
    "GET",
    "/categories",
  );
  await testEndpoint(
    "Author accesses comments",
    users.premiumAuthor,
    "GET",
    "/comments",
  );

  // Test 5: Admin privileges
  console.log("\n=== ADMIN TESTS ===");

  await testEndpoint(
    "Admin accesses articles",
    users.admin,
    "GET",
    "/articles",
  );
  await testEndpoint(
    "Admin creates category",
    users.admin,
    "POST",
    "/categories",
    {
      name: "Admin Category",
      description: "Created by admin",
    },
  );

  if (articleId) {
    await testEndpoint(
      "Admin deletes article",
      users.admin,
      "DELETE",
      `/articles/${articleId}`,
    );
  }

  console.log("\n🎉 Tests completed!");
}

// Run tests when script is executed
if (require.main === module) {
  runTests().catch(console.error);
}

module.exports = { testEndpoint, users, createToken };
