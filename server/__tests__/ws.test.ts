import { describe, it, expect, beforeAll, afterAll } from "vitest";
import WebSocket from "ws";
import { createTestApp } from "./testUtils";

describe("websocket handshake", () => {
  let server: Awaited<ReturnType<typeof createTestApp>>["server"];
  let port: number;

  beforeAll(async () => {
    const created = await createTestApp();
    server = created.server;
    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        if (typeof address === "object" && address) {
          port = address.port;
        }
        resolve();
      });
    });
  });

  afterAll(() => {
    server.close();
  });

  it("accepts a websocket connection on /ws", async () => {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "ping" }));
        ws.close();
        resolve();
      });
      ws.on("error", (error) => {
        reject(error);
      });
    });

    expect(port).toBeGreaterThan(0);
  });
});
