// Phase 2 — the analyst report engine. A report is a typed document (sections of
// blocks) the app assembles from REAL numbers (KPIs, charts, tables computed
// server-side) plus an AI-authored analysis layer (executive summary, findings,
// recommendations). The app owns the math; the model writes the prose. When no
// OPENROUTER_API_KEY is present it falls back to deterministic heuristics, so the
// report always renders. Analyst, not manager: findings + advice only, no actions.

import type { AccountReport, AdFatigueRow, AuditData, DailyPoint, Issue, Metrics, Platform, SearchTermRow } from "./providers/types";
import type { LandingPageRow, LandingPagesResult } from "./providers/ga";
import { deriveIssues } from "./metrics";
import { flagFatigue, scaleCandidates, scoreAudit, summarizeWaste, type Rating, type ScoredAudit } from "./audit";
import { type AIConfig, callAI, parseJsonSafe } from "./ai";

// ── Document schema (mirrored client-side in report.tsx) ─────────────────────

export type Severity = "high" | "medium" | "low";
export type Tone = "good" | "warn" | "bad" | "info";

export interface Cell {
  text: string;
  align?: "left" | "right";
  tone?: Tone;
  /** 0..1 — draws a small inline bar behind the value (perf cells). */
  bar?: number;
}

export type Block =
  | { kind: "prose"; text: string }
  | { kind: "kpis"; items: { label: string; value: string; deltaPct?: number | null; higherIsBetter?: boolean }[] }
  | { kind: "chart"; chart: "spend-roas" | "conv-rate" | "clicks-ctr"; barLabel: string; lineLabel: string }
  | { kind: "table"; columns: { label: string; align?: "left" | "right" }[]; rows: Cell[][] }
  | { kind: "findings"; items: { title: string; detail: string; severity: Severity; recommendation?: string }[] }
  | { kind: "recommendations"; items: { text: string; priority: "P0" | "P1" | "P2"; impact?: string }[] }
  | { kind: "callout"; tone: Tone; text: string }
  | {
      kind: "scorecard";
      score: number;
      rating: Rating;
      categories: { name: string; rating: Rating | null; tone: Tone; score: number | null; detail: string; atStake?: string; worst?: boolean }[];
    };

export interface Section {
  /** Uppercase zone label (the design-system eyebrow). */
  eyebrow: string;
  /** Optional right-aligned count/meta shown next to the eyebrow. */
  note?: string;
  blocks: Block[];
}

export interface ReportDoc {
  recipe: string;
  title: string;
  subtitle: string;
  account: { name: string; platform: Platform; currency: string };
  range: { since: string; until: string; days: number };
  health: { label: "Healthy" | "Watch" | "At risk" | "Khỏe mạnh" | "Cần theo dõi" | "Rủi ro cao" | string; tone: Tone; line: string };
  sections: Section[];
  /** Backs the chart blocks (kept once, not per-block). */
  daily: DailyPoint[];
  ai: boolean;
  preview: boolean;
  generatedAt: string;
}

// ── Recipe registry (the "AI analyst" gallery) ───────────────────────────────

export interface RecipeMeta {
  id: string;
  name: string;
  blurb: string;
  /** false → shown in the gallery as "coming soon", not yet generatable. */
  available: boolean;
  /** Platforms the recipe can run against (both when omitted-equivalent full list). */
  platforms: Platform[];
}

export const RECIPES: RecipeMeta[] = [
  { id: "account-audit", name: "Kiểm toán tài khoản", blurb: "Đánh giá sức khỏe tổng thể — chấm điểm /100 về tracking, lãng phí, độ phủ và mẫu quảng cáo, xếp hạng ưu tiên khắc phục.", available: true, platforms: ["meta", "google"] },
  { id: "search-terms", name: "Truy vấn tìm kiếm", blurb: "Phát hiện chi tiêu lãng phí và cơ hội thêm từ khóa phủ định.", available: true, platforms: ["google"] },
  { id: "creative-fatigue", name: "Độ bão hòa quảng cáo", blurb: "Quảng cáo suy giảm hiệu quả — nên tạm dừng, làm mới hay mở rộng quy mô.", available: true, platforms: ["meta"] },
  { id: "landing-page", name: "Phân tích trang đích", blurb: "Điểm thất thoát sau nhấp chuột — chuyển đổi giảm, tỷ lệ thoát tăng và thứ tự ưu tiên tối ưu theo doanh thu có thể cứu vãn.", available: true, platforms: ["meta", "google"] },
];

/** Data the routes pre-fetch for a recipe; only the field the recipe needs is set. */
export interface RecipeData {
  audit?: AuditData | null;
  terms?: SearchTermRow[];
  ads?: AdFatigueRow[];
  pages?: LandingPagesResult;
}

// ── Formatters (server-side → report carries display strings) ─────────────────

