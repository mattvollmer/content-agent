# Content Agent

A powerful content management and web analysis agent that provides comprehensive tools for content operations, web scraping, and analytics integration.

## Core Capabilities

### Content Management
- **DatoCMS Integration**: Full GraphQL API access for content queries, supporting both published and draft content
- **Content Analytics**: Google Analytics 4 (GA4) integration for performance metrics and insights
- **Content Discovery**: Advanced content querying with flexible filtering and search capabilities

### Web Intelligence
- **Smart Web Scraping**: Respectful web content extraction with robots.txt compliance checking
- **Content Analysis**: Intelligent text extraction and metadata parsing from web pages
- **Relevance Matching**: Advanced passage extraction based on query relevance using tokenization
- **Safety Features**: Built-in protection against private/internal networks and hostile environments

### Platform Integration
- **Slack Support**: Native Slack integration with threaded conversations and emoji reactions
- **Multi-Platform**: Optimized experience for both Slack and web interfaces
- **Caching System**: Intelligent in-memory caching with TTL for improved performance

## Key Features

- **Robots.txt Compliance**: Automatically checks and respects robots.txt files before scraping
- **Private Network Protection**: Prevents access to localhost, internal IPs, and private networks
- **Metadata Extraction**: Comprehensive parsing of Open Graph, article metadata, and page structure
- **Flexible Content Queries**: Support for complex DatoCMS GraphQL queries with variables
- **Analytics Integration**: JWT-based Google Analytics authentication with automatic token refresh
- **Content Summarization**: Smart text analysis and passage extraction for relevant information

## Use Cases

- Content strategy planning and analysis
- Competitive research and market intelligence
- SEO content optimization
- Multi-platform content distribution
- Performance tracking and analytics
- Automated content discovery and curation

## Technical Stack

- **Runtime**: Blink AI Agent Framework
- **APIs**: DatoCMS GraphQL, Google Analytics 4, Web APIs
- **Authentication**: JWT with service account credentials
- **Parsing**: HTML parsing with metadata extraction
- **Caching**: In-memory TTL-based caching system

This agent combines content management, web intelligence, and analytics to provide a comprehensive solution for modern content operations.