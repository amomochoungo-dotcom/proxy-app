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

// ---------- CORS (depuis ton frontend) — autorise plusieurs origines et renvoie l'origine exacte
const ORIGINS =
  (process.env.FRONTEND_ORIGIN || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

// Important pour les caches/intermédiaires quand l'origine varie
app.use((req, res, next) => { res.header("Vary", "Origin"); next(); });

app.use(cors({
  origin: (origin, cb) => {
    // Requêtes sans header Origin (ex: cURL, même origine) → OK
    if (!origin) return cb(null, true);
    // Pas de liste configurée → autorise (fallback dev)
    if (ORIGINS.length === 0) return cb(null, true);
    // Autorise si l'origine demandée est dans la liste
    if (ORIGINS.includes(origin)) return cb(null, true);
    // Sinon refuse (le navigateur bloquera la réponse)
    return cb(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-org-id", "x-user-id","x-api-key"],
}));

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
    const apiKey = req.headers["x-api-key"];
    if (orgId) proxyReq.setHeader("x-org-id", orgId);
    if (userId) proxyReq.setHeader("x-user-id", userId);
     if (apiKey) proxyReq.setHeader("x-api-key", apiKey); 
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
  // --- Préflight dédié aux webhooks n8n (OPTIONS) ---
// Répond 204 + en-têtes CORS exacts, en écho de la requête
app.options('/n8n/webhook/*', (req, res) => {
  const origin = req.headers.origin || '';
  const isAllowed = ORIGINS.length === 0 || ORIGINS.includes(origin);
  if (isAllowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  // Écho des headers demandés par le navigateur (le plus robuste)
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'content-type, x-org-id, x-api-key'
  );
  res.status(204).end();
});

// --- En-têtes CORS aussi sur le POST réel vers /n8n/webhook/* ---
app.use('/n8n/webhook', (req, res, next) => {
  const origin = req.headers.origin || '';
  const isAllowed = ORIGINS.length === 0 || ORIGINS.includes(origin);
  if (isAllowed && origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  next();
});
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
