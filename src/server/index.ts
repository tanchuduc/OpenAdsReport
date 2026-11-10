import { createApp } from "@clawnify/app";
import type { Bindings } from "./env";
import api from "./routes";
import { runSync } from "./sync";

const app = createApp<{ Bindings: Bindings }>({
  title: "OpenAdsReport",
  version: "1.0.0",
  description:
    "Cross-platform ads dashboard. Syncs spend, ROAS, conversions and CPA from Meta and Google Ads on a schedule, serves Account and Portfolio views from the synced data, surfaces the top issues hurting performance, and exposes everything as a clean JSON API for Clawnify agents.",
  db: true,
});

app.onError((err, c) => {
  return c.json({ error: err.message }, 500);
});

app.route("/", api);

app.all("*", (c) => {
  return (c.env as any).ASSETS ? (c.env as any).ASSETS.fetch(c.req.raw) : c.text("Not Found", 404);
});

export default {
  fetch: app.fetch,
  async scheduled(event: any, env: any, ctx: any) {
    if (ctx?.waitUntil) {
      ctx.waitUntil(runSync(env).catch((e) => console.error("Cron sync error:", e)));
    } else {
      await runSync(env).catch((e) => console.error("Cron sync error:", e));
    }
  },
};

