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

// ---------- CORS origins (depuis ton frontend)
const ORIGINS = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Toujours varier sur l’origine pour éviter du cache foireux
app.use((req, res, next) => { res.header("Vary", "Origin"); next(); });

// CORS "général" (OK)
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ORIGINS.length === 0) return cb(null, true);
    if (ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // NEW: ajoute les headers manquants
  allowedHeaders: [
    "Content-Type",
    "authorization",           // NEW
    "x-org-id",
    "x-user-id",
    "x-api-key",
    "x-public-password",       // NEW
    "apikey",                  // NEW
    "x-client-info"            // NEW
  ],
}));

// ---------- Health
app.get("/healthz", (_req, res) => res.send("ok"));

// ---------- Dev multi-tenant headers
const ALLOW_DEV_HEADERS = (process.env.ALLOW_DEV_HEADERS || "").toLowerCase() === "true";
app.use((req, _res, next) => {
  if (ALLOW_DEV_HEADERS) {
    req.headers["x-org-id"]  = req.headers["x-org-id"]  || process.env.DEV_ORG_ID  || "demo-org";
    req.headers["x-user-id"] = req.headers["x-user-id"] || process.env.DEV_USER_ID || "demo-user";
  }
  next();
});

// ---------- Proxy n8n
const N8N_BASE_URL = process.env.N8N_BASE_URL || ""; // ex: https://n8n.upvizio.com

if (N8N_BASE_URL) {
  const PROXY_TIMEOUT = Number(process.env.API_TIMEOUT_MS || 30000);

  const commonProxyOpts = {
    changeOrigin: true,
    xfwd: true,
    proxyTimeout: PROXY_TIMEOUT,
    timeout: PROXY_TIMEOUT,
    logLevel: "debug",
    onProxyReq(proxyReq, req) {
      // propage les headers multi-tenant si présents + password public
      const orgId  = req.headers["x-org-id"];
      const userId = req.headers["x-user-id"];
      const apiKey = req.headers["x-api-key"];
      const pubPwd = req.headers["x-public-password"]; // NEW

      if (orgId)  proxyReq.setHeader("x-org-id", orgId);
      if (userId) proxyReq.setHeader("x-user-id", userId);
      if (apiKey) proxyReq.setHeader("x-api-key", apiKey);
      if (pubPwd) proxyReq.setHeader("x-public-password", pubPwd); // NEW

      console.log("[n8n proxy] →", req.method, req.originalUrl);
    },
    onError(err, _req, res) {
      console.error("Proxy error:", err?.message);
      if (!res.headersSent) res.status(502).json({ error: "Bad gateway" });
    },
  };

  // --------- PRE-FLIGHT CORS: OPTIONS pour /n8n/webhook/* ET /n8n/webhook-test/* (NEW)
  function preflightHandler(req, res) {
    const origin = req.headers.origin || "";
    const isAllowed = ORIGINS.length === 0 || ORIGINS.includes(origin);
    if (isAllowed && origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Vary", "Origin");
    // écho la méthode et les headers demandés par le navigateur
    res.setHeader("Access-Control-Allow-Methods", req.headers["access-control-request-method"] || "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "content-type, authorization, x-org-id, x-api-key, x-public-password, apikey, x-client-info");
    res.setHeader("Access-Control-Max-Age", "86400");
    return res.status(204).end();
  }
  app.options("/n8n/webhook/*", preflightHandler);      // NEW
  app.options("/n8n/webhook-test/*", preflightHandler); // NEW

  // --------- CORS headers aussi sur toutes les vraies réponses /n8n/*
  app.use("/n8n", (req, res, next) => {
    const origin = req.headers.origin || "";
    const isAllowed = ORIGINS.length === 0 || ORIGINS.includes(origin);
    if (isAllowed && origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Vary", "Origin");
    next();
  });

  // --------- Proxy
  app.use(
    "/n8n",
    createProxyMiddleware({
      target: N8N_BASE_URL,
      ...commonProxyOpts,
      pathRewrite: (path) => path.replace(/^\/n8n\/?/, "/"),
    })
  );
}

// ---------- 404
app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.listen(PORT, () => {
  console.log(`Proxy running on :${PORT}`);
});
