const PORT = Number(process.env.PORT ?? 8787);

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      return new Response('OK', { status: 200 });
    }
    return new Response('Not Found', { status: 404 });
  },
});

console.log(`Server listening on port ${PORT}`);
