# Changelog

## 0.2.0
- Configurable transport path prefix (original hard-coded `/@BlueKnight_Net--…--`, still the default): panel page `/knight/settings`, `GET|POST /knight/api/settings`, env override `TRANSPORT_PATH_PREFIX` (locks the UI). Validated, persisted in `settings.json`, audited without logging the value, described but never revealed in diagnostics.
- Readiness now distinguishes critical checks from degraded (`settings_store`).
- Tests: 39.

## 0.1.0 — Milestone 1 (core, auth, logging & diagnostics)
- Zero-dependency Node.js (>=20) HTTP server, configuration validation with all problems reported at once.
- Structured JSON logging (DEBUG/INFO/WARNING/ERROR/CRITICAL), separate `app` and `security` channels, size-based rotation, age-based retention job, secret redaction, request IDs.
- Password authentication (scrypt), signed session cookie, login lockout, CSRF/origin checks, optional SETUP_KEY.
- `/healthz`, `/readyz`, admin log viewer, raw log download, diagnostic report (JSON) download, offline CLI report.
- Frontend error reporting to the backend log.
- Process-level handlers: uncaught exceptions, unhandled rejections, graceful shutdown.
- 32 automated tests.
- NOT yet implemented: proxy engines, routing, subscriptions, IP scanner, traffic stats (milestones 2-4).
