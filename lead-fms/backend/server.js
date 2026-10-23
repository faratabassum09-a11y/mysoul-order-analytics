import "dotenv/config";
import express from "express";
import cors from "cors";
import compression from "compression";
import mongoose from "mongoose";

import authRoutes from "./routes/auth.js";
import leadRoutes from "./routes/leads.js";
import { requireAuth } from "./middleware/auth.js";
import { startJobs } from "./utils/leadService.js";

const app = express();

// In production the backend (Render) and frontend (Vercel) live on different domains, so the
// browser needs an explicit CORS allow-list. Set FRONTEND_URL to your frontend URL(s), comma
// separated. With no FRONTEND_URL set, all origins are allowed — fine for local dev.
const allowedOrigins = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(",").map((s) => s.trim()) : null;
app.use(cors({ origin: allowedOrigins || true }));
app.use(express.json({ limit: "1mb" }));
// Gzip every response — the Leads list is thousands of rows of JSON.
app.use(compression({ threshold: 1024 }));

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.use("/api/auth", authRoutes);
// Everything else needs a signed-in user. Admin-only routes are guarded inside the router.
app.use("/api", requireAuth, leadRoutes);

// Free-tier hosts (Render) put the server to sleep after ~15 minutes with no traffic; the first
// request afterwards can take 30-50 seconds. Render sets RENDER_EXTERNAL_URL automatically — when
// it is present the server pings its own /api/health every 10 minutes. KEEP_ALIVE=0 turns it off.
function startKeepAlive() {
  const url = process.env.RENDER_EXTERNAL_URL;
  if (!url || process.env.KEEP_ALIVE === "0") return;
  setInterval(() => fetch(`${url.replace(/\/$/, "")}/api/health`).catch(() => {}), 10 * 60 * 1000).unref();
  console.log("[keep-alive] Self-ping enabled");
}

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/lead_fms";

mongoose
  .connect(MONGO_URI, { serverSelectionTimeoutMS: 10_000 })
  .then(() => {
    console.log("MongoDB connected");
    app.listen(PORT, () => console.log(`Lead FMS API running on port ${PORT}`));
    startKeepAlive();
    startJobs();
  })
  .catch((err) => {
    console.error("MongoDB connection error:", err.message);
    process.exit(1);
  });
