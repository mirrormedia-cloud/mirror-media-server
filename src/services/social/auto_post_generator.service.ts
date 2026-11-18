/**
 * Auto Post — AI "thought" generator + Facebook text-only publisher.
 *
 * generate_thought_post()  → Gemini (text only) returns
 *                             { headline, body, hashtags[] } and we lay it
 *                             out into a decorated plain-text post with
 *                             emojis and "·" / "." separators.
 * post_text_to_facebook()  → POST /{page_id}/feed with `message` only —
 *                             no media.
 */

import axios from "axios";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { SocialAccount } from "../../db/models";

const GRAPH_VERSION = "v18.0";
const GRAPH_URL = process.env.GRAPH_URL || `https://graph.facebook.com/${GRAPH_VERSION}`;

const MODEL_FALLBACK_CHAIN = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

/** Rotated per post so consecutive posts don't all sound the same. */
const TOPICS = [
    "a surprising space or rocket science fact (SpaceX, NASA, ISRO style achievements)",
    "a recent-feeling technology or AI milestone written as a short headline",
    "a motivational thought about discipline and consistency",
    "an inspiring line about entrepreneurs and startups",
    "a fun science fact that makes people say 'wow'",
    "a short life lesson about patience and growth",
    "a positive thought about health, fitness or mindfulness",
    "an interesting fact about the ocean, nature or animals",
    "a thought about money, saving and smart habits",
    "a light-hearted, relatable everyday-life observation",
    "an innovation in electric vehicles, energy or the environment",
    "a famous historical 'on this kind of day' style achievement",
];

const DIVIDERS = [
    "· · · · · · · · · · · · · · ·",
    ". . . . . . . . . . . . . . .",
    "•─────────•°•❀•°•─────────•",
    "✦ · · · · · · · · · · · · ✦",
    "⋆ ˚｡⋆ . . . . . . . . ⋆｡˚ ⋆",
];

const FALLBACK_HASHTAGS = ["#ThoughtOfTheDay", "#DailyInspiration", "#Motivation", "#Trending", "#Facebook"];

export interface GeneratedThought {
    headline: string;
    body: string;
    hashtags: string[];
    /** Final text exactly as it will be posted. */
    message: string;
    topic: string;
    model: string;
}

function dlog(step: string, data?: Record<string, any>) {
    console.log(`[auto-post] ${step}${data ? " " + JSON.stringify(data) : ""}`);
}

function pick<T>(arr: T[]): T {
    return arr[Math.floor(Math.random() * arr.length)]!;
}

function parse_json(text: string): any | null {
    const cleaned = text.replace(/```json|```/gi, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch { return null; }
}

function normalise_hashtags(raw: unknown): string[] {
    const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const h of list) {
        const word = String(h ?? "").replace(/^#+/, "").replace(/[^\p{L}\p{N}_]/gu, "");
        if (!word) continue;
        const tag = `#${word}`;
        const key = tag.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(tag);
    }
    for (const f of FALLBACK_HASHTAGS) {
        if (out.length >= 6) break;
        if (!seen.has(f.toLowerCase())) { seen.add(f.toLowerCase()); out.push(f); }
    }
    return out.slice(0, 12);
}

export function compose_message(headline: string, body: string, hashtags: string[]): string {
    const divider = pick(DIVIDERS);
    return [
        headline.trim(),
        divider,
        body.trim(),
        divider,
        hashtags.join(" "),
    ].filter(Boolean).join("\n\n");
}

export async function generate_thought_post(recent: string[] = []): Promise<GeneratedThought> {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");

    const topic = pick(TOPICS);
    const avoid = recent
        .filter(Boolean)
        .slice(0, 8)
        .map((r, i) => `${i + 1}. ${r.replace(/\s+/g, " ").slice(0, 160)}`)
        .join("\n");

    const prompt = `You write short, viral, text-only Facebook Page posts.

Write ONE fresh post about: ${topic}.

Style:
- Headline: one punchy line (max 90 chars) that starts AND ends with a fitting emoji, e.g. "🚀 Today a rocket was caught mid-air! 🤯".
- Body: 2–4 short lines, each starting with an emoji. Simple English, positive tone, easy to read on mobile. Total body under 400 characters.
- Do NOT invent specific dates, prices or quotes attributed to real people. Keep facts general and safe.
- Hashtags: 8–10 relevant hashtags (mix of broad + niche), no spaces inside a tag.
- No links, no "click here", no media references.
${avoid ? `\nDo NOT repeat or closely paraphrase these recent posts:\n${avoid}\n` : ""}
Return ONLY JSON:
{"headline": "...", "body": "line 1\\nline 2\\nline 3", "hashtags": ["#tag1", "#tag2"]}`;

    const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    let last_err: any = null;
    for (const model_name of MODEL_FALLBACK_CHAIN) {
        try {
            const model = genai.getGenerativeModel({
                model: model_name,
                generationConfig: { temperature: 1.0, maxOutputTokens: 1024, responseMimeType: "application/json" },
            });
            const res = await model.generateContent(prompt);
            const parsed = parse_json(res.response.text());
            if (!parsed?.headline || !parsed?.body) throw new Error("Gemini returned no usable post");
            const headline = String(parsed.headline).trim();
            const body = String(parsed.body).replace(/\\n/g, "\n").trim();
            const hashtags = normalise_hashtags(parsed.hashtags);
            dlog("generated", { model: model_name, topic, chars: body.length });
            return {
                headline,
                body,
                hashtags,
                message: compose_message(headline, body, hashtags),
                topic,
                model: model_name,
            };
        } catch (err: any) {
            last_err = err;
            dlog("generate_failed", { model: model_name, status: err?.status, error: err?.message });
        }
    }
    throw new Error(`AI thought generation failed: ${last_err?.message ?? "unknown error"}`);
}

export async function post_text_to_facebook(account: SocialAccount, message: string): Promise<{ post_id: string; raw: any }> {
    if (account.platform !== "facebook") throw new Error("Selected account is not a Facebook Page");
    if (!account.page_id || !account.access_token) {
        throw new Error("Facebook Page is missing page_id or access token — reconnect Facebook");
    }
    try {
        const res = await axios.post(`${GRAPH_URL}/${account.page_id}/feed`, null, {
            params: { message, access_token: account.access_token },
        });
        const post_id = res.data?.id;
        if (!post_id) throw new Error("Facebook returned no post id");
        dlog("fb_posted", { account_id: account.id, page_id: account.page_id, post_id });
        return { post_id, raw: res.data };
    } catch (err: any) {
        const fb_msg = err?.response?.data?.error?.message;
        dlog("fb_post_failed", { account_id: account.id, error: fb_msg ?? err?.message });
        throw new Error(fb_msg ? `Facebook: ${fb_msg}` : (err?.message ?? "Facebook post failed"));
    }
}
