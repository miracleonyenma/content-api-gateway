// ./src/functions/user-sync.js

const { Permit } = require("permitio");

const permit = new Permit({
  pdp: process.env.PERMIT_PDP_URL,
  token: process.env.PERMIT_API_KEY,
});

exports.handler = async (event) => {
  console.log("👥 User sync request:", JSON.stringify(event, null, 2));

  try {
    const { action, userData } = JSON.parse(event.body);

    switch (action) {
      case "sync":
        // Sync user to Permit.io
        await permit.api.syncUser({
          key: userData.userId,
          email: userData.email,
          first_name: userData.firstName || "",
          last_name: userData.lastName || "",
          attributes: {
            subscription_tier: userData.subscriptionTier || "free",
            created_at: userData.createdAt || new Date().toISOString(),
            last_active: new Date().toISOString(),
          },
        });

        console.log("✅ User synced:", userData.userId);
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({
            message: "User synced successfully",
            userId: userData.userId,
          }),
        };

      case "assign-role":
        // Assign role to user
        await permit.api.assignRole({
          user: userData.userId,
          role: userData.role,
          tenant: "default",
        });

        console.log("✅ Role assigned:", userData.userId, userData.role);
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({
            message: "Role assigned successfully",
            userId: userData.userId,
            role: userData.role,
          }),
        };

      default:
        return {
          statusCode: 400,
          headers: {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          },
          body: JSON.stringify({ error: "Invalid action" }),
        };
    }
  } catch (error) {
    console.error("❌ User sync failed:", error);
    return {
      statusCode: 500,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ error: error.message }),
    };
  }
};
