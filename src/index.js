import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// ---- Security & logs
app.use(helmet());
app.use(morgan("tiny"));
app.set("trust proxy", true);

// ---- CORS (frontend)
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
app.use(cors({ origin: FRONTEND_ORIGIN, credentials: true }));

// ---- Health
app.get("/healthz", (_req, res) => res.send("ok"));

// ---- Dev multi-tenant headers
const ALLOW_DEV_HEADERS = (process.env.ALLOW_DEV_HEADERS || "").toLowerCase() === "true";
app.use((req, _res, next) => {
  if (ALLOW_DEV_HEADERS) {
    req.headers["x-org-id"] = req.headers["x-org-id"] || process.env.DEV_ORG_ID || "demo-org";
    req.headers["x-user-id"] = req.headers["x-user-id"] || process.env.DEV_USER_ID || "demo-user";
  }
  next();
});

// ---- Common proxy options
const PROXY_TIMEOUT = Number(process.env.API_TIMEOUT_MS || 30000);
const commonProxyOpts = {
  changeOrigin: true,
  xfwd: true,
  proxyTimeout: PROXY_TIMEOUT,
  timeout: PROXY_TIMEOUT,
  onProxyReq(proxyReq, req) {
    // forward tenant headers if present
    const orgId = req.headers["x-org-id"];
    const userId = req.headers["x-user-id"];
    if (orgId) proxyReq.setHeader("x-org-id", orgId);
    if (userId) proxyReq.setHeader("x-user-id", userId);
  },
  onError(err, req, res) {
    console.error("Proxy error:", err?.message);
    if (!res.headersSent) {
      res.status(502).json({ error: "Bad gateway" });
    }
  },
};

// ---- n8n: Cloud today, Self-host tomorrow
const N8N_BASE_URL = process.env.N8N_BASE_URL || "";      // Cloud today OR http://n8n:5678 tomorrow
const N8N_PREFIX   = process.env.N8N_PREFIX || "";         // "" for Cloud today, "/n8n" for self-host UI under a prefix

// REST API passthrough for the frontend
// Example: frontend -> https://api.upvizio.com/rest/health  -> proxies to  N8N_BASE_URL/rest/health
if (N8N_BASE_URL) {
  app.use("/rest", createProxyMiddleware({ target: N8N_BASE_URL, ...commonProxyOpts }));

  // Webhooks (prod & test)
  app.use(["/webhook", "/webhook/"], createProxyMiddleware({
    target: N8N_BASE_URL,
    ...commonProxyOpts,
    pathRewrite: (path) => path.replace(/^\/webhook/, "/webhook"),
  }));
  app.use(["/webhook-test", "/webhook-test/"], createProxyMiddleware({
    target: N8N_BASE_URL,
    ...commonProxyOpts,
    pathRewrite: (path) => path.replace(/^\/webhook-test/, "/webhook-test"),
  }));

  // UI behavior:
  if (N8N_PREFIX) {
    // Self-host mode: serve n8n UI under /n8n (or any prefix you set)
    app.use(
      N8N_PREFIX,
      createProxyMiddleware({
        target: N8N_BASE_URL,
        ...commonProxyOpts,
        // /n8n/... -> /... on n8n
        pathRewrite: (path) => path.replace(new RegExp(`^${N8N_PREFIX}`), "") || "/",
      })
    );
  } else {
    // Cloud mode: redirect /n8n/* to the Cloud UI (no UI proxying)
    app.get("/n8n/*", (_req, res) => res.redirect(302, `${N8N_BASE_URL}/`));
  }
}

// (Optional) future services go here, e.g. /bazero -> Baserow self-host (not needed for Baserow Cloud)

// ---- 404
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => {
  console.log(`Proxy running on :${PORT}`);
});
