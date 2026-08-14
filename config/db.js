// const { MongoClient } = require("mongodb");
// require("dotenv").config();
// const client = new MongoClient(process.env.MONGO_URL);

// let db = null;

// async function connectDB() {
//     try {
//         await client.connect();
//         db = client.db(process.env.DB_NAME);
//         console.log("✅ MongoDB Connected");
//         console.log("Database :", process.env.DB_NAME);
//     } catch (error) {
//         console.error("MongoDB Connection Error:", error);
//         console.log(error);
//     }
// }

// function getDB() {
//     if (!db) {
//         throw new Error("Database not connected. call connectDB() first.");
//     }
//     return db;
// }
// module.exports = { connectDB, getDB };


const { MongoClient } = require("mongodb");
require("dotenv").config();

const mongoUrl =
    process.env.MONGO_URL ||
    process.env.MONGO_URI ||
    process.env.MONGODB_URI;

if (!mongoUrl) {
    throw new Error(
        "MongoDB URL is missing. Please set MONGO_URL in Heroku Config Vars."
    );
}

const client = new MongoClient(mongoUrl);

let db = null;

async function connectDB() {
    try {
        await client.connect();

        db = client.db(process.env.DB_NAME);

        console.log("✅ MongoDB Connected");
        console.log("Database:", process.env.DB_NAME);
    } catch (error) {
        console.error("❌ MongoDB Connection Error:", error.message);
        throw error;
    }
}

function getDB() {
    if (!db) {
        throw new Error("Database not connected. Call connectDB() first.");
    }

    return db;
}

module.exports = {
    connectDB,
    getDB
};