-- Remote Browser web-credential autofill: per-route behavior for injecting a
-- `web`-kind vault credential into the remote browser page. "off" | "auto" |
-- "manual" (default applied in app code is "manual"); NULL for non-web routes.
-- See docs/fabric-remote-browser-credential-injection.md.
ALTER TABLE "AgentTarget" ADD COLUMN "webAutofill" TEXT;
