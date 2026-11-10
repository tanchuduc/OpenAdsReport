// AI-generated hints and analysis via Google Gemini API or OpenRouter.
// When GEMINI_API_KEY (recommended) or OPENROUTER_API_KEY is injected, the dashboard
// upgrades its heuristic issues and reports to sharp, money-focused recommendations
// written by Gemini. Falls back to deterministic heuristics whenever the key is absent or fails.

import type { Issue, Metrics, Platform } from "./providers/types";
import { secret } from "@clawnify/connections";
import type { Bindings } from "./env";

export interface AIConfig {
  provider: "gemini" | "openrouter";
  apiKey: string;
  model?: string;
}

export function getAiConfig(env: Bindings): AIConfig | null {
  const gProcess = (globalThis as any).process;
  const geminiKey =
    secret("GEMINI_API_KEY", env) ||
    env.GEMINI_API_KEY ||
    gProcess?.env?.GEMINI_API_KEY;

  if (geminiKey) {
    const model =
      secret("GEMINI_MODEL", env) ||
      env.GEMINI_MODEL ||
      gProcess?.env?.GEMINI_MODEL ||
      "gemini-2.5-flash";
    return { provider: "gemini", apiKey: geminiKey, model };
  }

  const openrouterKey =
    secret("OPENROUTER_API_KEY", env) ||
    env.OPENROUTER_API_KEY ||
    gProcess?.env?.OPENROUTER_API_KEY;

  if (openrouterKey) {
    return {
      provider: "openrouter",
      apiKey: openrouterKey,
      model: "google/gemini-3.1-flash-lite",
    };
  }

  return null;
}

export interface HintContext {
  accountName: string;
  platform: Platform;
  currency: string;
  current: Metrics;
  previous: Metrics | null;
  days: number;
}

const fmtMoney = (n: number, cur: string) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: cur, maximumFractionDigits: 0 }).format(n);

function snapshot(c: HintContext): string {
  const { current: m, previous: p, currency } = c;
  const line = (label: string, cur: string, prev?: string) =>
    `${label}: ${cur}${prev ? ` (prev ${prev})` : ""}`;
  return [
    `Account "${c.accountName}" on ${c.platform === "meta" ? "Meta Ads" : "Google Ads"}, last ${c.days} days.`,
    line("Spend", fmtMoney(m.spend, currency), p ? fmtMoney(p.spend, currency) : undefined),
    line("Revenue", fmtMoney(m.revenue, currency), p ? fmtMoney(p.revenue, currency) : undefined),
    line("ROAS", `${m.roas.toFixed(2)}x`, p ? `${p.roas.toFixed(2)}x` : undefined),
    line("Conversions", String(Math.round(m.conversions)), p ? String(Math.round(p.conversions)) : undefined),
    line("CPA", fmtMoney(m.cpa, currency), p ? fmtMoney(p.cpa, currency) : undefined),
    line("CTR", `${m.ctr.toFixed(2)}%`, p ? `${p.ctr.toFixed(2)}%` : undefined),
    line("Conv. rate", `${m.convRate.toFixed(2)}%`, p ? `${p.convRate.toFixed(2)}%` : undefined),
  ].join("\n");
}

const SYSTEM = `You are a senior paid-media consultant auditing an ad account from its top-line metrics.
Return 1-3 of the most important issues, each tied to money (ROAS, CPA, revenue, or wasted spend).
Be decisive and specific — no hedging, no theory. Respond ONLY with JSON:
{"issues":[{"title":"short headline","detail":"what's wrong and why it hurts, with the numbers","action":"the exact fix to apply","severity":"high|medium|low"}]}
If the account looks healthy, return fewer issues (even an empty array).`;

export function parseJsonSafe<T = any>(raw: string): T | null {
  try {
    const clean = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    return JSON.parse(clean);
  } catch {
    return null;
  }
}

export async function callAI(
  configOrKey: AIConfig | string,
  systemPrompt: string,
  userPrompt: string,
  maxTokens = 1000,
): Promise<string | null> {
  const config: AIConfig =
    typeof configOrKey === "string"
      ? configOrKey.startsWith("AIza")
        ? { provider: "gemini", apiKey: configOrKey, model: "gemini-2.5-flash" }
        : { provider: "openrouter", apiKey: configOrKey, model: "google/gemini-3.1-flash-lite" }
      : configOrKey;

  try {
    if (config.provider === "gemini") {
      const model = config.model || "gemini-2.5-flash";
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: systemPrompt }],
          },
          contents: [
            {
              role: "user",
              parts: [{ text: userPrompt }],
            },
          ],
          generationConfig: {
            temperature: 0.3,
            maxOutputTokens: maxTokens,
            responseMimeType: "application/json",
          },
        }),
      });
      if (!res.ok) {
        console.error("Gemini API error:", res.status, await res.text().catch(() => ""));
        return null;
      }
      const data = (await res.json()) as any;
      return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    } else {
      const model = config.model || "google/gemini-3.1-flash-lite";
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          temperature: 0.3,
          max_tokens: maxTokens,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
        }),
      });
      if (!res.ok) {
        console.error("OpenRouter API error:", res.status, await res.text().catch(() => ""));
        return null;
      }
      const data = (await res.json()) as any;
      return data?.choices?.[0]?.message?.content ?? null;
    }
  } catch (err) {
    console.error("AI call failed:", err);
    return null;
  }
}

export async function aiHints(
  configOrKey: AIConfig | string,
  ctx: HintContext,
): Promise<Issue[] | null> {
  const content = await callAI(configOrKey, SYSTEM, snapshot(ctx), 700);
  if (!content) return null;

  const parsed = parseJsonSafe<{ issues?: any[] }>(content);
  const raw = Array.isArray(parsed?.issues) ? parsed.issues : [];
  return raw.slice(0, 3).map((it, i) => ({
    id: `ai-${i}`,
    title: String(it.title ?? "Issue"),
    detail: String(it.detail ?? ""),
    action: String(it.action ?? ""),
    severity: it.severity === "high" || it.severity === "low" ? it.severity : "medium",
  }));
}
