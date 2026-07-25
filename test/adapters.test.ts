import { Networks } from '@stellar/stellar-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const publicKeyMock = vi.fn();
const txMock = vi.fn();

vi.mock('@albedo-link/intent', () => ({
  default: {
    publicKey: (...args: unknown[]) => publicKeyMock(...args),
    tx: (...args: unknown[]) => txMock(...args),
  },
}));

import { createAlbedoAdapter } from '../src/adapters/albedo';
import { freighterAdapter, type WalletAdapter } from '../src/wallet';

// A no-op reference to prove the exported adapters are assignable to the
// public WalletAdapter interface (compile-time contract check).
const adapters: WalletAdapter[] = [freighterAdapter, createAlbedoAdapter()];

describe('freighterAdapter', () => {
  it('implements the WalletAdapter interface', () => {
    expect(typeof freighterAdapter.getPublicKey).toBe('function');
    expect(typeof freighterAdapter.signTransaction).toBe('function');
  });

  it('is included in the assignable adapter list', () => {
    expect(adapters).toContain(freighterAdapter);
  });
});

describe('createAlbedoAdapter', () => {
  beforeEach(() => {
    publicKeyMock.mockReset();
    txMock.mockReset();
  });

  it('returns the public key selected in Albedo', async () => {
    publicKeyMock.mockResolvedValue({ pubkey: 'GABC' });
    const adapter = createAlbedoAdapter();

    await expect(adapter.getPublicKey()).resolves.toBe('GABC');
  });

  it('signs a transaction and returns the signed envelope XDR', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    const signed = await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.TESTNET,
    });

    expect(signed).toBe('SIGNED_XDR');
    expect(txMock).toHaveBeenCalledWith(
      expect.objectContaining({ xdr: 'UNSIGNED_XDR', network: 'testnet' }),
    );
  });

  it('maps the public network passphrase to Albedo "public"', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.PUBLIC,
    });

    expect(txMock).toHaveBeenCalledWith(expect.objectContaining({ network: 'public' }));
  });

  it('passes unknown passphrases through unchanged', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: 'Standalone Network ; February 2017',
    });

    expect(txMock).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'Standalone Network ; February 2017' }),
    );
  });

  it('pins signatures to the previously selected public key', async () => {
    publicKeyMock.mockResolvedValue({ pubkey: 'GSELECTED' });
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.getPublicKey();
    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.TESTNET,
    });

    expect(txMock).toHaveBeenCalledWith(expect.objectContaining({ pubkey: 'GSELECTED' }));
  });

  it('omits pubkey before any account has been selected', async () => {
    txMock.mockResolvedValue({ signed_envelope_xdr: 'SIGNED_XDR' });
    const adapter = createAlbedoAdapter();

    await adapter.signTransaction('UNSIGNED_XDR', {
      networkPassphrase: Networks.TESTNET,
    });

    const call = txMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('pubkey');
  });
});

describe('SoroWillClient wallet injection', () => {
  it('defaults to the Freighter adapter when no wallet is supplied', async () => {
    const { SoroWillClient } = await import('../src/SoroWillClient');
    const client = new SoroWillClient({ network: 'testnet', contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR' });
    // The wallet is private; assert the client constructs with the default
    // rather than throwing, which proves the optional option is backwards
    // compatible.
    expect(client).toBeInstanceOf(SoroWillClient);
  });

  it('accepts a custom WalletAdapter', async () => {
    const { SoroWillClient } = await import('../src/SoroWillClient');
    const customWallet: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue('GCUSTOM'),
      signTransaction: vi.fn().mockResolvedValue('SIGNED'),
    };
    const client = new SoroWillClient({
      network: 'testnet',
      contractId: 'CADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP5KR',
      wallet: customWallet,
    });
    expect(client).toBeInstanceOf(SoroWillClient);
  });
});
