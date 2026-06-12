import express from "express";
import { getConfig } from "./lib/config.js";
import { router as webhookRouter } from "./routes/webhook.js";
import { log, tokenType, serializeError } from "./lib/logger.js";

// Last-resort handlers: today a throw in an async path can vanish silently.
// Log the full stack so it surfaces in the terminal during live debugging.
process.on("unhandledRejection", (reason) => {
  log.error("[process] unhandledRejection", { err: serializeError(reason) });
});
process.on("uncaughtException", (err) => {
  log.error("[process] uncaughtException", { err });
});

// Validate config at boot — fail fast with a clear message if a secret/env var
// is missing rather than 500ing on the first webhook.
let config;
try {
  config = getConfig();
} catch (err) {
  log.error(`[boot] configuration error: ${err.message}`, { err });
  process.exit(1);
}

const app = express();

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// The ClickUp Automation posts to the bare domain, so the handler lives at root.
app.use("/", webhookRouter);

// Last-resort error middleware — anything thrown synchronously in the route
// stack lands here with its stack intact instead of a bare 500.
app.use((err, _req, res, _next) => {
  log.error("[express] unhandled error in request", { err });
  res.status(500).json({ error: "internal error" });
});

app.listen(config.port, () => {
  log.info(`[boot] RUM auto-approve server listening on port ${config.port}`);
  // Non-secret diagnostic: token *type* prefix only (e.g. "sat.", "pat."), never
  // the secret — makes the deployed auth config verifiable in the console.
  log.info(
    `[boot] Split auth=Bearer | create token ${tokenType(config.split.apiToken)} | approve token ${tokenType(config.split.approveToken)}`,
  );
});
