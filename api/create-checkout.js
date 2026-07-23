// Canonical prices — the source of truth. Never trust prices sent by the client.
const PRODUCTS = {
  "cabernet-sauvignon": { name: "Cabernet Sauvignon", price: 120 },
  "merlot": { name: "Merlot", price: 120 },
  "shiraz": { name: "Shiraz", price: 120 },
  "chardonnay": { name: "Chardonnay", price: 120 },
  "chenin-blanc": { name: "Chenin Blanc", price: 125 },
  "sauvignon-blanc": { name: "Sauvignon Blanc", price: 110 },
  "charmat-selection": { name: "Charmat Selection", price: 130 },
  "beatrix-selection": { name: "Beatrix Selection", price: 270 },
  "niclas-selection": { name: "Niclas Selection", price: 270 },
  "jacob-selection": { name: "Jacob Selection", price: 270 },
  "cape-pearl-chardonnay": { name: "Cape Pearl Chardonnay", price: 70 },
  "cape-pearl-dry-red": { name: "Cape Pearl Dry Red", price: 70 },
};
const DELIVERY_FEE = 120;
const MAX_QTY_PER_ITEM = 48;
const BASE_URL = "https://www.kleinparysvineyards.co.za";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const secretKey = process.env.YOCO_SECRET_KEY;
  if (!secretKey) {
    console.error("YOCO_SECRET_KEY is not set");
    res.status(500).json({ error: "Checkout is not configured yet. Please email sales@kparys.co.za." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch (e) { body = null; }
  }
  if (!body || typeof body !== "object") {
    res.status(400).json({ error: "Invalid request." });
    return;
  }

  const { items, customer } = body;

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: "Your cart is empty." });
    return;
  }
  if (!customer || typeof customer !== "object") {
    res.status(400).json({ error: "Missing customer details." });
    return;
  }
  const name = String(customer.name || "").trim();
  const email = String(customer.email || "").trim();
  const phone = String(customer.phone || "").trim().replace(/[\s-]/g, "");
  const deliveryMethod = customer.deliveryMethod === "pickup" ? "pickup" : "ship";
  const rawAddress = (customer.address && typeof customer.address === "object") ? customer.address : {};
  const street = String(rawAddress.street || "").trim();
  const suburb = String(rawAddress.suburb || "").trim();
  const city = String(rawAddress.city || "").trim();
  const province = String(rawAddress.province || "").trim();
  const postalCode = String(rawAddress.postalCode || "").trim();
  const instructions = String(rawAddress.instructions || "").trim();

  if (!name || !email || !phone) {
    res.status(400).json({ error: "Please fill in your name, email and phone number." });
    return;
  }
  const saPhonePattern = /^(?:\+27|0)[1-9]\d{8}$/;
  if (!saPhonePattern.test(phone)) {
    res.status(400).json({ error: "Please enter a valid South African phone number." });
    return;
  }
  if (deliveryMethod === "ship") {
    if (!street || !city || !province || !postalCode) {
      res.status(400).json({ error: "Please enter your full delivery address (street, town, province and postal code)." });
      return;
    }
    if (!/^\d{4}$/.test(postalCode)) {
      res.status(400).json({ error: "Please enter a valid 4-digit postal code." });
      return;
    }
  }
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailPattern.test(email)) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }

  const lineItems = [];
  let subtotal = 0;
  const orderSummaryParts = [];

  for (const rawItem of items) {
    if (!rawItem || typeof rawItem !== "object") continue;
    const product = PRODUCTS[rawItem.id];
    if (!product) {
      res.status(400).json({ error: "One of the items in your cart is no longer available." });
      return;
    }
    const qty = Math.floor(Number(rawItem.qty));
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY_PER_ITEM) {
      res.status(400).json({ error: "Invalid quantity for " + product.name + "." });
      return;
    }
    const lineTotal = product.price * qty;
    subtotal += lineTotal;
    lineItems.push({
      displayName: product.name,
      quantity: qty,
      pricingDetails: { price: product.price * 100 },
    });
    orderSummaryParts.push(`${product.name} x${qty}`);
  }

  if (subtotal <= 0) {
    res.status(400).json({ error: "Your cart is empty." });
    return;
  }

  const deliveryFee = deliveryMethod === "ship" ? DELIVERY_FEE : 0;
  if (deliveryFee > 0) {
    lineItems.push({
      displayName: "Nationwide Delivery (2-4 business days)",
      quantity: 1,
      pricingDetails: { price: deliveryFee * 100 },
    });
  }

  const total = subtotal + deliveryFee;
  const amountInCents = total * 100;

  const deliveryAddressFormatted = deliveryMethod === "ship"
    ? [street, suburb, city, province, postalCode].filter(Boolean).join(", ")
    : "Estate collection";

  const payload = {
    amount: amountInCents,
    currency: "ZAR",
    successUrl: `${BASE_URL}/wine-shop.html?checkout=success`,
    cancelUrl: `${BASE_URL}/wine-shop.html?checkout=cancelled`,
    failureUrl: `${BASE_URL}/wine-shop.html?checkout=failed`,
    lineItems,
    subtotalAmount: subtotal * 100,
    metadata: {
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      deliveryMethod,
      deliveryAddress: deliveryAddressFormatted,
      deliveryStreet: street,
      deliverySuburb: suburb,
      deliveryCity: city,
      deliveryProvince: province,
      deliveryPostalCode: postalCode,
      deliveryInstructions: instructions,
      orderSummary: orderSummaryParts.join(", ").slice(0, 500),
    },
  };

  try {
    const yocoRes = await fetch("https://payments.yoco.com/api/checkouts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await yocoRes.json();

    if (!yocoRes.ok || !data.redirectUrl) {
      console.error("Yoco checkout creation failed:", yocoRes.status, data);
      res.status(502).json({ error: "Could not start payment. Please try again or email sales@kparys.co.za." });
      return;
    }

    res.status(200).json({ redirectUrl: data.redirectUrl });
  } catch (err) {
    console.error("Yoco checkout request error:", err);
    res.status(502).json({ error: "Could not reach the payment provider. Please try again shortly." });
  }
};
