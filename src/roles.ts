import type { Env } from './types';
import { verifyJWT } from './auth';
import { verifyApiToken } from './tokens';
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

export type Access = {
  kind: 'admin' | 'guest' | 'token';
  uid?: number;
  name?: string;
  /** 仅 kind==='token' 时有 */
  scopes?: string[];
  tokenId?: string;
};

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
  // 3) API 令牌（无面板管理）：Authorization: Bearer pan_xxx
  const auth = req.headers.get('Authorization') || '';
  const bearer = auth.replace(/^Bearer\s+/i, '').trim();
  if (bearer.startsWith('pan_')) {
    try {
      const tk = await verifyApiToken(env, bearer);
      if (tk) return { kind: 'token', name: tk.name, scopes: tk.scopes, tokenId: tk.id };
    } catch {
      /* 令牌无效，落到 null */
    }
  }
  return null;
}

/** 有没有管理权限：后台管理员，或带 manage 范围的 API 令牌 */
export function isManager(a: Access | null): boolean {
  if (!a) return false;
  if (a.kind === 'admin') return true;
  return a.kind === 'token' && !!a.scopes && a.scopes.includes('manage');
}

/** 登录过就行（前台访客 或 管理员） */
export async function requireAny(req: Request, env: Env): Promise<Access> {
  const a = await readAccess(req, env);
  if (!a) throw new Need(401, '未登录');
  return a;
}

/** 必须是管理员（后台会话，或带 manage 范围的 API 令牌） */
export async function requireAdmin(req: Request, env: Env): Promise<Access> {
  const a = await readAccess(req, env);
  if (!a) throw new Need(401, '未登录');
  if (!isManager(a)) throw new Need(403, '只有管理员能做这个操作');
  return a;
}

/** 清掉两套 cookie 的 Set-Cookie 头 */
export function clearAuthCookies(): string[] {
  return [cookie('sid', '', 0), cookie('guest', '', 0)];
}
