import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

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
app.use(cors(corsOptions));
app.use(cookieParser());
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

export default app;
