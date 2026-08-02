import { Hono } from "hono";

export interface StellarTomlConfig {
  signingKey: string;
  webAuthEndpoint: string;
  networkPassphrase: string;
  orgName?: string;
}

/** Renders `/.well-known/stellar.toml` per SEP-1, so wallets can discover our
 *  SEP-10 auth endpoint the same way we discover anchors' in packages/offramp. */
export function renderStellarToml(cfg: StellarTomlConfig): string {
  const lines = [
    `NETWORK_PASSPHRASE="${cfg.networkPassphrase}"`,
    `SIGNING_KEY="${cfg.signingKey}"`,
    `WEB_AUTH_ENDPOINT="${cfg.webAuthEndpoint}"`,
  ];
  if (cfg.orgName) {
    lines.push("", "[DOCUMENTATION]", `ORG_NAME="${cfg.orgName}"`);
  }
  return lines.join("\n") + "\n";
}

export function wellKnownRoutes(cfg: StellarTomlConfig): Hono {
  const app = new Hono();
  app.get("/stellar.toml", (ctx) => {
    ctx.header("Content-Type", "text/plain; charset=utf-8");
    return ctx.body(renderStellarToml(cfg));
  });
  return app;
}
