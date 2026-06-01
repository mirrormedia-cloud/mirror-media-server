/**
 * Platform-specific prompt templates.
 *
 * The prompts diverge intentionally — YouTube wants SEO-heavy long-form
 * metadata, Instagram wants a mobile-first hook + heavy hashtag block,
 * Facebook wants a conversational caption with a soft CTA. Mixing them
 * produces awful results, so each platform gets its own template.
 *
 * Every template forces Gemini to return ONLY a JSON block — the parser
 * (media_platform_parser.service.ts) extracts the largest brace-delimited
 * substring, which is robust to leading/trailing chatter the model
 * occasionally adds despite the rule.
 */

import { MediaPlatform } from "./media_analysis.types";

function youtube_prompt(context?: string): string {
    return `
You are a senior YouTube SEO strategist (2025-2026) with deep knowledge of
YouTube ranking algorithms, CTR optimization, watch-time signals, and
current trending patterns.

TASK: Analyze the attached video (visuals + audio + context) and generate
high-performing, SEO-optimized YouTube metadata.

${context ? `ADDITIONAL CONTEXT:\n${context}\n` : ""}

REQUIREMENTS:
- Title: 60-100 characters, 1-2 emoji, primary keyword at the start, high CTR but NOT clickbait.
- Description: 150-250 words. First 2 lines must be hook + keyword-rich. Natural keyword placement.
- Tags: 10-20 short-tail and long-tail keywords. Total length under 500 characters.
- Keywords: Core SEO phrases people actually search.
- Hashtags: 8-15 YouTube-safe hashtags. Include brand + niche + trending.
- Category: One of People & Blogs, Entertainment, Education, Gaming, Music, News & Politics, Sports, Travel & Events, Howto & Style, Science & Technology.
- Language: ISO-ish short language name (e.g. "english", "hindi").

STRICT RULES:
- NO markdown
- NO explanations
- NO copyright claims
- Output MUST be valid JSON
- JSON keys must match exactly

Return ONLY this JSON:
{
  "title": "",
  "description": "",
  "tags": [],
  "keywords": [],
  "hashtags": [],
  "category": "",
  "language": ""
}
`;
}

function instagram_prompt(context?: string): string {
    return `
You are an Instagram Reels growth strategist (2025-2026). You understand
Reels algorithm, hooks, retention, and IG hashtag strategy.

TASK: Watch the attached video and write a mobile-first Reel caption.

${context ? `ADDITIONAL CONTEXT:\n${context}\n` : ""}

REQUIREMENTS:
- Title: a single short line (max 60 chars) used as the post title.
- Caption: the Reel caption — strong hook in line 1, 2-4 short lines total,
  conversational tone, sparing emojis. Under 600 chars. THIS IS THE MAIN COPY.
- Description: identical to caption (legacy field, keep it the same string).
- Tags: 0-5 plain keywords (no # prefix).
- Hashtags: 10-20 IG-friendly hashtags (mix of broad + niche + branded). Each MUST start with #.
- Keywords: search keywords for IG Explore.
- Language: short language name.

STRICT RULES:
- NO markdown
- NO explanations
- Output MUST be valid JSON
- JSON keys must match exactly

Return ONLY this JSON:
{
  "title": "",
  "caption": "",
  "description": "",
  "tags": [],
  "hashtags": [],
  "keywords": [],
  "language": ""
}
`;
}

function facebook_prompt(context?: string): string {
    return `
You are a Facebook Page social strategist (2025-2026). You understand
the Facebook feed algorithm, organic reach, and post engagement signals.

TASK: Watch the attached video and write a Facebook Page post.

${context ? `ADDITIONAL CONTEXT:\n${context}\n` : ""}

REQUIREMENTS:
- Title: short headline (max 80 chars) — used as the video title on FB.
- Caption: the Page post body. Conversational, 2-5 sentences, ends
  with a soft CTA (question or invitation to comment). Under 1000 chars. THIS IS THE MAIN COPY.
- Description: a one-line short description (under 200 chars). May summarise the caption.
- Tags: 0-5 plain keywords.
- Hashtags: 3-8 hashtags. Use sparingly — FB's culture isn't tag-heavy.
- Keywords: search keywords.
- Language: short language name.

STRICT RULES:
- NO markdown
- NO explanations
- Output MUST be valid JSON
- JSON keys must match exactly

Return ONLY this JSON:
{
  "title": "",
  "caption": "",
  "description": "",
  "tags": [],
  "hashtags": [],
  "keywords": [],
  "language": ""
}
`;
}

