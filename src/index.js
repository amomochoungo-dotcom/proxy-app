import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = process.env.PORT || 8080;

// BASIC SECURITY + LOGS
app.use(helmet());
app.use(morgan("tiny"));

// CORS (allow your frontend)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  })
);

// HEALTH
app.get("/healthz", (_req, res) => res.send("ok"));

// TENANT INJECTION (dev mode)
const allowDevHeaders = process.env.ALLOW_DEV_HEADERS === "true";

app.use((req, _res, next) => {
  // In production, you’d read a JWT and set orgId/userId here.
  // For now, allow dev fallback if enabled.
  if (allowDevHeaders) {
    req.headers["x-org-id"] = process.env.DEV_ORG_ID || "demo-org";
    req.headers["x-user-id"] = process.env.DEV_USER_ID || "demo-user";
  }
  next();
});

// FORWARD EVERYTHING UNDER /n8n TO YOUR N8N
const N8N_BASE_URL = process.env.N8N_BASE_URL; // e.g., https://your-n8n-cloud
app.use(
  "/n8n",
  createProxyMiddleware({
    target: N8N_BASE_URL,
    changeOrigin: true,
    pathRewrite: { "^/n8n": "" }, // /n8n/* -> /* on n8n
    headers: {
      // pass org/user to n8n
      "x-org-id": (req) => req.headers["x-org-id"],
      "x-user-id": (req) => req.headers["x-user-id"],
    },
  })
);

// Example API for your frontend (proxy to n8n workflows)
app.use(
  "/api",
  createProxyMiddleware({
    target: N8N_BASE_URL,
    changeOrigin: true
  })
);

app.listen(PORT, () => {
  console.log(`Proxy running on :${PORT}`);
});
