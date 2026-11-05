# OAuth Path

Look up an app and get a shareable guide to creating, and getting approval for, your own OAuth app with that provider: difficulty, effort, approval wait, blockers, what an agent can do, and where a person must take over.

**Live demo:** https://oauth-wgq4.onrender.com
**Source:** https://github.com/pyatacharanteja/OAuth-

The demo runs on a free host, so the first load after idle can take about a minute.

## The problem
A developer building an agent product needs their own OAuth app with each provider so end users can connect their accounts. The code is the easy part. The unknown is the gate in front of it: instant self-serve, a verification or review, or a gated partner program that may say no. Developers find this out by reading scattered docs and emailing providers.

## What it does
- **Library:** four curated guides chosen to span the difficulty range: GitHub (self-serve), Slack (self-serve, optional directory review), Google (verification plus a possible security assessment), LinkedIn (partner-gated).
- **Live generation:** enter any app name or website. A server-side agent finds the provider's developer docs, reads them, and writes a guide in the same format.
- **Shareable:** every guide has its own link (`/g/<slug>`), plus copy-as-Markdown and print.
- **Each guide answers:** how hard it is, how long it takes, what blocks approval, what an agent can do for you, and where you take over.

## Try it
1. Open the demo and click a library guide, or type an app name or website and click **Generate guide**.
2. Watch the progress messages while it reads the docs (30 to 90 seconds).
3. Expand **Evidence** under a green `documented` step to see the quote and its source page.
4. Generate one guide at a time and wait about a minute between runs (see Limitations).

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
1. **Resolve the app.** A website is used as given. A name is resolved to its official domain by the model. The app name shown on the guide comes from your input, not from the model.
2. **Find the docs.** The server fetches the homepage, probes common developer and docs hosts (`developers.`, `developer.`, `docs.`, `/docs`, `/developers`, `api.`), tries common authorization paths (`/docs/authorization`, `/docs/oauth`, and similar), then follows the highest-scoring OAuth, app-review and verification links for two rounds. Up to 30 pages are fetched.
3. **Pick the evidence.** Pages are ranked by how often they mention OAuth terms. The best four are cut down to the most OAuth-dense window of each page and sent to the model within the character budget.
4. **Write the guide from those pages only.** For every step and blocker the model must give a source number and an exact quote.
5. **Check the quotes.** The server looks for each quote in the fetched text, matching it to whichever fetched page contains it if the model cited the wrong source number. Found: the item is labeled `documented` and its evidence links to the page. Not found: it is downgraded to `unverified`. The sources listed are only URLs the server actually fetched; the model cannot add links.
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

- **First Notion run read the wrong pages.** The sources were the homepage, a quick-start page and a general docs page. The model filled the OAuth steps from general knowledge, so they were `unverified`, and the few `documented` items described personal access tokens, which are a different mechanism from an OAuth app. It also used "scopes" where Notion appears to use capabilities and an installation scope. This showed that a matching quote proves a page says something, not that the page answers the question.
- **Fixes that came from it:** probing common authorization paths, ranking pages by OAuth relevance, sending the most OAuth-dense part of each page, matching a quote to whichever fetched page contains it, and deriving the app name from the input instead of trusting the model's title.
- **After the fixes,** Notion runs read an OAuth authorization page. On the hosted demo, all seven steps came back `documented` with quotes: create the integration, set redirect URIs, note the installation scope cannot be changed later, copy the client credentials and authorization URL, send the user to authorize, exchange the code at the token endpoint, store the token. Difficulty came back Easy.
- **Results vary between runs.** An intermediate Notion run on the same code path came back with every step `unverified` and difficulty Unknown. That variability is why the evidence labels matter and why an optional retry exists.
- **Model and provider limits shaped the design.** A free-tier tokens-per-minute limit rejected an oversized request, which led to the character budget. A reasoning model cut off its own JSON when its output limit was too small, which led to larger output headroom and an error that shows what the model said.

### Not yet checked
- **Difficulty, effort, approval and summary lines are not quote-checked.** Only steps and blockers are. For Notion, "approval: not published" means the app found no answer, not that none exists; it still needs comparing with Notion's own documentation on public integrations and review.
- **Curated guides** (GitHub, Slack, Google, LinkedIn) were written from provider documentation and carry `reviewed`, not `documented`. They were not run end to end.
- **Zoom and Calendly** have not been recorded as test results here.
- No provider app was created end to end.

## Limitations
- The agent researches and drafts. People sign in, give consent, pay, verify identity or business details, and answer reviewers.
- Docs that need JavaScript or a login cannot be read. Generation then fails with an explanation or produces a guide with many gaps.
- A matching quote proves a page says something, not that the page is current or that the step works.
- Name-to-website resolution uses the model and can be wrong; paste the website to be exact.
- Time estimates appear only when the sources state them; otherwise the guide says "not published".
- Free-tier model limits (roughly 8,000 tokens per minute on the tier used while building): generate one guide at a time and wait about a minute between runs. A rate-limit message there is expected, not a bug.
- One process; the rate limiter is in memory; guides are stored as files. On hosts with ephemeral disks, including the free tier used for the demo, generated guides disappear on restart while the curated library stays.
- DNS is checked before fetching, but a DNS-rebinding race remains; in production run behind an egress-restricted network.

## Deploy
Any Node host works: build command `npm install`, start command `npm start`. Enter `LLM_API_KEY`, `LLM_BASE_URL` and `LLM_MODEL` as environment variables in the host's dashboard, never in the repository. The demo uses a free web service connected to this repository, which redeploys on every push.

## Next
- Run sandbox signups with a human handoff and record what actually blocked.
- Quote-check the difficulty, effort and approval lines too.
- A scheduled re-verifier that flags stale guides.
- Grow the library toward 100 apps, starting with the apps developers ask about most.