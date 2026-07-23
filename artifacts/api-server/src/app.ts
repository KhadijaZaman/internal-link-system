import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors, { type CorsOptions } from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import { clerkMiddleware } from "@clerk/express";
import { publishableKeyFromHost } from "@clerk/shared/keys";
import {
  CLERK_PROXY_PATH,
  clerkProxyMiddleware,
  getClerkProxyHost,
} from "./middlewares/clerkProxyMiddleware";
import router from "./routes";
import { logger } from "./lib/logger";
import { IntegrationNotConnectedError } from "./lib/siteIntegrations";

const app: Express = express();

app.set("trust proxy", 1);

function buildAllowedOrigins(): Set<string> {
  const origins = new Set<string>();
  const domains = [
    ...(process.env["REPLIT_DOMAINS"]?.split(",") ?? []),
    process.env["REPLIT_DEV_DOMAIN"],
  ];
  for (const d of domains) {
    const host = d?.trim();
    if (host) origins.add(`https://${host}`);
  }
  return origins;
}

const allowedOrigins = buildAllowedOrigins();

const corsOptions: CorsOptions = {
  credentials: true,
  origin(origin, callback) {
    // Same-origin requests and non-browser clients (curl, server-to-server)
    // send no Origin header — always allow those.
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error("Not allowed by CORS"));
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
// Clerk Frontend API proxy — must be mounted BEFORE body parsers (it
// streams raw bytes). No-op in development.
app.use(CLERK_PROXY_PATH, clerkProxyMiddleware());

app.use(cors(corsOptions));
app.use(cookieParser());

// Resolve the publishable key from the incoming request host so the same
// server can serve multiple Clerk custom domains. Falls back to
// CLERK_PUBLISHABLE_KEY when the host doesn't map to a custom domain.
app.use(
  clerkMiddleware((req) => ({
    publishableKey: publishableKeyFromHost(
      getClerkProxyHost(req) ?? "",
      process.env["CLERK_PUBLISHABLE_KEY"],
    ),
  })),
);
// Knowledge-base uploads carry long transcripts (contract caps content at
// 500K chars). Parse that path with a larger limit BEFORE the global parser —
// body-parser sets req._body and the default parser below skips it — so the
// rest of the API stays at the tighter 100KB default.
app.use("/api/kb/documents", express.json({ limit: "600kb" }));
// Bing AI Performance exports (raw CSV text in JSON; contract caps content
// at 1.5M chars) — same pattern as the KB path above.
app.use("/api/bing/ai-citations/uploads", express.json({ limit: "2mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Typed error mapping. A site without a connected data source is an expected
// state, not a server fault — surface it as a machine-readable 409 so the
// dashboard can render a "connect it in Settings" notice instead of a raw
// error. Everything else stays a logged, opaque 500 (no stack leaks).
app.use((err: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof IntegrationNotConnectedError) {
    res.status(409).json({
      error: err.message,
      code: "integration_not_connected",
      provider: err.provider,
    });
    return;
  }
  (req.log ?? logger).error({ err }, "unhandled request error");
  res.status(500).json({ error: "Internal server error" });
});

export default app;
