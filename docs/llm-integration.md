# LLM integration direction

## Recommendation

PointPilot's optional desktop assistant answers general rewards-planning questions and can use wallet balances only when the user opts in. It does not yet receive current award results or call search tools. Keep award search, wallet optimization, booking-readiness checks, and alerts deterministic. The model must not invent availability, execute transfers, buy points, or book travel.

## Useful first workflows

- Translate a request such as “find two business-class seats from Boston to Thailand in November” into a reviewable search form.
- Explain why an award is or is not fundable, including transfer partners and the purchase-versus-cash estimate.
- Summarize a destination search and explain tradeoffs among points, fees, stops, and total travel time.
- Answer questions grounded in visible search results and the user's explicitly selected wallet balances.

Before adding result-aware answers, require them to cite the local fields used and show inventory observation time and stale-data warnings. Do not send wallet or trip history by default; the current wallet-sharing option shows a per-request preview before sending.

## Provider support

The Windows desktop app now includes a read-only assistant with explicit provider selection:

1. **OpenAI / ChatGPT plan**: the app uses OpenAI's Sign in with ChatGPT DevKit for its documented open-source local-app flow. Users sign in in their browser and separately approve plan usage. PointPilot never reads Codex CLI credentials. The DevKit is pinned as a Git submodule and licensed for noncommercial use; commercial distribution requires separate written permission from OpenAI.
2. **Anthropic Claude API**: users can save an Anthropic Console API key. The key is encrypted with Electron `safeStorage` in the main process and never written to PointPilot settings or exposed back to the renderer. API requests may be billed separately.
3. **Claude.ai / Pro / Max login**: not supported in the embedded assistant. Anthropic's Agent SDK docs state third-party apps may not offer Claude.ai login or use its subscription limits without prior approval. PointPilot does not extract Claude Code or other CLI credentials.
4. **Google Gemini and local models**: not yet supported in the embedded assistant. The local read-only MCP server lets users connect from Codex, Claude, or Gemini clients using those clients' own authentication.

## Where MCP fits

MCP is a good boundary for exposing PointPilot's existing capabilities to assistant clients, not a common authentication system for model providers. The local stdio server exposes three read-only tools: wallet balances by program, cached award search, and cached destination comparison. Search-and-refresh and all writes stay behind explicit UI confirmation. Codex, Claude, and Gemini clients connect using their own supported sign-in flows; PointPilot's MCP process never receives or forwards their model credentials. The embedded assistant separately supports ChatGPT plan sign-in and Claude API keys.

### Local MCP server

From a PointPilot checkout with dependencies installed, run `npm run mcp`. Configure the assistant client to launch `node` with the absolute path to `mcp/server.mjs` and set the checkout as its working directory. The server uses stdio, makes no network calls, and only reads PointPilot's locally stored balances and cached award data. It does not receive provider credentials. The embedded assistant is separate and currently sends only the user's question plus wallet balances when the user checks the explicit wallet-sharing option.

Do not describe PointPilot's OpenAI connection as “Codex login”: it uses the distinct Sign in with ChatGPT flow. A user's existing Codex CLI token or configuration should never be scraped, copied, or replayed by PointPilot.

## Security and privacy requirements

- Store cloud keys and OAuth credentials with OS-backed encryption (`safeStorage` for Anthropic keys and the OpenAI DevKit's encrypted profile store), never in browser storage or plaintext app settings. Keep credentials out of backups.
- Send provider requests from the local main/server process so keys are not exposed to renderer JavaScript. Never log prompts, keys, or full provider error bodies.
- Enforce HTTPS for cloud providers, short request timeouts, response-size limits, per-request token/output caps, and user-visible cost controls.
- Validate provider/model IDs against provider catalogs or strict input rules; keep base URLs fixed for cloud providers. For custom/local endpoints, block non-loopback/private destinations unless the user explicitly enables a remote endpoint, and guard against redirects to another host.
- Treat model output as untrusted text. Render as text or sanitized Markdown; never evaluate HTML, scripts, shell commands, or generated SQL.
- Make data sharing explicit at the moment of use. Default to sending only the active query and relevant selected results, with wallet details opt-in and redacted by default.
- Add a “clear conversation” action and keep history local only if persistence is enabled; do not retain prompts by default.

## Current implementation and next stages

1. **Read-only explainer**: implemented for the desktop app using ChatGPT plan sign-in or a Claude API key; wallet sharing is opt-in and previewed; prompts are not persisted.
2. **Search-form helper**: model returns a strict JSON search proposal; validate with the same server validators, show a preview, and require the user to press Search.
3. **Broader assistant**: only after privacy and quality evaluation, add opt-in local conversation history and a narrow allowlist of deterministic read-only tools.

Do not begin with autonomous agents, booking automation, point transfers, embeddings, or vector databases. Current structured award and wallet data is small enough for direct filtering and request-scoped context; embeddings can be reconsidered if PointPilot later needs semantic retrieval over a large help/reference corpus.

## References checked 2026-10-27

- [Google Gemini key guidance](https://ai.google.dev/gemini-api/docs/api-key) says to keep keys confidential and not expose them in client-side code.
- [OpenAI billing guidance](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform) documents separate ChatGPT and API billing.
- [OpenAI Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart) describes open-source client access to eligible ChatGPT plan usage through an OAuth flow.
- [OpenAI Sign in with ChatGPT DevKit](https://github.com/openai/sign-in-with-chatgpt-devkit) provides the local SDK and Electron credential-storage example used by the desktop assistant. Its included license is noncommercial; separate written permission is required for commercial use.
- [OpenAI Codex app-server guidance](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) documents the Responses API flow and token lifecycle for Codex app-server clients.
- [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started) documents Claude subscription sign-in and Console authentication as separate supported paths.
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview) says third-party products may not offer Claude.ai login or use Claude subscription limits without prior approval.
- [Gemini OAuth quickstart](https://ai.google.dev/gemini-api/docs/oauth) describes OAuth for Gemini API requests using a Google Cloud project.
- [Gemini CLI MCP setup](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md) documents stdio MCP client configuration.
- [Ollama API documentation](https://github.com/ollama/ollama/blob/main/docs/api/introduction.mdx) documents local and OpenAI-compatible API endpoints.
