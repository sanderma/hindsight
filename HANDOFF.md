# Handoff: opencode OIDC plugin implementation

## Context

Working in `sanderma/hindsight` on branch `claude/opencode-local-http-proxy-Lj8pd`.
Goal is to split work across two repos:
- `sanderma/hindsight` — upstream-worthy changes (proxy support, factory exports, `@me` alias)
- `sanderma/hindsight-oauth` — OIDC wrapper package (`opencode-oidc`)

---

## What's done in `sanderma/hindsight` (uncommitted, needs commit+push)

### 1. `hindsight-integrations/opencode/` — HTTP proxy + factory exports

- `src/proxy.ts` (new) — `injectProxyFetch()` patches the internal hey-api client with a `ProxyAgent`
- `src/config.ts` — added `httpProxy: string | null`, env var `HINDSIGHT_HTTP_PROXY`
- `src/hooks.ts` — added `createPluginState()` factory export
- `src/index.ts` — proxy injection on startup; re-exports `createTools`, `createHooks`, `createPluginState`
- `src/test-helpers.ts` — added `httpProxy: null` to base config
- `src/config.test.ts` — 4 new proxy config tests
- `src/plugin.test.ts` — proxy mock + export tests
- `package.json` — added `"undici": "^7.0.0"`
- `dist/` rebuilt (112 tests pass)

### 2. `hindsight-api-slim/` — `@me` bank alias

- `hindsight_api/config.py` — added `ENV_USER_IDENTITY_HEADER`, `DEFAULT_USER_IDENTITY_HEADER`, `user_identity_header: str` field + `from_env()` entry
- `hindsight_api/api/http.py` — `resolve_me_bank_alias` middleware rewrites `/@me` paths using a configurable trusted header (intended for Istio `outputClaimToHeaders`)
- `tests/test_user_identity.py` (new) — 3 tests: 400 when unconfigured, 401 when header absent, end-to-end path rewrite

### 3. `hindsight-clients/typescript/src/index.ts`

- Added `fetch?: typeof globalThis.fetch` to `HindsightClientOptions` (forward-compatibility for future npm release)

---

## What needs to go to `sanderma/hindsight-oauth`

The `opencode-oidc` package is fully written at:

    hindsight-integrations/opencode-oidc/

It is NOT committed to `sanderma/hindsight` — copy this directory to the oauth repo as the root or a subdirectory.

### Package: `@vectorize-io/opencode-hindsight-oidc` (v0.1.0)

```
package.json
tsconfig.json
tsup.config.ts
vitest.config.ts
src/
  config.ts        OidcConfig extends HindsightConfig, loadOidcConfig()
  token-cache.ts   TokenCache — load/save/isExpired/clear, mode 0o600
  oauth.ts         getValidAccessToken — cache → refresh → device flow
  bank-id.ts       extractJwtClaim — base64url decode JWT payload
  token-fetch.ts   createOidcFetch — per-request Bearer token injection
  index.ts         HindsightOidcPlugin Plugin function
  bank-id.test.ts
  token-cache.test.ts
  plugin.test.ts   (has known issues — see below)
```

### Known issues in `plugin.test.ts` (was being fixed when session ended)

**Issue 1**: `MockClient` uses an arrow function — needs `function` keyword to be constructable with `new`:
```ts
// WRONG (in vi.hoisted):
const MockClient = vi.fn().mockImplementation(() => ({
  deviceAuthorization: mockDeviceAuthorization,
  refresh: mockRefresh,
}));

// CORRECT:
const MockClient = vi.fn().mockImplementation(function() {
  return {
    deviceAuthorization: mockDeviceAuthorization,
    refresh: mockRefresh,
  };
});
```

