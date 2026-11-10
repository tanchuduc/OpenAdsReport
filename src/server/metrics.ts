// Shared metric math + issue derivation. The app owns every calculation here so
// Meta and Google numbers are computed identically and the JSON API is the single
// source of truth for agents.

import type { Metrics, MetricDelta, DailyPoint, Issue, DateRange } from "./providers/types";

export function roas(spend: number, revenue: number) {
  return spend > 0 ? revenue / spend : 0;
}
export function cpa(spend: number, conversions: number) {
  return conversions > 0 ? spend / conversions : 0;
}
export function ctr(clicks: number, impressions: number) {
  return impressions > 0 ? (clicks / impressions) * 100 : 0;
}
export function convRate(conversions: number, clicks: number) {
  return clicks > 0 ? (conversions / clicks) * 100 : 0;
}

/** Build a Metrics object from the four raw totals, recomputing all derived fields. */
export function metrics(raw: {
  spend: number;
  revenue: number;
  conversions: number;
  clicks: number;
  impressions: number;
}): Metrics {
  return {
    ...raw,
    roas: roas(raw.spend, raw.revenue),
    cpa: cpa(raw.spend, raw.conversions),
    ctr: ctr(raw.clicks, raw.impressions),
    convRate: convRate(raw.conversions, raw.clicks),
  };
}

export const emptyMetrics = (): Metrics =>
  metrics({ spend: 0, revenue: 0, conversions: 0, clicks: 0, impressions: 0 });

/** Sum a list of Metrics into one aggregate (derived fields recomputed from totals). */
export function sumMetrics(list: Metrics[]): Metrics {
  const raw = list.reduce(
    (a, m) => ({
      spend: a.spend + m.spend,
      revenue: a.revenue + m.revenue,
      conversions: a.conversions + m.conversions,
      clicks: a.clicks + m.clicks,
      impressions: a.impressions + m.impressions,
    }),
    { spend: 0, revenue: 0, conversions: 0, clicks: 0, impressions: 0 },
  );
  return metrics(raw);
}

function pctChange(value: number, prev: number | null): number | null {
  if (prev === null || prev === 0) return null;
  return ((value - prev) / prev) * 100;
}

export function delta(value: number, prev: number | null, higherIsBetter = true): MetricDelta {
  return { value, prev, deltaPct: pctChange(value, prev), higherIsBetter };
}

/** The six KPIs rendered as cards in the Account View, with prior-period deltas. */
export function buildKpis(cur: Metrics, prev: Metrics | null) {
  const p = prev;
  return {
    cost: delta(cur.spend, p?.spend ?? null, true),
    roas: delta(cur.roas, p?.roas ?? null, true),
    conversions: delta(cur.conversions, p?.conversions ?? null, true),
    convRate: delta(cur.convRate, p?.convRate ?? null, true),
    clicks: delta(cur.clicks, p?.clicks ?? null, true),
    ctr: delta(cur.ctr, p?.ctr ?? null, true),
  };
}

// ── Date helpers ─────────────────────────────────────────────────────────────

const iso = (d: Date) => d.toISOString().split("T")[0];

/** Resolve a date range from optional since/until, defaulting to the last `days`. */
export function resolveRange(opts: { since?: string; until?: string; days?: number }): DateRange {
  const today = new Date();
  let until = opts.until ? new Date(opts.until + "T00:00:00Z") : today;
  let since: Date;
  if (opts.since) {
    since = new Date(opts.since + "T00:00:00Z");
  } else {
    const days = opts.days && opts.days > 0 ? opts.days : 30;
    since = new Date(until);
    since.setUTCDate(since.getUTCDate() - (days - 1));
  }
  const days = Math.max(1, Math.round((+until - +since) / 86_400_000) + 1);
  // Prior period: same length, immediately before `since`.
  const prevUntil = new Date(since);
  prevUntil.setUTCDate(prevUntil.getUTCDate() - 1);
  const prevSince = new Date(prevUntil);
  prevSince.setUTCDate(prevSince.getUTCDate() - (days - 1));
  return { since: iso(since), until: iso(until), prevSince: iso(prevSince), prevUntil: iso(prevUntil), days };
}

// ── Issue derivation ─────────────────────────────────────────────────────────
//
// Heuristic, metric-driven issues. These are intentionally generic and honest —
// the deep audits (keywords, search terms, feed health, creative fatigue) belong
// to the Phase 2 agent-generated report engine, not to live API math.

/**
 * `currency` is the account's own (ISO 4217, as the platform reports it) so a
 * EUR or GBP account is never told what it spent in dollars. Defaults to USD
 * only for the sample data, which is minted in USD.
 */
