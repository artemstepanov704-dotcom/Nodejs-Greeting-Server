import { createServer } from "node:http";

const port = 3000;

const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("Hello from the Node.js greeting server!\n");
});

server.listen(port, "0.0.0.0", () => {
  console.info(`Greeting server listening on port ${port}`);
});
