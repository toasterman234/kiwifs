# Native OpenCode V2 chat in KiwiFS (fork feature)

**Status:** experimental feature branch; not deployed; requires verification before use.  
**Work package:** [Bec1 KiwiFS chat plan](https://github.com/toasterman234/Bec1/blob/main/Plan%20-%20KiwiFS%20Native%20Agent%20Chat%202026-10-26.md)

## Architecture

The normal KiwiFS server remains authoritative for documents, search, history, and its MCP/REST APIs. The React KiwiFS UI adds a chat drawer with direct page and selected-text context. Its same-origin Go bridge forwards **only explicit, scoped session, message, status and permission routes** to an existing OpenCode V2 service. OpenCode remains authoritative for sessions, tools, memory, and agent behavior. The bridge does not manage an agent runtime, touch OpenCode global config or modify KiwiFS documents.

```
KiwiFS UI (chat panel and page context)
  -> /api/kiwi/agent/* (KiwiFS existing auth + independent chat key)
     -> server-held OpenCode authentication
        -> OpenCode V2 service (existing ben-pa agent)
```

The chat creates dedicated KiwiFS-labeled OpenCode sessions. **It is not proven to share the live `bb` ACP private-server conversation.** No Temper integration is added; Bec1's decision keeps it paused for this specific independent agent.

## Configuration (server-side; disabled by default)

| Name | Meaning |
| --- | --- |
| `KIWIFS_AGENT_URL` | OpenCode V2 base URL, e.g. `http://127.0.0.1:4096` when colocated. Non-loopback requires HTTPS. |
| `KIWIFS_AGENT_ACCESS_TOKEN` | Independent random chat access key (24+ characters). Required. Do not commit or place in URLs. |
| `KIWIFS_AGENT_NAME` | Agent name; defaults to `ben-pa`. |
| `KIWIFS_AGENT_OPENCODE_PASSWORD` | OpenCode HTTP Basic Auth password **if required** by your server. Server-side only. |
| `KIWIFS_AGENT_WORKDIR` | Optional existing absolute working directory for the agent session. Leave blank to use the service default. |

Set these in a protected server environment/secret store, not in versioned configuration or browser-side JavaScript. The chat UI asks for the independent chat key and holds it in memory only. The rest of KiwiFS continues to use its configured authentication. A publicly readable KiwiFS space does **not** permit unkeyed chat reads: each private agent route independently requires the chat key.

Only serve the chat UI through trusted HTTPS (or local loopback); user-entered chat keys are sent as a request header. Network reachability between the KiwiFS backend and the OpenCode V2 service is required. If they are on different hosts, a privately authenticated link must exist. **Do not publish the OpenCode privileged API publicly.**

## Autolith ACP adapter (experimental)

The same native KiwiFS drawer can now select **OpenCode (`ben-pa`)** or **Autolith**. OpenCode keeps its original scoped HTTP routes. Autolith has independent `/api/kiwi/agent/autolith/*` routes backed by a server-owned **ACP v1 JSON-RPC stdin/stdout** subprocess (`autolith acp`). Autolith's provider/model auth remains in Autolith, not in KiwiFS.

**Autolith activation is opt-in.** The KiwiFS Go process must have all of:

| Environment variable | Required value |
| --- | --- |
| `KIWIFS_AGENT_ACCESS_TOKEN` | Shared independent chat bearer key, 24+ characters; required for either backend |
| `KIWIFS_AGENT_AUTOLITH_ENABLED` | `1` |
| `KIWIFS_AGENT_AUTOLITH_WORKDIR` | Existing **absolute** private workspace directory, e.g. `$HOME/kiwifs-autolith-preview`; never accept workspace paths from the browser |
| `KIWIFS_AGENT_AUTOLITH_BIN` | Optional absolute path to installed `autolith`; otherwise locate the named executable on the server PATH |

**Before enabling:** install Autolith from the [official source](https://github.com/lambda-symbolics/autolith), inspect the installer, authenticate its provider with `autolith auth`, and verify `autolith acp` is available. Autolith must be runnable by the **same OS account** as the KiwiFS server, with credentials in that account's normal configuration.

Safe local example after installing and authenticating Autolith:

```sh
mkdir -p "$HOME/kiwifs-autolith-preview"
export KIWIFS_AGENT_ACCESS_TOKEN="$(openssl rand -hex 24)"
export KIWIFS_AGENT_AUTOLITH_ENABLED=1
export KIWIFS_AGENT_AUTOLITH_WORKDIR="$HOME/kiwifs-autolith-preview"
# Optionally: export KIWIFS_AGENT_AUTOLITH_BIN=/absolute/path/to/autolith
make go-build
./kiwifs serve --root "$HOME/kiwifs-chat-preview" --port 3334
```

Then open `http://localhost:3334`, select **Autolith** in the agent dropdown, connect with the private chat key and click New conversation. If OpenCode is also configured, `ben-pa` remains selectable.

**Current scope:** ACP `initialize`, `session/new`, `session/prompt`, `session/update` (text and tool status), `session/request_permission` (allow once/reject only), per-process session listing and polling. The Go process owns the single Autolith subprocess and isolates Autolith conversations from OpenCode. ACP client requests for filesystem/terminal/unknown methods fail closed: KiwiFS does not advertise them. Autolith's own native tools still obey Autolith's permission configuration.

**Limitations / gates:**
- Autolith conversations are retained by Autolith, but the KiwiFS adapter's **live session list and rendered event cache are in-memory**; restarting KiwiFS currently clears the chat-visible list. ACP `session/load` replay/reconnect and persistent KiwiFS registry remain follow-up work, not claimed as working.
- No automated Autolith installation, system service, provider login, background launch beyond active KiwiFS requests, or production deployment has been performed. The adapter starts the child subprocess lazily when a new Autolith session is requested.
- This is **not the KiwiFS write pipeline**. In a private test workspace, native Autolith tools can touch files accessible to its OS user; do not point `KIWIFS_AGENT_AUTOLITH_WORKDIR` at authoritative KiwiFS files until governance and file-write boundaries are assessed.
- Validate with an authenticated **real** `autolith acp` process and local KiwiFS UI before claiming live Autolith availability. The unit tests use synthetic ACP traffic; no live provider call is asserted.
- Serve only on trusted local loopback or HTTPS. The independent chat key protects all privileged Autolith routes and is held in browser memory only. Permission approvals are scoped to an exact pending ACP request; there is no permanent-allow action in the UI.

See [Autolith's official ACP user guide](https://github.com/lambda-symbolics/autolith/blob/master/docs/guide.org).

## Included behavior

- Desktop right panel and mobile full-viewport conversation.
- Explicit session create/switch; message history and tool activity updated by 1.5-second polling.
- `Attach page` reads the current file through the normal KiwiFS authenticated API and includes the first 8,000 characters of document content, with space, path, ETag and an explicit truncation marker when needed. Reads failing do not silently degrade to path-only context.
- `Attach selection` includes selected quote, space, path and saved file ETag, labeled as potentially unsaved/draft if editing; richer CodeMirror/BlockNote selection integration is not verified.
- Pending permission requests show *Allow once* and *Reject* only. The runtime still decides whether actions are authorized.
- Requests fail closed for missing or short chat keys and invalid remote HTTP endpoints.

The first implementation uses polling instead of OpenCode's volatile SSE, so it has latency (~1.5 seconds) but no additional event-stream bridge. Selection is captured from rendered document DOM; source-mode CodeMirror and BlockNote selections require a separate, editor-specific correctness check before claiming complete coverage. No automatic file edits or approvals are introduced.

## Verification and lifecycle requirements

Run and record:
1. UI typecheck/tests and production build; Go package tests and whole-repo CI.
2. Read `/api/kiwi/agent/info`, then authenticate and verify a real `ben-pa` session create/send/read-back; compare OpenCode session ID and result against the server API.
3. Confirm selected file/ETag, permission reject/allow-once, disconnected/reconnect history, mobile viewport, and preservation of KiwiFS document editing.
4. Verify production service version and agent identity **after** any separately approved deployment. A PR, CI pass, or fork alone does not prove a working installation.

Known blockers as of 2026-10-26: the tested Mac control-plane clone is isolated only; the deployed KiwiFS location and auth are not verified. Governed Mac Go execution was denied (`program is not allowed`) and `npm run typecheck` found no `tsc` in the isolated checkout, so neither is a successful test. No production configuration/deployment has been performed.

## Rollback

Keep the feature on its own branch until reviewed. Do not merge a failing or unverified PR. The bridge remains off unless both required environment variables are provided. If deployed later, removing `KIWIFS_AGENT_URL` or `KIWIFS_AGENT_ACCESS_TOKEN` and restarting the service disables the backend. Revert the feature commit(s) to remove the UI. Existing OpenCode transcripts and KiwiFS files remain under their respective authorities.

## References

- [KiwiFS source and agent rules](https://github.com/kiwifs/kiwifs/blob/main/AGENTS.md)
- [OpenCode V2 HTTP API](https://dev.opencode.ai/v2/docs/api)
- [Bec1 exploration](https://github.com/toasterman234/Bec1/blob/main/Research%20-%20KiwiFS%20agent%20chat%20integration%202026-10-26.md)

## Current validation checkpoint (2026-10-26)

- Latest feature revision `acedbb3bb5f705d99364521debf15ea0f3c0feca`: isolated [TypeScript check passed](https://github.com/toasterman234/github-workflows-control-plane/actions/runs/40395445551) and [frontend production build passed](https://github.com/toasterman234/github-workflows-control-plane/actions/runs/40395451832). A later docs-only commit is not itself deployed.
- Go bridge malformed multiline string literals found during review and corrected in commit `d04e6c2062591c6d5f955826ebc982f1e56d6e97`; **Go compilation still unverified** because the Mac control-plane command allowlist correctly rejects `go`, and no GitHub Actions run was returned for the fork PR.
- `npm test` on Mac: 1,102 passed / 15 `KiwiEditor` failures; exact same 15 reproduced on unchanged fork `main`. These remain failing tests, but not a regression introduced by chat.
- OpenCode service reachable on loopback, but `/api/info` returned 401 without credentials; no authenticated session/prompt verification or deployment.
