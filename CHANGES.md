# Quantic: what changed

Run `cd back-end && npm install && npm test` (29 tests, no network or API key needed).

## Before you deploy (settings only you can change)
1. Render env: `JWT_SECRET` (32+ random chars) and `TAVILY_API_KEY`. See `back-end/.env.example` for every option.
2. Check your Groq model IDs: `GET https://api.groq.com/openai/v1/models`. Only set `GROQ_AGENT_MODEL` / `GROQ_VISION_MODEL` to IDs listed there.
3. Optional: run `npm run ingest` in `back-end/` to rebuild the knowledge base (downloads a small embedding model; I could not run it offline).
4. First login after deploy: users with a pending 2FA code will need a new one; old password hashes upgrade automatically at next login.

## New: tool-calling agent (the main "smart assistant" change)
`services/agentService.js`. The model now decides which tools to use, can call several in a row, and can search again with different wording when results are thin, then streams the answer.
Tools: `web_search`, `fetch_url` (SSRF-guarded), `calculator` (safe parser, no eval), `get_weather`, `recall_past_chats`, `save_memory` (signed-in), `search_knowledge_base`.
If the agent cannot start (no key, model without tool support, rate limit, empty output) and nothing has been sent yet, the request falls back to the old pipeline. Set `AGENT_MODE=0` to switch it off.
Image uploads still use the vision pipeline. Citations keep the existing sources-marker format.

## Fixed
- ChatPage.jsx: a 281-line broken paste (commit 7f9de12) was removed; the app builds again.
- Auth: no default JWT secret in production; logout now revokes the token (jti denylist); password change/reset signs out other sessions; PBKDF2 is async and 210k iterations (old hashes upgrade on login); unknown emails take the same time and give the same message as wrong passwords; 2FA codes are generated with `crypto`, stored hashed, compared in constant time; per-IP limiter on every login/OTP route; lockout 3 -> 5; Origin check on state-changing requests; urlencoded parser removed; chat body 100 MB -> 25 MB; removed a debug log echoing a client header; 3 DB reads per request now run in parallel.
- Usage limits: chat 200/h per user, 30/h per guest IP; images 30/day per user, 3/day per guest (in-memory, per instance).
- Answers: higher output and prompt budgets, medium/high reasoning, 8B "reflection" rewrite off, streaming always on, no more forced web search for words like "law/version/price" in conceptual questions, PM/DM/SP/CM only count as office titles in a government context.
- RAG: similarity floor so the sample KB is no longer injected into unrelated questions; ingest script now reads every .txt/.md in `back-end/data/` (added `quantic-faq.md`).
- Memory: 567 lines of dead code removed, extraction gate widened (projects, work, family, preferences, "from now on..."), no irrelevant-memory fallback, slower decay, extraction no longer blocks the reply; cross-chat recall via the agent tool.
- Images: "make a todo list / study plan / names" are no longer drawn; "show me a picture of", "design a logo", and follow-ups like "draw it as a watercolor" work; re-encoded to WebP (about 5-10x smaller); small worker pool instead of one global queue, one image per user at a time, "busy" answer under overload; failures are normal assistant messages, saved in history, not HTTP 500.
- Models: reasoning model defaults to the chat model; vision model auto-discovered from Groq's list.
- Web search: Tavily "advanced" depth, 7-day window for news, larger evidence budget.

## Correction to my earlier review
I said cross-site cookies would log users out. The frontend already sends a Bearer token (`front-end/src/services/authToken.js`), so that was overstated and I reverted the `vercel.json` change.

## Not done / limits
- Quotas are in-memory per instance; use Redis if you run several instances.
- Images are still stored in MongoDB (now compressed); move to S3/Cloudinary for scale.
- No automatic conversation summaries; the agent recalls past chats by keyword search instead.
- Live web search, real Groq calls and the browser UI were not run here (no internet in my sandbox); these were tested against a fake Groq server and mocks.
