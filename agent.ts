import { streamText, tool } from "ai";
import * as blink from "blink";
import { z } from "zod";
import { convertToModelMessages } from "ai";

const DATOCMS_ENDPOINT = "https://graphql.datocms.com/";

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

export default blink.agent({
  displayName: "dato-agent",

  async sendMessages({ messages }) {
    return streamText({
      model: "anthropic/claude-sonnet-4",
      system: `You are Dato Agent. Your job is to help users understand what content exists in DatoCMS today, including draft posts.

Rules:
- When listing or summarizing posts, only fetch lightweight metadata (id, title, _firstPublishedAt, description, slug, _status, _createdAt) and the total count.
- Do NOT fetch or read the full content/body of posts unless the user explicitly asks for additional context or the content itself. Only then, call the content tool.
- Clearly label whether posts are draft or published using the _status field.
- Prefer the most recent content first.
- If the user asks for specific posts (by slug or id), retrieve only what is necessary.
- For targeted searches, use the author/topic search tools without fetching content.
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
              .max(500)
              .default(50)
              .describe(
                "Maximum number of posts to fetch, defaults to 50. This is metadata-only to keep responses small."
              ),
          }),
          execute: async ({ first }) => {
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
                  _createdAt
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
      },
    });
  },
});
