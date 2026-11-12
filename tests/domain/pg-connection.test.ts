import { describe, expect, it } from 'vitest';
import { pgConnectionString } from '../../src/auth/session.js';

describe('pgConnectionString', () => {
  it('asks node-postgres for verify-full instead of require', () =>
    expect(pgConnectionString('postgresql://u:p@h/db?sslmode=require&channel_binding=require')).toBe(
      'postgresql://u:p@h/db?sslmode=verify-full&channel_binding=require',
    ));
  it('handles sslmode as a later parameter', () =>
    expect(pgConnectionString('postgresql://u:p@h/db?a=1&sslmode=prefer')).toBe('postgresql://u:p@h/db?a=1&sslmode=verify-full'));
  it('leaves other modes and plain URLs alone', () => {
    expect(pgConnectionString('postgresql://u:p@h/db?sslmode=disable')).toBe('postgresql://u:p@h/db?sslmode=disable');
    expect(pgConnectionString('postgresql://localhost/spendwise')).toBe('postgresql://localhost/spendwise');
  });
});
