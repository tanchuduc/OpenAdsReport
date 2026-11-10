import type {
  AccountRef, AccountReport, AccountSummary, AdFatigueRow, AdProvider, AdWindowMetrics,
  DailyPoint, DateRange, MetaAudit, Metrics,
} from "./types";
import type { ConnectionsEnv } from "@clawnify/connections";
import { buildKpis, cpa as cpaOf, ctr as ctrOf, deriveIssues, emptyMetrics, metrics } from "../metrics";

type MetaAction = { action_type: string; value: string };

function pickAction(arr: MetaAction[] | undefined, type: string): number {
  const omni = arr?.find((a) => a.action_type === `omni_${type}`);
  const direct = arr?.find((a) => a.action_type === type);
  return +((omni ?? direct)?.value ?? 0);
}

function rowMetrics(row: any): Metrics {
  return metrics({
    spend: +(row.spend ?? 0),
    revenue: pickAction(row.action_values, "purchase"),
    conversions: pickAction(row.actions, "purchase"),
    clicks: +(row.clicks ?? 0),
    impressions: +(row.impressions ?? 0),
  });
}

const first = (rows: any[]): Metrics => (rows[0] ? rowMetrics(rows[0]) : emptyMetrics());

function toDailyPoint(row: any): DailyPoint {
  const m = rowMetrics(row);
  return {
    date: row.date_start!,
    spend: m.spend, revenue: m.revenue, conversions: m.conversions, clicks: m.clicks,
    impressions: m.impressions, roas: m.roas, convRate: m.convRate, ctr: m.ctr,
  };
}

const AD_FIELDS = [
  "ad_id", "ad_name", "adset_name", "campaign_name",
  "spend", "impressions", "clicks", "frequency", "cpm", "actions", "action_values",
];

function adWindow(row: any): AdWindowMetrics {
  const spend = +(row.spend ?? 0);
  const clicks = +(row.clicks ?? 0);
  const impressions = +(row.impressions ?? 0);
  const conversions = pickAction(row.actions, "purchase");
  return {
    spend,
    impressions,
    clicks,
    conversions,
    frequency: row.frequency != null ? +row.frequency : null,
    ctr: ctrOf(clicks, impressions),
    cpm: row.cpm != null ? +row.cpm : impressions > 0 ? (spend / impressions) * 1000 : 0,
    cpa: cpaOf(spend, conversions),
  };
}

