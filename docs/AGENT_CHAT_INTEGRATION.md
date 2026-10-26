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

## Included behavior

- Desktop right panel and mobile full-viewport conversation.
- Explicit session create/switch; message history and tool activity updated by 1.5-second polling.
- `Attach page` adds KiwiFS space, path, and saved file ETag when available.
- `Attach selection` adds selected quote, labeled as unsaved/draft if editing.
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
