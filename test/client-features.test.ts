import { Account, Transaction, xdr } from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/wallet', () => ({
  getPublicKey: vi.fn(async () => 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'),
  signTransaction: vi.fn(async (transactionXdr: string) => transactionXdr),
}));

import { SoroWillClient } from '../src/SoroWillClient';
import { mapContractError, NotOwnerError, RequestTimeoutError } from '../src/errors';
import { RequestQueue } from '../src/requestQueue';

describe('RequestQueue', () => {
  it('applies backpressure to a burst of requests', async () => {
    const queue = new RequestQueue({ maxConcurrent: 2, requestsPerSecond: 100 });
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const burst = Array.from({ length: 6 }, (_, value) =>
      queue.enqueue(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate;
        active -= 1;
        return value;
      }),
    );

    await Promise.resolve();
    expect(peak).toBe(2);
    release?.();
    await expect(Promise.all(burst)).resolves.toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('rejects a hung request with the typed timeout error', async () => {
    const queue = new RequestQueue();
    const hung = queue.enqueue(() => new Promise<never>(() => undefined), 5);
    await expect(hung).rejects.toBeInstanceOf(RequestTimeoutError);
  });
});

describe('contract error mapping', () => {
  it('maps a Soroban contract code to its typed exception', () => {
    expect(mapContractError(new Error('HostError: Error(Contract, #2)'))).toBeInstanceOf(
      NotOwnerError,
    );
  });
});

describe('batch transactions', () => {
  it('prepares, signs, and submits two operations as one transaction', async () => {
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE',
    });
    let preparedOperationCount = 0;
    const fakeSpec = {
      funcArgsToScVals: () => [] as xdr.ScVal[],
    };
    const fakeServer = {
      getAccount: async (publicKey: string) => new Account(publicKey, '0'),
      prepareTransaction: async (transaction: Transaction) => {
        preparedOperationCount = transaction.operations.length;
        return transaction;
      },
      sendTransaction: async () => ({ status: 'PENDING', hash: 'batch-hash' }),
      pollTransaction: async () => ({
        status: 'SUCCESS',
        createdAt: 1_700_000_000,
        returnValue: xdr.ScVal.scvVoid(),
      }),
    };
    Object.defineProperty(client, 'specPromise', { value: Promise.resolve(fakeSpec) });
    Object.defineProperty(client, 'server', { value: fakeServer });

    await expect(
      client.batch([
        { method: 'first_operation', args: {} },
        { method: 'second_operation', args: {} },
      ]),
    ).resolves.toEqual({ txHash: 'batch-hash', createdAt: 1_700_000_000 });
    expect(preparedOperationCount).toBe(2);
  });
});
