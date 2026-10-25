# Desktop model proxy settings implementation plan

**Goal:** Add an application proxy switch with user-selectable disabled behavior and editable protocol, host and port, shared by chat and research model requests.

**Approved design:** When enabled, use the custom proxy. When disabled, the user chooses direct connection or environment proxy routing. Existing installations default to environment routing; no proxy software port is assumed. Persist only application settings; leave system settings, `.env`, credentials, research data and existing workspace edits intact.

**Architecture:** Global `settings.json` stores one atomic `network.proxy` object. Each newly admitted native model request reads the live global policy and freezes its effective network environment. Existing requests retain their route through retries and WS/SSE fallback. The existing JSONL → Electron → settings-store bridge carries configuration and payload-free TCP checks. Search/download/browser/MCP/terminal traffic retains its independent policies.

## Contract

```ts
interface ProxySettings {
  enabled: boolean
  whenDisabled: 'direct' | 'environment'
  protocol: 'http' | 'https' | 'socks5' | 'socks5h'
  host: string
  port: number | null
}
interface ProxyRoute { mode: 'direct' | 'proxy'; endpoint: string; proxy?: string }
interface ProxySettingsSnapshot { settings: ProxySettings; route: ProxyRoute | null; routeError?: string }
interface ProxyConnectionCheck { route: ProxyRoute | null; reachable: boolean; check: 'tcp'; error?: string }
```

- `get_proxy_settings` returns `ProxySettingsSnapshot`.
- `set_proxy_settings {settings}` validates and atomically saves the object, then returns its snapshot. Reject invalid values without changing saved state.
- `check_proxy_connection {settings?}` checks the current model's effective TCP route with saved settings or the provided draft; it sends no prompt, credential or HTTP payload and never persists a draft.
- Defaults: disabled, `whenDisabled=environment`, HTTP, host `127.0.0.1`, port unset. Custom mode requires a valid integer port 1–65535. IPv4, IPv6 and DNS hosts are accepted; host is not a URL and carries no credentials/path. Environment mode preserves existing scoped/environment precedence and authenticated proxy URLs. Custom mode overrides both cases of HTTP(S)/ALL proxy values while honoring the effective `NO_PROXY`; direct mode explicitly clears proxy routing. Preserve CA and unrelated provider variables.
- Backend shared module: `misaka/config/proxy_settings.py`, exporting `validate_proxy_settings(value)`, `get_proxy_settings()`, `proxy_request_env(env=None, *, settings=None)` and `proxy_httpx_options(endpoint, env=None)`. Settings are global-only; invalid persisted settings yield a configuration error rather than route fallback.
- Apply policy at native model registry stream, streamSimple, complete and deferred boundaries. Keep `network_route` pure. Attach an in-memory effective-env snapshot to the returned stream so research diagnostics use the actual request route. A fresh explicit connection check reads current settings, not the previous failure snapshot.

## Task 1 — Backend policy and bridge

- Add failing tests for validation, absent/default policy, explicit direct vs inherited environment, arbitrary ports, IPv6, NO_PROXY, config failures and cross-instance live updates.
- Implement the shared settings reader and request transformation with copied options (retain callbacks, signals and typed thinking budgets).
- Add atomic bridge APIs above, request-boundary integration and accurate research diagnostics. Add bridge ACK and registry integration tests; keep existing startup retry ownership/idempotency behavior.
- Verify focused Python regression suites using isolated homes and no live provider requests.

## Task 2 — Settings UI and state

- Add failing UI/store tests for switch + disabled-behavior selection, editable port, validation, ACK-gated commits, failed saves, persisted reload and draft-only TCP checks.
- Add a searchable `网络与代理` settings section matching existing dark semantic tokens. Show proxy switch, disabled behavior selector, protocol/host/port, saved effective route, explicit Save, and Check Connection. Keep draft edits until confirmed; disable duplicate actions while pending; distinguish TCP reachability from model authentication/availability.
- Use typed dedicated proxy state and existing settings command transport; do not put credentials into localStorage.
- Verify Vitest and TypeScript.

## Task 3 — Remaining native adapters and OAuth

- Add failing transport tests before wiring Google/Vertex, Mistral, Pi Messages and Bedrock to request-scoped routes. Reuse the pure network helper; keep owned clients closed. If an SDK lacks a transport capability, surface an explicit error rather than silently changing the route.
- Wire native OAuth HTTP requests to `proxy_httpx_options` using their actual token/service endpoint so enabling or disabling also works during token refresh; never apply application routing to a localhost callback listener.
- Verify provider/OAuth regressions with mocked transports and local services only.

## Task 4 — Review and end-to-end verification

- Run task-level review, fix material findings, then whole-change review.
- Verify full frontend Vitest, type check/build, relevant backend/provider/OAuth regression suites and a production Electron E2E using an isolated home, local model and dynamic-port local proxy.
- E2E must cover opening settings, default compatibility, saved/reopened arbitrary-port custom proxy, disabled-direct overriding a broken inherited proxy, disabled-environment retaining it, and no automatic replay of a real question. Preserve current sessions and workspaces.
- Keep all changes uncommitted; do not reset, clean, push, change user networking or send real model requests.
