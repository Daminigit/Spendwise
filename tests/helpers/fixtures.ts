/**
 * Test fixtures: an isolated organisation per test file, built through the
 * real domain functions (signup + invites), with unique emails so files can
 * run in parallel against one test database.
 */

import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { User } from '../../src/db/schema.js';
import { hashPassword } from '../../src/auth/password.js';
import { createInvite, signupWithInvite, signupWithNewOrg, verifyInvite } from '../../src/domain/org.js';
import { createToken } from '../../src/domain/tokens.js';

export const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);
export const PASSWORD = 'test-password-123';

let hashCache: Promise<string> | undefined;
const passwordHash = () => (hashCache ??= hashPassword(PASSWORD));

export interface TestOrg {
  orgId: string;
  admin: User;
  manager: User;
  /** Reports to `manager`. */
  emp: User;
  /** Also reports to `manager`. */
  emp2: User;
  /** A manager with their own report, unrelated to `manager`'s team. */
  otherManager: User;
  /** Reports to `otherManager`. */
  otherEmp: User;
}

async function invite(admin: User, role: User['role'], managerId: string | null, name: string, email: string) {
  const { token } = await createInvite(admin.id, role, managerId);
  const payload = verifyInvite(token);
  if (!payload) throw new Error('invite did not verify');
  return signupWithInvite(payload, { name, email, passwordHash: await passwordHash() });
}

export async function createTestOrg(label = 'test'): Promise<TestOrg> {
  const tag = `${label}-${randomUUID().slice(0, 8)}`;
  const email = (who: string) => `${who}.${tag}@example.test`;
  const admin = await signupWithNewOrg({ orgName: `Org ${tag}`, name: 'Ada Admin', email: email('admin'), passwordHash: await passwordHash() });
  const manager = await invite(admin, 'manager', admin.id, 'Mona Manager', email('manager'));
  const emp = await invite(admin, 'employee', manager.id, 'Eve Employee', email('eve'));
  const emp2 = await invite(admin, 'employee', manager.id, 'Ed Employee', email('ed'));
  const otherManager = await invite(admin, 'manager', admin.id, 'Omar Othermanager', email('omar'));
  const otherEmp = await invite(admin, 'employee', otherManager.id, 'Olga Otheremployee', email('olga'));
  return { orgId: admin.orgId, admin, manager, emp, emp2, otherManager, otherEmp };
}

// ── HTTP server ──────────────────────────────────────────────────────────────

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const { createApp } = await import('../../src/web/app.js');
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ── MCP client ───────────────────────────────────────────────────────────────

export interface ToolResult {
  isError: boolean;
  text: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any;
}

export interface McpTestClient {
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolResult>;
  listTools: () => Promise<string[]>;
  close: () => Promise<void>;
  tokenId: string;
  rawToken: string;
}

export async function mcpClientFor(server: TestServer, user: User): Promise<McpTestClient> {
  const { id, rawToken } = await createToken(user.id, 'test');
  const client = new Client({ name: 'spendwise-tests', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp/${rawToken}`)));
  return {
    tokenId: id,
    rawToken,
    listTools: async () => (await client.listTools()).tools.map((t) => t.name).sort(),
    close: () => client.close(),
    call: async (name, args = {}) => {
      try {
        const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text?: string }> };
        const text = r.content[0]?.text ?? '';
        let data: unknown = null;
        try {
          data = JSON.parse(text);
        } catch {
          /* error text */
        }
        return { isError: Boolean(r.isError), text, data };
      } catch (err) {
        // Protocol-level errors (e.g. schema validation, 401) surface as exceptions
        return { isError: true, text: (err as Error).message, data: null };
      }
    },
  };
}

// ── Web session ──────────────────────────────────────────────────────────────

export interface WebSession {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  post: (path: string, form: Record<string, string>) => Promise<Response>;
}

export async function loginAs(server: TestServer, user: Pick<User, 'email'>, password = PASSWORD): Promise<WebSession> {
  const res = await fetch(`${server.url}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: user.email, password }),
  });
  if (res.status !== 303) throw new Error(`login failed for ${user.email}: ${res.status}`);
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  const f = (path: string, init: RequestInit = {}) =>
    fetch(`${server.url}${path}`, { ...init, redirect: 'manual', headers: { ...(init.headers ?? {}), cookie } });
  return {
    fetch: f,
    post: (path, form) =>
      f(path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }),
  };
}

// ── Data helpers ─────────────────────────────────────────────────────────────

/** A weekday (Mon–Fri) ISO date, `daysAgo` days back. */
export function weekdayIso(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The Saturday on or before `daysAgo` days back. */
export function saturdayIso(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  while (d.getUTCDay() !== 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
