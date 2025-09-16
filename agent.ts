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
      system: `You are Dato Agent. Your job is to help users understand what content exists in DatoCMS today, including draft posts, and correlate recent GitHub releases to potential authors.

Rules:
- When listing or summarizing posts, only fetch lightweight metadata (id, title, _firstPublishedAt, description, slug, _status, _createdAt) and the total count.
- Do NOT fetch or read the full content/body of posts unless the user explicitly asks for additional context or the content itself. Only then, call the content tool.
- Clearly label whether posts are draft or published using the _status field.
- Prefer the most recent content first.
- If the user asks for specific posts (by slug or id), retrieve only what is necessary.
- For targeted searches, use the author/topic search tools without fetching content.
- For GitHub releases, default to metadata only (exclude body) unless explicitly requested to include it.
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
      },
    });
  },
});
