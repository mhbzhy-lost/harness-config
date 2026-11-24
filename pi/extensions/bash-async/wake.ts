import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WAKE_PENDING_MS = 10_000;
const reservationsSymbol = Symbol.for("pi.idle-wake.v1");
type Reservation = { sessionId: string; sentAt?: number };
const wakeGlobal = globalThis as Record<symbol, unknown>;
const reservations = (wakeGlobal[reservationsSymbol] ??= new WeakMap<object, Reservation>()) as WeakMap<object, Reservation>;

type WakeMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

export type BashAsyncWake = {
  sendMessage(message: WakeMessage, options: { triggerTurn: true }): boolean;
  bindSession(ctx: ExtensionContext): void;
  agentStarted(): void;
  userAborted(): void;
  releaseHold(): void;
  isHeld(): boolean;
  sessionShutdown(reason?: string): void;
};

export function createBashAsyncWake(pi: ExtensionAPI, now: () => number = Date.now): BashAsyncWake {
  let ctx: ExtensionContext | undefined;
  let session: { manager: object; id: string } | undefined;
  let held = false;
  const reservation = (): Reservation => {
    if (!session) return { sessionId: "" };
    const current = reservations.get(session.manager);
    if (current?.sessionId === session.id) return current;
    const next: Reservation = { sessionId: session.id };
    reservations.set(session.manager, next);
    return next;
  };
  const reserved = (): boolean => {
    const { sentAt } = reservation();
    return sentAt !== undefined && now() - sentAt < WAKE_PENDING_MS;
  };
  return {
    sendMessage(message, options) {
      if (options?.triggerTurn !== true) {
        pi.sendMessage(message, options);
        return false;
      }
      if (held || (ctx?.isIdle() && reserved())) {
        pi.sendMessage(message, { triggerTurn: false });
        return true;
      }
      if (ctx?.isIdle()) reservation().sentAt = now();
      pi.sendMessage(message, options);
      return false;
    },
    bindSession(context) {
      ctx = context;
      session = { manager: context.sessionManager, id: context.sessionManager.getSessionId() };
      held = false;
    },
    agentStarted() {
      reservation().sentAt = undefined;
      held = false;
    },
    userAborted() {
      held = true;
    },
    releaseHold() {
      held = false;
    },
    isHeld() {
      return held;
    },
    sessionShutdown(reason) {
      if (reason !== "reload") reservation().sentAt = undefined;
    },
  };
}