function createDirectMetaClient(token: string) {
  const base = "https://graph.facebook.com/v21.0";
  return {
    async adAccounts(fields = "id,name,currency,account_status") {
      const res = await fetch(`${base}/me/adaccounts?fields=${fields}&limit=100&access_token=${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error(`Meta API error: ${await res.text()}`);
      const data: any = await res.json();
      return data?.data ?? [];
    },
    async insights(objectId: string, opts: any = {}) {
      const id = objectId.startsWith("act_") ? objectId : `act_${objectId}`;
      const params = new URLSearchParams();
      params.set("access_token", token);
      params.set("level", opts.level ?? "account");
      const f = opts.fields ?? ["spend", "impressions", "clicks", "actions", "action_values"];
      params.set("fields", Array.isArray(f) ? f.join(",") : f);
      if (opts.since && opts.until) {
        params.set("time_range", JSON.stringify({ since: opts.since, until: opts.until }));
      } else {
        params.set("date_preset", opts.datePreset ?? "last_30d");
      }
      if (opts.timeIncrement != null) params.set("time_increment", String(opts.timeIncrement));
      const res = await fetch(`${base}/${id}/insights?${params.toString()}`);
      if (!res.ok) throw new Error(`Meta Insights error: ${await res.text()}`);
      const data: any = await res.json();
      return data?.data ?? [];
    },
    async object(objectId: string, fields: string[] = ["name", "currency"]) {
      const id = objectId.startsWith("act_") ? objectId : `act_${objectId}`;
      const res = await fetch(`${base}/${id}?fields=${fields.join(",")}&access_token=${encodeURIComponent(token)}`);
      if (!res.ok) throw new Error(`Meta Object error: ${await res.text()}`);
      return await res.json();
    }
  };
}

export class MetaProvider implements AdProvider {
  readonly id = "meta" as const;
  constructor(private client: any) {}

  static async create(env: ConnectionsEnv): Promise<MetaProvider | null> {
    const token = (env as any).METAADS_BEARER_TOKEN || (env as any).METAADS_ACCESS_TOKEN;
    if (!token) return null;
    return new MetaProvider(createDirectMetaClient(token));
  }

  isConnected() { return true; }

  async listAccounts(): Promise<AccountRef[]> {
    const accounts = await this.client.adAccounts("name,currency,account_status");
    return accounts
      .filter((a: any) => a.account_status === 1)
      .map((a: any) => ({ id: a.id, name: a.name ?? a.id, platform: "meta" as const, currency: a.currency ?? "VND" }));
  }

  async accountSummaries(range: DateRange): Promise<AccountSummary[]> {
    const accounts = await this.listAccounts();
    return Promise.all(
      accounts.map(async (acc) => {
        const [cur, prev] = await Promise.all([
          this.client.insights(acc.id, { level: "account", since: range.since, until: range.until }),
          this.client.insights(acc.id, { level: "account", since: range.prevSince, until: range.prevUntil }),
        ]);
        return { ...acc, metrics: first(cur), prev: prev[0] ? rowMetrics(prev[0]) : null };
      }),
    );
  }

  async accountReport(accountId: string, range: DateRange): Promise<AccountReport> {
    const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
    const [obj, cur, prev, daily] = await Promise.all([
      this.client.object(id, ["name", "currency"]),
      this.client.insights(id, { level: "account", since: range.since, until: range.until }),
      this.client.insights(id, { level: "account", since: range.prevSince, until: range.prevUntil }),
      this.dailySeries(id, range.since, range.until),
    ]);

    const curM = first(cur);
    const prevM = prev[0] ? rowMetrics(prev[0]) : null;
    const account: AccountRef = { id, name: obj.name ?? id, platform: "meta", currency: obj.currency ?? "VND" };

    return {
      account,
      range: { since: range.since, until: range.until, days: range.days },
      kpis: buildKpis(curM, prevM),
      daily,
      channels: [{ platform: "meta", metrics: curM }],
      issues: deriveIssues(curM, prevM, daily, account.currency),
      generatedAt: new Date().toISOString(),
      preview: false,
    };
  }

  async dailySeries(accountId: string, since: string, until: string): Promise<DailyPoint[]> {
    const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
    const rows = await this.client.insights(id, { level: "account", since, until, timeIncrement: 1 });
    return rows.filter((row: any) => row.date_start).map(toDailyPoint);
  }

  async adFatigue(accountId: string, range: DateRange): Promise<AdFatigueRow[]> {
    const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
    const start = new Date(range.since + "T00:00:00Z");
    const end = new Date(range.until + "T00:00:00Z");
    const mid = new Date(start.getTime() + Math.floor((end.getTime() - start.getTime()) / 2));
    const midNext = new Date(mid);
    midNext.setUTCDate(midNext.getUTCDate() + 1);
    const iso = (d: Date) => d.toISOString().split("T")[0];

    const [curRows, prevRows] = await Promise.all([
      this.client.insights(id, { level: "ad", fields: AD_FIELDS, since: iso(midNext), until: range.until }),
      this.client.insights(id, { level: "ad", fields: AD_FIELDS, since: range.since, until: iso(mid) }),
    ]);

    const prevById = new Map(prevRows.filter((r: any) => r.ad_id).map((r: any) => [String(r.ad_id), r]));
    return curRows
      .filter((r: any) => r.ad_id)
      .map((r: any) => {
        const prev = prevById.get(String(r.ad_id));
        return {
          adId: String(r.ad_id),
          adName: String(r.ad_name ?? r.ad_id),
          adsetName: String(r.adset_name ?? ""),
          campaignName: String(r.campaign_name ?? ""),
          current: adWindow(r),
          prev: prev ? adWindow(prev) : null,
        };
      })
      .sort((a: any, b: any) => b.current.spend - a.current.spend);
  }

  async auditData(accountId: string, range: DateRange): Promise<MetaAudit> {
    const id = accountId.startsWith("act_") ? accountId : `act_${accountId}`;
    const [ads, totals] = await Promise.all([
      this.adFatigue(accountId, range).catch(() => [] as AdFatigueRow[]),
      this.client.insights(id, { level: "account", since: range.since, until: range.until }),
    ]);
    const row = totals[0];
    return {
      platform: "meta",
      ads,
      hasPurchaseTracking: pickAction(row?.actions, "purchase") > 0,
      hasValueTracking: pickAction(row?.action_values, "purchase") > 0,
    };
  }
}