export function deriveIssues(cur: Metrics, prev: Metrics | null, daily: DailyPoint[], currency = "VND"): Issue[] {
  const issues: Issue[] = [];
  const money = (n: number) => formatMoney(n, currency);
  const drop = (a: number, b: number | undefined) => (b && b > 0 ? ((a - b) / b) * 100 : null);

  if (cur.spend > 0 && cur.roas < 1) {
    issues.push({
      id: "roas-below-1",
      title: "Tài khoản đang chạy lỗ",
      detail: `ROAS chỉ đạt ${cur.roas.toFixed(2)}x — mỗi đồng trong số ${money(cur.spend)} chi tiêu thu về ít hơn chi phí bỏ ra.`,
      action: "Tạm dừng các chiến dịch có ROAS thấp nhất và chuyển ngân sách sang các chiến dịch hiệu quả trước khi tăng quy mô.",
      severity: "high",
    });
  } else if (cur.spend > 0 && cur.roas < 2) {
    issues.push({
      id: "roas-thin",
      title: "ROAS dưới ngưỡng sinh lời an toàn",
      detail: `ROAS đạt ${cur.roas.toFixed(2)}x, thấp hơn ngưỡng 2.0x thường cần để đảm bảo lợi nhuận sau khi trừ giá vốn và chi phí vận hành.`,
      action: "Thu hẹp tệp mục tiêu và cắt giảm 20% nhóm quảng cáo có ROAS thấp nhất để nâng cao tỷ suất hoàn vốn tổng thể.",
      severity: "medium",
    });
  }

  const cpaChange = drop(cur.cpa, prev?.cpa);
  if (prev && cpaChange !== null && cpaChange > 15 && cur.spend > 0) {
    issues.push({
      id: "cpa-rising",
      title: "Chi phí mỗi chuyển đổi (CPA) đang tăng",
      detail: `Giá mỗi chuyển đổi tăng ${cpaChange.toFixed(0)}% so với kỳ trước (hiện tại là ${money(cur.cpa)}).`,
      action: "Làm mới các mẫu quảng cáo đã bị bão hòa và kiểm tra độ trùng lặp đối tượng — CPA tăng thường là dấu hiệu tệp khán giả bị bão hòa.",
      severity: cpaChange > 30 ? "high" : "medium",
    });
  }

  const ctrChange = drop(cur.ctr, prev?.ctr);
  if (prev && ctrChange !== null && ctrChange < -10) {
    issues.push({
      id: "ctr-falling",
      title: "CTR sụt giảm — Mẫu quảng cáo bị bão hòa",
      detail: `Tỷ lệ nhấp (CTR) giảm ${Math.abs(ctrChange).toFixed(0)}% so với kỳ trước (hiện tại là ${cur.ctr.toFixed(2)}%).`,
      action: "Bổ sung thêm 3 biến thể nội dung quảng cáo mới cho nhóm quảng cáo hàng đầu và tắt các mẫu quảng cáo kém hiệu quả.",
      severity: "medium",
    });
  }

  if (cur.clicks > 100 && cur.convRate < 1) {
    issues.push({
      id: "low-conv-rate",
      title: "Tỷ lệ chuyển đổi thấp",
      detail: `Chỉ ${cur.convRate.toFixed(2)}% trong tổng số ${formatNum(cur.clicks)} lượt nhấp có phát sinh chuyển đổi — điểm thất thoát nằm ở trải nghiệm trang đích sau nhấp chuột.`,
      action: "Kiểm tra tốc độ tải trang đích, tính nhất quán thông điệp giữa quảng cáo và web, đồng thời xác nhận mã chuyển đổi hoạt động chuẩn xác.",
      severity: "medium",
    });
  }

  // Spend up while conversions down — a classic efficiency warning.
  const spendUp = drop(cur.spend, prev?.spend);
  const convDown = drop(cur.conversions, prev?.conversions);
  if (prev && spendUp !== null && convDown !== null && spendUp > 5 && convDown < -5) {
    issues.push({
      id: "spend-up-conv-down",
      title: "Chi tiêu tăng nhưng chuyển đổi lại giảm",
      detail: `Chi tiêu tăng ${spendUp.toFixed(0)}% nhưng lượt chuyển đổi lại giảm ${Math.abs(convDown).toFixed(0)}% so với kỳ trước.`,
      action: "Đặt trần giới hạn ngân sách cho các chiến dịch đang ngốn thêm chi tiêu cho đến khi số lượng chuyển đổi phục hồi.",
      severity: "high",
    });
  }

  return issues;
}

const formatMoney = (n: number, currency: string) => {
  if (currency === "VND" || currency === "VNĐ") {
    return new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(Math.round(n));
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n);
};

const formatNum = (n: number) =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));

/** Map an account's ROAS to a severity used for the portfolio "Top Issues" ranking. */
export function roasSeverity(roasValue: number): "high" | "medium" | "low" {
  if (roasValue < 1) return "high";
  if (roasValue < 2.5) return "medium";
  return "low";
}
