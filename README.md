<!--
  Quantic — repository landing page
  Keep claims aligned with the codebase and never commit credentials.
-->

<div align="center">

<img src="docs/assets/quantic-banner.svg" alt="Quantic — Conversations with context" width="100%" />

# ✦ Quantic

### A modern AI chat experience with memory, retrieval, and document understanding.

**Explore the live app:** [quantic-nu.vercel.app](https://quantic-nu.vercel.app)

<br />

![React](https://img.shields.io/badge/React-19-61DAFB?style=for-the-badge&logo=react&logoColor=111827)
![Vite](https://img.shields.io/badge/Vite-powered-646CFF?style=for-the-badge&logo=vite&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-backend-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-FFFFFF?style=for-the-badge&logo=express&logoColor=111827)
![MongoDB](https://img.shields.io/badge/MongoDB-data-47A248?style=for-the-badge&logo=mongodb&logoColor=white)

<br />

[Live Demo](https://quantic-nu.vercel.app) · [Report a Bug](https://github.com/Basudeb-Bej/Quantic/issues/new?template=bug_report.yml) · [Request a Feature](https://github.com/Basudeb-Bej/Quantic/issues/new?template=feature_request.yml)

</div>

---

## Overview

Quantic is an AI-powered chatbot project built around conversational AI, retrieval-augmented generation (RAG), long-term memory, and document understanding. Its web interface uses React and Vite, while the API is built with Node.js and Express.

The repository is organized into separate frontend and backend applications.

## Highlights

| Capability | What it provides |
| --- | --- |
| **AI conversations** | Conversational responses using the Groq SDK |
| **Retrieval-augmented generation** | RAG components using ChromaDB and local embedding support |
| **Long-term memory** | Dedicated memory functionality |
| **Document understanding** | PDF and Office document processing, with OCR support through Tesseract.js |
| **Authentication** | JWT-based authentication and optional two-factor authentication support |
| **Files and images** | Upload-related functionality in the chat experience |
| **Administration** | Admin routes and public announcements |
| **Modern interface** | React 19, Vite, React Router, and TipTap-based editing components |

> Feature availability may depend on configuration and external services. See the application code and deployment environment for the current implementation details.

## Tech stack

<table>
  <tr><td><strong>Frontend</strong></td><td>React 19, Vite, React Router, TipTap, Axios</td></tr>
  <tr><td><strong>Backend</strong></td><td>Node.js, Express 5, MongoDB, Mongoose</td></tr>
  <tr><td><strong>AI and retrieval</strong></td><td>Groq SDK, ChromaDB, @xenova/transformers</td></tr>
  <tr><td><strong>Authentication and security</strong></td><td>JSON Web Tokens, bcrypt, Speakeasy, Helmet, express-rate-limit</td></tr>
  <tr><td><strong>Documents and media</strong></td><td>pdf-parse, Mammoth, officeparser, Tesseract.js, Sharp</td></tr>
  <tr><td><strong>Operations</strong></td><td>Nodemailer, Winston, Morgan</td></tr>
</table>

## Repository layout

```text
Quantic/
├── front-end/       # React + Vite web application
│   └── package.json
├── back-end/        # Express API and backend services
│   ├── server.js
│   └── package.json
├── README.md
├── CONTRIBUTING.md
└── SECURITY.md
```

## Run locally

### Prerequisites

- A supported Node.js release and npm
- Access to the external services required by the features you want to run
- MongoDB configured for the backend

### 1. Start the backend

```bash
cd back-end
npm install
```

Create a local `.env` file inside `back-end/` and configure the environment variables required by the backend and its service integrations. The server reads this file at startup. Keep real credentials out of Git.

Start the API:

```bash
npm start
```

The server defaults to port `8000` when `PORT` is not set. The backend CORS configuration uses `FRONTEND_URL` for allowed frontend origins and includes the published Quantic frontend origin in its current configuration.

### 2. Start the frontend

Open a second terminal:

```bash
cd front-end
npm install
npm run dev
```

Vite prints the local development URL in the terminal (typically `http://localhost:5173`). Keep the frontend origin aligned with the backend's CORS configuration.

### 3. Build the frontend

From `front-end/`:

```bash
npm run build
```

To preview a production build locally:

```bash
npm run preview
```

### Configuration notes

- Use the environment variable names expected by the current backend code and service integrations; do not copy production credentials into local files or commit them.
- Store deployment secrets in the hosting provider's environment-variable settings.
- The exact configuration needed depends on which integrations and features you enable.
- Do not publish API keys, database connection strings, session/JWT secrets, mail credentials, or private tokens in issues, screenshots, logs, or commits.

## Development workflow

1. Create a branch for your change.
2. Keep changes focused and preserve existing application behavior unless a feature change is intentional.
3. Run the frontend build after frontend or documentation-adjacent UI changes.
4. Test the backend and affected flows in your environment; the backend package currently contains a placeholder test script rather than a configured automated test suite.
5. Review the diff for accidental secrets before opening a pull request.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance and [SECURITY.md](SECURITY.md) for responsible vulnerability reporting.

## Security

Quantic includes authentication and security-related middleware, but no application should be assumed secure solely because it uses these components. Keep dependencies updated, configure secrets outside source control, and verify production settings before deployment.

If you believe you have found a vulnerability, please follow [SECURITY.md](SECURITY.md). Do not publish exploit details or credentials in a public issue.

## Project status

Quantic is actively represented by the source in this repository. Features, configuration requirements, and deployment behavior may evolve. For the most accurate details, use the current code and the live demo rather than assuming every integration is enabled in every environment.

---

<div align="center">

**Built with curiosity. Designed for useful conversations.**

[Open Quantic](https://quantic-nu.vercel.app) · [Browse the source](https://github.com/Basudeb-Bej/Quantic)

</div>
