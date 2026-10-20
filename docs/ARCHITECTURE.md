# Quantic architecture overview

This page describes the high-level structure confirmed in the repository. It is intentionally concise and avoids assuming that every optional integration is enabled in every deployment.

## Application layers

### Frontend

The `front-end/` directory contains the React 19 application built with Vite. Its package manifest includes React Router for navigation, TipTap editing packages, and Axios for HTTP requests.

### Backend API

The `back-end/` directory contains the Node.js and Express 5 service. The entry point is `back-end/server.js`. The server configures CORS, Helmet, request parsing and rate limiting, logging, MongoDB connection status, and application route modules.

### Data and AI integrations

The backend dependencies include MongoDB/Mongoose for data persistence, the Groq SDK for AI requests, ChromaDB and `@xenova/transformers` for retrieval/embedding-related functionality, and document/media libraries including PDF parsing, Office document processing, Tesseract.js, and Sharp.

### Authentication and operational support

The dependency manifest includes JSON Web Token handling, bcrypt, Speakeasy, Nodemailer, Winston, and Morgan. Exact behavior and configuration are defined by the corresponding source modules and deployment environment.

## Local development

See the root [README](../README.md) for the basic frontend and backend startup commands.

## Configuration and secrets

- The backend loads environment variables from a local `back-end/.env` file.
- Keep populated environment files out of source control.
- Set production secrets in the deployment platform's secret manager or environment settings.
- Configure allowed frontend origins to match the deployed frontend URL.
- Never put real credentials in this document, examples, issue reports, or screenshots.

## Change discipline

When changing a layer, check the callers and integration points that depend on it. Preserve existing API contracts and authentication/session behavior unless a change is intentional and documented.
