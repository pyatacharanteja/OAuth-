# OAuth Path

Look up an app and get a shareable guide to creating, and getting approval for, your own OAuth app with that provider: difficulty, effort, approval wait, blockers, what an agent can do, and where a person must take over.

## The problem
A developer building an agent product needs their own OAuth app with each provider so end users can connect their accounts. The code is the easy part. The unknown is the gate in front of it: instant self-serve, a verification or review, or a gated partner program that may say no. Developers find this out by reading scattered docs and emailing providers.

## What this does
- **Library:** four curated guides chosen to span the difficulty range: GitHub (self-serve), Slack (self-serve, optional directory review), Google (verification plus a possible security assessment), LinkedIn (partner-gated).
- **Live generation:** enter any app name or website. A server-side agent finds the provider's developer docs, reads them, and writes a guide in the same format.
- **Shareable:** every guide has its own link (`/g/<slug>`), plus copy-as-Markdown and print.
- **Every guide answers:** how hard it is, how long it takes, what blocks approval, what an agent can do for you, and where you take over.

## Run locally
Requires Node 18 or newer. No dependencies to install.
```
cp .env.example .env     # on Windows: copy .env.example .env
npm start                # http://localhost:3000
npm test
```
Live generation needs three settings in `.env`, pointing at any OpenAI-compatible chat completions endpoint:
```
LLM_API_KEY=...
LLM_BASE_URL=https://your-provider.example/v1
LLM_MODEL=your-model-name
```
Optional:
- `PORT` (default 3000)
- `LLM_MAX_CHARS` (default 12000): how much documentation text is sent to the model per guide. Lower it if your provider returns rate-limit errors.
- `LLM_RETRY=1`: retry once when the first answer contains no quotable evidence. Off by default because a second request can exceed free-tier limits.

Without these settings the library still works and generation shows a clear "not configured" message. No credentials are stored in the repository; `.env` is git-ignored.

## How live generation works
1. **Resolve the app.** A website is used as given. A name is resolved to its official domain by the model. The app name shown on the guide is derived from your input, not from the model.
2. **Find the docs.** The server fetches the homepage, probes common developer and docs hosts (`developers.`, `developer.`, `docs.`, `/docs`, `/developers`, `api.`), tries common authorization paths (`/docs/authorization`, `/docs/oauth`, and similar), then follows the highest-scoring OAuth, app-review and verification links for two rounds. Up to 30 pages are fetched.
3. **Pick the evidence.** Pages are ranked by how often they mention OAuth terms. The best four are cut down to the most OAuth-dense window of each page and sent to the model, within the character budget.
4. **Write the guide from those pages only.** For every step and blocker the model must give the source number and an exact quote.
5. **Check the quotes.** The server looks for each quote in the fetched text. Found: the item is labeled `documented` and its evidence links to the page. Not found: it is downgraded to `unverified`. The sources listed are only URLs the server actually fetched; the model cannot add links.
6. **Cache and share.** The guide is saved and served at `/g/<slug>` for 7 days.

Safety: fetching refuses non-http(s) URLs, unusual ports, and addresses that resolve to private or local networks; responses are size- and time-limited; generation is limited to 5 requests per minute per IP.

## Evidence labels
| Label | Meaning |
|---|---|
| `documented` | The quoted text was found on a page the server fetched. |
| `reviewed` | A curator read the linked source (curated guides only). Not machine-checked. |
| `unverified` | Plausible, but no supporting text was found. |
| `unknown` | The sources did not answer it. |

Each guide also lists **Not answered by the sources**, so gaps are visible instead of papered over.

## What I tested and found
This is what happened when the app was run, not a claim of full coverage.

- **First Notion run read the wrong pages.** The sources were the homepage, a quick-start page and a general docs page. The model filled the OAuth steps from general knowledge, so they were all `unverified`, and the few `documented` items described personal access tokens, which are a different mechanism from an OAuth app. It also used the word "scopes" where I believe Notion uses "capabilities". This was the clearest sign that a matching quote proves a page says something, not that the page answers the question.
- **Fixes that came from it:** probing common authorization paths, ranking pages by OAuth relevance, sending the most OAuth-dense part of each page, and matching a quote to whichever fetched page contains it when the model cites the wrong source number.
- **After the fixes,** a Notion run read an OAuth authorization page: the title was correct, difficulty was set, and several steps (create the integration, save the client credentials, build the authorization URL, exchange the code) were `documented` with quotes.
- **A second Notion run came back with every step `unverified` and difficulty Unknown.** Results vary from run to run, which is why the evidence labels matter and why the optional retry exists.
- **Model and provider limits shaped the design.** A free-tier token-per-minute limit rejected an oversized request, which led to the character budget. A reasoning model cut off its own JSON when its output limit was too small, which led to larger output headroom and a clearer error that shows what the model said.

### Not yet checked
- **Approval, effort, difficulty and summary lines are not quote-checked.** Only steps and blockers are. For Notion, "approval: not required" or "not published" still needs comparing with Notion's own documentation on public integrations and review.
- **Curated guides** were written from provider documentation and carry `reviewed`, not `documented`. They were not run end to end.
- **Zoom and Calendly** were planned as additional live tests; record their results here once run.
- No provider app was created end to end.

## Limitations
- The agent researches and drafts. People sign in, give consent, pay, verify identity or business details, and answer reviewers.
- Docs that need JavaScript or a login cannot be read. Generation then fails with an explanation or produces a guide with many gaps.
- A matching quote proves a page says something, not that the page is current or that the step works.
- Name-to-website resolution uses the model and can be wrong; paste the website to be exact.
- Time estimates appear only when the sources state them; otherwise the guide says "not published".
- Free-tier model limits (roughly 8,000 tokens per minute on the tier used while building): generate one guide at a time and wait about a minute between runs. A rate-limit message is expected there, not a bug.
- One process; the rate limiter is in memory; guides are stored as files. On hosts with ephemeral disks (such as free web tiers) generated guides disappear on restart, while the curated library stays.
- DNS is checked before fetching, but a DNS-rebinding race remains; in production run behind an egress-restricted network.

## Deploy
Any Node host works: build command `npm install`, start command `npm start`. Enter `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL` as environment variables in the host's dashboard, never in the repository.

## Next
- Run sandbox signups with a human handoff and record what actually blocked.
- Quote-check the difficulty, effort and approval lines too.
- A scheduled re-verifier that flags stale guides.
- Grow the library toward 100 apps, starting with the apps developers ask about most.