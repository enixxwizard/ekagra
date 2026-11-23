import crypto from 'node:crypto';
import type { Request } from 'express';

export interface EkuAuthIdentity {
  authenticated: true;
  mode: 'supabase' | 'guest';
  scopeId: string;
}

export interface EkuAuthFailure {
  authenticated: false;
  status: number;
  error: string;
}

const tokenCache = new Map<string, { userId: string; expiresAt: number }>();

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function verifyEkuRequestAuth(
  req: Request
): Promise<EkuAuthIdentity | EkuAuthFailure> {
  const authHeader = req.headers.authorization;

  if (typeof authHeader === 'string' && authHeader.trim()) {
    const match = authHeader.trim().match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return {
        authenticated: false,
        status: 401,
        error: 'Malformed authorization header. Please sign in again.',
      };
    }

    const token = match[1].trim();
    if (!token || token.length > 8192) {
      return {
        authenticated: false,
        status: 401,
        error: 'Invalid session token. Please sign in again.',
      };
    }

    const tokenKey = hashToken(token);
    const cached = tokenCache.get(tokenKey);
    if (cached && cached.expiresAt > Date.now()) {
      return {
        authenticated: true,
        mode: 'supabase',
        scopeId: cached.userId,
      };
    }

    const supabaseUrl = (
      process.env.SUPABASE_URL ||
      process.env.VITE_SUPABASE_URL ||
      ''
    ).trim();
    const supabaseAnonKey = (
      process.env.SUPABASE_PUBLISHABLE_KEY ||
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
      ''
    ).trim();

    if (!supabaseUrl || !supabaseAnonKey) {
      return {
        authenticated: false,
        status: 503,
        error: 'Authentication verification is not configured on the server.',
      };
    }

    try {
      const response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: supabaseAnonKey,
        },
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        tokenCache.delete(tokenKey);
        return {
          authenticated: false,
          status: 401,
          error: 'Your session has expired. Please sign in again.',
        };
      }

      const userPayload = (await response.json()) as { id?: unknown };
      if (typeof userPayload.id !== 'string' || !userPayload.id.trim()) {
        return {
          authenticated: false,
          status: 401,
          error: 'Unable to verify user identity.',
        };
      }

      if (tokenCache.size > 200) {
        const oldest = tokenCache.keys().next().value;
        if (oldest) tokenCache.delete(oldest);
      }
      tokenCache.set(tokenKey, {
        userId: userPayload.id,
        expiresAt: Date.now() + 45_000,
      });

      return {
        authenticated: true,
        mode: 'supabase',
        scopeId: userPayload.id,
      };
    } catch {
      return {
        authenticated: false,
        status: 503,
        error: 'Could not verify your session right now. Please retry.',
      };
    }
  }

  const clientMode = req.headers['x-ekagra-mode'];
  if (clientMode === 'guest') {
    return {
      authenticated: true,
      mode: 'guest',
      scopeId: 'guest',
    };
  }

  return {
    authenticated: false,
    status: 401,
    error: 'Authentication or guest session header is required to talk to Eku.',
  };
}
