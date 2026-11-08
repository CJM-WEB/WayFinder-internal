<p align="center">
  <strong>English</strong> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<h1 align="center">WayFinder</h1>

<p align="center"><strong>AI-powered web search with an editable results graph</strong></p>

<p align="center">
  <a href="#technology-stack"><img src="./assets/readme/stack.svg" alt="React, Vite, TypeScript, Node.js"></a>
</p>

<p align="center">
  <a href="#product-overview">Overview</a> ·
  <a href="#preview">Preview</a> ·
  <a href="#quick-start">Setup</a> ·
  <a href="#how-to-use">Guide</a> ·
  <a href="#development">Develop</a>
</p>

![WayFinder home page](./assets/readme/1.png)

## Product overview

WayFinder turns an open-ended web search into a map of related topics and original sources. It is useful for learning a new field, comparing technical approaches, and collecting material for a project. **The graph is the search results page.** AI organizes the web; you choose which topics and pages to explore.

A search first produces a topic outline, then fills each node with ranked web resources, summaries, and reasons for selection. You can read those sources, revise the map, add your own links, and search an individual node again as your questions become more specific. The map is a working collection you can edit, rather than a finished answer you must accept.

| Capability | What it offers |
| --- | --- |
| **Topic map** | Nodes organize a question into topics. Connections distinguish suggested reading paths from related ideas; you can browse any node. |
| **Progressive results** | The graph outline appears before all resources have finished loading. Each node has its own search results and status. |
| **Editable research context** | Add or change a node's title and description. When you explicitly search that node again, AI uses both fields as clues alongside the available original search context. |
| **Source collection** | Open original pages, inspect summaries and selection reasons, add links manually, and reorder resources. |
| **Preview and selective undo** | Review new results before applying them. Append to one node or replace its resources; reverse an edit while retaining later independent changes. |
| **API key settings** | Configure DeepSeek and SerpAPI separately, use your own keys or an invited author trial, and keep settings separate from graph history. |

> **Example workflow** · Search `How do Transformers work?`, then select the self-attention node. Edit its title to `Implementing self-attention in PyTorch` and its description to `Focus on tensor shapes, masking, and step-by-step code examples`. Choose **Search this node again** to provide those details to AI as retrieval clues. Review the proposed resources before appending or replacing them. Editing the text alone does not start a search.

## Preview

![WayFinder search](./assets/readme/2.png)

![WayFinder results graph](./assets/readme/3.png)

## Quick start

