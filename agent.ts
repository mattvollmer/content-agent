import { streamText, tool } from "ai";
import * as blink from "blink";
import { z } from "zod";
import { convertToModelMessages } from "ai";
import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { isIP } from "node:net";
import * as slackbot from "@blink-sdk/slackbot";
import { BetaAnalyticsDataClient } from "@google-analytics/data";

const DATOCMS_ENDPOINT = "https://graphql.datocms.com/";

// Simple in-memory cache for fetched pages
const pageCache = new Map<string, { at: number; data: unknown }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function isPrivateHostname(host: string): boolean {
  const lower = host.toLowerCase();
  if (
    lower === "localhost" ||
    lower === "127.0.0.1" ||
    lower === "0.0.0.0" ||
    lower === "::1" ||
    lower.endsWith(".local")
  ) {
    return true;
  }
  // If it's an IP, check private ranges
  if (isIP(lower)) {
    // IPv4 checks
    if (lower.startsWith("10.")) return true;
    if (lower.startsWith("127.")) return true;
    if (lower.startsWith("192.168.")) return true;
    const octets = lower.split(".").map((n) => parseInt(n, 10));
    if (
      octets.length === 4 &&
      octets[0] === 172 &&
      octets[1] >= 16 &&
      octets[1] <= 31
    )
      return true;
  }
  return false;
}

async function fetchRobotsAllowed(target: URL, userAgent = "content-agent") {
  try {
    const robotsUrl = new URL(
      "/robots.txt",
      `${target.protocol}//${target.host}`
    );
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(robotsUrl.toString(), {
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return true; // no robots to enforce
    const body = await res.text();
    // Minimal robots parsing for User-agent: * or matching agent
    const lines = body
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, "").trim())
      .filter(Boolean);
    type Rule = { type: "allow" | "disallow"; path: string };
    const groups: { agents: string[]; rules: Rule[] }[] = [];
    let current: { agents: string[]; rules: Rule[] } | null = null;
    for (const line of lines) {
      const [rawKey, ...rest] = line.split(":");
      if (!rawKey || rest.length === 0) continue;
      const key = rawKey.toLowerCase().trim();
      const value = rest.join(":").trim();
      if (key === "user-agent") {
        if (current && current.rules.length > 0) groups.push(current);
        current = { agents: [value.toLowerCase()], rules: [] };
      } else if (key === "allow" || key === "disallow") {
        if (!current) current = { agents: ["*"], rules: [] };
        current.rules.push({ type: key, path: value });
      }
    }
    if (current) groups.push(current);

    // Choose rules for agent or *
    const ua = userAgent.toLowerCase();
    const applicable =
      groups.find((g) => g.agents.some((a) => a === ua)) ||
      groups.find((g) => g.agents.some((a) => a === "*"));
    if (!applicable) return true;

    const path = target.pathname || "/";
    // Longest match wins between allow/disallow
    let best: { type: "allow" | "disallow"; len: number } | null = null;
    for (const r of applicable.rules) {
      if (r.path === "") continue;
      if (path.startsWith(r.path)) {
        const len = r.path.length;
        if (!best || len > best.len) best = { type: r.type, len };
      }
    }
    if (!best) return true;
    return best.type === "allow";
  } catch {
    return true; // fail-open to avoid false negatives
  }
}

function extractMetadata(doc: Document) {
  const getMeta = (name: string) =>
    doc.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ||
    doc.querySelector(`meta[property="${name}"]`)?.getAttribute("content") ||
    null;
  const title =
    doc.querySelector("meta[property='og:title']")?.getAttribute("content") ||
    doc.querySelector("title")?.textContent ||
    null;
  const description =
    getMeta("description") || getMeta("og:description") || null;
  const publishedAt = getMeta("article:published_time");
  const author = getMeta("author") || getMeta("article:author");
  return { title, description, publishedAt, author };
}

