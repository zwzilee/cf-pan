import type { Env } from './types';
import { verifyJWT } from './auth';
import { cookie, getCookie, Need } from './util';

/**
 * 角色与权限（唯一入口，别再各函数自己 requireAuth）。
 *
 * 两套身份，两个 secret，两个 cookie：
 *   - 后台会话  cookie `sid`   JWT_SECRET    role=admin 才能管
 *   - 前台访客  cookie `guest` PUBLIC_SECRET scope=read 只能看
 *
 * 前台凭证单独用 PUBLIC_SECRET 签名：前台 cookie 泄露不等于能动管理接口，
 * 两边密钥不同，谁也伪造不出对方。没配 PUBLIC_SECRET 时退化用 JWT_SECRET。
 */

export const GUEST_TTL = 90 * 86400; // 前台凭证 90 天，免每次输密码

export function publicSecret(env: Env): string {
  return env.PUBLIC_SECRET || env.JWT_SECRET;
}

export type Access = { kind: 'admin' | 'guest'; uid?: number; name?: string };

/** 判断这次请求的身份；无效或没有 → null（不抛） */
export async function readAccess(req: Request, env: Env): Promise<Access | null> {
  // 1) 后台会话
  const sid = getCookie(req, 'sid') || (req.headers.get('Authorization') || '').replace(/^Bearer\s+/, '');
  if (sid) {
    try {
      const p = await verifyJWT(sid, env.JWT_SECRET);
      if (p?.role === 'admin') return { kind: 'admin', uid: p.uid, name: p.u };
      if (p?.uid) return { kind: 'guest', uid: p.uid, name: p.u };
    } catch {
      /* 往下试前台凭证 */
    }
  }

  // 2) 前台访客凭证
  const guest = getCookie(req, 'guest');
  if (guest) {
    try {
      const p = await verifyJWT(guest, publicSecret(env));
      if (p?.scope === 'read') return { kind: 'guest' };
    } catch {
      /* 都没有 */
    }
  }
  return null;
}

/** 登录过就行（前台访客 或 管理员） */
export async function requireAny(req: Request, env: Env): Promise<Access> {
  const a = await readAccess(req, env);
  if (!a) throw new Need(401, '未登录');
  return a;
}

/** 必须是管理员 */
export async function requireAdmin(req: Request, env: Env): Promise<Access> {
  const a = await readAccess(req, env);
  if (!a) throw new Need(401, '未登录');
  if (a.kind !== 'admin') throw new Need(403, '只有管理员能做这个操作');
  return a;
}

/** 清掉两套 cookie 的 Set-Cookie 头 */
export function clearAuthCookies(): string[] {
  return [cookie('sid', '', 0), cookie('guest', '', 0)];
}
