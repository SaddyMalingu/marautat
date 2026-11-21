export const GA4_MEASUREMENT_ID = "G-2WH69MDCER";

const GA4_TAG = `<script async src="https://www.googletagmanager.com/gtag/js?id=${GA4_MEASUREMENT_ID}"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', '${GA4_MEASUREMENT_ID}');
</script>`;

export function withGoogleAnalytics(html) {
  const document = String(html);
  if (document.includes(`gtag('config', '${GA4_MEASUREMENT_ID}')`)) return document;
  if (!/<\/head\s*>/i.test(document)) {
    throw new Error("Cannot add GA4 tag: HTML document has no closing head tag");
  }
  return document.replace(/<\/head\s*>/i, `${GA4_TAG}</head>`);
}
