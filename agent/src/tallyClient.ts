import { config } from './config.js';
import { parseTallyResponse } from './tallyXml.js';

/**
 * Tally's HTTP listener is single-threaded, so every request goes through
 * this serial queue: only one XML request is ever in flight.
 */
let chain: Promise<unknown> = Promise.resolve();

export function postToTally(xml: string, timeoutMs = 60_000): Promise<any> {
  const run = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(config.tallyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml; charset=utf-8' },
        body: xml,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Tally HTTP ${res.status}`);
      const body = await res.text();
      // HTTP 200 does not mean success: inspect the body.
      return parseTallyResponse(body);
    } finally {
      clearTimeout(timer);
    }
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}
