import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = process.env.PORT || 8080;

// ---- Security & logs
app.use(helmet());
app.use(morgan("tiny"));
app.set("trust proxy", true);

// ---- CORS (depuis ton frontend)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
app.use(
  cors({
    origin: FRONTEND_ORIGIN,
    credentials: true,
  })
);

// ---- Health
app.get("/healthz", (_req, res) => res.send("ok"));

// ---- Dev headers (multi-tenant côté dev)
const allowDevHeaders = process.env.ALLOW_DEV_HEADERS === "true";
app.use((req, _res, next) => {
  if (allowDevHeaders) {
    req.headers["x-org-id"] = process.env.DEV_ORG_ID || "demo-org";
    req.headers["x-user-id"] = process.env.DEV_USER_ID || "demo-user";
  }
  next();
});

// ---- Proxy n8n
const N8N_BASE_URL = process.env.N8N_BASE_URL; // ex: https://upvizio.app.n8n.cloud

app.use(
  "/n8n",
  createProxyMiddleware({
    target: N8N_BASE_URL,
    changeOrigin: true,
    xfwd: true,
    // /n8n/... -> /... côté n8n
    pathRewrite: { "^/n8n": "/" },
    // si le target est en https avec un cert valide, pas besoin de secure:false
    // secure: true (par défaut)
    proxyTimeout: 30_000,
    timeout: 30_000,
    onProxyReq(proxyReq, req) {
      // propage les headers multi-tenant si présents
      const orgId = req.headers["x-org-id"];
      const userId = req.headers["x-user-id"];
      if (orgId) proxyReq.setHeader("x-org-id", orgId);
      if (userId) proxyReq.setHeader("x-user-id", userId);
    },
  })
);

// ---- (Optionnel) Proxy /api vers n8n si tu appelles ses endpoints REST
app.use(
  "/api",
  createProxyMiddleware({
    target: N8N_BASE_URL,
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: 30_000,
    timeout: 30_000,
  })
);

app.listen(PORT, () => {
  console.log(`Proxy running on :${PORT}`);
});