const money = (n: number, cur: string) => {
  if (cur === "VND" || cur === "VNĐ") {
    return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(Math.round(n));
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n);
};
const moneyK = (n: number, cur = "VND") => {
  if (cur === "VND" || cur === "VNĐ") {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)} Tỷ ₫`;
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} Tr ₫`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K ₫`;
    return `${Math.round(n)} ₫`;
  }
  return n >= 1000 ? `$${(n / 1000).toFixed(1)}K` : `$${n.toFixed(0)}`;
};
const num = (n: number) => new Intl.NumberFormat("vi-VN").format(Math.round(n));
const pct = (n: number) => `${n.toFixed(1)}%`;
const xroas = (n: number) => `${n.toFixed(1)}x`;
const roasTone = (r: number): Tone => (r >= 2.5 ? "good" : r >= 1 ? "warn" : "bad");

// ── AI analysis layer ────────────────────────────────────────────────────────

interface Analysis {
  summary: string;
  findings: { title: string; detail: string; severity: Severity; recommendation?: string }[];
  recommendations: { text: string; priority: "P0" | "P1" | "P2" }[];
}

const SYSTEM = (reportName: string) => `You are a senior paid-media analyst writing a ${reportName} report for a client.
You DIAGNOSE and ADVISE — you never execute changes. Ground every claim in the numbers given.
Be decisive and specific; no hedging, no theory, no filler.
Respond ONLY with JSON of this exact shape:
{
  "summary": "2-3 sentences: the account's overall health and the single most important thing to address, with numbers.",
  "findings": [{"title":"short headline","detail":"what's wrong/right and why it matters, with the numbers","severity":"high|medium|low","recommendation":"the specific fix to advise"}],
  "recommendations": [{"text":"one concrete next step the client should take","priority":"P0|P1|P2"}]
}
Give 2-4 findings (most important first) and 2-4 recommendations. If the account is healthy, say so and keep findings light.`;

function snapshot(report: AccountReport): string {
  const k = report.kpis;
  const cur = report.channels[0]?.metrics;
  const d = (m: { value: number; deltaPct: number | null }, unit = "") =>
    `${m.value.toFixed(2)}${unit}${m.deltaPct !== null ? ` (${m.deltaPct >= 0 ? "+" : ""}${m.deltaPct.toFixed(0)}% vs prior)` : ""}`;
  const lines = [
    `Account "${report.account.name}" on ${report.account.platform === "meta" ? "Meta Ads" : "Google Ads"}, last ${report.range.days} days. Currency ${report.account.currency}.`,
    `Spend: ${d(k.cost)}`,
    `ROAS: ${d(k.roas, "x")}`,
    `Conversions: ${d(k.conversions)}`,
    `Conversion rate: ${d(k.convRate, "%")}`,
    `Clicks: ${d(k.clicks)}`,
    `CTR: ${d(k.ctr, "%")}`,
  ];
  if (cur) lines.push(`Revenue: ${cur.revenue.toFixed(0)}, CPA: ${cur.cpa.toFixed(2)}`);
  return lines.join("\n");
}

async function aiAnalysis(
  configOrKey: AIConfig | string,
  reportName: string,
  user: string,
): Promise<Analysis | null> {
  try {
    const content = await callAI(configOrKey, SYSTEM(reportName), user, 1100);
    if (!content) return null;
    const p = parseJsonSafe<any>(content);
    if (!p) return null;
    const sev = (s: any): Severity => (s === "high" || s === "low" ? s : "medium");
    const prio = (s: any): "P0" | "P1" | "P2" => (s === "P0" || s === "P2" ? s : "P1");
    return {
      summary: String(p.summary ?? ""),
      findings: (Array.isArray(p.findings) ? p.findings : []).slice(0, 4).map((f: any) => ({
        title: String(f.title ?? "Finding"),
        detail: String(f.detail ?? ""),
        severity: sev(f.severity),
        recommendation: f.recommendation ? String(f.recommendation) : undefined,
      })),
      recommendations: (Array.isArray(p.recommendations) ? p.recommendations : []).slice(0, 4).map((r: any) => ({
        text: String(r.text ?? ""),
        priority: prio(r.priority),
      })),
    };
  } catch {
    return null;
  }
}

/** Deterministic analysis when no AI key — derived from the same heuristics as the dashboard. */
function heuristicAnalysis(report: AccountReport, scored?: ScoredAudit | null): Analysis {
  if (scored) {
    const short = scored.categories.filter((c) => c.score !== null && c.rating !== "Good").sort((a, b) => a.score! - b.score!);
    const worst = short[0];
    return {
      summary: `The account scores ${scored.score}/100 (${scored.rating}).${worst ? ` ${worst.name} is the weakest category — ${worst.detail}` : " Every category rates Good; focus on scaling what works."}`,
      findings: short.slice(0, 4).map((c) => ({
        title: `${c.name}: ${c.rating}`,
        detail: c.detail,
        severity: c.score! < 30 ? ("high" as const) : c.score! < 60 ? ("medium" as const) : ("low" as const),
        recommendation: c.fix ?? undefined,
      })),
      recommendations: scored.fixes.slice(0, 4).map((f) => ({
        text: f.text,
        priority: f.tag === "HIGH" ? ("P0" as const) : ("P1" as const),
      })),
    };
  }
  return legacyHeuristic(report);
}

function legacyHeuristic(report: AccountReport): Analysis {
  const cur = report.channels[0]?.metrics ?? ({} as Metrics);
  const prev = report.kpis.cost.prev !== null
    ? ({ spend: report.kpis.cost.prev, roas: report.kpis.roas.prev, conversions: report.kpis.conversions.prev,
         convRate: report.kpis.convRate.prev, clicks: report.kpis.clicks.prev, ctr: report.kpis.ctr.prev } as any)
    : null;
  const issues: Issue[] = deriveIssues(cur, prev, report.daily, report.account.currency);
  const roas = report.kpis.roas.value;
  const summary =
    roas >= 2.5
      ? `The account is healthy at ${xroas(roas)} ROAS over ${report.range.days} days. Focus on scaling the top performers without diluting return.`
      : roas >= 1
        ? `The account is profitable but thin at ${xroas(roas)} ROAS. The priority is lifting return before adding spend.`
        : `The account is losing money at ${xroas(roas)} ROAS — every dollar spent returns less than a dollar. Cut waste before anything else.`;
  return {
    summary,
    findings: issues.map((i) => ({ title: i.title, detail: i.detail, severity: i.severity, recommendation: i.action })),
    recommendations: issues.slice(0, 3).map((i, idx) => ({
      text: i.action,
      priority: i.severity === "high" ? "P0" : i.severity === "medium" ? "P1" : "P2",
    })) as Analysis["recommendations"],
  };
}

// ── Report assembly ──────────────────────────────────────────────────────────

function kpiBlock(report: AccountReport, currency: string): Block {
  const k = report.kpis;
  return {
    kind: "kpis",
    items: [
      { label: "Chi phí", value: money(k.cost.value, currency), deltaPct: k.cost.deltaPct, higherIsBetter: true },
      { label: "ROAS", value: xroas(k.roas.value), deltaPct: k.roas.deltaPct, higherIsBetter: true },
      { label: "Chuyển đổi", value: num(k.conversions.value), deltaPct: k.conversions.deltaPct, higherIsBetter: true },
      { label: "Tỷ lệ chuyển đổi", value: pct(k.convRate.value), deltaPct: k.convRate.deltaPct, higherIsBetter: true },
      { label: "Lượt nhấp", value: num(k.clicks.value), deltaPct: k.clicks.deltaPct, higherIsBetter: true },
      { label: "CTR", value: pct(k.ctr.value), deltaPct: k.ctr.deltaPct, higherIsBetter: true },
    ],
  };
}

function channelTable(report: AccountReport, currency: string): Block {
  return {
    kind: "table",
    columns: [
      { label: "Kênh", align: "left" },
      { label: "Chi tiêu", align: "right" },
      { label: "ROAS", align: "right" },
      { label: "Tỷ lệ chuyển đổi", align: "right" },
      { label: "Chuyển đổi", align: "right" },
    ],
    rows: report.channels.map((c) => [
      { text: c.platform === "meta" ? "Meta" : "Google Ads", align: "left" },
      { text: money(c.metrics.spend, currency), align: "right" },
      { text: xroas(c.metrics.roas), align: "right", tone: roasTone(c.metrics.roas), bar: Math.min(1, c.metrics.roas / 5) },
      { text: pct(c.metrics.convRate), align: "right" },
      { text: num(c.metrics.conversions), align: "right" },
    ]),
  };
}

const HEALTH = (roas: number): ReportDoc["health"] =>
  roas >= 2.5
    ? { label: "Healthy", tone: "good", line: `ROAS đạt ${xroas(roas)} — hiệu quả sinh lời rất tốt trên chi phí.` }
    : roas >= 1
      ? { label: "Watch", tone: "warn", line: `ROAS đạt ${xroas(roas)} — có lãi nhưng dưới mục tiêu 2.5x.` }
      : { label: "At risk", tone: "bad", line: `ROAS đạt ${xroas(roas)} — chi phí quảng cáo đang cao hơn doanh thu.` };

const fmtRange = (since: string, until: string) => {
  const o: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" };
  return `${new Date(since + "T00:00:00").toLocaleDateString("vi-VN", o)} – ${new Date(until + "T00:00:00").toLocaleDateString("vi-VN", o)}`;
};

const ratingTone = (r: Rating | null): Tone =>
  r === "Good" ? "good" : r === "Fair" ? "warn" : r === null ? "info" : r === "Needs work" ? "warn" : "bad";

/** Doc shell shared by every recipe builder. */
function doc(recipe: string, title: string, report: AccountReport, health: ReportDoc["health"], sections: Section[], usedAi: boolean): ReportDoc {
  return {
    recipe,
    title,
    subtitle: `${report.account.name} · ${fmtRange(report.range.since, report.range.until)}`,
    account: { name: report.account.name, platform: report.account.platform, currency: report.account.currency },
    range: report.range,
    health,
    sections,
    daily: report.daily,
    ai: usedAi,
    preview: report.preview,
    generatedAt: new Date().toISOString(),
  };
}

const finish = (analysis: Analysis, sections: Section[], fixes?: Block) => {
  if (analysis.findings.length) {
    sections.push({ eyebrow: "Phát hiện chính", note: `${analysis.findings.length}`, blocks: [{ kind: "findings", items: analysis.findings }] });
  }
  const recs: Block | undefined =
    fixes ?? (analysis.recommendations.length ? { kind: "recommendations", items: analysis.recommendations } : undefined);
  if (recs && recs.kind === "recommendations" && recs.items.length) {
    sections.push({ eyebrow: fixes ? "Hành động ưu tiên khắc phục" : "Khuyến nghị tối ưu", note: `${recs.items.length}`, blocks: [recs] });
  }
};

// ── Account Audit (scored when audit data is available) ──────────────────────

async function buildAccountAudit(report: AccountReport, apiKey: AIConfig | string | null, audit: AuditData | null): Promise<ReportDoc> {
  const currency = report.account.currency;
  const scored: ScoredAudit | null = audit ? scoreAudit(report, audit) : null;

  let user = snapshot(report);
  if (scored) {
    user += `\n\nAudit categories (deterministic scores, 0-100):\n` + scored.categories
      .map((c) => `- ${c.name}: ${c.score === null ? "no data" : `${Math.round(c.score)} (${c.rating})`} — ${c.detail}`)
      .join("\n") + `\nOverall score: ${scored.score}/100 (${scored.rating}).`;
  }
  const aiResult = apiKey ? await aiAnalysis(apiKey, "Account Audit", user) : null;
  const analysis = aiResult ?? heuristicAnalysis(report, scored);

  // Health from the audit score when we have one, else the ROAS bands.
  const health: ReportDoc["health"] = scored
    ? scored.score >= 70
      ? { label: "Khỏe mạnh", tone: "good", line: `Điểm kiểm toán ${scored.score}/100 — xếp loại ${scored.rating} trên ${scored.categories.filter((c) => c.score !== null).length} hạng mục.` }
      : scored.score >= 50
        ? { label: "Cần theo dõi", tone: "warn", line: `Điểm kiểm toán ${scored.score}/100 — nên bắt đầu khắc phục hạng mục yếu nhất phía dưới.` }
        : { label: "Rủi ro cao", tone: "bad", line: `Điểm kiểm toán ${scored.score}/100 — tồn tại các vấn đề cấu trúc cần xử lý ngay trước khi tăng ngân sách.` }
    : HEALTH(report.kpis.roas.value);

  const sections: Section[] = [];
  if (scored) {
    sections.push({
      eyebrow: "Điểm đánh giá kiểm toán",
      note: `${scored.categories.filter((c) => c.score !== null).length} hạng mục`,
      blocks: [{
        kind: "scorecard",
        score: scored.score,
        rating: scored.rating,
        categories: scored.categories.map((c) => ({
          name: c.name,
          rating: c.rating,
          tone: ratingTone(c.rating),
          score: c.score === null ? null : Math.round(c.score),
          detail: c.detail,
          atStake: c.atStake !== null ? money(c.atStake, currency) : undefined,
          worst: c.id === scored.worst,
        })),
      }],
    });
  }
  sections.push(
    {
      eyebrow: "Tóm tắt quản trị",
      blocks: [
        { kind: "callout", tone: health.tone, text: `${health.label} · ${health.line}` },
        { kind: "prose", text: analysis.summary },
      ],
    },
    { eyebrow: "Chỉ số trọng yếu", note: `${report.range.days} ngày`, blocks: [kpiBlock(report, currency)] },
    {
      eyebrow: "Xu hướng hiệu suất",
      blocks: [
        { kind: "chart", chart: "spend-roas", barLabel: "Chi phí", lineLabel: "ROAS" },
        { kind: "chart", chart: "conv-rate", barLabel: "Chuyển đổi", lineLabel: "Tỷ lệ chuyển đổi" },
        { kind: "chart", chart: "clicks-ctr", barLabel: "Lượt nhấp", lineLabel: "CTR" },
      ],
    },
    { eyebrow: "Phân bổ theo kênh", blocks: [channelTable(report, currency)] },
  );

  // Priority fixes come from the deterministic audit engine — dollar amounts are
  // never AI-authored. Fall back to AI/heuristic recommendations without one.
  const fixes: Block | undefined = scored?.fixes.length
    ? {
        kind: "recommendations",
        items: scored.fixes.map((f) => ({
          text: f.text,
          priority: f.tag === "HIGH" ? "P0" : "P1",
          impact: f.atStake !== null ? `${money(f.atStake, currency)} at stake` : undefined,
        })),
      }
    : undefined;
  finish(analysis, sections, fixes);
  return doc("account-audit", "Account Audit", report, health, sections, aiResult !== null);
}

// ── Search Terms (Google) ────────────────────────────────────────────────────

async function buildSearchTerms(report: AccountReport, apiKey: AIConfig | string | null, terms: SearchTermRow[]): Promise<ReportDoc> {
  const currency = report.account.currency;
  const waste = summarizeWaste(terms);
  const wastePct = waste.analyzed > 0 ? (waste.wasted / waste.analyzed) * 100 : 0;

  const user = [
    snapshot(report),
    ``,
    `Top search terms by cost (${terms.length} analyzed, ${money(waste.wasted, currency)} of ${money(waste.analyzed, currency)} spent on zero-conversion terms):`,
    ...terms.slice(0, 25).map((t) => `- "${t.term}" [${t.matchType.toLowerCase()}] ${money(t.spend, currency)}, ${Math.round(t.clicks)} clicks, ${t.conversions.toFixed(1)} conv (${t.campaign})`),
  ].join("\n");
  const aiResult = apiKey ? await aiAnalysis(apiKey, "Search Term Waste Audit", user) : null;

  const negatives = waste.wastedTerms.slice(0, 20);
  const analysis: Analysis = aiResult ?? {
    summary:
      wastePct >= 20
        ? `${money(waste.wasted, currency)} — ${wastePct.toFixed(0)}% of the spend on your top ${terms.length} search terms — converted nothing. Negatives are the fastest saving available in this account.`
        : `Search-term hygiene is decent: ${wastePct.toFixed(0)}% of top-term spend (${money(waste.wasted, currency)}) went to zero-conversion queries.`,
    findings: negatives.slice(0, 3).map((t, i) => ({
      title: `"${t.term}" is pure waste`,
      detail: `${money(t.spend, currency)} and ${Math.round(t.clicks)} clicks in ${report.range.days} days with zero conversions (campaign: ${t.campaign}).`,
      severity: i === 0 ? ("high" as const) : ("medium" as const),
      recommendation: "Add as an exact-match negative.",
    })),
    recommendations: negatives.length
      ? [{ text: `Add the ${negatives.length} zero-conversion terms below as exact negatives — ${money(waste.wasted, currency)} of spend at stake.`, priority: "P0" as const }]
      : [{ text: "No zero-conversion spenders in the top terms — re-run on a longer range for the tail.", priority: "P2" as const }],
  };

  const tone: Tone = wastePct >= 30 ? "bad" : wastePct >= 15 ? "warn" : "good";
  const health: ReportDoc["health"] =
    tone === "bad"
      ? { label: "At risk", tone, line: `${wastePct.toFixed(0)}% of top-term spend converts nothing.` }
      : tone === "warn"
        ? { label: "Watch", tone, line: `${wastePct.toFixed(0)}% of top-term spend is wasted — trim the negatives.` }
        : { label: "Healthy", tone, line: `Only ${wastePct.toFixed(0)}% of top-term spend shows no conversions.` };

  const termRow = (t: SearchTermRow): Cell[] => [
    { text: t.term, align: "left" },
    { text: t.campaign, align: "left" },
    { text: t.matchType.toLowerCase().replace(/_/g, " "), align: "left" },
    { text: money(t.spend, currency), align: "right", bar: waste.analyzed > 0 ? Math.min(1, t.spend / (terms[0]?.spend || 1)) : 0 },
    { text: num(t.clicks), align: "right" },
    { text: t.conversions.toFixed(1), align: "right", tone: t.conversions === 0 ? "bad" : t.revenue > t.spend ? "good" : undefined },
  ];
  const termColumns = [
    { label: "Cụm từ tìm kiếm", align: "left" as const },
    { label: "Chiến dịch", align: "left" as const },
    { label: "Đối sánh", align: "left" as const },
    { label: "Chi phí", align: "right" as const },
    { label: "Lượt nhấp", align: "right" as const },
    { label: "Chuyển đổi", align: "right" as const },
  ];

  const sections: Section[] = [
    {
      eyebrow: "Tóm tắt quản trị",
      blocks: [
        { kind: "callout", tone: health.tone, text: `${health.label} · ${health.line}` },
        { kind: "prose", text: analysis.summary },
      ],
    },
    {
      eyebrow: "Tổng quan lãng phí",
      note: `top ${terms.length} cụm từ`,
      blocks: [{
        kind: "kpis",
        items: [
          { label: "Chi phí từ khóa", value: money(waste.analyzed, currency) },
          { label: "Lãng phí", value: money(waste.wasted, currency) },
          { label: "Tỷ lệ lãng phí", value: pct(wastePct) },
          { label: "Từ khóa 0 chuyển đổi", value: num(waste.wastedTerms.length) },
          { label: "Từ khóa đã duyệt", value: num(terms.length) },
          { label: "Khung thời gian", value: `${report.range.days} ngày` },
        ],
      }],
    },
  ];
  if (negatives.length) {
    sections.push({
      eyebrow: "Gợi ý từ khóa phủ định",
      note: `${negatives.length} từ khóa · ${money(waste.wasted, currency)}`,
      blocks: [{ kind: "table", columns: termColumns, rows: negatives.map(termRow) }],
    });
  }
  sections.push({
    eyebrow: "Top từ khóa theo chi phí",
    note: `${Math.min(20, terms.length)} trên ${terms.length}`,
    blocks: [{ kind: "table", columns: termColumns, rows: terms.slice(0, 20).map(termRow) }],
  });

  finish(analysis, sections);
  return doc("search-terms", "Kiểm toán lãng phí từ khóa tìm kiếm", report, health, sections, aiResult !== null);
}

// ── Creative Fatigue (Meta) ──────────────────────────────────────────────────

const chg = (v: number | null) => (v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`);

