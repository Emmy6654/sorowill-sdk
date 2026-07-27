import {
  Account,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { describe, expect, it, vi } from 'vitest';

import {
  HanaWalletAdapter,
  HotWalletAdapter,
  LedgerWalletAdapter,
  LobstrWalletAdapter,
  type InjectedWalletProvider,
  type LedgerStellarApp,
} from '../src/adapters';

const connection = {
  publicKey: 'GTEST',
  network: 'testnet',
  networkPassphrase: Networks.TESTNET,
};

function injectedProvider(): InjectedWalletProvider {
  return {
    connect: vi.fn().mockResolvedValue(connection),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: 'signed-xdr' }),
  };
}

describe.each([
  ['HanaWalletAdapter', HanaWalletAdapter],
  ['HotWalletAdapter', HotWalletAdapter],
])('%s', (_name, Adapter) => {
  it('connects and signs through its injected provider', async () => {
    const provider = injectedProvider();
    const adapter = new Adapter(provider);

    await expect(adapter.connect()).resolves.toEqual(connection);
    await expect(
      adapter.signTransaction('unsigned-xdr', {
        networkPassphrase: Networks.TESTNET,
      }),
    ).resolves.toBe('signed-xdr');
    await expect(adapter.getPublicKey()).resolves.toBe('GTEST');
  });

  it('clears its local connection on disconnect', async () => {
    const adapter = new Adapter(injectedProvider());
    await adapter.connect();
    await adapter.disconnect();

    await expect(adapter.isConnected()).resolves.toBe(false);
    await expect(adapter.getPublicKey()).rejects.toThrow('Call connect() first');
  });
});

describe('LobstrWalletAdapter', () => {
  it('publishes a pairing URI and waits for mobile approval', async () => {
    const approved = vi.fn().mockResolvedValue(connection);
    const onPairingUri = vi.fn();
    const openDeepLink = vi.fn();
    const client = {
      connect: vi.fn().mockResolvedValue({
        uri: 'wc:pairing@2?key=value',
        approval: approved,
      }),
      disconnect: vi.fn().mockResolvedValue(undefined),
      isConnected: vi.fn().mockResolvedValue(true),
      getPublicKey: vi.fn().mockResolvedValue('GTEST'),
      signTransaction: vi.fn().mockResolvedValue('signed-xdr'),
    };
    const adapter = new LobstrWalletAdapter({ client, onPairingUri, openDeepLink });

    await expect(adapter.connect()).resolves.toEqual(connection);
    expect(onPairingUri).toHaveBeenCalledWith('wc:pairing@2?key=value');
    expect(openDeepLink).toHaveBeenCalledWith(
      'lobstr://wallet-connect?uri=wc%3Apairing%402%3Fkey%3Dvalue',
    );
    expect(approved).toHaveBeenCalledOnce();
  });
});

describe('LedgerWalletAdapter', () => {
  it('waits for device confirmation and returns XDR with the Ledger signature', async () => {
    const keypair = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
    const transaction = new TransactionBuilder(new Account(keypair.publicKey(), '1'), {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.manageData({ name: 'test', value: 'value' }))
      .setTimeout(0)
      .build();

    let confirm: ((value: { signature: Buffer }) => void) | undefined;
    const confirmation = new Promise<{ signature: Buffer }>((resolve) => {
      confirm = resolve;
    });
    const app: LedgerStellarApp = {
      getPublicKey: vi.fn().mockResolvedValue({ rawPublicKey: keypair.rawPublicKey() }),
      signTransaction: vi.fn().mockReturnValue(confirmation),
    };
    const adapter = new LedgerWalletAdapter({
      transport: {},
      app,
      network: 'testnet',
      networkPassphrase: Networks.TESTNET,
    });
    await adapter.connect();

    let resolved = false;
    const signing = adapter
      .signTransaction(transaction.toXDR(), { networkPassphrase: Networks.TESTNET })
      .then((xdr) => {
        resolved = true;
        return xdr;
      });
    await Promise.resolve();
    expect(resolved).toBe(false);

    confirm?.({ signature: keypair.sign(transaction.hash()) });
    const signed = TransactionBuilder.fromXDR(await signing, Networks.TESTNET);
    expect(signed.signatures).toHaveLength(1);
  });
});

