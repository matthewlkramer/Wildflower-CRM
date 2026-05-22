import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { CLERK_PROXY_PATH, clerkProxyMiddleware } from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

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

app.use(cors({ credentials: true, origin: true }));
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