function tokenize(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

function relevantPassages(text: string, question: string, max = 10) {
  const qTokens = new Set(tokenize(question));
  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 60);
  const scored = paras
    .map((p) => {
      const t = tokenize(p);
      const score = t.reduce((acc, w) => acc + (qTokens.has(w) ? 1 : 0), 0);
      return { p, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map(({ p, score }) => ({ snippet: p.slice(0, 600), score }));
  return scored;
}

async function datoQuery<T>(
  query: string,
  variables?: Record<string, unknown>
) {
  const token = process.env.DATOCMS_API_TOKEN;
  if (!token) {
    throw new Error(
      "Missing DATOCMS_API_TOKEN environment variable. Please export your DatoCMS API key."
    );
  }

  const res = await fetch(DATOCMS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      // Include drafts so the agent can report on both draft and published content
      "X-Include-Drafts": "true",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = (await res.json()) as {
    data?: T;
    errors?: { message: string }[];
  };

  if (!res.ok || json.errors) {
    const err = json.errors?.map((e) => e.message).join("; ") || res.statusText;
    throw new Error(`DatoCMS GraphQL error: ${err}`);
  }

  return json.data as T;
}

// GA4 helpers
let gaClient: BetaAnalyticsDataClient | null = null;
function getGAClient() {
  if (!gaClient) {
    const creds = process.env.GOOGLE_CREDENTIALS_JSON
      ? { credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON) }
      : undefined;
    gaClient = new BetaAnalyticsDataClient(creds);
  }
  return gaClient;
}

function yyyymmddToIso(d: string) {
  return d && d.length === 8
    ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
    : d;
}

function toYMD(date: Date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function resolveAbsoluteUrl(input: {
  url?: string;
  path?: string;
  slug?: string;
}) {
  if (input.url) return input.url;
  const origin = process.env.SITE_ORIGIN;
  if (!origin) {
    throw new Error(
      "Missing SITE_ORIGIN environment variable. Provide full url, or set SITE_ORIGIN to construct pageLocation from path/slug."
    );
  }
  if (input.path) {
    const p = input.path.startsWith("/") ? input.path : `/${input.path}`;
    return `${origin.replace(/\/$/, "")}${p}`;
  }
  if (input.slug) {
    const prefix = (process.env.BLOG_PATH_PREFIX || "/blog/").replace(
      /\/$/,
      ""
    );
    const s = input.slug.startsWith("/") ? input.slug.slice(1) : input.slug;
    return `${origin.replace(/\/$/, "")}${prefix}/${s}`;
  }
  throw new Error("Provide one of url, path, or slug");
}

const DEFAULT_GA_METRICS = [
  "screenPageViews",
  "activeUsers",
  "sessions",
] as const;
const ALLOWED_GA_METRICS = new Set(DEFAULT_GA_METRICS);

type AllowedMetric = (typeof DEFAULT_GA_METRICS)[number];

async function runGa4ReportByLocation(opts: {
  pageLocation: string;
  startDate: string;
  endDate: string;
  metrics?: AllowedMetric[];
}) {
  const propertyId = process.env.GA4_PROPERTY_ID;
  if (!propertyId) {
    throw new Error("Missing GA4_PROPERTY_ID environment variable.");
  }

  const metrics = (
    opts.metrics && opts.metrics.length ? opts.metrics : DEFAULT_GA_METRICS
  ).map((name) => ({ name }));

  const [resp] = await getGAClient().runReport({
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate: opts.startDate, endDate: opts.endDate }],
    dimensions: [{ name: "date" }, { name: "pageLocation" }],
    dimensionFilter: {
      filter: {
        fieldName: "pageLocation",
        stringFilter: { matchType: "EXACT", value: opts.pageLocation },
      },
    },
    metrics,
    limit: 100000,
  });

  type SeriesRow = { date: string } & Record<string, number>;
  const rows = resp.rows || [];
  const series: SeriesRow[] = rows.map((r) => {
    const date = yyyymmddToIso(r.dimensionValues?.[0]?.value || "");
    const metricsObj: Record<string, number> = {};
    r.metricValues?.forEach((mv, i) => {
      metricsObj[metrics[i].name] = Number(mv.value || 0);
    });
    return { date, ...metricsObj } as SeriesRow;
  });

  const totals = series.reduce<Record<string, number>>((acc, day) => {
    for (const [k, v] of Object.entries(day)) {
      if (k === "date") continue;
      if (typeof v === "number") {
        acc[k] = (acc[k] ?? 0) + v;
      }
    }
    return acc;
  }, {});

  return {
    pageLocation: opts.pageLocation,
    startDate: opts.startDate,
    endDate: opts.endDate,
    totals,
    series,
  };
}

// Platform detection and prompt generation
const detectPlatform = (messages: any[]) => {
  return slackbot.findLastMessageMetadata(messages) ? "slack" : "web";
};

const createSystemPrompt = (platform: "slack" | "web") => {
  const basePrompt = `You are Coder's Blog Analyst. Your job is to help users understand what content exists in DatoCMS today, including draft posts, correlate recent GitHub releases to potential authors, and assist with content planning and gap analysis.

## Core Rules:
- When listing or summarizing posts, only fetch lightweight metadata (id, title, _firstPublishedAt, description, slug, _status, _createdAt) and the total count.
- Do NOT fetch or read the full content/body of posts unless the user explicitly asks for additional context or the content itself. Only then, call the content tool.
- Clearly label whether posts are draft or published using the _status field.
- Prefer the most recent content first.
- If the user asks for specific posts (by slug or id), retrieve only what is necessary.
- For targeted searches, use the author/topic search tools without fetching content.
- For GitHub releases, default to metadata only (exclude body) unless explicitly requested to include it.
- All links you provide must be in full URL format (e.g. https://coder.com/blog/[slug])
- For content planning, focus on identifying gaps and matching expertise to topics.
- Use the web browsing tool only when the user asks for page content, or when additional context is needed from links found in blog posts or releases.
- If an operation fails, return the error message without guessing.`;

  if (platform === "slack") {
    return `${basePrompt}

## Slack-Specific Behavior:
When chatting in Slack channels:

### Interaction Protocol:
- ALWAYS first call slackbot_react_to_message with reaction "thinking_face" to add an :thinking_face: reaction to the latest incoming message before doing anything else
- ALWAYS remove the emoji after you send your response by calling slackbot_react_to_message with reaction "thinking_face" and remove_reaction: true

### Communication Style:
- Keep responses concise and to the point to respect users' time
- Aim for clarity and brevity over comprehensive explanations
- Use bullet points or numbered lists for easy reading when listing items
- Never include emojis in responses unless explicitly asked to do so
- Prefer short responses with maximum 2,900 characters

### Slack Formatting Rules:
- *text* = bold (NOT italics like in standard markdown)
- _text_ = italics  
- \`text\` = inline code
- \`\`\` = code blocks (do NOT put a language after the backticks)
- ~text~ = strikethrough
- <http://example.com|link text> = links
- tables must be in a code block
- user mentions must be in the format <@user_id> (e.g. <@U01UBAM2C4D>)

### Never Use in Slack:
- Headings (#, ##, ###, etc.)
- Double asterisks (**text**) - Slack doesn't support this
- Standard markdown bold/italic conventions`;
  } else {
    return `${basePrompt}

## Web Chat Behavior:

### Communication Style:
- Provide comprehensive explanations when helpful
- Use structured formatting to organize information clearly
- Include detailed context when discussing technical topics

### Web Formatting Rules:
- Your responses use GitHub-flavored Markdown rendered with CommonMark specification
- Code blocks must be rendered with \`\`\` and the language name
- Use standard markdown conventions for links: [text](url)
- Mermaid diagrams can be used for visualization when helpful`;
  }
};

export default blink.agent({
  async sendMessages({ messages }) {
    const platform = detectPlatform(messages);
    const systemPrompt = createSystemPrompt(platform);

    return streamText({
      model: "anthropic/claude-sonnet-4",
      // model: "openai/gpt-5-mini",
      system: systemPrompt,
      messages: convertToModelMessages(messages),
      tools: {
        ...slackbot.tools({
          messages,
        }),
        browse_url: tool({
          description:
            "Fetch and analyze a public web page (HTML-only). Respects robots.txt, blocks private addresses, 10s timeout, 5MB max. Use when the user asks for page content or when following links in releases/blog posts.",
          inputSchema: z.object({
            url: z.string().url(),
            question: z
              .string()
              .optional()
              .describe(
                "Optional focus question; returns relevant passages from the page content."
              ),
            cache: z
              .boolean()
              .default(true)
              .describe("Cache the fetched page for ~10 minutes."),
          }),
          execute: async ({ url, question, cache }) => {
            const u = new URL(url);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
              throw new Error("Only http/https URLs are supported.");
            }
            if (isPrivateHostname(u.hostname)) {
              throw new Error("Blocked private/local address.");
            }

            // Cache
            const key = `${u.toString()}`;
            const now = Date.now();
            const cached = cache ? pageCache.get(key) : undefined;
            if (cached && now - cached.at < CACHE_TTL_MS) {
              return cached.data;
            }

            // Robots
            const allowed = await fetchRobotsAllowed(u);
            if (!allowed) {
              throw new Error("Fetching disallowed by robots.txt.");
            }

            // Fetch with timeout
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 10_000);
            const res = await fetch(u.toString(), {
              redirect: "follow",
              signal: controller.signal,
              headers: {
                "User-Agent":
                  "content-agent (+https://github.com/mattvollmer/content-agent)",
                Accept: "text/html,application/xhtml+xml",
              },
            });
            clearTimeout(t);
            if (!res.ok) {
              throw new Error(`HTTP ${res.status} ${res.statusText}`);
            }
            const cl = res.headers.get("content-length");
            if (cl && Number(cl) > 5 * 1024 * 1024) {
              throw new Error("Page exceeds 5MB limit.");
            }
            const html = await res.text();
            if (html.length > 5 * 1024 * 1024) {
              throw new Error("Page exceeds 5MB limit.");
            }
            const { document: doc } = parseHTML(html);
            const meta = extractMetadata(doc as unknown as Document);
            const reader = new Readability(doc as unknown as Document);
            const article = reader.parse();
            const mainText =
              article?.textContent || doc.body?.textContent || "";

            // Collect headings and links
            const headings = Array.from(
              (doc as unknown as Document).querySelectorAll(
                "h1, h2, h3, h4"
              ) as NodeListOf<Element>
            ).map((h) => ({
              tag: (h as Element).tagName,
              text: ((h as Element).textContent || "").trim().slice(0, 300),
            }));
            const links = Array.from(
              (doc as unknown as Document).querySelectorAll(
                "a[href]"
              ) as NodeListOf<Element>
            )
              .slice(0, 500)
              .map((a) => {
                const el = a as Element;
                const href = (el.getAttribute("href") || "").trim();
                const rel = (el.getAttribute("rel") || "").toLowerCase();
                const text = (el.textContent || "").trim().replace(/\s+/g, " ");
                return {
                  href: new URL(href, u).toString(),
                  text: text.slice(0, 200),
                  rel,
                  nofollow: rel.includes("nofollow"),
                };
              });

            const result = {
              url: u.toString(),
              finalUrl: res.url || u.toString(),
              ...meta,
              wordCount: mainText ? mainText.split(/\s+/).length : 0,
              headings,
              links,
              excerpt: mainText.slice(0, 1000),
              mainText,
              relevantPassages: question
                ? relevantPassages(mainText, question)
                : [],
            };

            if (cache) pageCache.set(key, { at: now, data: result });
            return result;
          },
        }),
        // New: GA4 metrics by pageLocation for any page
        get_ga_metrics: tool({
          description:
            "Get GA4 metrics for any page via pageLocation. Provide url, or path/slug (requires SITE_ORIGIN). Returns totals and daily series.",
          inputSchema: z
            .object({
              url: z.string().url().optional(),
              path: z.string().optional(),
              slug: z.string().optional(),
              lastNDays: z.number().int().min(1).max(365).optional(),
              startDate: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional(),
              endDate: z
                .string()
                .regex(/^\d{4}-\d{2}-\d{2}$/)
                .optional(),
              metrics: z
                .array(
                  z.enum([
                    "screenPageViews",
                    "activeUsers",
                    "sessions",
                  ] as const)
                )
                .optional(),
            })
            .refine((v) => v.url || v.path || v.slug, {
              message: "Provide one of url, path, or slug.",
            })
            .refine((v) => Boolean(v.lastNDays) || (v.startDate && v.endDate), {
              message: "Provide lastNDays or startDate+endDate.",
            }),
          execute: async ({
            url,
            path,
            slug,
            lastNDays,
            startDate,
            endDate,
            metrics,
          }) => {
            const pageLocation = resolveAbsoluteUrl({ url, path, slug });

            let s = startDate;
            let e = endDate;
            if (lastNDays) {
              const now = new Date();
              const end = toYMD(now);
              const start = toYMD(
                new Date(now.getTime() - (lastNDays - 1) * 86400000)
              );
              s = start;
              e = end;
            }
            if (!s || !e) {
              throw new Error(
                "Invalid date range. Check lastNDays or start/end dates."
              );
            }

            const safeMetrics = (metrics || DEFAULT_GA_METRICS).filter((m) =>
              ALLOWED_GA_METRICS.has(m)
            ) as AllowedMetric[];
            return runGa4ReportByLocation({
              pageLocation,
              startDate: s,
              endDate: e,
              metrics: safeMetrics,
            });
          },
        }),

        // New: GA4 metrics for N days after a blog post's first publish date (uses DatoCMS)
        get_ga_post_views_after_launch: tool({
          description:
            "Given a blog slug and a day window (default 30), fetch GA4 metrics for N days after the post’s first publish date (pageLocation).",
          inputSchema: z.object({
            slug: z.string(),
            days: z.number().int().min(1).max(365).default(30),
            metrics: z
              .array(
                z.enum(["screenPageViews", "activeUsers", "sessions"] as const)
              )
              .optional(),
          }),
          execute: async ({ slug, days, metrics }) => {
            const query = /* GraphQL */ `
              query BlogFirstPublished($slug: String!) {
                allBlogs(first: 1, filter: { slug: { eq: $slug } }) {
                  _firstPublishedAt
                }
              }
            `;
            const data = await datoQuery<{
              allBlogs: Array<{ _firstPublishedAt: string | null }>;
            }>(query, { slug });
            const publishedAt = data.allBlogs?.[0]?._firstPublishedAt;
            if (!publishedAt) {
              throw new Error(
                "Could not resolve first published date for slug."
              );
            }

            const start = new Date(publishedAt);
            const end = new Date(start.getTime() + (days - 1) * 86400000);
            const pageLocation = resolveAbsoluteUrl({ slug });
            const safeMetrics = (metrics || DEFAULT_GA_METRICS).filter((m) =>
              ALLOWED_GA_METRICS.has(m)
            ) as AllowedMetric[];
            return runGa4ReportByLocation({
              pageLocation,
              startDate: toYMD(start),
              endDate: toYMD(end),
              metrics: safeMetrics,
            });
          },
        }),

        get_blogs_overview: tool({
          description:
            "Retrieve the total count and a list of recent blog posts (metadata only, no content). Use this to answer questions about what content exists.",
          inputSchema: z.object({
            first: z
              .number()
              .int()
              .min(1)
              .max(100)
              .default(50)
              .describe(
                "Maximum number of posts to fetch, defaults to 50. This is metadata-only to keep responses small."
              ),
            includeAuthors: z
              .boolean()
              .default(false)
              .describe(
                "Include authors { name } to show who wrote each post. Defaults to false."
              ),
          }),
          execute: async ({ first, includeAuthors }) => {
            const authorsSelection = includeAuthors
              ? `\n                  authors { name }`
              : "";

            const query = /* GraphQL */ `
              query BlogsOverview($first: IntType) {
                _allBlogsMeta {
                  count
                }
                allBlogs(orderBy: _createdAt_DESC, first: $first) {
                  id
                  title
                  _firstPublishedAt
                  description
                  slug
                  _status
                  _createdAt${authorsSelection}
                }
              }
            `;

            const data = await datoQuery<{
              _allBlogsMeta: { count: number };
              allBlogs: Array<{
                id: string;
                title: string | null;
                _firstPublishedAt: string | null;
                description: string | null;
                slug: string | null;
                _status: string;
                _createdAt: string;
                authors?: Array<{ name: string | null }>;
              }>;
            }>(query, { first });

            return data;
          },
        }),

        get_blog_content: tool({
          description:
            "Fetch the full content/body for a single blog post. Use ONLY when the user explicitly asks for additional context about a post's content.",
          inputSchema: z
            .object({
              id: z.string().optional(),
              slug: z.string().optional(),
            })
            .refine((v) => Boolean(v.id || v.slug), {
              message: "Provide either id or slug to locate the blog post.",
            }),
          execute: async ({ id, slug }) => {
            if (id) {
              const queryById = /* GraphQL */ `
                query BlogContentById($id: ItemId!) {
                  allBlogs(first: 1, filter: { id: { eq: $id } }) {
                    id
                    slug
                    title
                    _status
                    content {
                      ... on TextRecord {
                        text
                      }
                    }
                  }
                }
              `;

              const data = await datoQuery<{
                allBlogs: Array<{
                  id: string;
                  slug: string | null;
                  title: string | null;
                  _status: string;
                  content?: Array<{
                    __typename?: string;
                    text?: string | null;
                  }>;
                }>;
              }>(queryById, { id });

              return data.allBlogs?.[0] || null;
            }

            const queryBySlug = /* GraphQL */ `
              query BlogContentBySlug($slug: String!) {
                allBlogs(first: 1, filter: { slug: { eq: $slug } }) {
                  id
                  slug
                  title
                  _status
                  content {
                    ... on TextRecord {
                      text
                    }
                  }
                }
              }
            `;

            const data = await datoQuery<{
              allBlogs: Array<{
                id: string;
                slug: string | null;
                title: string | null;
                _status: string;
                content?: Array<{ __typename?: string; text?: string | null }>;
              }>;
            }>(queryBySlug, { slug });

            return data.allBlogs?.[0] || null;
          },
        }),

        get_blogs_count: tool({
          description:
            "Return just the total number of blog posts. Use for quick metrics without listing posts.",
          inputSchema: z.object({}),
          execute: async () => {
            const query = /* GraphQL */ `
              query BlogsCount {
                _allBlogsMeta {
                  count
                }
              }
            `;

            const data = await datoQuery<{ _allBlogsMeta: { count: number } }>(
              query
            );
            return data._allBlogsMeta.count;
          },
        }),

        find_blogs_by_author: tool({
          description:
            "Find recent blog posts by author name (case-insensitive). Returns metadata only and authors; does not include content.",
          inputSchema: z.object({
            author: z
              .string()
              .min(1)
              .describe("Author name or partial match, case-insensitive."),
            first: z
              .number()
              .int()
              .min(1)
              .max(100)
              .default(50)
              .describe("Max number of posts to return. Defaults to 50."),
          }),
          execute: async ({ author, first }) => {
            // Step 1: find author IDs matching the provided name (case-insensitive)
            const authorsQuery = /* GraphQL */ `
              query FindAuthorIds($author: String!) {
                allAuthors(
                  filter: {
                    name: {
                      matches: { pattern: $author, caseSensitive: false }
                    }
                  }
                ) {
                  id
                }
              }
            `;

            const authorsData = await datoQuery<{
              allAuthors: Array<{ id: string }>;
            }>(authorsQuery, { author });

            const authorIds = authorsData.allAuthors?.map((a) => a.id) ?? [];
            if (!authorIds.length) return [];

            // Step 2: fetch blogs that reference any of these authors
            const blogsQuery = /* GraphQL */ `
              query BlogsByAuthorIds($authorIds: [ItemId], $first: IntType) {
                allBlogs(
                  orderBy: _createdAt_DESC
                  first: $first
                  filter: { authors: { anyIn: $authorIds } }
                ) {
                  id
                  title
                  _firstPublishedAt
                  description
                  slug
                  _status
                  _createdAt
                  authors {
                    name
                  }
                }
              }
            `;

            const blogsData = await datoQuery<{
              allBlogs: Array<{
                id: string;
                title: string | null;
                _firstPublishedAt: string | null;
                description: string | null;
                slug: string | null;
                _status: string;
                _createdAt: string;
                authors?: Array<{ name: string | null }>;
              }>;
            }>(blogsQuery, { authorIds, first });

            return blogsData.allBlogs;
          },
        }),

        find_blogs_by_description: tool({
          description:
            "Find recent blog posts by topic keywords in the description (case-insensitive). Returns metadata only and authors; does not include content.",
          inputSchema: z.object({
            q: z
              .string()
              .min(1)
              .describe(
                "Keyword(s) to search in description, case-insensitive."
              ),
            first: z
              .number()
              .int()
              .min(1)
              .max(100)
              .default(50)
              .describe("Max number of posts to return. Defaults to 50."),
          }),
          execute: async ({ q, first }) => {
            const query = /* GraphQL */ `
              query FindByDescription($q: String!, $first: IntType) {
                allBlogs(
                  orderBy: _createdAt_DESC
                  first: $first
                  filter: {
                    description: {
                      matches: { pattern: $q, caseSensitive: false }
                    }
                  }
                ) {
                  id
                  title
                  _firstPublishedAt
                  description
                  slug
                  _status
                  _createdAt
                  authors {
                    name
                  }
                }
              }
            `;

            const data = await datoQuery<{
              allBlogs: Array<{
                id: string;
                title: string | null;
                _firstPublishedAt: string | null;
                description: string | null;
                slug: string | null;
                _status: string;
                _createdAt: string;
                authors?: Array<{ name: string | null }>;
              }>;
            }>(query, { q, first });

            return data.allBlogs;
          },
        }),

        get_github_releases: tool({
          description:
            "Fetch the last N releases for a repository in the coder organization. Defaults to metadata only (no body).",
          inputSchema: z.object({
            repo: z
              .string()
              .min(1)
              .describe(
                "Repository name within the coder org, e.g. 'coder' or 'vscode-coder'."
              ),
            limit: z
              .number()
              .int()
              .min(1)
              .max(100)
              .default(10)
              .describe("Max number of releases to return. Default 10."),
            includePrereleases: z
              .boolean()
              .default(false)
              .describe("Include prereleases. Default false."),
            includeDrafts: z
              .boolean()
              .default(false)
              .describe(
                "Include draft releases (requires token with access). Default false."
              ),
            includeBody: z
              .boolean()
              .default(false)
              .describe(
                "Include release body text. Default false to keep payload small."
              ),
          }),
          execute: async ({
            repo,
            limit,
            includePrereleases,
            includeDrafts,
            includeBody,
          }) => {
            const token = process.env.GITHUB_TOKEN;
            if (!token) {
              throw new Error(
                "Missing GITHUB_TOKEN environment variable. Please export a GitHub token."
              );
            }

            const url = new URL(
              `https://api.github.com/repos/coder/${encodeURIComponent(
                repo
              )}/releases`
            );
            url.searchParams.set("per_page", String(Math.min(limit, 100)));

            const res = await fetch(url.toString(), {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
              },
            });
            const json = (await res.json()) as Array<{
              name: string | null;
              tag_name: string | null;
              draft: boolean;
              prerelease: boolean;
              published_at: string | null;
              html_url: string;
              body?: string | null;
            }>;
            if (!res.ok) {
              throw new Error(
                `GitHub releases error: ${res.status} ${res.statusText}`
              );
            }

            const filtered = json
              .filter((r) => (includePrereleases ? true : !r.prerelease))
              .filter((r) => (includeDrafts ? true : !r.draft))
              .slice(0, limit)
              .map((r) => ({
                name: r.name,
                tag: r.tag_name,
                draft: r.draft,
                prerelease: r.prerelease,
                publishedAt: r.published_at,
                url: r.html_url,
                body: includeBody ? r.body ?? null : undefined,
              }));

            return filtered;
          },
        }),

        list_accessible_repos: tool({
          description:
            "List repositories in the coder organization that are accessible. Use this to discover available repos for get_github_releases.",
          inputSchema: z.object({
            type: z
              .enum(["all", "public", "private", "forks", "sources", "member"])
              .default("all")
              .describe("Filter repos by type. Default 'all'."),
            sort: z
              .enum(["created", "updated", "pushed", "full_name"])
              .default("updated")
              .describe("Sort order. Default 'updated'."),
            direction: z
              .enum(["asc", "desc"])
              .default("desc")
              .describe("Sort direction. Default 'desc' (newest first)."),
            includeArchived: z
              .boolean()
              .default(false)
              .describe("Include archived repositories. Default false."),
            limit: z
              .number()
              .int()
              .min(1)
              .max(100)
              .default(30)
              .describe("Max repos to return. Default 30."),
          }),
          execute: async ({
            type,
            sort,
            direction,
            includeArchived,
            limit,
          }) => {
            const token = process.env.GITHUB_TOKEN;
            if (!token) {
              throw new Error(
                "Missing GITHUB_TOKEN environment variable. Please export a GitHub token."
              );
            }

            const url = new URL("https://api.github.com/orgs/coder/repos");
            url.searchParams.set("type", type);
            url.searchParams.set("sort", sort);
            url.searchParams.set("direction", direction);
            url.searchParams.set("per_page", String(Math.min(limit, 100)));

            const res = await fetch(url.toString(), {
              headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
              },
            });

            if (!res.ok) {
              throw new Error(
                `GitHub repos error: ${res.status} ${res.statusText}`
              );
            }

            const json = (await res.json()) as Array<{
              name: string;
              full_name: string;
              private: boolean;
              archived: boolean;
              fork: boolean;
              description: string | null;
              language: string | null;
              stargazers_count: number;
              updated_at: string;
              html_url: string;
            }>;

            const filtered = json
              .filter((r) => (includeArchived ? true : !r.archived))
              .map((r) => ({
                name: r.name,
                fullName: r.full_name,
                private: r.private,
                archived: r.archived,
                fork: r.fork,
                description: r.description,
                language: r.language,
                stars: r.stargazers_count,
                updatedAt: r.updated_at,
                url: r.html_url,
              }));

            return filtered;
          },
        }),

        rank_authors_for_keywords: tool({
          description:
            "Rank DatoCMS blog authors by how often they appear on posts matching the given keywords (in description). Metadata only.",
          inputSchema: z.object({
            q: z
              .string()
              .min(1)
              .describe(
                "Keyword(s) to search in descriptions, case-insensitive."
              ),
            first: z
              .number()
              .int()
              .min(1)
              .max(200)
              .default(100)
              .describe(
                "How many posts to consider for ranking (most recent first)."
              ),
          }),
          execute: async ({ q, first }) => {
            const query = /* GraphQL */ `
              query RankAuthors($q: String!, $first: IntType) {
                allBlogs(
                  orderBy: _createdAt_DESC
                  first: $first
                  filter: {
                    description: {
                      matches: { pattern: $q, caseSensitive: false }
                    }
                  }
                ) {
                  id
                  _createdAt
                  authors {
                    name
                  }
                }
              }
            `;

            const data = await datoQuery<{
              allBlogs: Array<{
                id: string;
                _createdAt: string;
                authors?: Array<{ name: string | null }>;
              }>;
            }>(query, { q, first });

            const counts = new Map<
              string,
              { count: number; latestAt: string }
            >();
            for (const post of data.allBlogs || []) {
              const when = post._createdAt;
              for (const a of post.authors || []) {
                const name = (a?.name || "").trim();
                if (!name) continue;
                const prev = counts.get(name);
                if (prev) {
                  counts.set(name, {
                    count: prev.count + 1,
                    latestAt: prev.latestAt > when ? prev.latestAt : when,
                  });
                } else {
                  counts.set(name, { count: 1, latestAt: when });
                }
              }
            }

            return Array.from(counts.entries())
              .map(([name, v]) => ({
                name,
                count: v.count,
                latestAt: v.latestAt,
              }))
              .sort(
                (a, b) =>
                  b.count - a.count || (b.latestAt > a.latestAt ? 1 : -1)
              );
          },
        }),

        analyze_content_gaps: tool({
          description:
            "Compare release keywords/topics to existing blog coverage to identify content gaps. Shows what releases haven't been covered.",
          inputSchema: z.object({
            keywords: z
              .array(z.string())
              .min(1)
              .describe(
                "Keywords or topics from recent releases to check coverage for."
              ),
            lookbackDays: z
              .number()
              .int()
              .min(1)
              .max(365)
              .default(90)
              .describe(
                "How many days back to check for existing coverage. Default 90 days."
              ),
          }),
          execute: async ({ keywords, lookbackDays }) => {
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - lookbackDays);
            const cutoffISO = cutoffDate.toISOString();

            const gaps: Array<{
              keyword: string;
              existingPosts: number;
              recentPosts: Array<{
                id: string;
                title: string | null;
                _createdAt: string;
                _status: string;
                slug: string | null;
              }>;
              hasGap: boolean;
            }> = [];
            for (const keyword of keywords) {
              const queryTitle = /* GraphQL */ `
                query CheckCoverageTitle($keyword: String!, $since: DateTime!) {
                  allBlogs(
                    filter: {
                      _createdAt: { gte: $since }
                      title: {
                        matches: { pattern: $keyword, caseSensitive: false }
                      }
                    }
                    orderBy: _createdAt_DESC
                  ) {
                    id
                    title
                    _createdAt
                    _status
                    slug
                  }
                }
              `;

              const queryDesc = /* GraphQL */ `
                query CheckCoverageDesc($keyword: String!, $since: DateTime!) {
                  allBlogs(
                    filter: {
                      _createdAt: { gte: $since }
                      description: {
                        matches: { pattern: $keyword, caseSensitive: false }
                      }
                    }
                    orderBy: _createdAt_DESC
                  ) {
                    id
                    title
                    _createdAt
                    _status
                    slug
                  }
                }
              `;

              const [titleData, descData] = await Promise.all([
                datoQuery<{
                  allBlogs: Array<{
                    id: string;
                    title: string | null;
                    _createdAt: string;
                    _status: string;
                    slug: string | null;
                  }>;
                }>(queryTitle, { keyword, since: cutoffISO }),
                datoQuery<{
                  allBlogs: Array<{
                    id: string;
                    title: string | null;
                    _createdAt: string;
                    _status: string;
                    slug: string | null;
                  }>;
                }>(queryDesc, { keyword, since: cutoffISO }),
              ]);

              // Dedupe by id
              const byId = new Map<
                string,
                {
                  id: string;
                  title: string | null;
                  _createdAt: string;
                  _status: string;
                  slug: string | null;
                }
              >();
              for (const p of [...titleData.allBlogs, ...descData.allBlogs]) {
                byId.set(p.id, p);
              }
              const merged = Array.from(byId.values()).sort((a, b) =>
                a._createdAt < b._createdAt ? 1 : -1
              );

              gaps.push({
                keyword,
                existingPosts: merged.length,
                recentPosts: merged.slice(0, 3),
                hasGap: merged.length === 0,
              });
            }

            return {
              lookbackDays,
              analysis: gaps,
              summary: {
                totalKeywords: keywords.length,
                uncoveredKeywords: gaps.filter((g) => g.hasGap).length,
                gapPercentage: Math.round(
                  (gaps.filter((g) => g.hasGap).length / keywords.length) * 100
                ),
              },
            };
          },
        }),

        get_author_expertise: tool({
          description:
            "Analyze an author's historical posts to understand their topic areas and expertise based on titles and descriptions.",
          inputSchema: z.object({
            authorName: z
              .string()
              .min(1)
              .describe("Author name to analyze (case-insensitive match)."),
            limit: z
              .number()
              .int()
              .min(1)
              .max(100)
              .default(50)
              .describe("Max posts to analyze. Default 50."),
          }),
          execute: async ({ authorName, limit }) => {
            // Step 1: resolve author IDs by name (case-insensitive)
            const authorsQuery = /* GraphQL */ `
              query FindAuthorIdsForExpertise($authorName: String!) {
                allAuthors(
                  filter: {
                    name: {
                      matches: { pattern: $authorName, caseSensitive: false }
                    }
                  }
                ) {
                  id
                  name
                }
              }
            `;

            const authors = await datoQuery<{
              allAuthors: Array<{ id: string; name: string | null }>;
            }>(authorsQuery, { authorName });

            const authorIds = authors.allAuthors?.map((a) => a.id) ?? [];
            if (!authorIds.length) {
              return {
                authorName,
                postCount: 0,
                expertise: [],
                recentPosts: [],
              };
            }

            // Step 2: fetch blogs linked to any of these authors
            const blogsQuery = /* GraphQL */ `
              query AuthorExpertiseBlogs(
                $authorIds: [ItemId]
                $first: IntType
              ) {
                allBlogs(
                  orderBy: _createdAt_DESC
                  first: $first
                  filter: { authors: { anyIn: $authorIds } }
                ) {
                  id
                  title
                  description
                  _createdAt
                  _status
                  slug
                }
              }
            `;

            const data = await datoQuery<{
              allBlogs: Array<{
                id: string;
                title: string | null;
                description: string | null;
                _createdAt: string;
                _status: string;
                slug: string | null;
              }>;
            }>(blogsQuery, { authorIds, first: limit });

            if (!data.allBlogs.length) {
              return {
                authorName,
                postCount: 0,
                expertise: [],
                recentPosts: [],
              };
            }

            // Extract keywords from titles and descriptions
            const keywords = new Map<string, number>();
            const stopWords = new Set([
              "the",
              "and",
              "or",
              "but",
              "in",
              "on",
              "at",
              "to",
              "for",
              "of",
              "with",
              "by",
              "is",
              "are",
              "was",
              "were",
              "be",
              "been",
              "have",
              "has",
              "had",
              "do",
              "does",
              "did",
              "will",
              "would",
              "could",
              "should",
              "may",
              "might",
              "can",
              "this",
              "that",
              "these",
              "those",
              "a",
              "an",
              "how",
              "what",
              "when",
              "where",
              "why",
              "who",
            ]);

            for (const post of data.allBlogs) {
              const text = `${post.title || ""} ${post.description || ""}`
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, " ")
                .split(/\s+/)
                .filter((word) => word.length > 2 && !stopWords.has(word));

              for (const word of text) {
                keywords.set(word, (keywords.get(word) || 0) + 1);
              }
            }

            const topKeywords = Array.from(keywords.entries())
              .sort(([, a], [, b]) => b - a)
              .slice(0, 10)
              .map(([word, count]) => ({ keyword: word, frequency: count }));

            return {
              authorName,
              postCount: data.allBlogs.length,
              expertise: topKeywords,
              recentPosts: data.allBlogs.slice(0, 5).map((p) => ({
                title: p.title,
                slug: p.slug,
                createdAt: p._createdAt,
                status: p._status,
              })),
            };
          },
        }),

        suggest_content_topics: tool({
          description:
            "Extract themes and keywords from GitHub releases to suggest blog post topics and angles.",
          inputSchema: z.object({
            releaseData: z
              .array(
                z.object({
                  name: z.string().nullable(),
                  tag: z.string().nullable(),
                  body: z.string().nullable().optional(),
                })
              )
              .min(1)
              .describe(
                "Release data from get_github_releases to analyze for topics."
              ),
          }),
          execute: async ({ releaseData }) => {
            const themes = new Map<string, number>();
            const contentIdeas: Array<{
              release: string;
              suggestedTopics: string[];
            }> = [];

            for (const release of releaseData) {
              const text = `${release.name || ""} ${release.tag || ""} ${
                release.body || ""
              }`
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, " ")
                .split(/\s+/)
                .filter((word) => word.length > 2);
              // Extract meaningful keywords
              const keywords = text.filter(
                (word) =>
                  ![
                    "the",
                    "and",
                    "for",
                    "with",
                    "this",
                    "that",
                    "fix",
                    "add",
                    "update",
                    "new",
                    "now",
                    "can",
                    "will",
                  ].includes(word)
              );
              for (const keyword of keywords) {
                themes.set(keyword, (themes.get(keyword) || 0) + 1);
              }
              // Generate content ideas based on release
              const releaseName = release.name || release.tag || "Release";
              contentIdeas.push({
                release: releaseName,
                suggestedTopics: [
                  `What's new in ${releaseName}`,
                  `Getting started with ${releaseName} features`,
                  `Migration guide for ${releaseName}`,
                  `Deep dive into ${releaseName} improvements`,
                ],
              });
            }

            const topThemes = Array.from(themes.entries())
              .sort(([, a], [, b]) => b - a)
              .slice(0, 15)
              .map(([theme, frequency]) => ({ theme, frequency }));

            return {
              analyzedReleases: releaseData.length,
              topThemes,
              contentIdeas,
              generalSuggestions: [
                "Feature spotlight posts",
                "Tutorial and how-to guides",
                "Migration and upgrade guides",
                "Performance and improvement highlights",
                "Developer experience stories",
              ],
            };
          },
        }),

        find_similar_posts: tool({
          description:
            "Find existing blog posts that cover similar topics to given keywords, useful for understanding existing coverage.",
          inputSchema: z.object({
            keywords: z
              .array(z.string())
              .min(1)
              .describe("Keywords to find similar posts for."),
            limit: z
              .number()
              .int()
              .min(1)
              .max(50)
              .default(20)
              .describe("Max posts to return per keyword. Default 20."),
          }),
          execute: async ({ keywords, limit }) => {
            const results: Array<{
              keyword: string;
              matchingPosts: number;
              posts: Array<{
                title: string | null;
                description: string | null;
                slug: string | null;
                createdAt: string;
                status: string;
                authors: string[];
              }>;
            }> = [];

            for (const keyword of keywords) {
              const queryTitle = /* GraphQL */ `
                query SimilarPostsTitle($keyword: String!, $first: IntType) {
                  allBlogs(
                    orderBy: _createdAt_DESC
                    first: $first
                    filter: {
                      title: {
                        matches: { pattern: $keyword, caseSensitive: false }
                      }
                    }
                  ) {
                    id
                    title
                    description
                    slug
                    _createdAt
                    _status
                    authors {
                      name
                    }
                  }
                }
              `;

              const queryDesc = /* GraphQL */ `
                query SimilarPostsDesc($keyword: String!, $first: IntType) {
                  allBlogs(
                    orderBy: _createdAt_DESC
                    first: $first
                    filter: {
                      description: {
                        matches: { pattern: $keyword, caseSensitive: false }
                      }
                    }
                  ) {
                    id
                    title
                    description
                    slug
                    _createdAt
                    _status
                    authors {
                      name
                    }
                  }
                }
              `;

              const [titleData, descData] = await Promise.all([
                datoQuery<{
                  allBlogs: Array<{
                    id: string;
                    title: string | null;
                    description: string | null;
                    slug: string | null;
                    _createdAt: string;
                    _status: string;
                    authors?: Array<{ name: string | null }>;
                  }>;
                }>(queryTitle, { keyword, first: limit }),
                datoQuery<{
                  allBlogs: Array<{
                    id: string;
                    title: string | null;
                    description: string | null;
                    slug: string | null;
                    _createdAt: string;
                    _status: string;
                    authors?: Array<{ name: string | null }>;
                  }>;
                }>(queryDesc, { keyword, first: limit }),
              ]);

              // Dedupe by id and sort
              const byId = new Map<
                string,
                {
                  id: string;
                  title: string | null;
                  description: string | null;
                  slug: string | null;
                  _createdAt: string;
                  _status: string;
                  authors?: Array<{ name: string | null }>;
                }
              >();
              for (const p of [...titleData.allBlogs, ...descData.allBlogs]) {
                byId.set(p.id, p);
              }
              const merged = Array.from(byId.values()).sort((a, b) =>
                a._createdAt < b._createdAt ? 1 : -1
              );

              results.push({
                keyword,
                matchingPosts: merged.length,
                posts: merged.slice(0, limit).map((p) => ({
                  title: p.title,
                  description: p.description,
                  slug: p.slug,
                  createdAt: p._createdAt,
                  status: p._status,
                  authors:
                    p.authors
                      ?.map((a) => a.name)
                      .filter((name): name is string => Boolean(name)) || [],
                })),
              });
            }

            return {
              searchedKeywords: keywords.length,
              results,
              summary: {
                totalMatches: results.reduce(
                  (sum, r) => sum + r.matchingPosts,
                  0
                ),
                averageMatchesPerKeyword: Math.round(
                  results.reduce((sum, r) => sum + r.matchingPosts, 0) /
                    keywords.length
                ),
              },
            };
          },
        }),
      },
    });
  },
  async webhook(request) {
    if (slackbot.isOAuthRequest(request)) {
      return slackbot.handleOAuthRequest(request);
    }
    if (slackbot.isWebhook(request)) {
      return slackbot.handleWebhook(request);
    }
  },
});
