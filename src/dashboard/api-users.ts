// ═══════════════════════════════════════
// ATLAS — Dashboard Users API
// v0.9 Feature 9
// ═══════════════════════════════════════

import { Router, Request, Response } from 'express';
import { UserManager } from '../security/user-manager';
import { UserRole } from '../types';

export function createUsersRouter(userManager: UserManager): Router {
  const router = Router();

  router.get('/', (_req: Request, res: Response) => {
    res.json(userManager.listUsers());
  });

  router.get('/:id', (req: Request, res: Response) => {
    const user = userManager.getUser(String(req.params.id));
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    res.json(user);
  });

  router.post('/:id/role', (req: Request, res: Response) => {
    const { role } = req.body;
    const validRoles: UserRole[] = ['owner', 'admin', 'user', 'guest'];
    if (!validRoles.includes(role)) {
      res.status(400).json({ error: `Invalid role. Valid: ${validRoles.join(', ')}` });
      return;
    }
    const updated = userManager.setRole(String(req.params.id), role);
    res.json({ updated });
  });

  router.delete('/:id', (req: Request, res: Response) => {
    const deleted = userManager.deleteUser(String(req.params.id));
    res.json({ deleted });
  });

  router.get('/:id/permissions', (req: Request, res: Response) => {
    const user = userManager.getUser(String(req.params.id));
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    const perms = userManager.getPermissions(user.role);
    res.json({ role: user.role, permissions: perms });
  });

  router.post('/permissions', (req: Request, res: Response) => {
    const { role, permission, allowed } = req.body;
    if (!role || !permission) {
      res.status(400).json({ error: 'role and permission required' });
      return;
    }
    userManager.setPermission(role as UserRole, permission, allowed !== false);
    res.json({ success: true });
  });

  return router;
}
