const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    // Set a timeout so it doesn't hang forever
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000 
    });
    
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error(`❌ MongoDB Connection Error: ${error.message}`);
    // Check if it's an IP whitelist error
    if (error.message.includes('DSDNS')) {
      console.log('👉 Tip: Check your MongoDB Atlas Network Access (IP Whitelist).');
    }
    process.exit(1); 
  }
};

module.exports = connectDB;