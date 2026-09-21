// Razorpay's in-browser Checkout, wrapped so the Sell screen never has to
// think about a global that may not be there.
//
// Nothing here is evidence. Checkout tells this page the customer succeeded;
// the page relays that to the server to be signature-checked, and even a
// verified relay only changes what the cashier reads. The payment itself is
// recorded by the webhook the provider sends our server directly, which is
// the one path a customer's browser cannot reach.

const SCRIPT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

let pending = null;

// Loaded on demand rather than in index.html: on a deployment with no
// provider — which is every deployment today — this request is never made,
// so the POS has no third-party script in it at all.
export const loadRazorpayCheckout = () => {
  if (window.Razorpay) return Promise.resolve(window.Razorpay);
  if (pending) return pending;
  pending = new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = SCRIPT_SRC;
    el.async = true;
    el.onload = () =>
      window.Razorpay
        ? resolve(window.Razorpay)
        : reject(new Error('Razorpay Checkout loaded but did not register itself'));
    el.onerror = () => {
      pending = null;
      reject(new Error('Could not load Razorpay Checkout — check this terminal’s internet access'));
    };
    document.head.appendChild(el);
  });
  return pending;
};

// Resolves for every outcome including dismissal, because a customer closing
// the window is an ordinary thing that happened and not an error to throw.
// `ok: false` with reason 'dismissed' is the cashier's cue that nothing was
// paid; 'failed' is Razorpay reporting the attempt itself failed.
export const openRazorpayCheckout = async ({
  keyId,
  orderRef,
  amountPaise,
  companyName,
  description,
}) => {
  const Razorpay = await loadRazorpayCheckout();
  return new Promise((resolve) => {
    let answered = false;
    const once = (value) => {
      if (answered) return;
      answered = true;
      resolve(value);
    };

    const rzp = new Razorpay({
      key: keyId,
      order_id: orderRef,
      amount: amountPaise,
      currency: 'INR',
      name: companyName || 'Payment',
      description,
      // Cash counter, not a customer's own device: retrying inside the widget
      // would leave the cashier watching a screen with no way back.
      retry: { enabled: false },
      modal: {
        escape: true,
        ondismiss: () => once({ ok: false, reason: 'dismissed' }),
      },
      handler: (response) =>
        once({
          ok: true,
          paymentId: response?.razorpay_payment_id ?? null,
          signature: response?.razorpay_signature ?? null,
        }),
    });

    rzp.on('payment.failed', (e) =>
      once({ ok: false, reason: 'failed', detail: e?.error?.description || 'the payment failed' }),
    );
    rzp.open();
  });
};