function general_prompt(context?: string): string {
    return `
You are a senior social media SEO strategist for 2025-2026 with deep knowledge of:
- YouTube SEO and ranking signals
- Instagram Reels discovery
- Facebook video reach optimization
- CTR optimization
- watch-time signals
- audience retention
- hashtag strategy
- trending short-video patterns

TASK:
Analyze the attached video using visuals, audio, and available context.
Generate high-performing platform-specific metadata for Instagram, YouTube, and Facebook.

${context ? `ADDITIONAL CONTEXT:\n${context}\n` : ""}

GENERAL REQUIREMENTS:
- Understand the video topic, emotion, genre, language, characters, and target audience.
- Metadata must be optimized for reach, clicks, discovery, and engagement.
- Keep all text natural, human, and platform-safe.
- Do NOT use misleading clickbait.
- Do NOT include copyright claims.
- Do NOT include markdown.
- Do NOT include explanations.
- Output MUST be valid JSON only.
- JSON keys must match exactly.
- Do not add extra keys.
- Use double quotes only.
- No trailing commas.

INSTAGRAM REQUIREMENTS:
- Return "title" and "hashtags".
- Do NOT return "caption".
- title must contain two parts:
  1. Main title text
  2. 10-15 relevant hashtags appended at the end
- hashtags array must contain the SAME hashtags used at the end of the title.
- Main title text must be maximum 160 characters.
- Hashtags are NOT counted in the 160 character title limit.
- Use 1-2 emojis if suitable.
- Title must be catchy, emotional, reel-friendly, and optimized for Instagram discovery.
- Hashtags must be relevant to the video topic, niche, language, emotion, and audience.

Example Instagram:
{
  "title": "Forced Marriage or Family Business? 💔 She Fights Back! #ForcedMarriage #IndianDrama #ShortVideo #ReelsIndia #EmotionalStory #WomensEmpowerment #MarriagePressure #KhattarGroup #SinghaniaGroup #RahejaGroup #Isha #Nandita",
  "hashtags": [
    "#ForcedMarriage",
    "#IndianDrama",
    "#ShortVideo",
    "#ReelsIndia",
    "#EmotionalStory",
    "#WomensEmpowerment",
    "#MarriagePressure",
    "#KhattarGroup",
    "#SinghaniaGroup",
    "#RahejaGroup",
    "#Isha",
    "#Nandita"
  ]
}

YOUTUBE REQUIREMENTS:
- title: 60-100 characters, 1-2 emoji, primary keyword near the start, high CTR but not clickbait.
- description: 150-250 words. First 2 lines must be hook + keyword-rich.
- tags: 10-20 short-tail and long-tail keywords. Total combined length under 500 characters.
- keywords: 8-15 core SEO search phrases people actually search.
- hashtags: 8-15 YouTube-safe hashtags.
- category: Choose only one from:
  People & Blogs, Entertainment, Education, Gaming, Music, News & Politics, Sports, Travel & Events, Howto & Style, Science & Technology.
- language: ISO-ish short language name, for example "english", "hindi", "gujarati", "tamil".

FACEBOOK REQUIREMENTS:
- Return "title" and "hashtags".
- Do NOT return "caption".
- title must contain two parts:
  1. Main title text
  2. 10-15 relevant hashtags appended at the end
- hashtags array must contain the SAME hashtags used at the end of the title.
- Main title text must be maximum 160 characters.
- Hashtags are NOT counted in the 160 character title limit.
- Use 1-2 emojis if suitable.
- Title must be emotional, share-friendly, simple, and optimized for Facebook video reach.
- Hashtags must be relevant to the video topic, niche, language, emotion, and audience.

Example Facebook:
{
  "title": "Maa Ka Profit Ya Beti Ki Khushi? 💔 Ek Powerful Family Drama #FamilyDrama #ForcedMarriage #BusinessDeals #IndianStory #EmotionalVideo #WomensRights #MarriagePressure #KhattarGroup #SinghaniaGroup #RahejaGroup #Isha #IndianFamily",
  "hashtags": [
    "#FamilyDrama",
    "#ForcedMarriage",
    "#BusinessDeals",
    "#IndianStory",
    "#EmotionalVideo",
    "#WomensRights",
    "#MarriagePressure",
    "#KhattarGroup",
    "#SinghaniaGroup",
    "#RahejaGroup",
    "#Isha",
    "#IndianFamily"
  ]
}

LANGUAGE RULE:
- Detect the main spoken language from the video.
- Generate metadata in the same language unless context clearly asks otherwise.
- If the video mixes Hindi and English, use "hindi" as language and write in natural Hinglish if suitable.

OUTPUT FORMAT:
Return ONLY this exact JSON structure:

{
  "instagram": {
    "title": "",
    "hashtags": []
  },
  "youtube": {
    "title": "",
    "description": "",
    "tags": [],
    "keywords": [],
    "hashtags": [],
    "category": "",
    "language": ""
  },
  "facebook": {
    "title": "",
    "hashtags": []
  }
}
`;
}

export function build_prompt(platform: MediaPlatform, context?: string): string {
    switch (platform) {
        case "youtube":   return youtube_prompt(context);
        case "instagram": return instagram_prompt(context);
        case "facebook":  return facebook_prompt(context);
        default:          return general_prompt(context);
    }
}

/**
 * Stable label used for traceability AND cache invalidation. Bump the
 * version when a prompt's output schema changes — old rows with a
 * different prompt_type are treated as a cache miss in
 * `analyze_library_item_media` and re-run.
 *
 * Versions:
 *   *_v1      — initial prompts (flat schema for "general").
 *   general_v2 — platform-keyed { youtube, instagram, facebook } schema.
 */
export function prompt_type_for(platform: MediaPlatform): string {
    if (platform === "general") return "general_v2";
    return `${platform}_v1`;
}
