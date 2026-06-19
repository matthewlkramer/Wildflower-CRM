import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import helmet from "helmet";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// CORS allowlist. The SPA is served same-origin with this API (both behind the
// shared Replit proxy), so its requests carry no cross-origin Origin and pass
// the `!origin` branch below. We additionally allow the configured app domains,
// the user-installed Magio browser extension (which calls the tracking API
// cross-origin from mail.google.com), and localhost in development. Every other
// origin is refused a CORS grant, which stops arbitrary websites from making
// credentialed requests with a signed-in user's session.
const allowedOrigins = new Set<string>();
for (const domain of (process.env.REPLIT_DOMAINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)) {
  allowedOrigins.add(`https://${domain}`);
}
const devDomain = process.env.REPLIT_DEV_DOMAIN?.trim();
if (devDomain) allowedOrigins.add(`https://${devDomain}`);
const isProduction = process.env.NODE_ENV === "production";

const corsOptions: CorsOptions = {
  credentials: true,
  origin(origin, callback) {
    // No Origin header: same-origin requests, server-to-server, curl, <img>
    // pixel loads, and extension calls that omit Origin.
    if (!origin) return callback(null, true);
    // The user-installed Magio extension calls the tracking API cross-origin.
    if (
      origin.startsWith("chrome-extension://") ||
      origin.startsWith("moz-extension://")
    ) {
      return callback(null, true);
    }
    if (allowedOrigins.has(origin)) return callback(null, true);
    if (
      !isProduction &&
      /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
    ) {
      return callback(null, true);
    }
    return callback(null, false);
  },
};

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);

app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

// Security headers. This service is a JSON + file-streaming API (no HTML pages),
// so the document-oriented CSP doesn't apply and is disabled to avoid
// interfering with streamed downloads; CORP is relaxed to cross-origin so the
// SPA can load streamed objects through the shared proxy.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);

app.use(cors(corsOptions));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(clerkMiddleware());

app.use("/api", router);

app.use("/api", (_req, res) => {
  res.status(404).json({ error: "not_found", message: "Route not found" });
});

app.use(
  (
    err: unknown,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (res.headersSent) return next(err);
    const anyErr = err as { status?: number; statusCode?: number; message?: string } | undefined;
    const status = anyErr?.status ?? anyErr?.statusCode ?? 500;
    (req as unknown as { log?: { error: (...a: unknown[]) => void } }).log?.error(
      { err },
      "Unhandled API error",
    );
    res.status(status).json({
      error: status >= 500 ? "internal_error" : "request_error",
      message:
        status >= 500 ? "Internal server error" : (anyErr?.message ?? "Request failed"),
    });
  },
);

export default app;
