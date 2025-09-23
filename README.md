# Content Agent

A content management and web analysis agent that integrates with DatoCMS, Google Analytics, and provides web scraping capabilities.

## Tools

- `dato_query_content` - Execute GraphQL queries against DatoCMS (includes drafts)
- `dato_list_models` - List all content models in DatoCMS
- `dato_search_content` - Search content across models with text matching
- `fetch_web_page` - Fetch and extract content from web pages with robots.txt compliance
- `analyze_web_content` - Extract relevant passages from web content based on queries
- `ga4_get_metrics` - Retrieve Google Analytics 4 data for content performance
- `ga4_get_popular_content` - Get top-performing content from GA4
- `current_date` - Get current date and time information

## Core Capabilities

### Content Management
- DatoCMS GraphQL API integration with support for published and draft content
- Content model introspection and search across multiple content types
- Google Analytics 4 integration for content performance metrics

### Web Content Operations
- Web page content extraction with automatic robots.txt checking
- Metadata parsing (Open Graph, article data, page titles)
- Text analysis and relevant passage extraction
- Private network protection (blocks localhost, internal IPs)

### Platform Integration
- Native Slack integration with emoji reactions and threading
- Multi-platform support (Slack and web interfaces)
- In-memory caching with TTL for improved performance

## Use Cases

- Content strategy and performance analysis
- Competitive research and content discovery
- SEO content optimization
- Multi-platform content distribution planning
- Automated content curation

## Technical Details

- **Authentication**: JWT with Google service account credentials for GA4
- **Content Processing**: HTML parsing with metadata extraction
- **Safety**: Robots.txt compliance checking and private network blocking
- **Caching**: TTL-based in-memory cache (10 minutes default)
- **Rate Limiting**: Respectful web scraping with timeout controls