async function buildCreativeFatigue(report: AccountReport, apiKey: AIConfig | string | null, ads: AdFatigueRow[]): Promise<ReportDoc> {
  const currency = report.account.currency;
  const flags = flagFatigue(ads);
  const fatigued = flags.filter((f) => f.fatigued);
  const winners = scaleCandidates(flags);
  const fatiguedSpend = fatigued.reduce((a, f) => a + f.ad.current.spend, 0);
  const halfDays = Math.max(1, Math.floor(report.range.days / 2));

  const user = [
    snapshot(report),
    ``,
    `Per-ad current vs prior ${halfDays}-day window (${flags.length} ads analyzed, ${fatigued.length} fatigued carrying ${money(fatiguedSpend, currency)}):`,
    ...flags.slice(0, 20).map((f) =>
      `- "${f.ad.adName}" (${f.ad.adsetName}): ${money(f.ad.current.spend, currency)}, freq ${f.ad.current.frequency?.toFixed(1) ?? "?"}, CTR ${f.ad.current.ctr.toFixed(2)}% (${chg(f.ctrChangePct)}), CPM ${chg(f.cpmChangePct)}, CPA ${chg(f.cpaChangePct)}${f.fatigued ? " [FATIGUED]" : ""}`,
    ),
  ].join("\n");
  const aiResult = apiKey ? await aiAnalysis(apiKey, "Creative Fatigue", user) : null;

  const analysis: Analysis = aiResult ?? {
    summary: fatigued.length
      ? `${fatigued.length} of ${flags.length} analyzed ads show fatigue (high frequency plus falling CTR), carrying ${money(fatiguedSpend, currency)} of recent spend. Refresh those first; ${winners.length} ads are healthy enough to scale into the freed budget.`
      : `No ads cross the fatigue thresholds (frequency > 2.5 with CTR down > 15%). Creative is holding; keep the refresh cadence and scale the winners gradually.`,
    findings: fatigued.slice(0, 3).map((f, i) => ({
      title: `"${f.ad.adName}" is fatigued`,
      detail: `${f.reasons.join(", ")} on ${money(f.ad.current.spend, currency)} of spend (${f.ad.adsetName}).`,
      severity: i === 0 ? ("high" as const) : ("medium" as const),
      recommendation: "Pause it or ship a refreshed variant into the same ad set.",
    })),
    recommendations: [
      ...(fatigued.length ? [{ text: `Pause or refresh the ${fatigued.length} flagged ads — ${money(fatiguedSpend, currency)} of spend is grinding on tired audiences.`, priority: "P0" as const }] : []),
      ...(winners.length ? [{ text: `Scale the ${winners.length} healthy winners by 20% budget steps while CPA holds.`, priority: "P1" as const }] : []),
    ],
  };

  const tone: Tone = fatigued.length >= 3 ? "bad" : fatigued.length > 0 ? "warn" : "good";
  const health: ReportDoc["health"] =
    tone === "bad"
      ? { label: "At risk", tone, line: `${fatigued.length} ads fatigued, ${money(fatiguedSpend, currency)} of spend affected.` }
      : tone === "warn"
        ? { label: "Watch", tone, line: `${fatigued.length} ad${fatigued.length === 1 ? "" : "s"} showing fatigue — refresh before it spreads.` }
        : { label: "Healthy", tone, line: "No ads cross the fatigue thresholds." };

  const adColumns = [
    { label: "Mẫu quảng cáo", align: "left" as const },
    { label: "Nhóm quảng cáo", align: "left" as const },
    { label: "Chi phí", align: "right" as const },
    { label: "Tần suất", align: "right" as const },
    { label: "CTR", align: "right" as const },
    { label: "CTR Δ", align: "right" as const },
    { label: "CPM Δ", align: "right" as const },
    { label: "CPA Δ", align: "right" as const },
  ];
  const maxSpend = Math.max(...flags.map((f) => f.ad.current.spend), 1);
  const adRow = (f: (typeof flags)[number]): Cell[] => [
    { text: f.ad.adName, align: "left" },
    { text: f.ad.adsetName, align: "left" },
    { text: money(f.ad.current.spend, currency), align: "right", bar: f.ad.current.spend / maxSpend },
    { text: f.ad.current.frequency?.toFixed(1) ?? "—", align: "right", tone: (f.ad.current.frequency ?? 0) > 2.5 ? "bad" : undefined },
    { text: `${f.ad.current.ctr.toFixed(2)}%`, align: "right" },
    { text: chg(f.ctrChangePct), align: "right", tone: f.ctrChangePct !== null ? (f.ctrChangePct < -15 ? "bad" : f.ctrChangePct > 5 ? "good" : undefined) : undefined },
    { text: chg(f.cpmChangePct), align: "right", tone: f.cpmChangePct !== null && f.cpmChangePct > 20 ? "bad" : undefined },
    { text: chg(f.cpaChangePct), align: "right", tone: f.cpaChangePct !== null ? (f.cpaChangePct > 20 ? "bad" : f.cpaChangePct < -10 ? "good" : undefined) : undefined },
  ];

  const sections: Section[] = [
    {
      eyebrow: "Tóm tắt quản trị",
      blocks: [
        { kind: "callout", tone: health.tone, text: `${health.label} · ${health.line}` },
        { kind: "prose", text: analysis.summary },
      ],
    },
    {
      eyebrow: "Tổng quan bão hòa quảng cáo",
      note: `kỳ hiện tại vs ${halfDays} ngày trước`,
      blocks: [{
        kind: "kpis",
        items: [
          { label: "Quảng cáo đã duyệt", value: num(flags.length) },
          { label: "Đã bão hòa", value: num(fatigued.length) },
          { label: "Ngân sách rủi ro", value: money(fatiguedSpend, currency) },
          { label: "Sẵn sàng scale", value: num(winners.length) },
          { label: "Tần suất TB", value: flags.length ? (flags.reduce((a, f) => a + (f.ad.current.frequency ?? 0), 0) / flags.length).toFixed(1) : "—" },
          { label: "Chu kỳ so sánh", value: `${halfDays}n vs ${halfDays}n` },
        ],
      }],
    },
  ];
  if (fatigued.length) {
    sections.push({
      eyebrow: "Quảng cáo đã bão hòa — Ưu tiên tạm dừng hoặc thay mới",
      note: `${fatigued.length} quảng cáo cảnh báo`,
      blocks: [{ kind: "table", columns: adColumns, rows: fatigued.map(adRow) }],
    });
  }
  if (winners.length) {
    sections.push({
      eyebrow: "Quảng cáo hiệu quả — An toàn để tăng ngân sách",
      note: `${winners.length} quảng cáo chiến thắng`,
      blocks: [{ kind: "table", columns: adColumns, rows: winners.map(adRow) }],
    });
  }
  sections.push({
    eyebrow: "Toàn bộ quảng cáo đã phân tích",
    note: `${flags.length} theo chi phí`,
    blocks: [{ kind: "table", columns: adColumns, rows: flags.slice(0, 25).map(adRow) }],
  });

  finish(analysis, sections);
  return doc("creative-fatigue", "Báo cáo độ bão hòa mẫu quảng cáo", report, health, sections, aiResult !== null);
}

