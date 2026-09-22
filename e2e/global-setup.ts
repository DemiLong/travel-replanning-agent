import { createServer } from "node:http";
import type { Socket } from "node:net";
import next from "next";

export default async function globalSetup() {
  const hostname = "127.0.0.1";
  const port = 3000;
  const app = next({ dev: false, hostname, port });
  const handle = app.getRequestHandler();
  await app.prepare();

  const sockets = new Set<Socket>();
  const server = createServer((request, response) => handle(request, response));
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, hostname, resolve);
  });

  return async () => {
    server.close();
    for (const socket of sockets) socket.destroy();
    await app.close();
  };
}
