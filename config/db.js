const { MongoClient } = require("mongodb");
require("dotenv").config();
const client = new MongoClient(process.env.MONGO_URL);

let db = null;

async function connectDB() {
    try {
        await client.connect();
        db = client.db(process.env.DB_NAME);
        console.log("✅ MongoDB Connected");
        console.log("Database :", process.env.DB_NAME);
    } catch (error) {
        console.error("MongoDB Connection Error:", error);
        console.log(error);
    }
}

function getDB() {
    if (!db) {
        throw new Error("Database not connected. call connectDB() first.");
    }
    return db;
}
module.exports = { connectDB, getDB };