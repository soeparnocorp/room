// src/global.mjs
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    try {
      // Handle root - serve index.html
      if (url.pathname === "/") {
        const html = await fetchHTML("index.html");
        return new Response(html, {
          headers: { "Content-Type": "text/html" }
        });
      }
      
      // Handle /chat - serve chat.html (kalo beda)
      if (url.pathname === "/chat") {
        const html = await fetchHTML("chat.html");
        return new Response(html, {
          headers: { "Content-Type": "text/html" }
        });
      }
      
      // Handle /line - serve line.html
      if (url.pathname === "/line") {
        const html = await fetchHTML("line.html");
        return new Response(html, {
          headers: { "Content-Type": "text/html" }
        });
      }
      
      // Forward API requests ke chat.mjs
      if (url.pathname.startsWith("/api/")) {
        const chatMjs = await import('./chat.mjs');
        return chatMjs.default.fetch(request, env);
      }
      
      return new Response("Not found", { status: 404 });
      
    } catch (err) {
      return new Response(err.stack, { status: 500 });
    }
  }
};

// Fungsi baca file HTML langsung
async function fetchHTML(filename) {
  const url = new URL(filename, import.meta.url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${filename}`);
  return res.text();
}
