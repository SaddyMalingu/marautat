const BASE = process.env.BASE_URL || "http://localhost:3000";
const PHONE = process.env.TENANT_PHONE || "0702245555";
const KEY = process.env.TENANT_DASHBOARD_PASS || "254702245555";

async function main() {
  const sku = `SMOKE-${Date.now()}`;
  const payload = {
    sku,
    name: "Smoke Test Product",
    description: "Catalog media smoke test",
    price: 12345,
    currency: "KES",
    stock_count: 3,
    image_url: "https://example.com/images/smoke-test.jpg",
    store_url: "https://www.kassangasmusicstore.com/product/Shure%20SM7B%20Cardioid%20Dynamic%20Legendary%20Vocal%20Microphone",
    metadata: {
      category: "Testing",
      store_url: "https://www.kassangasmusicstore.com/product/Shure%20SM7B%20Cardioid%20Dynamic%20Legendary%20Vocal%20Microphone"
    }
  };

  const out = [];
  let token = "";

  const j = async (url, opts = {}) => {
    const headers = { ...(opts.headers || {}) };
    if (token) headers["x-tenant-session"] = token;
    const r = await fetch(`${BASE}${url}`, { ...opts, headers });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data: d };
  };

  try {
    // Login
    let r = await j("/tenant/session/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenant_phone: PHONE, key: KEY })
    });
    token = r.data?.token || "";
    out.push({ step: "login", ok: r.ok && !!token, status: r.status, detail: r.data?.error || "token issued" });
    if (!token) throw new Error("Login failed");

    // Create
    r = await j("/tenant/catalog", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    out.push({ step: "create product", ok: r.ok && !!r.data?.item, status: r.status, detail: r.data?.error || (r.data?.item?.sku || "created") });
    if (!r.ok) throw new Error("Create failed");

    // Fetch
    r = await j(`/tenant/catalog?q=${encodeURIComponent(sku)}`);
    const item = (r.data?.items || []).find((x) => x.sku === sku);
    const checks = {
      hasItem: !!item,
      storeUrl: item?.store_url === payload.store_url,
      imageUrl: item?.image_url === payload.image_url,
      primaryImage: item?.primary_image === payload.image_url
    };
    out.push({
      step: "read normalized fields",
      ok: r.ok && checks.hasItem && checks.storeUrl && checks.imageUrl && checks.primaryImage,
      status: r.status,
      detail: JSON.stringify(checks)
    });

    // Delete
    r = await j(`/tenant/catalog?sku=${encodeURIComponent(sku)}`, { method: "DELETE" });
    out.push({
      step: "delete product",
      ok: r.ok,
      status: r.status,
      detail: r.data?.error || "deleted"
    });

    // Logout
    r = await j("/tenant/session/logout", { method: "POST" });
    out.push({ step: "logout", ok: r.ok, status: r.status, detail: r.data?.error || "session closed" });

    console.log(JSON.stringify({ ok: out.every((x) => x.ok), steps: out }, null, 2));
    process.exit(out.every((x) => x.ok) ? 0 : 1);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message, steps: out }, null, 2));
    process.exit(1);
  }
}

main();
