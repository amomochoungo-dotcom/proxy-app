// src/index.js

import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import { createProxyMiddleware } from "http-proxy-middleware";

const app = express();
const PORT = Number(process.env.PORT || 8080);

// ========== SUPABASE JWT VALIDATION CONFIG ==========
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const N8N_SERVICE_API_KEY = process.env.N8N_SERVICE_API_KEY || "";

// ---------- Security & logs
app.use(helmet());
app.use(morgan("tiny"));
app.set("trust proxy", true);

// ---------- CORS origins (depuis ton frontend)
const ORIGINS = (process.env.FRONTEND_ORIGIN || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Toujours varier sur l'origine pour éviter du cache foireux
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
  allowedHeaders: [
    "Content-Type",
    "authorization",
    "x-org-id",
    "x-user-id",
    "x-api-key",
    "x-public-password",
    "apikey",
    "x-client-info"
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

// ========== JWT VALIDATION MIDDLEWARE ==========
/**
 * Validates Supabase JWT and converts to x-org-id + x-api-key for n8n
 * If no JWT present, passes through to legacy API Key mode
 */
async function validateJWT(req, res, next) {
  const authHeader = req.headers["authorization"];
  
  // If no JWT, continue with legacy API Key mode
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return next();
  }
  
  // Skip JWT validation if Supabase not configured
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_KEY) {
    console.warn("[JWT] Supabase not configured, falling back to API Key mode");
    return next();
  }
  
  const jwt = authHeader.slice(7);
  
  try {
    // 1. Validate JWT via Supabase Auth API
    const userResponse = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        apikey: SUPABASE_ANON_KEY,
      },
    });
    
    if (!userResponse.ok) {
      console.log("[JWT] Invalid token, status:", userResponse.status);
      return res.status(401).json({ error: "Invalid token" });
    }
    
    const userData = await userResponse.json();
    const userId = userData.id;
    
    if (!userId) {
      console.log("[JWT] No user ID in response");
      return res.status(401).json({ error: "Invalid token payload" });
    }
    
    // 2. Get org_id from profiles table
    const profileResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}&select=organization_id`,
      {
        headers: {
          apikey: SUPABASE_SERVICE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }
    );
    
    if (!profileResponse.ok) {
      console.log("[JWT] Profile lookup failed, status:", profileResponse.status);
      return res.status(500).json({ error: "Profile lookup failed" });
    }
    
    const profiles = await profileResponse.json();
    if (!profiles || !profiles.length) {
      console.log("[JWT] No profile found for user:", userId.slice(0, 8));
      return res.status(403).json({ error: "No organization found for this user" });
    }
    
    const orgId = profiles[0].organization_id;
    
    // 3. Convert to headers for n8n
    req.headers["x-org-id"] = String(orgId);
    req.headers["x-api-key"] = N8N_SERVICE_API_KEY;
    req.headers["x-user-id"] = userId;
    
    // Remove Authorization header (n8n uses x-api-key)
    delete req.headers["authorization"];
    
    console.log("[JWT] ✓ Validated:", { userId: userId.slice(0, 8) + "...", orgId });
    next();
    
  } catch (err) {
    console.error("[JWT] Validation error:", err.message);
    return res.status(500).json({ error: "Auth validation failed" });
  }
}

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
      const pubPwd = req.headers["x-public-password"];

      if (orgId)  proxyReq.setHeader("x-org-id", orgId);
      if (userId) proxyReq.setHeader("x-user-id", userId);
      if (apiKey) proxyReq.setHeader("x-api-key", apiKey);
      if (pubPwd) proxyReq.setHeader("x-public-password", pubPwd);

      console.log("[n8n proxy] →", req.method, req.originalUrl);
    },
    onError(err, _req, res) {
      console.error("Proxy error:", err?.message);
      if (!res.headersSent) res.status(502).json({ error: "Bad gateway" });
    },
  };

  // --------- PRE-FLIGHT CORS: OPTIONS pour /n8n/webhook/* ET /n8n/webhook-test/*
  function preflightHandler(req, res) {
    const origin = req.headers.origin || "";
    const isAllowed = ORIGINS.length === 0 || ORIGINS.includes(origin);
    if (isAllowed && origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
    }
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", req.headers["access-control-request-method"] || "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"] || "content-type, authorization, x-org-id, x-api-key, x-public-password, apikey, x-client-info");
    res.setHeader("Access-Control-Max-Age", "86400");
    return res.status(204).end();
  }
  app.options("/n8n/webhook/*", preflightHandler);
  app.options("/n8n/webhook-test/*", preflightHandler);

  // --------- CORS headers sur toutes les vraies réponses /n8n/*
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

  // --------- JWT VALIDATION (NEW - validates token and resolves org_id)
  app.use("/n8n", validateJWT);

  // --------- Proxy to n8n
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
  if (SUPABASE_URL) {
    console.log(`JWT validation enabled (Supabase: ${SUPABASE_URL})`);
  } else {
    console.log(`JWT validation disabled (SUPABASE_URL not set)`);
  }
});
