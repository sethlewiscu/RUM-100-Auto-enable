import express from "express";
import { getConfig } from "./lib/config.js";
import { router as webhookRouter } from "./routes/webhook.js";

// Validate config at boot — fail fast with a clear message if a secret/env var
// is missing rather than 500ing on the first webhook.
let config;
try {
  config = getConfig();
} catch (err) {
  console.error(`[boot] configuration error: ${err.message}`);
  process.exit(1);
}

const app = express();

app.get("/health", (_req, res) => res.json({ status: "ok" }));

// The ClickUp Automation posts to the bare domain, so the handler lives at root.
app.use("/", webhookRouter);

app.listen(config.port, () => {
  console.log(`[boot] RUM auto-approve server listening on port ${config.port}`);
});
