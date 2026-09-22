import type { Request, Response, NextFunction } from 'express';

/**
 * Content-Security-Policy for the Cerebro SPA. Everything the built UI needs is
 * same-origin (API, the WebSocket relays, uploads, the noVNC/guacamole canvases,
 * the camera/stream proxy) except Google Fonts, which the LCARS theme pulls from
 * fonts.googleapis.com (stylesheet) + fonts.gstatic.com (font files). The build
 * emits no inline scripts, so `script-src 'self'` holds; inline **styles** are
 * required (React `style={{…}}` props, xterm/noVNC), hence `'unsafe-inline'` there.
 *
 * Operators can override the whole policy with SECURITY_CSP, or set CSP_DISABLED=1
 * to drop just the CSP header (the other headers stay) if a future asset needs a
 * change that can't be shipped immediately.
 */
function defaultCsp(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "connect-src 'self'",
  ].join('; ');
}

/**
 * Baseline security response headers. `frame-ancestors 'none'` + `X-Frame-Options:
 * DENY` stop the dashboard being framed (clickjacking); `nosniff` blocks MIME
 * confusion on served uploads/recordings; HSTS is set only when the app is served
 * over HTTPS. Intentionally omits Cross-Origin-Opener-Policy so the Fabric session
 * tabs (window.open + window.close) keep working.
 */
export function securityHeaders(opts: { https: boolean }) {
  const csp = process.env.SECURITY_CSP ?? defaultCsp();
  const cspOn = process.env.CSP_DISABLED !== '1' && process.env.CSP_DISABLED !== 'true';
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    if (opts.https) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (cspOn) res.setHeader('Content-Security-Policy', csp);
    next();
  };
}
