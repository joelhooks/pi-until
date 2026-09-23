import { afterEach, describe, expect, it, vi } from "vitest";

import { FOLLOW_UP_REQUEST_EVENT } from "../extensions/pi-until.ts";
import { FakeSession, loadExtension } from "./fake-pi.ts";
import type { FakeExtension } from "./fake-pi.ts";

const live: FakeExtension[] = [];

afterEach(async () => {
  await Promise.all(
    live.splice(0).map((extension) => extension.shutdown("quit"))
  );
});

const request = (id: string, onAccept: () => void = () => {}) => ({
  accept: onAccept,
  content: `external follow-up ${id}`,
  customType: "bellwether-herdr-watch",
  details: { watch: id },
  id,
  source: "bellwether",
  version: 1,
});

describe("external follow-up requests", () => {
  it("accepts a valid request and delivers it through the session arbiter", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context();
    await extension.sessionStart("startup", ctx);

    const accept = vi.fn<() => void>();
    extension.emitToExtension(FOLLOW_UP_REQUEST_EVENT, request("a", accept));

    expect(accept).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(1);
    });
    expect(extension.messages[0]).toMatchObject({
      message: {
        content: "external follow-up a",
        customType: "bellwether-herdr-watch",
        details: {
          followUpId: expect.any(String),
          receipt: { watch: "a" },
        },
        display: true,
      },
      options: { deliverAs: "followUp", triggerTurn: true },
    });
  });

  it("serializes external requests with one follow-up in flight", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context({ idle: false });
    await extension.sessionStart("startup", ctx);

    extension.emitToExtension(FOLLOW_UP_REQUEST_EVENT, request("a"));
    extension.emitToExtension(FOLLOW_UP_REQUEST_EVENT, request("b"));
    expect(extension.messages).toHaveLength(0);

    await extension.agentSettled(ctx);
    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(1);
    });
    await extension.agentSettled(ctx);
    await vi.waitFor(() => {
      expect(extension.messages).toHaveLength(2);
    });
    expect(extension.messages.map((sent) => sent.message.content)).toEqual([
      "external follow-up a",
      "external follow-up b",
    ]);
  });

  it("does not accept before session start, after shutdown, or when malformed", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    const { ctx } = session.context();

    const early = vi.fn<() => void>();
    extension.emitToExtension(FOLLOW_UP_REQUEST_EVENT, request("early", early));
    expect(early).not.toHaveBeenCalled();

    await extension.sessionStart("startup", ctx);
    const malformed = vi.fn<() => void>();
    extension.emitToExtension(FOLLOW_UP_REQUEST_EVENT, {
      ...request("bad", malformed),
      version: 2,
    });
    extension.emitToExtension(FOLLOW_UP_REQUEST_EVENT, {
      ...request("", malformed),
    });
    extension.emitToExtension(FOLLOW_UP_REQUEST_EVENT, "not a request");
    expect(malformed).not.toHaveBeenCalled();

    await extension.shutdown("quit");
    const late = vi.fn<() => void>();
    extension.emitToExtension(FOLLOW_UP_REQUEST_EVENT, request("late", late));
    expect(late).not.toHaveBeenCalled();
    expect(extension.messages).toHaveLength(0);
  });

  it("listens again after a session replacement restarts the same instance", async () => {
    const session = new FakeSession();
    const extension = loadExtension(session);
    live.push(extension);
    const { ctx } = session.context();
    await extension.sessionStart("startup", ctx);
    await extension.shutdown("new", ctx);
    await extension.sessionStart("new", ctx);

    const accept = vi.fn<() => void>();
    extension.emitToExtension(
      FOLLOW_UP_REQUEST_EVENT,
      request("again", accept)
    );
    expect(accept).toHaveBeenCalledOnce();
  });
});