Set up a local copy using [macOS Terminal](#macos-terminal) or [Windows PowerShell](#windows-powershell). Once it is running, open `http://127.0.0.1:3000/?language=en-US`.

1. Select **Start exploring**.
2. Expand the bottom arrow and open **Settings**. Save your own DeepSeek and SerpAPI keys, or confirm an author trial if the deployment offers one and you have its invitation code.
3. Return to the search box, choose a language and search engine, enter a topic, and press **Enter**.
4. Select a node to browse its sources. Edit a node's title or description and explicitly search it again when you want to refine the topic.

The server's environment keys do not automatically populate browser settings. Missing configuration produces a prompt; saving it does not automatically replay the blocked search.

## How to use

### Configure API keys

The bottom arrow contains **Search history**, **Undo**, and **Settings**. Hover or use keyboard focus to expand the controls; on a touch screen, tap the arrow to reveal the choices first. Opening one panel closes the other panels.

**Use your own keys.** DeepSeek provides AI planning and resource organization; SerpAPI provides web search. Each service defaults to **Your API key**, and each has its own save action.

| Service | Get a key | What to do in Settings |
| --- | --- | --- |
| DeepSeek | [DeepSeek platform](https://platform.deepseek.com/) | Enter your DeepSeek API key and select **Save settings**. |
| SerpAPI | [SerpAPI website](https://serpapi.com/) | Enter your SerpAPI key and select **Save settings**. |

Keys are hidden by default. Use **Show** or **Hide** to inspect an entry, and save after replacing or clearing it. Unsaved changes are discarded when you close Settings. Keys and the selected sources are saved long term in the current browser; browser data removal or storage restrictions can affect that persistence. They are stored separately from graph content and undo history and are not automatically synchronized between devices. A failed save leaves the previously saved configuration active. Saving does not make a paid API request or prove that a key has available quota.

**Use the author's trial.** Select **Author trial** for the desired service, read the announcement and shared-quota notice, enter the invitation code supplied by the author, and choose **Confirm trial**. You may use your own key for one service and the trial for the other. The two services share one valid browser trial qualification, but each switch to the trial still requires confirmation. Canceling or entering an invalid code leaves the saved configuration unchanged.

Trial quota is shared and paid for by the author. Searches may fail if it runs out. Changing the invitation code revokes previous trial qualifications; enter the current code to regain access. Updating only the announcement preserves valid qualifications. Ordinary settings changes apply to subsequent runs; revocation can also stop later author-funded calls in a run already in progress. An upstream request already sent may still be charged.

> [!IMPORTANT]
> While using the author's trial API keys, avoid searching for personal or sensitive information to reduce the risk of exposing it to the author or other developers involved in the service.
>
> Searches and node re-search context, including titles and descriptions, pass through the WayFinder backend and are sent to the relevant model or search providers as needed. Using your own API keys does not bypass this backend or make the query end-to-end confidential. Avoid putting passwords, credentials, private documents, or other sensitive personal data into queries or node descriptions.

Author keys remain on the server. Browser-supplied keys are sent to the backend for the current search and are not persisted there. Self-hosting configuration, announcements, invitation-code updates, and recovery are covered in the [deployment guide (简体中文)](./apps/server/EXPERIENCE.md). The application does not include an author administration page.

### Search and browse

1. Enter a keyword or question. Select **Google** or **Baidu** below the box, then press **Enter**. A recognized HTTP(S) URL opens directly instead of generating a graph.
2. The graph outline appears first; resources arrive by node. Select a node to see its resources on the right. Hover over a resource or use **Show details** to inspect its description and selection reason, then open the original page to judge the source yourself.
3. Scroll to zoom or drag blank canvas space to pan. Drag a node to adjust its position. A partial or failed node does not mean every other node has failed.

Missing keys or expired trial access block new searches and node/full-graph re-searches before a request starts. Existing graphs, local editing, undo, and valid direct navigation remain available. Configure the missing service and explicitly submit again when ready.

### Edit the whole graph

After a search finishes, edit the graph directly on the canvas. Local edits do not call the model or search provider.

- **Nodes and context.** Right-click blank space and choose **Add node**. Right-click a node to edit its title and description, add a resource by URL, or delete it. A title names the subject; a description can specify your intended angle, comparison criteria, technical constraints, or kinds of material to look for. Saving those fields updates the map; use node re-search to ask AI to act on them.
- **Resources.** Select a node and drag its resource cards up or down to reorder them. Right-click a resource to edit its title, summary, selection reason, or URL, or to delete it. A manually added link is not automatically read or validated by AI.
- **Connections.** Hover over a node to reveal its handles. Drag from a bottom handle to another node's top handle for **Recommended next**, or from a right handle to a left handle for **Related**. Right-click a connection to change its type or delete it.

> [!TIP]
> **Start with a blank graph.** On the search screen, right-click the background and choose **Add node**. Add titles, descriptions, and links yourself, then explicitly search selected nodes for additional resources.

### Refine a node with re-search

1. Right-click a generated or manually added node and edit its title and description. For example, use the title `Choosing a Python web framework` and the description `Compare FastAPI and Django for a small API project; focus on authentication, deployment, and maintainability`.
2. Choose **Search this node again**. AI receives the node's **current title and description**, together with the original query and saved analysis when available, to generate targeted retrieval clues. For a manually created graph without an original query, the node title supplies the query context. You do not need an existing resource for a node to be searchable.
3. Inspect the temporary preview. The current graph is unchanged until you apply the result. Cancel a running re-search or choose **Discard new results** to keep the current graph.
4. Choose **Append to this node** to retain existing resources and add new, non-duplicate links, or **Apply replacement** to replace the target node's resource collection. Node re-search preserves the node's edited title and description.

Only the selected node's context is sent for node re-search; it does not send the entire edited graph as a new prompt. Editing another node or a resource summary does not automatically make that text part of the selected node's search context. Title and description guide AI; they do not guarantee that every requested source or constraint will be satisfied.

### Search the full graph again

Right-click blank canvas space and choose **Search entire graph again**. A graph created from a search reuses its saved original query; a manually created graph asks you to enter a search topic. Full-graph re-search starts a fresh search from that topic rather than treating all manually edited nodes and descriptions as a prompt. Use node re-search when you want AI to follow one node's revised context.

Review the preview and choose **Apply replacement** or **Discard new results**. Full-graph results support replacement, not append. Applying them replaces the graph's generated content and layout while preserving its saved record identity and title.

> [!IMPORTANT]
> Node **Apply replacement** removes the target node's previous resources, including manually added links. Full-graph replacement replaces the current nodes, connections, and resources. **Append to this node** preserves existing resources. Review the preview before applying either kind of replacement.

### Choose search engines

The search box lets you choose Google or Baidu for a new search. A saved graph has its own engine preference, and a node can have an independent override for node re-search. A node without an override follows the graph's preference, or the language default when no explicit preference is saved. Changing a preference does not start a search and does not relabel the actual search-engine source of resources already collected. Engine selection does not provide a separate region setting.

### History and revisions

- **Reopen a graph.** Expand the bottom arrow and choose **Search history**. Click a graph's title to restore the saved map, resources, edits, and layout without searching again. Rename or delete saved records, or choose **New search graph** to begin another one.
- **Undo an edit.** Open **Undo** and choose an available edit to reverse while keeping later independent changes. Dependent edits may need to be undone first. Use **Redo** to bring an edit back or **Restore search graph** to recover the most recently deleted graph.
- **Local persistence.** Graphs and revision history are stored in this browser. A refresh can restore them; this is not cloud or cross-device synchronization. Moving nodes is saved as layout and does not create an undo entry. Clearing site data can remove graphs as well as API key settings.

## Development

Install Node.js `24.21.0` and run the commands from the repository root. Before starting WayFinder, configure the server deployment variables in your local `.env`. The current server requires non-empty `LLM_API_KEY` (DeepSeek) and `SERPAPI_API_KEY` (SerpAPI) values at startup; browser settings do not replace these startup fields. These remain server-side; each browser still needs the Settings step above. Keep `PORT=3000` so Vite can send API requests to the backend. Enable author invitations only through the [protected configuration workflow](./apps/server/EXPERIENCE.md).

### macOS Terminal

1. Install the pinned pnpm version and project dependencies. Create `.env` from the template if it’s missing.

   ```bash
   npm install --global pnpm@11.25.0
   pnpm install --frozen-lockfile
   if [ ! -e .env ]; then
     cp -n .env.example .env
   fi
   ```

2. Fill in the API keys, then build and start WayFinder.

   ```bash
   pnpm build
   pnpm start
   ```

3. Keep the server running. Open a second Terminal window at the repository root and run `pnpm dev` for frontend hot reload.

### Windows PowerShell

1. Install the pinned pnpm version and project dependencies. Create `.env` from the template if it’s missing.

   ```powershell
   npm.cmd install --global pnpm@11.25.0
   pnpm.cmd install --frozen-lockfile
   if (-not (Test-Path -LiteralPath .\.env)) {
     Copy-Item -LiteralPath .\.env.example -Destination .\.env
   }
   ```

2. Fill in the API keys, then build and start WayFinder.

   ```powershell
   pnpm.cmd build
   pnpm.cmd start
   ```

3. Keep the server running. Open a second PowerShell window at the repository root and run `pnpm.cmd dev` for frontend hot reload.

Open the `Local` address printed by Vite. Append `?language=en-US` to open the English interface. After changing server code, a shared schema, or startup environment variables, rebuild as needed and restart the backend. Production mode serves the built frontend; rebuild and restart after updating it. Keep the development proxy’s explicit `changeOrigin: false` setting so authorization receives matching browser Host and Origin headers.

### Technology stack

| Stack | Where it is used |
| --- | --- |
| React | Renders the search interface and graph editor in `apps/web`. |
| Vite | Serves the frontend during development and builds production web assets. |
| TypeScript | Provides type checking across the frontend, backend, and shared contracts. |
| Node.js | Runs the search backend in `apps/server` and streams results to the frontend. |

### Local checks

Install Playwright’s Chromium build before running the local CI checks. Ordinary CI uses deterministic tests and fake providers; it does not spend DeepSeek or SerpAPI quota. Real search tests and live evaluations are performed manually by the user; an agent must obtain separate, explicit confirmation for each proposed scope before making real provider calls.

**macOS Terminal**

```bash
pnpm --filter @wayfinder/web exec playwright install chromium
pnpm run ci
```

**Windows PowerShell**

```powershell
pnpm.cmd --filter '@wayfinder/web' exec playwright install chromium
pnpm.cmd run ci
```