// ── Landing Page Analysis (GA4 paid traffic) ─────────────────────────────────

interface PageDiag {
  row: LandingPageRow;
  convDropPp: number | null; // percentage points vs prior window
  bounceJumpPp: number | null;
  recoverable: number; // prior rev/session on current sessions, minus current revenue
  suggestion: string;
}

function diagnosePages(rows: LandingPageRow[]): PageDiag[] {
  return rows.map((row) => {
    const p = row.prev;
    const convDropPp = p ? row.current.convRatePct - p.convRatePct : null;
    const bounceJumpPp = p ? row.current.bounceRatePct - p.bounceRatePct : null;
    const recoverable = p && p.revenuePerSession > row.current.revenuePerSession
      ? (p.revenuePerSession - row.current.revenuePerSession) * row.current.sessions
      : 0;
    const suggestion =
      bounceJumpPp !== null && bounceJumpPp > 10
        ? "Bounce spiked — re-check message match: the ad's promise vs the hero copy on this page."
        : convDropPp !== null && convDropPp < 0 && row.current.transactions < (p?.transactions ?? 0)
          ? "Visitors stay but stopped buying — audit the form/checkout for new friction."
          : "Conversion softened without a bounce spike — compare the ad creative sending traffic here against the page offer.";
    return { row, convDropPp, bounceJumpPp, recoverable, suggestion };
  });
}

