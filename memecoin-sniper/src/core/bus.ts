import { makeLogger } from './logger.js';
import type { LaunchEvent, Position } from '../types.js';

const log = makeLogger('bus');

export interface Events {
  launch: LaunchEvent;
  'position:open': Position;
  'position:update': Position;
  'position:close': Position;
  'risk:halt': { reason: string };
  shutdown: { reason: string };
}

type Handler<K extends keyof Events> = (payload: Events[K]) => void | Promise<void>;

/**
 * Minimal typed event bus. A throwing handler is logged and isolated so one
 * bad subscriber can never take down the detection loop.
 */
export class Bus {
  private readonly handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as Handler<never>);
    return () => set!.delete(handler as Handler<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        const out = (handler as Handler<K>)(payload);
        if (out instanceof Promise) {
          out.catch((err) => log.error('async handler threw', { event, err }));
        }
      } catch (err) {
        log.error('handler threw', { event, err });
      }
    }
  }
}

export const bus = new Bus();
