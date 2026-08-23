// A tiny TCP proxy so tests can simulate a genuinely unreachable network —
// not just one dropped socket (which a fast reconnect can paper over in
// under a second) but a real outage window where every connection attempt
// fails until it's restored. The runner connects to the proxy's address,
// never to the real server directly.
import { createServer, Socket, type Server } from "node:net";

export class ChaosProxy {
  private server: Server;
  private sockets = new Set<Socket>();
  private accepting = true;
  port = 0;

  constructor(private targetPort: number, private targetHost = "127.0.0.1") {
    this.server = createServer((client) => {
      if (!this.accepting) {
        client.destroy();
        return;
      }
      const upstream = new Socket();
      upstream.connect(this.targetPort, this.targetHost);
      client.pipe(upstream);
      upstream.pipe(client);
      this.sockets.add(client);
      this.sockets.add(upstream);
      const cleanup = () => {
        this.sockets.delete(client);
        this.sockets.delete(upstream);
      };
      client.on("close", cleanup);
      upstream.on("close", cleanup);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.port = (this.server.address() as any).port;
    return this.port;
  }

  // "Wi-Fi dies": stop accepting new connections and kill everything already
  // flowing through. Every in-flight and future reconnect attempt fails
  // until restore() is called.
  cutNetwork() {
    this.accepting = false;
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
  }

  restoreNetwork() {
    this.accepting = true;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