async function buildLandingPages(report: AccountReport, apiKey: AIConfig | string | null, pages: LandingPagesResult): Promise<ReportDoc> {
  const currency = report.account.currency;
  const diags = diagnosePages(pages.rows);
  const totalSessions = pages.rows.reduce((a, r) => a + r.current.sessions, 0);
  const totalRevenue = pages.rows.reduce((a, r) => a + r.current.revenue, 0);
  const totalKeyEvents = pages.rows.reduce((a, r) => a + r.current.keyEvents, 0);
  const wBounce = totalSessions > 0 ? pages.rows.reduce((a, r) => a + r.current.bounceRatePct * r.current.sessions, 0) / totalSessions : 0;
  const convRate = totalSessions > 0 ? (totalKeyEvents / totalSessions) * 100 : 0;
  // Ignore sub-$50 declines — below that the "fix" is noise, not a priority.
  const fixOrder = diags.filter((d) => d.recoverable >= 50).sort((a, b) => b.recoverable - a.recoverable);
  const recoverable = fixOrder.reduce((a, d) => a + d.recoverable, 0);
  const bounceSpikes = diags.filter((d) => d.bounceJumpPp !== null && d.bounceJumpPp > 10);

  const user = [
    snapshot(report),
    ``,
    `GA4 paid-traffic landing pages (property "${pages.propertyName}", ${pages.rows.length} pages, current vs prior ${report.range.days}-day window):`,
    ...diags.slice(0, 20).map((d) =>
      `- ${d.row.page} [${d.row.sourceMedium}]: ${Math.round(d.row.current.sessions)} sessions, bounce ${d.row.current.bounceRatePct.toFixed(0)}%${d.bounceJumpPp !== null ? ` (${d.bounceJumpPp >= 0 ? "+" : ""}${d.bounceJumpPp.toFixed(0)}pp)` : ""}, conv ${d.row.current.convRatePct.toFixed(1)}%${d.convDropPp !== null ? ` (${d.convDropPp >= 0 ? "+" : ""}${d.convDropPp.toFixed(1)}pp)` : ""}, rev/session ${d.row.current.revenuePerSession.toFixed(2)}${d.recoverable > 0 ? `, recoverable ~${Math.round(d.recoverable)}` : ""}`,
    ),
  ].join("\n");
  const aiResult = apiKey ? await aiAnalysis(apiKey, "Landing Page Funnel Diagnostic", user) : null;

  const analysis: Analysis = aiResult ?? {
    summary: fixOrder.length
      ? `${fixOrder.length} paid landing page${fixOrder.length === 1 ? "" : "s"} lost ground vs the prior period — roughly ${money(recoverable, currency)} of revenue is recoverable at current traffic. Start with ${fixOrder[0].row.page}.`
      : `Paid landing pages are holding: no page shows a meaningful revenue-per-session decline vs the prior period.`,
    findings: fixOrder.slice(0, 3).map((d, i) => ({
      title: `${d.row.page} is leaking`,
      detail: `Conv rate ${d.row.current.convRatePct.toFixed(1)}% (${d.convDropPp! >= 0 ? "+" : ""}${d.convDropPp!.toFixed(1)}pp), bounce ${d.row.current.bounceRatePct.toFixed(0)}%${d.bounceJumpPp !== null && d.bounceJumpPp > 10 ? ` (+${d.bounceJumpPp.toFixed(0)}pp — spike)` : ""} on ${Math.round(d.row.current.sessions)} sessions from ${d.row.sourceMedium}. ~${money(d.recoverable, currency)} recoverable.`,
      severity: i === 0 ? ("high" as const) : ("medium" as const),
      recommendation: d.suggestion,
    })),
    recommendations: fixOrder.slice(0, 4).map((d, i) => ({
      text: `${d.row.page}: ${d.suggestion}`,
      priority: i === 0 ? ("P0" as const) : ("P1" as const),
    })),
  };

  const leakShare = totalRevenue > 0 ? recoverable / totalRevenue : 0;
  const tone: Tone = leakShare > 0.15 ? "bad" : leakShare > 0.05 || bounceSpikes.length > 0 ? "warn" : "good";
  const health: ReportDoc["health"] =
    tone === "bad"
      ? { label: "At risk", tone, line: `~${money(recoverable, currency)} recoverable across ${fixOrder.length} declining pages.` }
      : tone === "warn"
        ? { label: "Watch", tone, line: `${fixOrder.length || bounceSpikes.length} page${(fixOrder.length || bounceSpikes.length) === 1 ? "" : "s"} slipping — ~${money(recoverable, currency)} at stake.` }
        : { label: "Healthy", tone, line: "Paid landing pages are converting in line with the prior period." };

  const pageColumns = [
    { label: "Trang đích", align: "left" as const },
    { label: "Nguồn / Phương tiện", align: "left" as const },
    { label: "Phiên truy cập", align: "right" as const },
    { label: "Tỷ lệ thoát", align: "right" as const },
    { label: "Tỷ lệ chuyển đổi", align: "right" as const },
    { label: "Doanh thu / Phiên", align: "right" as const },
    { label: "Khả năng phục hồi", align: "right" as const },
  ];
  const pp = (v: number | null) => (v === null ? "" : ` (${v >= 0 ? "+" : ""}${v.toFixed(1)}pp)`);
  const maxSessions = Math.max(...pages.rows.map((r) => r.current.sessions), 1);
  const pageRow = (d: PageDiag): Cell[] => [
    { text: d.row.page, align: "left" },
    { text: d.row.sourceMedium, align: "left" },
    { text: num(d.row.current.sessions), align: "right", bar: d.row.current.sessions / maxSessions },
    { text: `${d.row.current.bounceRatePct.toFixed(0)}%${pp(d.bounceJumpPp)}`, align: "right", tone: d.bounceJumpPp !== null && d.bounceJumpPp > 10 ? "bad" : undefined },
    { text: `${d.row.current.convRatePct.toFixed(1)}%${pp(d.convDropPp)}`, align: "right", tone: d.convDropPp !== null ? (d.convDropPp < -0.5 ? "bad" : d.convDropPp > 0.5 ? "good" : undefined) : undefined },
    { text: money(d.row.current.revenuePerSession, currency), align: "right" },
    { text: d.recoverable > 0 ? money(d.recoverable, currency) : "—", align: "right", tone: d.recoverable > 0 ? "warn" : undefined },
  ];

  const sections: Section[] = [
    {
      eyebrow: "Tóm tắt quản trị",
      blocks: [
        { kind: "callout", tone: health.tone, text: `${health.label} · ${health.line}` },
        { kind: "prose", text: analysis.summary },
        { kind: "prose", text: `Nguồn dữ liệu: Google Analytics 4 (GA4) - "${pages.propertyName}", chỉ tính lưu lượng từ các kênh trả phí. Thời gian tải trang thực tế: GA4 không lưu trực tiếp chỉ số tốc độ, vui lòng kiểm tra PageSpeed Insights cho các trang nghi ngờ tải chậm.` },
      ],
    },
    {
      eyebrow: "Tổng quan phễu trang đích",
      note: `${pages.rows.length} trang đích trả phí`,
      blocks: [{
        kind: "kpis",
        items: [
          { label: "Phiên trả phí", value: num(totalSessions) },
          { label: "Tỷ lệ chuyển đổi", value: pct(convRate) },
          { label: "Tỷ lệ thoát", value: pct(wBounce) },
          { label: "Doanh thu", value: money(totalRevenue, currency) },
          { label: "Trang thoát tăng vọt", value: num(bounceSpikes.length) },
          { label: "Doanh thu có thể cứu", value: money(recoverable, currency) },
        ],
      }],
    },
  ];
  if (fixOrder.length) {
    sections.push({
      eyebrow: "Thứ tự tối ưu — Xếp hạng theo doanh thu có thể cứu vãn",
      note: `${fixOrder.length} trang`,
      blocks: [{ kind: "table", columns: pageColumns, rows: fixOrder.slice(0, 10).map(pageRow) }],
    });
  }
  sections.push({
    eyebrow: "Toàn bộ trang đích có trả phí",
    note: `top ${Math.min(15, diags.length)} theo phiên truy cập`,
    blocks: [{ kind: "table", columns: pageColumns, rows: diags.slice(0, 15).map(pageRow) }],
  });

  const fixes: Block | undefined = fixOrder.length
    ? {
        kind: "recommendations",
        items: fixOrder.slice(0, 5).map((d, i) => ({
          text: `${d.row.page}: ${d.suggestion}`,
          priority: i === 0 || d.recoverable >= totalRevenue * 0.1 ? ("P0" as const) : ("P1" as const),
          impact: `${money(d.recoverable, currency)} có thể cứu vãn`,
        })),
      }
    : undefined;
  finish(analysis, sections, fixes);
  return doc("landing-page", "Phân tích trang đích quảng cáo", report, health, sections, aiResult !== null);
}

// ── Entry point ──────────────────────────────────────────────────────────────

/** Build a recipe's report document from a computed AccountReport + pre-fetched recipe data. */
export async function generateReport(
  recipe: string,
  report: AccountReport,
  apiKey: AIConfig | string | null,
  data: RecipeData = {},
): Promise<ReportDoc> {
  switch (recipe) {
    case "search-terms":
      return buildSearchTerms(report, apiKey, data.terms ?? []);
    case "creative-fatigue":
      return buildCreativeFatigue(report, apiKey, data.ads ?? []);
    case "landing-page":
      return buildLandingPages(report, apiKey, data.pages ?? { property: "", propertyName: "—", rows: [] });
    default:
      return buildAccountAudit(report, apiKey, data.audit ?? null);
  }
}
