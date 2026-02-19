// global.mjs
import chatMjs from './chat.mjs';

async function serveHTML(filename) {
  const html = await fetch(new URL(`./${filename}`, import.meta.url)).then(r => r.text());
  return new Response(html, {
    headers: { "Content-Type": "text/html" }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (path === "/" || path === "/index") return serveHTML("index.html");
    if (path === "/chat") return serveHTML("chat.html");
    if (path === "/line" || path === "/stories") return serveHTML("line.html");
    
    return chatMjs.fetch(request, env);
  }
};
