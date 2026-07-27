import Str from '@ledgerhq/hw-app-str';
import { StrKey, TransactionBuilder } from '@stellar/stellar-sdk';

import type { SignTransactionOptions, WalletAdapter, WalletConnection } from './types';

export interface LedgerTransport {
  close?(): Promise<void>;
}

export interface LedgerStellarApp {
  getPublicKey(path: string, display?: boolean): Promise<{ rawPublicKey: Buffer }>;
  signTransaction(path: string, signatureBase: Buffer): Promise<{ signature: Buffer }>;
}

export interface LedgerWalletAdapterOptions {
  transport: LedgerTransport;
  /** Stellar BIP-44 account path. */
  derivationPath?: string;
  network?: string;
  networkPassphrase: string;
  /** Test seam for a mocked Ledger Stellar application. */
  app?: LedgerStellarApp;
}

/** Wallet adapter backed by the Ledger Stellar device application. */
export class LedgerWalletAdapter implements WalletAdapter {
  readonly id = 'ledger';
  readonly name = 'Ledger';

  private readonly app: LedgerStellarApp;
  private readonly derivationPath: string;
  private publicKey: string | null = null;

  constructor(private readonly options: LedgerWalletAdapterOptions) {
    this.derivationPath = options.derivationPath ?? "44'/148'/0'";
    this.app =
      options.app ??
      new Str(options.transport as unknown as ConstructorParameters<typeof Str>[0]);
  }

  async connect(): Promise<WalletConnection> {
    const result = await this.app.getPublicKey(this.derivationPath);
    this.publicKey = StrKey.encodeEd25519PublicKey(result.rawPublicKey);
    return {
      publicKey: this.publicKey,
      network: this.options.network ?? 'custom',
      networkPassphrase: this.options.networkPassphrase,
    };
  }

  async disconnect(): Promise<void> {
    await this.options.transport.close?.();
    this.publicKey = null;
  }

  async isConnected(): Promise<boolean> {
    return this.publicKey !== null;
  }

  async getPublicKey(): Promise<string> {
    if (!this.publicKey) {
      throw new Error('Ledger is not connected. Call connect() first.');
    }
    return this.publicKey;
  }

  async signTransaction(
    transactionXdr: string,
    options: SignTransactionOptions,
  ): Promise<string> {
    const publicKey = await this.getPublicKey();
    const transaction = TransactionBuilder.fromXDR(transactionXdr, options.networkPassphrase);

    // The Ledger promise remains pending while the device displays transaction
    // details. This method therefore cannot resolve before physical approval.
    const signatureBase = Buffer.from(transaction.signatureBase());
    const { signature } = await this.app.signTransaction(this.derivationPath, signatureBase);
    transaction.addSignature(publicKey, signature.toString('base64'));
    return transaction.toXDR();
  }
}
