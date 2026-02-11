import { MongoClient } from "mongodb";

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017";
const DB_NAME = process.env.DB_NAME || "las_app";

let client;
let db;

export async function connectMongo() {
  if (db) return db;

  client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(DB_NAME);

  // Collections
  const wells = db.collection("wells");
  const points = db.collection("well_points");

  // Indexes (critical)
  await wells.createIndex({ wellId: 1 }, { unique: true });
  await points.createIndex({ wellId: 1, depth: 1 });

  console.log(`✅ Mongo connected: ${DB_NAME}`);
  return db;
}

export function getDb() {
  if (!db) throw new Error("Mongo not connected. Call connectMongo() first.");
  return db;
}
