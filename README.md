# Blue Knight Panel — rebuild (v0.2.0)

Independent rewrite of the Blue Knight Panel. This milestone delivers the foundation: configuration, authentication, a login-protected panel, and the **logging / diagnostics system** used to debug deployments. Proxy engines, subscriptions and the scanner come in later milestones (see "Status").

## Install & run locally
Requires Node.js >= 20. No `npm install` needed (no dependencies).
```
cp .env.example .env     # optional; export the variables in your shell or hosting dashboard
SETUP_KEY=choose-a-key node src/main.js
```
Open `http://localhost:3000/knight`, enter the setup key and create the password.

## Docker
```
docker build -t bk-panel .
docker run -p 3000:3000 -v bkdata:/data -e SETUP_KEY=choose-a-key bk-panel
```
Keep `/data` on persistent storage (password, session secret and logs live there). Image sets `TRUST_PROXY_HOPS=1` for PaaS hosts; set `0` if the container is exposed directly.

## Environment variables
| Variable | Default | Meaning |
|---|---|---|
| PORT / HOST | 3000 / 0.0.0.0 | Listen address |
| BK_DATA_DIR | ./data | Persistent data (auth.json, logs/) |
| PANEL_PATH | knight | Panel URL prefix |
| SETUP_KEY | – | Required on first-run setup (strongly recommended) |
| PANEL_PASSWORD | – | Initial password (>= 8 chars), only if none exists |
| LOG_LEVEL | INFO | DEBUG, INFO, WARNING, ERROR, CRITICAL |
| LOG_MAX_MB / LOG_MAX_FILES | 5 / 5 | Rotation size and number of rotated files |
| LOG_RETENTION_DAYS | 14 | Rotated files older than this are deleted hourly |
| LOG_STDOUT | true | Also print logs to stdout/stderr (platform log viewers) |
| LOG_CLIENT_IP | true | `false` masks client IPs in logs |
| TRUST_PROXY_HOPS | 0 | Reverse proxies in front (uses X-Forwarded-For/Proto/Host) |
| COOKIE_SECURE | auto | auto / true / false |
| TRANSPORT_PATH_PREFIX | (original `/@BlueKnight_Net--…--`) | Prefix of every transport path (`<prefix>ws`, `httpupgrade`, `xhttp`, `grpc`, …). Setting it locks the panel field |

Invalid values stop the process with a CRITICAL log listing every problem.

## Getting logs after deployment
1. **Panel:** `/knight/logs` — filter by channel/level/text, auto-refresh.
2. **Diagnostic report (send this to me):** `/knight/logs` → "Diagnostic report", or `GET /knight/api/diagnostics/download`. Contains version, runtime, sanitized config, health checks, last errors and recent app/security logs.
3. **Raw files:** `<BK_DATA_DIR>/logs/app.log` and `security.log` (+ rotated `.1` …).
4. **Platform logs:** the same JSON lines go to stdout/stderr (`docker logs`, Railway/Meera log tabs).
5. **If the panel is unreachable:** run `npm run diagnostics -- --out report.json` on the host (works offline from files on disk).

Logs never contain passwords, cookies, tokens, keys or proxy links (redacted at write time). Reports DO contain client IPs and request paths unless `LOG_CLIENT_IP=false` — skim before sharing.

Each response carries `X-Request-Id`; the same id is in the log lines, so a failing request can be traced. 500 responses include it in the body.

## Debugging workflow
Deploy → reproduce → download the diagnostic report → send it with the steps you took → I find the root cause, patch, run tests and send a new ZIP + changelog entry.

## Endpoints
`GET /healthz` (liveness), `GET /readyz` (data dir, log dir, auth store), `/knight/login`, `/knight/logs`, `/knight/api/{status,logs,logs/download,diagnostics,diagnostics/download}` (session required), `POST /knight/api/client-log` (public, rate-limited, 8 KB).

## Changing the transport path prefix
Panel → Settings → *Transport path prefix* (live preview of every resulting path), or the `TRANSPORT_PATH_PREFIX` variable. Allowed: `/` + 1-150 chars of `A-Z a-z 0-9 @ . _ ~ -`. Empty = default. The value is stored in `<data>/settings.json`. After a change old client configs no longer match: refresh the subscription. The prefix is stored and exposed now; the engines/routers that consume it arrive in milestone 2.

## Update
Replace the files (or rebuild the image), keep `/data`, restart. Check `CHANGELOG.md`.

## Troubleshooting
- *Login page says "setup" again:* data dir is not persistent (look for the "temporary fallback" WARNING).
- *Locked out (5 failures):* wait 15 min, or restart the process.
- *Forgot password:* stop the app, delete `auth.json` in the data dir, start with `SETUP_KEY` set.
- *503 on /readyz:* open the diagnostic report → `checks[].detail`.
- *Everyone shares one IP in logs / lockouts affect all users:* set `TRUST_PROXY_HOPS=1`.

## Status & known limitations
- Done (tested): everything above. `npm test` = 39 tests; `npm run check` = syntax/forbidden-pattern scan.
- Not done yet: sing-box/Xray management, TCP/SNI routing, subscriptions (base64/Clash/sing-box/Xray), IP scanner, traffic stats, resource monitor.
- Not verified: Docker build/health check, deployment on Meera Solution or Railway, ESLint/type checks (no network in the build sandbox).
- Sessions are stateless: logout clears the cookie but a stolen cookie stays valid until expiry (12 h).
- Login lockout state is in memory (resets on restart).