**Issue 2**: The `@vectorize-io/hindsight-client` mock is missing `createClient` and `createConfig` exports. `index.ts` imports both. Add to mock:
```ts
vi.mock("@vectorize-io/hindsight-client", () => {
  const MockHindsightClient = vi.fn(function (this: any) {
    this.retain = vi.fn().mockResolvedValue({});
    this.recall = vi.fn().mockResolvedValue({ results: [] });
    this.reflect = vi.fn().mockResolvedValue({ text: "" });
    this.createBank = vi.fn().mockResolvedValue({});
  });
  const mockCreateConfig = vi.fn((opts) => opts ?? {});
  const mockCreateClient = vi.fn(() => ({}));
  return {
    HindsightClient: MockHindsightClient,
    createConfig: mockCreateConfig,
    createClient: mockCreateClient,
  };
});
```

**Issue 3**: The "injects Authorization header" test captures `opts.fetch` from the `HindsightClient` constructor, but `index.ts` no longer passes `fetch` there — it injects via `(client as any).client = createClient(createConfig({ fetch: oidcFetch }))`. The test should instead capture the fetch from the `createConfig` call:
```ts
it("injects Authorization header in the fetch wrapper", async () => {
  let capturedFetch: typeof globalThis.fetch | undefined;
  const { createConfig } = await import("@vectorize-io/hindsight-client");
  (createConfig as any).mockImplementation((opts: any) => {
    if (opts?.fetch) capturedFetch = opts.fetch;
    return opts ?? {};
  });
  // ... rest of test unchanged
});
```

**Issue 4**: The "runs device flow" test asserts `HindsightClient` was called with `fetch` in options — remove that assertion since fetch is no longer in the constructor options:
```ts
// Remove this:
expect(HindsightClient).toHaveBeenCalledWith(
  expect.objectContaining({ fetch: expect.any(Function) })
);
// Keep:
expect(HindsightClient).toHaveBeenCalledWith(
  expect.objectContaining({ baseUrl: "https://hindsight.internal" })
);
```

### `package.json` dependency note

Currently set to `"@vectorize-io/opencode-hindsight": "file:../opencode"` for local dev.
In the oauth repo, change this to the published npm version once factory exports are published
(next release of `@vectorize-io/opencode-hindsight` after the hindsight PR merges).

---

## Immediate next steps for new session

### In `sanderma/hindsight`

1. Run `./scripts/hooks/lint.sh`
2. Run `/code-review`
3. Fix any "must fix" issues
4. Commit and push branch `claude/opencode-local-http-proxy-Lj8pd`
5. Check `.github/workflows/test.yml` — ensure the opencode integration test job picks up the new tests
6. Add `opencode` to `scripts/release-integration.sh` `VALID_INTEGRATIONS` if not already present

### In `sanderma/hindsight-oauth`

1. Copy `hindsight-integrations/opencode-oidc/` from the hindsight repo (or the files are at `/home/user/hindsight/hindsight-integrations/opencode-oidc/`)
2. Fix the 4 test issues listed above
3. Run `npm install && npm test` — all should pass
4. Add CI workflow
5. Add README

---

## Key design decisions (for context)

- **No `fetch` in published `HindsightClient` constructor**: The npm package `@vectorize-io/hindsight-client` doesn't expose `fetch` in `HindsightClientOptions`. OIDC fetch injection works by patching `(client as any).client = createClient(createConfig({ fetch: oidcFetch }))` using the exported lower-level hey-api API.
- **Factory exports**: The OIDC wrapper builds everything from scratch (its own `HindsightClient`, its own bank ID derivation) using exported factory functions `createTools`/`createHooks`/`createPluginState` from `@vectorize-io/opencode-hindsight`. A pure wrapper calling `HindsightPlugin()` would give no access to internals.
- **Token refresh**: `createOidcFetch` calls `getValidAccessToken` on every request — fast (cache hit), auto-refreshes silently within session.
- **`@me` alias**: Starlette middleware mutating `request.scope["path"]` — transparent to all routes, no per-route changes needed. Intended for Istio `outputClaimToHeaders` forwarding a JWT claim as a trusted header.
