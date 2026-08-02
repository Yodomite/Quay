/**
 * Stellar Checkout Embeddable Widget
 * Lightweight script to embed non-custodial checkout modal into any merchant site.
 * 
 * Usage:
 *   1. Include script: <script src="https://quay-web.vercel.app/widget.js"></script>
 *   2. HTML attribute: <button data-stellar-checkout="lnk_123">Pay with Stellar</button>
 *   3. JS call: StellarCheckout.open("lnk_123")
 */
(function () {
  function init() {
    var buttons = document.querySelectorAll("[data-stellar-checkout]");
    buttons.forEach(function (btn) {
      if (btn.dataset.stellarBound) return;
      btn.dataset.stellarBound = "true";
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var linkId = btn.getAttribute("data-stellar-checkout");
        if (linkId) {
          openModal(linkId);
        }
      });
    });
  }

  function openModal(linkId) {
    var existingModal = document.getElementById("stellar-checkout-modal");
    if (existingModal) {
      existingModal.remove();
    }

    var overlay = document.createElement("div");
    overlay.id = "stellar-checkout-modal";
    overlay.style.cssText =
      "position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.7);z-index:999999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px);padding:16px;box-sizing:border-box;";

    var container = document.createElement("div");
    container.style.cssText =
      "position:relative;width:100%;max-width:440px;height:90vh;max-height:680px;background:#0d1117;border-radius:16px;overflow:hidden;box-shadow:0 20px 25px -5px rgba(0,0,0,0.5),0 8px 10px -6px rgba(0,0,0,0.5);border:1px solid #30363d;";

    var closeBtn = document.createElement("button");
    closeBtn.innerHTML = "&times;";
    closeBtn.setAttribute("aria-label", "Close checkout modal");
    closeBtn.style.cssText =
      "position:absolute;top:12px;right:16px;background:none;border:none;color:#8b949e;font-size:24px;line-height:1;cursor:pointer;z-index:10;padding:4px 8px;border-radius:4px;";
    closeBtn.onclick = function () {
      overlay.remove();
    };

    var iframe = document.createElement("iframe");
    iframe.id = "stellar-checkout-iframe";
    iframe.style.cssText = "width:100%;height:100%;border:none;background:#0d1117;";

    var baseUrl =
      window.STELLAR_CHECKOUT_URL || "https://quay-web.vercel.app";
    iframe.src = baseUrl + "/pay/" + encodeURIComponent(linkId);

    container.appendChild(closeBtn);
    container.appendChild(iframe);
    overlay.appendChild(container);
    document.body.appendChild(overlay);

    overlay.addEventListener("click", function (e) {
      if (e.target === overlay) {
        overlay.remove();
      }
    });
  }

  window.StellarCheckout = {
    open: openModal,
    init: init,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
