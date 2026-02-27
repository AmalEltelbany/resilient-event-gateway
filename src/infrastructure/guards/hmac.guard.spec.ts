import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { HmacGuard } from './hmac.guard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'test-hmac-secret';
const REPLAY_WINDOW_MS = 300_000; // 5 minutes

function makeGuard(overrides: { secret?: string; replayWindowMs?: number } = {}): HmacGuard {
  const config = {
    get: (key: string) => {
      if (key === 'webhook.secret') return overrides.secret ?? SECRET;
      if (key === 'webhook.replayWindowMs') return overrides.replayWindowMs ?? REPLAY_WINDOW_MS;
      return undefined;
    },
  } as unknown as ConfigService;
  return new HmacGuard(config);
}

function makeSignature(body: Buffer, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function makeContext(
  headers: Record<string, string | undefined>,
  rawBody: Buffer | undefined,
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        headers,
        rawBody,
        method: 'POST',
        url: '/api/events',
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeBody(timestamp: string = new Date().toISOString()): Buffer {
  return Buffer.from(JSON.stringify({
    eventId: '123e4567-e89b-12d3-a456-426614174000',
    type: 'shipment.status_updated',
    source: 'fedex',
    timestamp,
    payload: { shipmentId: 'ship-1' },
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HmacGuard', () => {
  let guard: HmacGuard;

  beforeEach(() => {
    guard = makeGuard();
  });

  // -------------------------------------------------------------------------
  // Signature validation
  // -------------------------------------------------------------------------

  describe('signature validation', () => {
    it('returns true for a valid signature with a fresh timestamp', () => {
      const body = makeBody();
      const ctx = makeContext({ 'x-signature': makeSignature(body) }, body);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('throws UnauthorizedException when x-signature header is missing', () => {
      const body = makeBody();
      const ctx = makeContext({}, body);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when x-signature header is undefined', () => {
      const body = makeBody();
      const ctx = makeContext({ 'x-signature': undefined }, body);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when rawBody is undefined', () => {
      const ctx = makeContext({ 'x-signature': 'sha256=abc' }, undefined);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when signature does not match', () => {
      const body = makeBody();
      const ctx = makeContext({ 'x-signature': 'sha256=deadbeefdeadbeef' }, body);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when signed with a different secret', () => {
      const body = makeBody();
      const wrongSig = makeSignature(body, 'wrong-secret');
      const ctx = makeContext({ 'x-signature': wrongSig }, body);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('throws UnauthorizedException when signature has wrong prefix format', () => {
      const body = makeBody();
      // Valid hex but missing the `sha256=` prefix
      const raw = createHmac('sha256', SECRET).update(body).digest('hex');
      const ctx = makeContext({ 'x-signature': raw }, body);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects a tampered body even with the original signature', () => {
      const originalBody = makeBody();
      const sig = makeSignature(originalBody);
      // Body is changed after signing — signature no longer matches
      const tamperedBody = Buffer.from(originalBody.toString('utf8').replace('fedex', 'dhl'));
      const ctx = makeContext({ 'x-signature': sig }, tamperedBody);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });

  // -------------------------------------------------------------------------
  // Replay-protection (timestamp window)
  // -------------------------------------------------------------------------

  describe('replay protection', () => {
    it('accepts a request whose timestamp is exactly at the window boundary', () => {
      // Timestamp is REPLAY_WINDOW_MS - 1ms ago — just inside the allowed window
      const ts = new Date(Date.now() - (REPLAY_WINDOW_MS - 1)).toISOString();
      const body = makeBody(ts);
      const ctx = makeContext({ 'x-signature': makeSignature(body) }, body);
      expect(guard.canActivate(ctx)).toBe(true);
    });

    it('rejects a request whose timestamp is outside the replay window', () => {
      // Timestamp is well outside the window
      const staleTs = new Date(Date.now() - REPLAY_WINDOW_MS - 60_000).toISOString();
      const body = makeBody(staleTs);
      const ctx = makeContext({ 'x-signature': makeSignature(body) }, body);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects a future timestamp outside the window (clock skew attack)', () => {
      const futureTs = new Date(Date.now() + REPLAY_WINDOW_MS + 60_000).toISOString();
      const body = makeBody(futureTs);
      const ctx = makeContext({ 'x-signature': makeSignature(body) }, body);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects a request with an unparseable timestamp', () => {
      const badBody = Buffer.from(JSON.stringify({ timestamp: 'not-a-date' }));
      const ctx = makeContext({ 'x-signature': makeSignature(badBody) }, badBody);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('rejects a request with a missing timestamp field', () => {
      const noTsBody = Buffer.from(JSON.stringify({ eventId: '123' }));
      const ctx = makeContext({ 'x-signature': makeSignature(noTsBody) }, noTsBody);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });

    it('skips timestamp validation entirely when replayWindowMs is 0', () => {
      const disabledGuard = makeGuard({ replayWindowMs: 0 });
      // Timestamp from 1970 — would fail the window check if it were active
      const oldBody = makeBody(new Date(0).toISOString());
      const ctx = makeContext({ 'x-signature': makeSignature(oldBody) }, oldBody);
      // Should pass because replay protection is disabled
      expect(disabledGuard.canActivate(ctx)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Timing-safe comparison guarantee
  // -------------------------------------------------------------------------

  describe('timing-safe comparison', () => {
    it('rejects signatures of different length without calling timingSafeEqual', () => {
      // A shorter-than-expected signature should be rejected by the length check,
      // not by timingSafeEqual (which throws on mismatched buffer lengths).
      // If the length check is missing, Node.js would throw a RangeError here.
      const body = makeBody();
      const shortSig = 'sha256=abc'; // far shorter than a real sha256 hex
      const ctx = makeContext({ 'x-signature': shortSig }, body);
      expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
    });
  });
});
