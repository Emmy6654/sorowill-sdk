import freighterApi from '@stellar/freighter-api';

/** Result of a successful wallet connection. */
export interface WalletConnection {
  publicKey: string;
  network: string;
  networkPassphrase: string;
}

export interface WalletAdapter {
  isConnected(): Promise<boolean>;
  connect(): Promise<WalletConnection>;
  reconnect(): Promise<WalletConnection>;
  disconnect(): Promise<void>;
  getPublicKey(): Promise<string>;
  signTransaction(transactionXdr: string, opts: { networkPassphrase: string }): Promise<string>;
}

export class FreighterWalletAdapter implements WalletAdapter {
  async isConnected(): Promise<boolean> {
    const { isConnected, error } = await freighterApi.isConnected();
    if (error) {
      return false;
    }
    return isConnected;
  }

  async connect(): Promise<WalletConnection> {
    const access = await freighterApi.requestAccess();
    if (access.error) {
      throw new Error(access.error.message);
    }

    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails.error) {
      throw new Error(networkDetails.error.message);
    }

    return {
      publicKey: access.address,
      network: networkDetails.network,
      networkPassphrase: networkDetails.networkPassphrase,
    };
  }

  async reconnect(): Promise<WalletConnection> {
    const publicKey = await this.getPublicKey();
    const networkDetails = await freighterApi.getNetworkDetails();
    if (networkDetails.error) {
      throw new Error(networkDetails.error.message);
    }

    return {
      publicKey,
      network: networkDetails.network,
      networkPassphrase: networkDetails.networkPassphrase,
    };
  }

  async disconnect(): Promise<void> {
    return;
  }

  async getPublicKey(): Promise<string> {
    const { address, error } = await freighterApi.getAddress();
    if (error) {
      throw new Error(error.message);
    }
    if (!address) {
      throw new Error('No Freighter account is connected. Call connectWallet() first.');
    }
    return address;
  }

  async signTransaction(
    transactionXdr: string,
    opts: { networkPassphrase: string },
  ): Promise<string> {
    const { signedTxXdr, error } = await freighterApi.signTransaction(transactionXdr, {
      networkPassphrase: opts.networkPassphrase,
    });
    if (error) {
      throw new Error(error.message);
    }
    return signedTxXdr;
  }
}

const defaultFreighterWalletAdapter = new FreighterWalletAdapter();

export async function isFreighterInstalled(): Promise<boolean> {
  return await defaultFreighterWalletAdapter.isConnected();
}

export async function connectWallet(): Promise<WalletConnection> {
  return await defaultFreighterWalletAdapter.connect();
}

export async function getPublicKey(): Promise<string> {
  return await defaultFreighterWalletAdapter.getPublicKey();
}

export async function signTransaction(
  transactionXdr: string,
  opts: { networkPassphrase: string },
): Promise<string> {
  return await defaultFreighterWalletAdapter.signTransaction(transactionXdr, opts);
}

export function getDefaultWalletAdapter(): WalletAdapter {
  return defaultFreighterWalletAdapter;
}
