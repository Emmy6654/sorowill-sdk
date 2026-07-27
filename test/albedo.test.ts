import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Networks } from '@stellar/stellar-sdk';

// ---------------------------------------------------------------------------
// vi.mock is hoisted to the top of the file by Vitest, so any variables used
// inside the factory MUST also be hoisted via vi.hoisted().
// ---------------------------------------------------------------------------
const { mockPublicKey, mockTx } = vi.hoisted(() => ({
  mockPublicKey: vi.fn(),
  mockTx: vi.fn(),
}));

vi.mock('@albedo-link/intent', () => ({
  default: {
    publicKey: mockPublicKey,
    tx: mockTx,
  },
}));

// Import after the mock is in place.
import {
  connectAlbedo,
  connectAlbedoWithNetwork,
  getAlbedoPublicKey,
  signAlbedoTransaction,
  _resetAlbedoConnection,
} from '../src/albedo';

const TEST_PUBKEY = 'GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGKWKZ7NNHV9CNHBNOBXN4';
const SIGNED_XDR = 'SIGNED_XDR_ENVELOPE';
const UNSIGNED_XDR = 'UNSIGNED_XDR_ENVELOPE';

describe('connectAlbedo', () => {
  beforeEach(() => {
    _resetAlbedoConnection();
    mockPublicKey.mockResolvedValue({
      pubkey: TEST_PUBKEY,
      signed_message: 'abc',
      signature: 'def',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the connected public key', async () => {
    const connection = await connectAlbedo();
    expect(connection.publicKey).toBe(TEST_PUBKEY);
  });

  it('defaults to testnet network when no prior connection exists', async () => {
    const connection = await connectAlbedo();
    expect(connection.network).toBe('testnet');
    expect(connection.networkPassphrase).toBe(Networks.TESTNET);
  });

  it('calls albedo.publicKey once', async () => {
    await connectAlbedo();
    expect(mockPublicKey).toHaveBeenCalledTimes(1);
  });

  it('throws when albedo.publicKey rejects (user cancels)', async () => {
    mockPublicKey.mockRejectedValue(new Error('User rejected'));
    await expect(connectAlbedo()).rejects.toThrow('User rejected');
  });
});

describe('connectAlbedoWithNetwork', () => {
  beforeEach(() => {
    _resetAlbedoConnection();
    mockPublicKey.mockResolvedValue({
      pubkey: TEST_PUBKEY,
      signed_message: 'abc',
      signature: 'def',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('stores and returns the provided network passphrase', async () => {
    const connection = await connectAlbedoWithNetwork(Networks.TESTNET);
    expect(connection.networkPassphrase).toBe(Networks.TESTNET);
    expect(connection.network).toBe('testnet');
    expect(connection.publicKey).toBe(TEST_PUBKEY);
  });

  it('maps public mainnet passphrase to "public"', async () => {
    const connection = await connectAlbedoWithNetwork(Networks.PUBLIC);
    expect(connection.network).toBe('public');
    expect(connection.networkPassphrase).toBe(Networks.PUBLIC);
  });

  it('throws when albedo.publicKey rejects', async () => {
    mockPublicKey.mockRejectedValue(new Error('Cancelled'));
    await expect(connectAlbedoWithNetwork(Networks.TESTNET)).rejects.toThrow('Cancelled');
  });
});

describe('getAlbedoPublicKey', () => {
  beforeEach(() => {
    _resetAlbedoConnection();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('throws before connectAlbedo is called', async () => {
    await expect(getAlbedoPublicKey()).rejects.toThrow(
      'No Albedo account is connected. Call connectAlbedo() first.',
    );
  });

  it('returns the public key stored during connectAlbedo', async () => {
    mockPublicKey.mockResolvedValue({
      pubkey: TEST_PUBKEY,
      signed_message: 'abc',
      signature: 'def',
    });
    await connectAlbedo();

    const pubkey = await getAlbedoPublicKey();
    expect(pubkey).toBe(TEST_PUBKEY);
  });

  it('does not call albedo.publicKey again (no extra popup)', async () => {
    mockPublicKey.mockResolvedValue({
      pubkey: TEST_PUBKEY,
      signed_message: 'abc',
      signature: 'def',
    });
    await connectAlbedo();
    vi.clearAllMocks();

    await getAlbedoPublicKey();
    expect(mockPublicKey).not.toHaveBeenCalled();
  });
});

describe('signAlbedoTransaction', () => {
  beforeEach(() => {
    _resetAlbedoConnection();
    mockPublicKey.mockResolvedValue({
      pubkey: TEST_PUBKEY,
      signed_message: 'abc',
      signature: 'def',
    });
    mockTx.mockResolvedValue({
      xdr: UNSIGNED_XDR,
      signed_envelope_xdr: SIGNED_XDR,
      tx_hash: 'abc123',
      network: 'testnet',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the signed envelope XDR', async () => {
    await connectAlbedo();
    const result = await signAlbedoTransaction(UNSIGNED_XDR, {
      networkPassphrase: Networks.TESTNET,
    });
    expect(result).toBe(SIGNED_XDR);
  });

  it('calls albedo.tx with the correct xdr and network identifier', async () => {
    await connectAlbedo();
    await signAlbedoTransaction(UNSIGNED_XDR, {
      networkPassphrase: Networks.TESTNET,
    });
    expect(mockTx).toHaveBeenCalledWith(
      expect.objectContaining({
        xdr: UNSIGNED_XDR,
        network: 'testnet',
      }),
    );
  });

  it('maps mainnet passphrase to "public" network identifier', async () => {
    await connectAlbedoWithNetwork(Networks.PUBLIC);
    await signAlbedoTransaction(UNSIGNED_XDR, {
      networkPassphrase: Networks.PUBLIC,
    });
    expect(mockTx).toHaveBeenCalledWith(
      expect.objectContaining({ network: 'public' }),
    );
  });

  it('passes the stored pubkey to pre-select the account in the Albedo popup', async () => {
    await connectAlbedo();
    await signAlbedoTransaction(UNSIGNED_XDR, {
      networkPassphrase: Networks.TESTNET,
    });
    expect(mockTx).toHaveBeenCalledWith(
      expect.objectContaining({ pubkey: TEST_PUBKEY }),
    );
  });

  it('throws when albedo.tx rejects (user cancels signing)', async () => {
    await connectAlbedo();
    mockTx.mockRejectedValue(new Error('Transaction signing rejected'));
    await expect(
      signAlbedoTransaction(UNSIGNED_XDR, { networkPassphrase: Networks.TESTNET }),
    ).rejects.toThrow('Transaction signing rejected');
  });

  it('works without a prior connectAlbedo call (pubkey is undefined)', async () => {
    // signAlbedoTransaction does not require a prior connect — it just won't
    // pre-select the account in the popup.
    const signed = await signAlbedoTransaction(UNSIGNED_XDR, {
      networkPassphrase: Networks.TESTNET,
    });
    expect(signed).toBe(SIGNED_XDR);
    expect(mockTx).toHaveBeenCalledWith(
      expect.objectContaining({ xdr: UNSIGNED_XDR, network: 'testnet' }),
    );
    // Without a prior connect the pubkey property should be absent from the call.
    const callArg = mockTx.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArg?.['pubkey']).toBeUndefined();
  });
});
