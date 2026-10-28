# LLM integration direction

## Recommendation

Add an optional, user-configured trip-planning assistant that explains PointPilot's own search results. Keep the existing award search, wallet optimizer, booking-readiness checks, and alert decisions deterministic. The model may summarize, compare, and help turn plain-language requests into a proposed search; it must not invent availability, execute transfers, buy points, or book travel.

## Useful first workflows

- Translate a request such as “find two business-class seats from Boston to Thailand in November” into a reviewable search form.
- Explain why an award is or is not fundable, including transfer partners and the purchase-versus-cash estimate.
- Summarize a destination search and explain tradeoffs among points, fees, stops, and total travel time.
- Answer questions grounded in visible search results and the user's explicitly selected wallet balances.

Every answer should cite the local result fields it used, show observation time and stale-data warnings, and offer links/buttons that invoke existing deterministic flows. Do not send the full wallet or trip history by default; provide a per-request preview of the context being shared.

## Provider support

Use a small provider adapter interface with explicit provider selection:

1. **OpenAI / ChatGPT plan**: investigate OpenAI's documented Sign in with ChatGPT flow for open-source clients and eligible Responses API use. This requires completing the current client registration/approval process and following its permitted request flow; it is distinct from entering an OpenAI API key. Do not infer that a normal Codex login credential can be copied from the user's CLI or reused by PointPilot.
2. **Anthropic Claude**: Claude API access uses an Anthropic Console API key and separate API billing. Claude Pro/Max access is available through Claude Code's supported sign-in, but should only be used through Anthropic's supported Claude Code/Agent SDK flow—not by extracting or replaying private CLI tokens. Test whether the official SDK is suitable for PointPilot's narrow, read-only use case before promising it in the UI.
3. **Google Gemini**: support the Gemini API through its documented OAuth flow with a Google Cloud project, or the API key path. OAuth authorizes the Gemini API project; it does not automatically spend a Gemini consumer subscription allowance. Explain project setup and potential API charges before sign-in.
4. **Local models**: first target Ollama on loopback, with an OpenAI-compatible adapter where supported. Require explicit enablement and allow only loopback addresses by default.

## Where MCP fits

MCP is a good boundary for exposing PointPilot's existing capabilities to assistant clients, not a common authentication system for model providers. Build a local stdio MCP server first and expose a small allowlist of deterministic read-only tools (search saved award results, explain a funding result, list current transfer partners, and retrieve destination-search summaries). Keep search-and-refresh and all writes behind explicit UI confirmation. Codex and Claude clients can connect using their own supported sign-in flows; PointPilot's MCP process should never receive or forward their model credentials. Add a PointPilot embedded chat only after each provider's sign-in and billing path has a supported implementation.

Do not advertise “Codex login” as a supported credential type unless an official, supported OpenAI integration is available for PointPilot and has been approved as required. A user's existing Codex CLI token or configuration should never be scraped, copied, or replayed by PointPilot.

## Security and privacy requirements

- Store cloud keys in the operating system credential store (Windows Credential Manager / Electron `safeStorage` backed by the OS), never in browser storage or plaintext app settings. Mask keys in UI and diagnostics; exclude them from backups unless users explicitly opt in to encrypted backup.
- Send provider requests from the local main/server process so keys are not exposed to renderer JavaScript. Never log prompts, keys, or full provider error bodies.
- Enforce HTTPS for cloud providers, short request timeouts, response-size limits, per-request token/output caps, and user-visible cost controls.
- Validate provider/model IDs against provider catalogs or strict input rules; keep base URLs fixed for cloud providers. For custom/local endpoints, block non-loopback/private destinations unless the user explicitly enables a remote endpoint, and guard against redirects to another host.
- Treat model output as untrusted text. Render as text or sanitized Markdown; never evaluate HTML, scripts, shell commands, or generated SQL.
- Make data sharing explicit at the moment of use. Default to sending only the active query and relevant selected results, with wallet details opt-in and redacted by default.
- Add a “clear conversation” action and keep history local only if persistence is enabled; do not retain prompts by default.

## Suggested implementation stages

1. **Read-only explainer**: provider settings, credential-store abstraction, one-shot questions grounded in a selected result, no tools or persistent chat history.
2. **Search-form helper**: model returns a strict JSON search proposal; validate with the same server validators, show a preview, and require the user to press Search.
3. **Broader assistant**: only after privacy and quality evaluation, add opt-in local conversation history and a narrow allowlist of deterministic read-only tools.

Do not begin with autonomous agents, booking automation, point transfers, embeddings, or vector databases. Current structured award and wallet data is small enough for direct filtering and request-scoped context; embeddings can be reconsidered if PointPilot later needs semantic retrieval over a large help/reference corpus.

## References checked 2026-10-27

- [Google Gemini key guidance](https://ai.google.dev/gemini-api/docs/api-key) says to keep keys confidential and not expose them in client-side code.
- [OpenAI billing guidance](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform) documents separate ChatGPT and API billing.
- [OpenAI Sign in with ChatGPT quickstart](https://developers.openai.com/siwc/quickstart) describes open-source client access to eligible ChatGPT plan usage through an OAuth flow.
- [OpenAI Codex app-server guidance](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) documents the Responses API flow and token lifecycle for Codex app-server clients.
- [Claude Code setup](https://docs.anthropic.com/en/docs/claude-code/getting-started) documents Claude subscription sign-in and Console authentication as separate supported paths.
- [Gemini OAuth quickstart](https://ai.google.dev/gemini-api/docs/oauth) describes OAuth for Gemini API requests using a Google Cloud project.
- [Ollama API documentation](https://github.com/ollama/ollama/blob/main/docs/api/introduction.mdx) documents local and OpenAI-compatible API endpoints.
