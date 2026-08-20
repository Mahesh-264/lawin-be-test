const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const dotenv = require("dotenv");

dotenv.config();

const User = require("../models/User");

async function resetAllPasswords() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);

    console.log("✅ Connected to MongoDB");

    // New password for everyone
    const newPassword = "Verdits@1234";

    // Hash using the same salt rounds as your project
    const hashedPassword = await bcrypt.hash(newPassword, 12);

    // Update all users
    const result = await User.updateMany(
      {},
      {
        $set: {
          password: hashedPassword,
        },
      }
    );

    console.log("\n======================================");
    console.log("✅ PASSWORD RESET COMPLETED");
    console.log("======================================");
    console.log(`Users Updated : ${result.modifiedCount}`);
    console.log(`New Password  : ${newPassword}`);
    console.log("======================================\n");

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error("\n❌ ERROR RESETTING PASSWORDS");
    console.error(error);

    try {
      await mongoose.disconnect();
    } catch (_) {}

    process.exit(1);
  }
}

resetAllPasswords();