import { streamText, tool } from "ai";
import * as blink from "blink";
import { z } from "zod";
import { convertToModelMessages } from "ai";

const DATOCMS_ENDPOINT = "https://graphql.datocms.com/";

async function datoQuery<T>(
  query: string,
  variables?: Record<string, unknown>,
) {
  const token = process.env.DATOCMS_API_TOKEN;
  if (!token) {
    throw new Error(
      "Missing DATOCMS_API_TOKEN environment variable. Please export your DatoCMS API key.",
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

export default blink.agent({
  displayName: "dato-agent",

  async sendMessages({ messages }) {
    return streamText({
      model: "anthropic/claude-sonnet-4",
      system: `You are Dato Agent. Your job is to help users understand what content exists in DatoCMS today, including draft posts, correlate recent GitHub releases to potential authors, and assist with content planning and gap analysis.

Rules:
- When listing or summarizing posts, only fetch lightweight metadata (id, title, _firstPublishedAt, description, slug, _status, _createdAt) and the total count.
- Do NOT fetch or read the full content/body of posts unless the user explicitly asks for additional context or the content itself. Only then, call the content tool.
- Clearly label whether posts are draft or published using the _status field.
- Prefer the most recent content first.
- If the user asks for specific posts (by slug or id), retrieve only what is necessary.
- For targeted searches, use the author/topic search tools without fetching content.
- For GitHub releases, default to metadata only (exclude body) unless explicitly requested to include it.
- For content planning, focus on identifying gaps and matching expertise to topics.
- If an operation fails, return the error message without guessing.
`,
      messages: convertToModelMessages(messages),
      tools: {
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
                "Maximum number of posts to fetch, defaults to 50. This is metadata-only to keep responses small.",
              ),
            includeAuthors: z
              .boolean()
              .default(false)
              .describe(
                "Include authors { name } to show who wrote each post. Defaults to false.",
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
              query,
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
                "Keyword(s) to search in description, case-insensitive.",
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
                "Repository name within the coder org, e.g. 'coder' or 'vscode-coder'.",
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
                "Include draft releases (requires token with access). Default false.",
              ),
            includeBody: z
              .boolean()
              .default(false)
              .describe(
                "Include release body text. Default false to keep payload small.",
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
                "Missing GITHUB_TOKEN environment variable. Please export a GitHub token.",
              );
            }

            const url = new URL(
              `https://api.github.com/repos/coder/${encodeURIComponent(
                repo,
              )}/releases`,
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
                `GitHub releases error: ${res.status} ${res.statusText}`,
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
                body: includeBody ? (r.body ?? null) : undefined,
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
                "Missing GITHUB_TOKEN environment variable. Please export a GitHub token.",
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
                `GitHub repos error: ${res.status} ${res.statusText}`,
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
                "Keyword(s) to search in descriptions, case-insensitive.",
              ),
            first: z
              .number()
              .int()
              .min(1)
              .max(200)
              .default(100)
              .describe(
                "How many posts to consider for ranking (most recent first).",
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
                  b.count - a.count || (b.latestAt > a.latestAt ? 1 : -1),
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
                "Keywords or topics from recent releases to check coverage for.",
              ),
            lookbackDays: z
              .number()
              .int()
              .min(1)
              .max(365)
              .default(90)
              .describe(
                "How many days back to check for existing coverage. Default 90 days.",
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
                a._createdAt < b._createdAt ? 1 : -1,
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
                  (gaps.filter((g) => g.hasGap).length / keywords.length) * 100,
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
                }),
              )
              .min(1)
              .describe(
                "Release data from get_github_releases to analyze for topics.",
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
                  ].includes(word),
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
                a._createdAt < b._createdAt ? 1 : -1,
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
                  0,
                ),
                averageMatchesPerKeyword: Math.round(
                  results.reduce((sum, r) => sum + r.matchingPosts, 0) /
                    keywords.length,
                ),
              },
            };
          },
        }),
      },
    });
  },
});
