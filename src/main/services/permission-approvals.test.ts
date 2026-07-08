import { afterEach, describe, expect, it } from 'vitest';
import {
  approvalBus,
  hasApprover,
  requestApproval,
  resolveApproval,
  type ApprovalRequest,
} from './permission-approvals';

function makeRequest(id: string): ApprovalRequest {
  return { id, toolName: 'Bash', input: { command: 'ls' }, sessionId: 'sess-1' };
}

afterEach(() => {
  approvalBus.removeAllListeners('request');
  approvalBus.removeAllListeners('expired');
});

describe('permission-approvals', () => {
  it('resolves true when the approval is allowed', async () => {
    approvalBus.on('request', (req: ApprovalRequest) => resolveApproval(req.id, true));
    await expect(requestApproval(makeRequest('a1'))).resolves.toBe(true);
  });

  it('resolves false when the approval is denied', async () => {
    approvalBus.on('request', (req: ApprovalRequest) => resolveApproval(req.id, false));
    await expect(requestApproval(makeRequest('a2'))).resolves.toBe(false);
  });

  it('emits the request payload on the bus for the approver', async () => {
    let seen: ApprovalRequest | null = null;
    approvalBus.on('request', (req: ApprovalRequest) => {
      seen = req;
      resolveApproval(req.id, true);
    });
    const req = makeRequest('a3');
    await requestApproval(req);
    expect(seen).toEqual(req);
  });

  it('denies on timeout when nobody answers and emits expired with the id', async () => {
    const expired: string[] = [];
    approvalBus.on('expired', (id: string) => expired.push(id));
    approvalBus.on('request', () => {
      /* aprovador presente, mas nunca responde */
    });
    await expect(requestApproval(makeRequest('a4'), 20)).resolves.toBe(false);
    expect(expired).toEqual(['a4']);
  });

  it('does not emit expired when the approval is answered in time', async () => {
    const expired: string[] = [];
    approvalBus.on('expired', (id: string) => expired.push(id));
    approvalBus.on('request', (req: ApprovalRequest) => resolveApproval(req.id, true));
    await expect(requestApproval(makeRequest('a4b'), 20)).resolves.toBe(true);
    // O timer foi limpo no resolve — espera além do timeout pra provar.
    await new Promise((r) => setTimeout(r, 40));
    expect(expired).toEqual([]);
  });

  it('resolveApproval returns true when it settles a pending request', async () => {
    let settled: boolean | null = null;
    approvalBus.on('request', (req: ApprovalRequest) => {
      settled = resolveApproval(req.id, true);
    });
    await expect(requestApproval(makeRequest('a4c'))).resolves.toBe(true);
    expect(settled).toBe(true);
  });

  it('resolveApproval returns false for unknown ids and later real answers still work', async () => {
    expect(resolveApproval('ghost', true)).toBe(false);
    approvalBus.on('request', (req: ApprovalRequest) => {
      expect(resolveApproval('other-ghost', false)).toBe(false); // não afeta o pending real
      expect(resolveApproval(req.id, true)).toBe(true);
    });
    await expect(requestApproval(makeRequest('a5'))).resolves.toBe(true);
  });

  it('resolveApproval returns false after the request already expired', async () => {
    approvalBus.on('request', () => {
      /* nunca responde — deixa expirar */
    });
    await expect(requestApproval(makeRequest('a5b'), 20)).resolves.toBe(false);
    expect(resolveApproval('a5b', true)).toBe(false);
  });

  it('does not double-settle: a late second answer is a no-op returning false', async () => {
    approvalBus.on('request', (req: ApprovalRequest) => {
      expect(resolveApproval(req.id, false)).toBe(true);
      expect(resolveApproval(req.id, true)).toBe(false); // já resolvido — ignorada
    });
    await expect(requestApproval(makeRequest('a6'))).resolves.toBe(false);
  });

  it('hasApprover reflects listeners on the bus', () => {
    expect(hasApprover()).toBe(false);
    const listener = (): void => {};
    approvalBus.on('request', listener);
    expect(hasApprover()).toBe(true);
    approvalBus.off('request', listener);
    expect(hasApprover()).toBe(false);
  });
});
