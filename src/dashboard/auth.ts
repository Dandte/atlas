// ═══════════════════════════════════════
// ATLAS — Dashboard Authentication
// JWT + bcrypt + rate limiting
// ═══════════════════════════════════════

import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { Router, Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import logger from '../utils/logger';

// ── Config ──

const JWT_SECRET = process.env.DASHBOARD_JWT_SECRET || (process.env.DASHBOARD_PASSWORD || 'atlas') + '_jwt_secret_change_me';
const JWT_EXPIRY = process.env.DASHBOARD_JWT_EXPIRY || '24h';
const REFRESH_EXPIRY = '7d';

// ── Password Hash ──

let passwordHash: string | null = null;

export async function initAuth(db: Database.Database): Promise<void> {
  // Ensure atlas_config table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS atlas_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const stored = db.prepare(
    `SELECT value FROM atlas_config WHERE key = 'dashboard_password_hash'`
  ).get() as { value: string } | undefined;

  if (stored) {
    passwordHash = stored.value;
  } else {
    const plainPassword = process.env.DASHBOARD_PASSWORD;
    if (!plainPassword) {
      logger.warn('DASHBOARD_PASSWORD not configured — dashboard auth disabled');
      return;
    }
    passwordHash = await bcrypt.hash(plainPassword, 12);
    db.prepare(
      `INSERT OR REPLACE INTO atlas_config (key, value) VALUES (?, ?)`
    ).run('dashboard_password_hash', passwordHash);
    logger.info('Dashboard password hashed and stored');
  }
}

// ── Rate Limiting ──

export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Demasiados intentos. Esperá 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 120,
  message: { error: 'Rate limit excedido.' },
});

// ── Token Generation ──

function generateTokens(): { accessToken: string; refreshToken: string } {
  const signOpts: jwt.SignOptions = {};
  signOpts.expiresIn = JWT_EXPIRY as any;
  const accessToken = jwt.sign(
    { role: 'admin', type: 'access' },
    JWT_SECRET,
    signOpts
  );

  const refreshOpts: jwt.SignOptions = {};
  refreshOpts.expiresIn = REFRESH_EXPIRY as any;
  const refreshToken = jwt.sign(
    { role: 'admin', type: 'refresh' },
    JWT_SECRET,
    refreshOpts
  );

  return { accessToken, refreshToken };
}

// ── Auth Routes ──

export function createAuthRouter(db: Database.Database): Router {
  const router = Router();

  // LOGIN
  router.post('/login', loginLimiter, async (req: Request, res: Response) => {
    const { password } = req.body;

    if (!password || !passwordHash) {
      res.status(400).json({ error: 'Password requerido' });
      return;
    }

    const valid = await bcrypt.compare(password, passwordHash);
    if (!valid) {
      logger.warn(`Dashboard login failed from ${req.ip}`);
      res.status(401).json({ error: 'Password incorrecto' });
      return;
    }

    const tokens = generateTokens();

    res.cookie('atlas_access', tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.cookie('atlas_refresh', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/auth',
    });

    logger.info(`Dashboard login successful from ${req.ip}`);
    res.json({ success: true, expiresIn: JWT_EXPIRY });
  });

  // REFRESH TOKEN
  router.post('/refresh', (req: Request, res: Response) => {
    const refreshToken = req.cookies?.atlas_refresh;
    if (!refreshToken) {
      res.status(401).json({ error: 'No refresh token' });
      return;
    }

    try {
      const decoded = jwt.verify(refreshToken, JWT_SECRET) as any;
      if (decoded.type !== 'refresh') throw new Error('Invalid token type');

      const tokens = generateTokens();

      res.cookie('atlas_access', tokens.accessToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 24 * 60 * 60 * 1000,
      });

      res.json({ success: true });
    } catch {
      res.status(401).json({ error: 'Refresh token inválido o expirado' });
    }
  });

  // LOGOUT
  router.post('/logout', (_req: Request, res: Response) => {
    res.clearCookie('atlas_access');
    res.clearCookie('atlas_refresh');
    res.json({ success: true });
  });

  // CHANGE PASSWORD
  router.post('/change-password', async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword || !passwordHash) {
      res.status(400).json({ error: 'Passwords requeridos' });
      return;
    }

    if (newPassword.length < 8) {
      res.status(400).json({ error: 'Password mínimo 8 caracteres' });
      return;
    }

    const valid = await bcrypt.compare(currentPassword, passwordHash);
    if (!valid) {
      res.status(401).json({ error: 'Password actual incorrecto' });
      return;
    }

    passwordHash = await bcrypt.hash(newPassword, 12);

    db.prepare(
      `UPDATE atlas_config SET value = ?, updated_at = datetime('now') WHERE key = 'dashboard_password_hash'`
    ).run(passwordHash);

    res.clearCookie('atlas_access');
    res.clearCookie('atlas_refresh');

    logger.info('Dashboard password changed');
    res.json({ success: true, message: 'Password cambiado. Iniciá sesión de nuevo.' });
  });

  return router;
}

// ── Auth Middleware ──

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  // Auth routes are public
  if (req.path.startsWith('/auth/')) {
    next();
    return;
  }

  const token = req.cookies?.atlas_access
    || (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);

  if (!token) {
    res.status(401).json({ error: 'No autenticado' });
    return;
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.type !== 'access') throw new Error('Invalid token type');
    (req as any).user = decoded;
    next();
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      res.status(401).json({ error: 'Sesión expirada', code: 'TOKEN_EXPIRED' });
      return;
    }
    res.status(401).json({ error: 'Token inválido' });
  }
}

/** JWT secret for WebSocket auth verification */
export function getJwtSecret(): string {
  return JWT_SECRET;
}
