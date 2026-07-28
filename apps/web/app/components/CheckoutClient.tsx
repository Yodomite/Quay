"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { api, type LinkWithRequest } from "../../lib/api";

const SETTLED = new Set(["paid", "offramp_pending", "offramp_settled", "offramp_failed"]);

// Terminal-but-not-paid: the link is dead — TTL elapsed (`expired`) or the
// seller voided it (`cancelled`). Showing a live QR or "Waiting for payment…"
// here would be a merchant-visible lie.
const TERMINAL = new Set(["expired", "cancelled"]);

export default function CheckoutClient({ initial }: { initial: LinkWithRequest }) {
  const { request } = initial;
  const [link, setLink] = useState(initial.link);

  const settled = SETTLED.has(link.status);
  const dead = TERMINAL.has(link.status);
  const done = settled || dead;

  useEffect(() => {
    if (done) return;
    const poll = async () => {
      try {
        const next = await api.getLink(link.id);
        setLink(next.link);
      } catch {
        /* keep polling */
      }
    };
    const t = setInterval(poll, 4000);
    return () => clearInterval(t);
  }, [link.id, done]);

  if (dead) {
    return (
      <div className="checkout">
        <div
          className="settled-check"
          aria-hidden
          style={{ background: "rgba(232, 115, 107, 0.12)", color: "#e8736b" }}
        >
          ✕
        </div>
        <div className="settled" style={{ color: "#e8736b" }}>
          This link is no longer active
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {link.status === "expired"
            ? "The payment window has closed. Ask the merchant for a fresh link."
            : "This link was cancelled by the merchant. Ask them for a new one."}
        </p>
      </div>
    );
  }

  if (settled) {
    return (
      <div className="checkout">
        <div className="settled-check" aria-hidden>✓</div>
        <div className="settled">Payment received</div>
        <p className="muted" style={{ marginTop: 8 }}>
          {link.paidAmount ?? link.amount} {link.asset.code} settled to the merchant.
        </p>
        <div className="memo-note" style={{ marginTop: 24 }}>
          <div className="k">Transaction</div>
          <div className="v">{link.txHash ?? "confirmed on-chain"}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="checkout">
      <div className="merchant">Pay merchant</div>
      <p className="title">{link.title}</p>

      <div className="amount-hero">
        {link.amount}
        <span className="asset">{link.asset.code}</span>
      </div>

      <div className="qr-wrap">
        <QRCodeSVG value={request.uri} size={180} fgColor="#0b0f14" bgColor="#ffffff" level="M" />
      </div>
      <p className="muted" style={{ fontSize: 13 }}>Scan with a Stellar wallet, or</p>

      <a className="btn btn--primary btn--block" href={request.uri} style={{ marginTop: 12 }}>
        Open in wallet
      </a>

      <div className="memo-note">
        <div className="k">Memo — must be included</div>
        <div className="v">{request.memo}</div>
        <p className="muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
          Your wallet must send this memo so the payment can be matched. The link above sets it for you.
        </p>
      </div>

      <div className="status-rail">
        <span className="spinner" aria-hidden />
        Waiting for payment…
      </div>
    </div>
  );
}
