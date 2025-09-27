// src/index.js
import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// ---------- Security & logs
app.use(helmet());
app.use(morgan("tiny"));
app.set("trust proxy", true);

// ---------- CORS (depuis ton frontend)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));

// ---------- Health
app.get("/healthz", (_req, res) => res.send("ok"));

// ---------- Dev multi-tenant headers
const ALLOW_DEV_HEADERS = (process.env.ALLOW_DEV_HEADERS || "").toLowerCase() === "true";
app.use((req, _res, next) => {
  if (ALLOW_DEV_HEADERS) {
    req.headers["x-org-id"] = req.headers["x-org-id"] || process.env.DEV_ORG_ID || "demo-org";
    req.headers["x-user-id"] = req.headers["x-user-id"] || process.env.DEV_USER_ID || "demo-user";
  }
  next();
});

// ---------- Options communes proxy
const PROXY_TIMEOUT = Number(process.env.API_TIMEOUT_MS || 30000);
const commonProxyOpts = {
  changeOrigin: true,
  xfwd: true,
  proxyTimeout: PROXY_TIMEOUT,
  timeout: PROXY_TIMEOUT,
  logLevel: "debug",
  onProxyReq(proxyReq, req) {
    // propage les headers multi-tenant si présents + petit log
    const orgId = req.headers["x-org-id"];
    const userId = req.headers["x-user-id"];
    if (orgId) proxyReq.setHeader("x-org-id", orgId);
    if (userId) proxyReq.setHeader("x-user-id", userId);
    console.log("[n8n proxy] →", req.method, req.originalUrl);
  },
  onError(err, _req, res) {
    console.error("Proxy error:", err?.message);
    if (!res.headersSent) res.status(502).json({ error: "Bad gateway" });
  },
};

// ---------- n8n (Cloud aujourd'hui, Self-host demain)
const N8N_BASE_URL = process.env.N8N_BASE_URL || ""; // ex: https://upvizio.app.n8n.cloud  (cloud)
                                                     // ex: http://n8n:5678             (self-host docker)

if (N8N_BASE_URL) {
  // Tout ce qui commence par /n8n est passé à n8n.
  // Exemples côté client:
  //   /n8n/rest/health        -> N8N_BASE_URL/rest/health
  //   /n8n/webhook/XXX        -> N8N_BASE_URL/webhook/XXX
  //   /n8n/webhook-test/YYY   -> N8N_BASE_URL/webhook-test/YYY
  //   /n8n/ (UI)              -> N8N_BASE_URL/
  app.use(
    "/n8n",
    createProxyMiddleware({
      target: N8N_BASE_URL,
      ...commonProxyOpts,
      // enlève proprement le préfixe /n8n (avec ou sans slash après)
      pathRewrite: (path) => path.replace(/^\/n8n\/?/, "/"),
    })
  );
}

// ---------- 404
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => {
  console.log(`Proxy running on :${PORT}`);
});
