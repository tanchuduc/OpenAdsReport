import { createApp } from "@clawnify/app";
import type { Bindings } from "./env";
import api from "./routes";

// Credentials are resolved per-request by @clawnify/connections straight off
// `env` (the CREDENTIALS broker binding + injected secrets), so there's no
// credential bootstrapping middleware to run here anymore.
const app = createApp<{ Bindings: Bindings }>({
  title: "OpenAdsReport",
  version: "1.0.0",
  description:
    "Cross-platform ads dashboard. Syncs spend, ROAS, conversions and CPA from Meta and Google Ads on a schedule, serves Account and Portfolio views from the synced data, surfaces the top issues hurting performance, and exposes everything as a clean JSON API for Clawnify agents.",
  db: true,
});

app.route("/", api);

app.all("*", (c) => {
  return (c.env as any).ASSETS ? (c.env as any).ASSETS.fetch(c.req.raw) : c.text("Not Found", 404);
});

export default app;
